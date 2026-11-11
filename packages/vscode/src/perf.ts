// The perf counters (§7.9): exposed as `api.perf` and printed by showStats.

import type { Log } from './log'

export type Perf = {
  diffsRequested: number
  diffsComputed: number
  diffsSkipped: number
  workerMsTotal: number
  workerMsMax: number
  baseDocsProvided: number
  baseDocChangeEvents: number
  treeFullRefreshes: number
  treeItemRefreshes: number
  decorationPaints: number
  lensRefreshes: number
  ledgerScans: number
  batchesFolded: number
  handlerMsMax: number
}

export const newPerf = (): Perf => ({
  diffsRequested: 0,
  diffsComputed: 0,
  diffsSkipped: 0,
  workerMsTotal: 0,
  workerMsMax: 0,
  baseDocsProvided: 0,
  baseDocChangeEvents: 0,
  treeFullRefreshes: 0,
  treeItemRefreshes: 0,
  decorationPaints: 0,
  lensRefreshes: 0,
  ledgerScans: 0,
  batchesFolded: 0,
  handlerMsMax: 0,
})

/** Wraps a VS Code event handler or command: its time feeds `handlerMsMax`, and a throw is logged, not lost. */
export const timed =
  <A extends unknown[], R>(perf: Perf, log: Log, label: string, fn: (...args: A) => R) =>
  (...args: A): R | undefined => {
    const start = performance.now()
    try {
      return fn(...args)
    } catch (err) {
      log.error(label, err)
      return undefined
    } finally {
      const ms = performance.now() - start
      if (ms > perf.handlerMsMax) perf.handlerMsMax = ms
    }
  }
