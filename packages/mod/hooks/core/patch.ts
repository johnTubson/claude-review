// Generated from packages/core/src/patch.ts by scripts/sync-core.mjs: edit the original, then run `npm run sync-core`.

// Applying hunks to texts that may have moved on since they were diffed.

import type { Hunk } from './diff'
import { splitLines } from './lines'

export type PatchResult = { readonly ok: true; readonly text: string } | { readonly ok: false }

const replaceAt = (lines: readonly string[], idx: number, len: number, repl: readonly string[]): string =>
  [...lines.slice(0, idx), ...repl, ...lines.slice(idx + len)].join('')

/** `base` with hunk `h` (from diffHunks(base, ·)) applied: the change becomes part of the baseline. */
export const keepHunk = (base: string, h: Hunk): string =>
  replaceAt(
    splitLines(base),
    h.oldIdx,
    h.oldLen,
    h.lines.filter(l => l.op !== '-').map(l => l.text),
  )

/** `current` with hunk `h` (from diffHunks(·, current)) taken back out. */
export const undoHunk = (current: string, h: Hunk): string =>
  replaceAt(
    splitLines(current),
    h.newIdx,
    h.newLen,
    h.lines.filter(l => l.op !== '+').map(l => l.text),
  )

const matchesAt = (lines: readonly string[], at: number, block: readonly string[]): boolean =>
  block.every((line, i) => lines[at + i] === line)

/**
 * Applies hunks (forward: before → after; reverse: after → before) to a text
 * that may have moved on since, finding each hunk's lines nearest where they
 * were. Fails when any hunk's lines are no longer there.
 */
export const patch = (text: string, hunks: readonly Hunk[], direction: 'forward' | 'reverse'): PatchResult => {
  const isForward = direction === 'forward'
  let lines = splitLines(text)
  let delta = 0
  let lastEnd = 0

  for (const h of hunks) {
    const find = h.lines.filter(l => l.op !== (isForward ? '+' : '-')).map(l => l.text)
    const repl = h.lines.filter(l => l.op !== (isForward ? '-' : '+')).map(l => l.text)
    const expected = (isForward ? h.oldIdx : h.newIdx) + delta
    const last = lines.length - find.length
    let found = -1
    for (let dist = 0; found < 0 && dist <= lines.length; dist++) {
      for (const at of [expected + dist, expected - dist]) {
        if (at >= lastEnd && at <= last && matchesAt(lines, at, find)) {
          found = at
          break
        }
      }
    }
    if (found < 0) return { ok: false }
    lines = splitLines(replaceAt(lines, found, find.length, repl))
    delta += found - expected + repl.length - find.length
    lastEnd = found + repl.length
  }

  return { ok: true, text: lines.join('') }
}
