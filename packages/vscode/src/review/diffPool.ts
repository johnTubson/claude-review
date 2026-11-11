// The extension host's side of the diff worker(s). One worker, two when more
// than 8 jobs wait; a crashed worker fails its jobs and is restarted on the
// next one. No diff runs on the host thread, except tiny ones while no worker
// can start at all.

import { Worker } from 'node:worker_threads'

import { splitLines } from '@core/lines'

import type { Log } from '../log'
import { computeDiff } from './diffCompute'
import { responseSchema, type DiffOutput, type DiffRequest } from './protocol'

export type DiffJob = { readonly baseKey: string; readonly base: () => string; readonly live: string }

/** What the scheduler runs diffs on: a worker pool, or a fake in tests. */
export type DiffRunner = {
  diff(job: DiffJob): Promise<DiffOutput>
  dispose(): void
}

export class DiffFailedError extends Error {
  override readonly name = 'DiffFailedError'
}

/** Past this many characters, no diff runs on the host thread even when no worker starts. */
const INLINE_LIMIT = 16 * 1024
const GROW_AT_QUEUED = 8
const MAX_WORKERS = 2

type Pending = { readonly job: DiffJob; readonly resolve: (out: DiffOutput) => void; readonly reject: (err: Error) => void; hasSentBase: boolean }

type Slot = { readonly worker: Worker; readonly inFlight: Map<number, Pending> }

export class WorkerPool implements DiffRunner {
  private readonly slots: Slot[] = []
  private nextId = 0
  private queued = 0
  private canStart = true

  constructor(
    private readonly workerFile: string,
    private readonly log: Log,
  ) {}

  diff(job: DiffJob): Promise<DiffOutput> {
    const slot = this.slot()
    if (!slot) return this.inline(job)
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const pending: Pending = { job, resolve, reject, hasSentBase: false }
      slot.inFlight.set(id, pending)
      this.queued++
      this.send(slot, id, pending, false)
    })
  }

  dispose(): void {
    for (const slot of this.slots.splice(0)) {
      this.failAll(slot, new DiffFailedError('the diff worker stopped'))
      void slot.worker.terminate()
    }
  }

  private inline(job: DiffJob): Promise<DiffOutput> {
    const base = job.base()
    if (base.length + job.live.length > INLINE_LIMIT) return Promise.reject(new DiffFailedError('the diff worker could not start'))
    return Promise.resolve(computeDiff(splitLines(base), job.live))
  }

  private send(slot: Slot, id: number, pending: Pending, withBase: boolean): void {
    pending.hasSentBase ||= withBase
    const request: DiffRequest = withBase
      ? { t: 'diff', id, baseKey: pending.job.baseKey, base: pending.job.base(), live: pending.job.live }
      : { t: 'diff', id, baseKey: pending.job.baseKey, live: pending.job.live }
    slot.worker.postMessage(request)
  }

  /** The least busy worker, starting one when there is none or the queue is long. */
  private slot(): Slot | undefined {
    const idle = [...this.slots].sort((a, b) => a.inFlight.size - b.inFlight.size)[0]
    const shouldGrow = this.slots.length === 0 || (this.queued > GROW_AT_QUEUED && this.slots.length < MAX_WORKERS)
    if (shouldGrow && this.canStart) {
      const started = this.start()
      if (started) return started
    }
    return idle
  }

  private start(): Slot | undefined {
    let worker: Worker
    try {
      worker = new Worker(this.workerFile)
    } catch (err) {
      this.canStart = false
      this.log.error('starting the diff worker', err)
      return undefined
    }
    const slot: Slot = { worker, inFlight: new Map() }
    worker.on('message', (raw: unknown) => this.receive(slot, raw))
    worker.on('error', err => {
      this.log.error('the diff worker', err)
      this.drop(slot)
    })
    worker.on('exit', code => {
      if (code !== 0) this.log.warn(`the diff worker exited with ${code}; it restarts on the next diff`)
      this.drop(slot)
    })
    worker.unref()
    this.slots.push(slot)
    return slot
  }

  private receive(slot: Slot, raw: unknown): void {
    const parsed = responseSchema.safeParse(raw)
    if (!parsed.success) {
      this.log.warn('the diff worker sent a message that is not a diff response')
      return
    }
    const message = parsed.data
    const pending = slot.inFlight.get(message.id)
    if (!pending) return
    switch (message.t) {
      case 'needBase':
        if (pending.hasSentBase) {
          this.finish(slot, message.id)
          pending.reject(new DiffFailedError('the diff worker lost the base it was sent'))
        } else {
          this.send(slot, message.id, pending, true)
        }
        return
      case 'err':
        this.finish(slot, message.id)
        pending.reject(new DiffFailedError(message.message))
        return
      case 'ok': {
        this.finish(slot, message.id)
        const { t: _t, id: _id, ...output } = message
        pending.resolve(output)
        return
      }
      default: {
        const unhandled: never = message
        throw new Error(`unknown diff response ${JSON.stringify(unhandled)}`)
      }
    }
  }

  private finish(slot: Slot, id: number): void {
    if (slot.inFlight.delete(id)) this.queued--
  }

  private drop(slot: Slot): void {
    const i = this.slots.indexOf(slot)
    if (i < 0) return
    this.slots.splice(i, 1)
    this.failAll(slot, new DiffFailedError('the diff worker crashed'))
  }

  private failAll(slot: Slot, err: Error): void {
    for (const [id, pending] of slot.inFlight) {
      this.finish(slot, id)
      pending.reject(err)
    }
  }
}
