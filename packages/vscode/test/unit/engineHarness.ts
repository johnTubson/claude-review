// The engine (model, scheduler, actions) on a real ledger in a temp dir, with
// the editor, the disk and the clock faked.

import type { LedgerEvent } from '@core/events'
import { toSessionId, type BatchId } from '@core/ids'
import { splitLines } from '@core/lines'

import { Blobs } from '../../src/ledger/blobs'
import { LedgerStore } from '../../src/ledger/store'
import { computeDiff } from '../../src/review/diffCompute'
import type { DiffJob, DiffRunner } from '../../src/review/diffPool'
import type { LiveEdit, LiveTexts, LiveWriter } from '../../src/review/live'
import { ReviewModel, type DiffReason } from '../../src/review/model'
import { ActionQueue } from '../../src/review/actions'
import { DiffScheduler, type TimerHandle, type Timers } from '../../src/review/scheduler'
import type { DiffOutput } from '../../src/review/protocol'
import { perf, tempDir, testLog } from './support'

export class FakeTimers implements Timers {
  private time = 0
  private queue: { at: number; fn: () => void; isCancelled: boolean }[] = []

  now = (): number => this.time

  after = (ms: number, fn: () => void): TimerHandle => {
    const t = { at: this.time + ms, fn, isCancelled: false }
    this.queue.push(t)
    return { cancel: () => void (t.isCancelled = true) }
  }

  /** Moves time on, firing timers due on the way, then lets promises settle. */
  async advance(ms: number): Promise<void> {
    const end = this.time + ms
    for (;;) {
      const due = this.queue.filter(t => !t.isCancelled && t.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      this.time = due.at
      due.isCancelled = true
      due.fn()
      await flush()
    }
    this.time = end
    this.queue = this.queue.filter(t => !t.isCancelled)
    await flush()
  }
}

export const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r))
}

type FakeFile = { text: string | null; version: number; isOpen: boolean }

export class FakeLive implements LiveTexts, LiveWriter {
  readonly files = new Map<string, FakeFile>()
  readonly reads: string[] = []
  readonly applied: LiveEdit[][] = []
  /** Reported sizes that override the text's, for size limits. */
  readonly sizes = new Map<string, number>()

  set(path: string, text: string | null, isOpen = false): void {
    const f = this.files.get(path)
    this.files.set(path, { text, version: (f?.version ?? 0) + 1, isOpen: f?.isOpen ?? isOpen })
  }

  text(path: string): string | null {
    return this.files.get(path)?.text ?? null
  }

  probe = async (path: string): Promise<{ version: string; size: number; read: () => Promise<string | null> }> => {
    const f = this.files.get(path)
    const text = f?.text ?? null
    return {
      version: text === null ? 'missing' : `${f?.isOpen ? 'd' : 'f'}${f?.version ?? 0}`,
      size: this.sizes.get(path) ?? text?.length ?? 0,
      read: async () => {
        this.reads.push(path)
        return text
      },
    }
  }

  apply = async (edits: readonly LiveEdit[]): Promise<void> => {
    this.applied.push([...edits])
    for (const e of edits) {
      switch (e.kind) {
        case 'delete':
          this.set(e.path, null)
          break
        case 'create':
          this.set(e.path, e.text)
          break
        case 'lines': {
          const lines = splitLines(this.text(e.path) ?? '')
          for (const l of [...e.edits].sort((a, b) => b.start - a.start)) lines.splice(l.start, l.end - l.start, ...splitLines(l.text))
          this.set(e.path, lines.join(''))
          break
        }
        default: {
          const unhandled: never = e
          throw new Error(String(unhandled))
        }
      }
    }
  }
}

/** Diffs inline, optionally held until released, counting runs. */
export class FakeRunner implements DiffRunner {
  runs = 0
  private gate: Promise<void> | undefined
  private open: (() => void) | undefined

  hold(): void {
    this.gate = new Promise(r => (this.open = r))
  }

  release(): void {
    this.open?.()
    this.gate = undefined
  }

  diff = async (job: DiffJob): Promise<DiffOutput> => {
    this.runs++
    if (this.gate) await this.gate
    return computeDiff(splitLines(job.base()), job.live)
  }

  dispose(): void {}
}

export type Harness = Awaited<ReturnType<typeof harness>>

const disposables: { dispose(): void }[] = []
/** Stores watch their folder: the test process only exits once they are disposed. */
export const disposeHarnesses = (): void => {
  for (const d of disposables.splice(0)) d.dispose()
}

export const harness = async (options: { readonly maxDiffBytes?: number } = {}) => {
  const dir = `${tempDir('cr-eng-')}/ledger`
  const log = testLog()
  const p = perf()
  const store = new LedgerStore(dir, log, p)
  await store.start()
  const blobs = new Blobs(64 * 1024 * 1024, () => options.maxDiffBytes ?? 4 * 1024 * 1024)
  const live = new FakeLive()
  const runner = new FakeRunner()
  const timers = new FakeTimers()
  const requested: { path: string; reason: DiffReason }[] = []
  let scheduler: DiffScheduler | undefined
  const model = new ReviewModel(
    (path, reason) => {
      requested.push({ path, reason })
      scheduler?.request(path, reason)
    },
    m => log.warn(m),
  )
  scheduler = new DiffScheduler({
    model,
    live,
    runner,
    readBlob: (d, r) => blobs.get(d, r),
    maxDiffBytes: () => options.maxDiffBytes ?? 4 * 1024 * 1024,
    perf: p,
    log,
    timers,
    concurrency: 1,
  })
  const actionPaths = new Set<string>()
  const actions = new ActionQueue({ model, scheduler, store: d => (d === dir ? store : undefined), blobs, live, writer: live, runner, log, markActionPaths: ps => ps.forEach(x => actionPaths.add(x)) })
  disposables.push(store, scheduler, model)
  store.onChange(c => model.applyLedger(c.dir, c.current))
  model.addLedger(dir, '/w', store.ledger)

  /** Records an edit the way the mod does: blobs, then a batch. */
  const edit = async (path: string, before: string | null, after: string | null, turn = 't1', session = 's1'): Promise<BatchId> => {
    const b = before === null ? null : await blobs.put(dir, before)
    const a = after === null ? null : await blobs.put(dir, after)
    const events: LedgerEvent[] = [{ kind: 'edit', session: toSessionId(session), turn, path, before: b, after: a, tool: 'Edit' }]
    // As the mod: the file changes before its batch lands.
    live.set(path, after)
    const batch = await store.append(events)
    return batch.id
  }
  const settled = async (): Promise<void> => {
    await flush()
    await scheduler?.settle(model.trackedPaths())
    await flush()
  }
  return { dir, log, perf: p, store, blobs, live, runner, timers, model, scheduler, actions, requested, actionPaths, edit, settled }
}
