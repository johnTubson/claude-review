// Hunks as the editor shows them.

import type { Hunk } from './diff'

export type RemovedBlock = { readonly line: number; readonly text: readonly string[] }

/** One hunk as the editor shows it: the lines added, and the removed blocks anchored where they were. */
export type HunkView = {
  readonly index: number
  readonly hunk: Hunk
  /** 0-based lines of the live text the hunk spans, context excluded. */
  readonly startLine: number
  readonly endLine: number
  readonly added: readonly number[]
  readonly removed: readonly RemovedBlock[]
  /** Identifies the hunk's content, so an action can find it again after the text moves. */
  readonly sig: string
}

const withoutNewline = (text: string): string => (text.endsWith('\n') ? text.slice(0, -1) : text)

/** FNV-1a (32-bit) over the hunk's ops and lines. */
export const hunkSig = (h: Hunk): string => {
  let hash = 0x811c9dc5
  for (const l of h.lines) {
    const s = l.op + l.text
    for (let i = 0; i < s.length; i++) {
      hash ^= s.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193)
    }
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** Where in the live text each hunk's changed lines sit, and what it removed. */
export const viewHunks = (hunks: readonly Hunk[]): HunkView[] =>
  hunks.map((hunk, index) => {
    let line = hunk.newIdx
    const added: number[] = []
    const removed: { line: number; text: string[] }[] = []
    let start = -1
    let end = -1
    for (const l of hunk.lines) {
      if (l.op === ' ') {
        line++
        continue
      }
      if (start < 0) start = line
      if (l.op === '+') {
        added.push(line)
        end = line
        line++
      } else {
        const last = removed[removed.length - 1]
        if (last && last.line === line) last.text.push(withoutNewline(l.text))
        else removed.push({ line, text: [withoutNewline(l.text)] })
        end = Math.max(end, line)
      }
    }
    return { index, hunk, startLine: Math.max(0, start), endLine: Math.max(start, end), added, removed, sig: hunkSig(hunk) }
  })

/**
 * Hunk positions only: added lines as runs, removed blocks as anchor and
 * length. Equal signatures mean nothing a decoration draws has moved.
 */
export const layoutSignature = (views: readonly HunkView[]): string => {
  const parts: string[] = []
  for (const v of views) {
    let runs = ''
    let runStart = -1
    let prev = -2
    for (const line of v.added) {
      if (line !== prev + 1) {
        if (runStart >= 0) runs += `${runStart}+${prev - runStart + 1},`
        runStart = line
      }
      prev = line
    }
    if (runStart >= 0) runs += `${runStart}+${prev - runStart + 1},`
    const removed = v.removed.map(r => `${r.line}-${r.text.length}`).join(',')
    parts.push(`${v.startLine}:${v.endLine}|${runs}|${removed}`)
  }
  return parts.join(';')
}

/**
 * The hunk covering 0-based `line`, by binary search: this runs on every
 * cursor move. Hunks are in file order and never overlap.
 */
export const hunkAtLine = (hunks: readonly HunkView[], line: number, lineCount: number): HunkView | undefined => {
  let lo = 0
  let hi = hunks.length - 1
  let candidate: HunkView | undefined
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const h = hunks[mid]
    if (h === undefined) break
    if (h.startLine <= line) {
      candidate = h
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  if (candidate && line <= candidate.endLine) return candidate
  // A removal at the very end anchors past the last line.
  const last = hunks[hunks.length - 1]
  if (last && last.added.length === 0 && line === last.startLine - 1 && last.startLine >= lineCount) return last
  return undefined
}

/** The hunk a toolbar acts on: the one at the cursor, else the next one below it, else the last. */
export const focusedHunk = (hunks: readonly HunkView[], line: number, lineCount: number): HunkView | undefined =>
  hunkAtLine(hunks, line, lineCount) ?? hunks.find(h => h.startLine > line) ?? hunks[hunks.length - 1]

/** The hunk with signature `sig` nearest `start`: how an action re-finds its target after the text moved. */
export const hunkBySig = (hunks: readonly HunkView[], sig: string, start: number): HunkView | undefined => {
  let best: HunkView | undefined
  for (const h of hunks) {
    if (h.sig !== sig) continue
    if (!best || Math.abs(h.startLine - start) < Math.abs(best.startLine - start)) best = h
  }
  return best
}
