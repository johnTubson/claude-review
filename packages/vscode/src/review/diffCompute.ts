// The diff the worker runs, also used inline when no worker can start.

import { countChanges, diffLines } from '@core/diff'
import { splitLines } from '@core/lines'
import { layoutSignature, viewHunks } from '@core/view'

import type { DiffOutput } from './protocol'

export const computeDiff = (baseLines: readonly string[], live: string): DiffOutput => {
  const liveLines = splitLines(live)
  const hunks = viewHunks(diffLines(baseLines, liveLines))
  const { added, removed } = countChanges(hunks.map(h => h.hunk))
  // An empty text and one ending in '\n' both end on an empty line the editor shows.
  const lineCount = live.length === 0 || live.endsWith('\n') ? liveLines.length + 1 : liveLines.length
  return { hunks, added, removed, lineCount, layout: layoutSignature(hunks) }
}
