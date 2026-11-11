// What each keep/undo does to a file (§7.6), as pure plans: the new base, the
// live text or exact line edits, and the events. The extension's ActionQueue
// and the mod's terminal actions both carry them out, so they agree. The
// extension plans on texts as the editor holds them (no BOM) and a base blob's
// BOM is put back when it is kept; the mod plans on raw texts.

import type { FileRecord } from './events'
import type { TurnKey } from './ids'
import { splitLines } from './lines'
import { keepTurnsText, undoTurnsText, type TurnTexts } from './model'
import { keepHunk, undoHunk } from './patch'
import type { HunkView } from './view'

/** Lines [start, end) of the text before any edit, replaced by `text`. */
export type LineEdit = { readonly start: number; readonly end: number; readonly text: string }

/** `text` with line ranges replaced; ranges refer to the text before any of them, and never overlap. */
export const applyLineEdits = (text: string, edits: readonly LineEdit[]): string => {
  const lines = splitLines(text)
  for (const e of [...edits].sort((a, b) => b.start - a.start)) lines.splice(e.start, e.end - e.start, ...splitLines(e.text))
  return lines.join('')
}

export type FileInput = {
  readonly path: string
  readonly ledgerDir: string
  readonly record: FileRecord
  /** The base blob's text with its BOM, null for no file. */
  readonly rawBase: string | null
  /** As the editor holds them. */
  readonly base: string | null
  readonly live: string | null
  readonly hunks: readonly HunkView[]
}

export type LivePlan = { readonly kind: 'lines'; readonly edits: readonly LineEdit[] } | { readonly kind: 'text'; readonly text: string | null }

export type FilePlan = {
  readonly path: string
  readonly ledgerDir: string
  /** A new base to record with `keep` (undefined: none). */
  readonly keep?: string | null
  readonly live?: LivePlan
  readonly resolves: readonly (TurnKey | null)[]
  readonly settle: boolean
}

const BOM = '﻿'
const withBomOf = (rawBase: string | null, text: string | null): string | null =>
  text !== null && rawBase !== null && rawBase.startsWith(BOM) && !text.startsWith(BOM) ? BOM + text : text

const removedText = (h: HunkView): string =>
  h.hunk.lines
    .filter(l => l.op !== '+')
    .map(l => l.text)
    .join('')

export const planKeepHunk = (f: FileInput, h: HunkView): FilePlan => {
  const next = keepHunk(f.base ?? '', h.hunk)
  const text = f.base === null && next === '' && f.live === null ? null : next
  return { path: f.path, ledgerDir: f.ledgerDir, keep: withBomOf(f.rawBase, text), resolves: [], settle: text === f.live }
}

export const planUndoHunk = (f: FileInput, h: HunkView): FilePlan => {
  const next = undoHunk(f.live ?? '', h.hunk)
  if (f.base === null && next === '') return { path: f.path, ledgerDir: f.ledgerDir, live: { kind: 'text', text: null }, resolves: [], settle: true }
  const edit: LineEdit = { start: h.hunk.newIdx, end: h.hunk.newIdx + h.hunk.newLen, text: removedText(h) }
  return { path: f.path, ledgerDir: f.ledgerDir, live: { kind: 'lines', edits: [edit] }, resolves: [], settle: next === f.base }
}

/** VS Code's diff gutter hands over the whole original with that change applied. */
export const planKeepMapping = (f: FileInput, originalWithModifiedChanges: string): FilePlan => ({
  path: f.path,
  ledgerDir: f.ledgerDir,
  keep: withBomOf(f.rawBase, originalWithModifiedChanges),
  resolves: [],
  settle: originalWithModifiedChanges === f.live,
})

export type LineRange = { readonly start: number; readonly end: number }

export const planUndoMapping = (f: FileInput, original: LineRange, modified: LineRange, baseLines: readonly string[], liveLines: readonly string[]): FilePlan => {
  const text = baseLines.slice(original.start, original.end).join('')
  const next = [...liveLines.slice(0, modified.start), text, ...liveLines.slice(modified.end)].join('')
  return { path: f.path, ledgerDir: f.ledgerDir, live: { kind: 'lines', edits: [{ start: modified.start, end: modified.end, text }] }, resolves: [], settle: next === (f.base ?? '') }
}

export const planKeepFile = (f: FileInput): FilePlan => ({ path: f.path, ledgerDir: f.ledgerDir, resolves: [], settle: true })

export const planUndoFile = (f: FileInput): FilePlan => ({ path: f.path, ledgerDir: f.ledgerDir, live: { kind: 'text', text: f.base }, resolves: [null], settle: true })

export type TurnPlans = { readonly plans: readonly FilePlan[]; readonly conflicts: readonly string[] }

/** One file's open entries of these turns, oldest first, with their texts. */
export type TurnFileInput = FileInput & { readonly pairs: readonly (TurnTexts & { readonly turn: TurnKey })[] }

/** keepTurn and keepSession: each file's pending parts of those turns fold into its base, oldest first. */
export const planKeepTurns = (files: readonly TurnFileInput[]): TurnPlans => {
  const plans: FilePlan[] = []
  const conflicts: string[] = []
  for (const f of files) {
    const res = keepTurnsText(f.base, f.live, f.pairs)
    if (!res.ok) {
      conflicts.push(f.path)
      continue
    }
    plans.push({ path: f.path, ledgerDir: f.ledgerDir, keep: withBomOf(f.rawBase, res.text), resolves: f.pairs.map(p => p.turn), settle: res.text === f.live })
  }
  return { plans, conflicts }
}

/** undoTurn and undoSession: each file's pending parts of those turns come out of its live text, newest first. */
export const planUndoTurns = (files: readonly TurnFileInput[]): TurnPlans => {
  const plans: FilePlan[] = []
  const conflicts: string[] = []
  for (const f of files) {
    const res = undoTurnsText(f.base, f.live, f.pairs)
    if (!res.ok) {
      conflicts.push(f.path)
      continue
    }
    plans.push({ path: f.path, ledgerDir: f.ledgerDir, live: { kind: 'text', text: res.text }, resolves: f.pairs.map(p => p.turn), settle: res.text === f.base })
  }
  return { plans, conflicts }
}

export const planKeepAll = (files: readonly FileInput[]): FilePlan[] => files.map(planKeepFile)
export const planUndoAll = (files: readonly FileInput[]): FilePlan[] => files.map(planUndoFile)
