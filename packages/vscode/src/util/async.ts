/** `fn` over `items` with at most `limit` running at once; results in input order. */
export const mapLimit = async <T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> => {
  const out: R[] = []
  const jobs = items.map((item, index) => ({ item, index }))
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (let job = jobs[cursor++]; job !== undefined; job = jobs[cursor++]) out[job.index] = await fn(job.item)
  }
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker))
  return out
}

/**
 * Runs `task` one at a time: a call while it runs queues one more run, and
 * every call made meanwhile shares that one.
 */
export class Coalescer {
  private running: Promise<void> | undefined
  private queued: Promise<void> | undefined

  constructor(private readonly task: () => Promise<void>) {}

  run(): Promise<void> {
    if (!this.running) {
      this.running = this.task().finally(() => {
        this.running = undefined
      })
      return this.running
    }
    this.queued ??= this.running.then(() => {
      this.queued = undefined
      return this.run()
    })
    return this.queued
  }
}
