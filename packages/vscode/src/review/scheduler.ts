// Decides when each tracked file is diffed (§7.5): typing is debounced, the
// queue runs the most urgent first, nothing is re-diffed when neither the base
// nor the live text moved, and a file over the size limit is never read.

import type { Ref } from '@core/ids'

import type { Log } from '../log'
import type { Perf } from '../perf'
import { BlobTooLargeError, forDiff } from '../ledger/blobs'
import type { DiffRunner } from './diffPool'
import type { LiveTexts } from './live'
import type { DiffReason, ReviewModel } from './model'

export const TYPING_QUIET_MS = 150
export const TYPING_MAX_WAIT_MS = 600

const PRIORITY: Readonly<Record<DiffReason, number>> = { action: 0, ledger: 0, visible: 0, typing: 1, external: 2, startup: 3 }
const SKIPPABLE: ReadonlySet<DiffReason> = new Set<DiffReason>(['typing', 'visible', 'external', 'startup'])

export type TimerHandle = { cancel(): void }

export type Timers = {
  readonly after: (ms: number, fn: () => void) => TimerHandle
  readonly now: () => number
}

export const realTimers: Timers = {
  after: (ms, fn) => {
    const t = setTimeout(fn, ms)
    return { cancel: () => clearTimeout(t) }
  },
  now: () => performance.now(),
}

export type SchedulerDeps = {
  readonly model: ReviewModel
  readonly live: LiveTexts
  readonly runner: DiffRunner
  readonly readBlob: (ledgerDir: string, ref: Ref) => Promise<string>
  readonly maxDiffBytes: () => number
  readonly perf: Perf
  readonly log: Log
  readonly timers: Timers
  /** How many diffs run at once: the worker pool's size. */
  readonly concurrency: number
}

type PathState = {
  /** Bumped by every request: a result for an older generation is stale. */
  generation: number
  reason: DiffReason
  debounce: TimerHandle | undefined
  debounceStartedAt: number
  isQueued: boolean
  running: Promise<void> | undefined
  waiters: (() => void)[]
}

export class DiffScheduler {
  private readonly paths = new Map<string, PathState>()
  private readonly queue: string[] = []
  private running = 0
  private isDisposed = false

  constructor(private readonly deps: SchedulerDeps) {}

  request(path: string, reason: DiffReason): void {
    if (this.isDisposed) return
    this.deps.perf.diffsRequested++
    const s = this.stateOf(path)
    s.generation++
    if (reason === 'typing' && !s.isQueued) {
      this.debounce(path, s)
      return
    }
    this.cancelDebounce(s)
    if (!s.isQueued || PRIORITY[reason] < PRIORITY[s.reason]) s.reason = reason
    this.enqueue(path, s)
  }

  /** Flushes these paths' debounces and resolves once their diffs have been applied. */
  async settle(paths: readonly string[]): Promise<void> {
    await Promise.all(
      paths.map(path => {
        const s = this.paths.get(path)
        if (!s) return Promise.resolve()
        if (s.debounce !== undefined) {
          this.cancelDebounce(s)
          this.enqueue(path, s)
        }
        return this.idle(path, s)
      }),
    )
  }

  dispose(): void {
    this.isDisposed = true
    for (const s of this.paths.values()) this.cancelDebounce(s)
  }

  private stateOf(path: string): PathState {
    let s = this.paths.get(path)
    if (!s) {
      s = { generation: 0, reason: 'startup', debounce: undefined, debounceStartedAt: 0, isQueued: false, running: undefined, waiters: [] }
      this.paths.set(path, s)
    }
    return s
  }

  private debounce(path: string, s: PathState): void {
    const { timers } = this.deps
    const now = timers.now()
    if (s.debounce === undefined) s.debounceStartedAt = now
    else s.debounce.cancel()
    const wait = Math.min(TYPING_QUIET_MS, Math.max(0, s.debounceStartedAt + TYPING_MAX_WAIT_MS - now))
    s.reason = 'typing'
    s.debounce = timers.after(wait, () => {
      s.debounce = undefined
      this.enqueue(path, s)
    })
  }

  private cancelDebounce(s: PathState): void {
    s.debounce?.cancel()
    s.debounce = undefined
  }

  private enqueue(path: string, s: PathState): void {
    if (!s.isQueued) {
      s.isQueued = true
      this.queue.push(path)
    }
    this.pump()
  }

  private pump(): void {
    while (this.running < this.deps.concurrency && this.queue.length > 0) {
      const path = this.takeNext()
      if (path === undefined) return
      const s = this.stateOf(path)
      s.isQueued = false
      this.running++
      const job = this.run(path, s.reason, s.generation)
        .catch((err: unknown) => this.deps.log.error(`diffing ${path}`, err))
        .finally(() => {
          this.running--
          s.running = undefined
          if (!s.isQueued && s.debounce === undefined) for (const w of s.waiters.splice(0)) w()
          this.pump()
        })
      s.running = job
    }
  }

  private takeNext(): string | undefined {
    let best = -1
    let bestPriority = Infinity
    for (let i = 0; i < this.queue.length; i++) {
      const p = this.queue[i]
      // One job per path at a time: a path whose diff is running waits in the queue for it.
      const s = p === undefined ? undefined : this.stateOf(p)
      const priority = s === undefined || s.running ? Infinity : PRIORITY[s.reason]
      if (priority < bestPriority) {
        best = i
        bestPriority = priority
      }
    }
    return best < 0 ? undefined : this.queue.splice(best, 1)[0]
  }

  private idle(path: string, s: PathState): Promise<void> {
    if (!s.isQueued && !s.running && s.debounce === undefined) return Promise.resolve()
    return new Promise(resolve => s.waiters.push(resolve))
  }

  private isStale(path: string, generation: number): boolean {
    const s = this.paths.get(path)
    return s !== undefined && s.generation !== generation && (s.isQueued || s.debounce !== undefined)
  }

  private async run(path: string, reason: DiffReason, generation: number): Promise<void> {
    const { model, live, runner, readBlob, maxDiffBytes, perf } = this.deps
    const state = model.get(path)
    if (!state) return
    const { baseVersion, ledgerDir, record } = state
    const probe = await live.probe(path)
    if (probe.size > maxDiffBytes()) {
      model.applyDiff(path, { kind: 'tooLarge', baseVersion, bytes: probe.size })
      return
    }
    const d = state.diff
    if (SKIPPABLE.has(reason) && (d.kind === 'ready' || d.kind === 'clean') && d.baseVersion === baseVersion && d.liveVersion === probe.version) {
      perf.diffsSkipped++
      return
    }
    let base: string
    try {
      base = record.base === null ? '' : forDiff(await readBlob(ledgerDir, record.base))
    } catch (err) {
      if (err instanceof BlobTooLargeError) model.applyDiff(path, { kind: 'tooLarge', baseVersion, bytes: err.bytes })
      else model.applyDiff(path, { kind: 'error', baseVersion, message: `the baseline could not be read: ${err instanceof Error ? err.message : String(err)}` })
      return
    }
    const liveText = forDiff((await probe.read()) ?? '')
    const started = this.deps.timers.now()
    let output
    try {
      output = await runner.diff({ baseKey: record.base === null ? `${ledgerDir}|empty` : `${ledgerDir}|${record.base}`, base: () => base, live: liveText })
    } catch (err) {
      if (!this.isStale(path, generation)) model.applyDiff(path, { kind: 'error', baseVersion, message: err instanceof Error ? err.message : String(err) })
      return
    }
    const ms = this.deps.timers.now() - started
    perf.diffsComputed++
    perf.workerMsTotal += ms
    if (ms > perf.workerMsMax) perf.workerMsMax = ms
    if (this.isStale(path, generation)) return
    model.applyDiff(path, { kind: 'diff', baseVersion, liveVersion: probe.version, ...output })
  }
}
