// Generated from packages/core/src/model.ts by scripts/sync-core.mjs: edit the original, then run `npm run sync-core`.

// Keep/undo over texts: pure, no I/O.
// A null text is a file that does not exist; diffs read it as ''.

import { diffHunks, type Hunk } from './diff'
import { patch } from './patch'

export type TextResult = { readonly ok: true; readonly text: string | null } | { readonly ok: false }

/**
 * Where one part (hunk) of a turn's change stands: `kept` when the baseline
 * holds it, `pending` while the live text holds it, `undone` once the live
 * text is back to before it, `edited` when the live text has neither.
 */
export type Standing = 'kept' | 'pending' | 'undone' | 'edited'

export const standingOf = (h: Hunk, base: string | null, current: string | null): Standing =>
  patch(base ?? '', [h], 'reverse').ok
    ? 'kept'
    : patch(current ?? '', [h], 'reverse').ok
      ? 'pending'
      : patch(current ?? '', [h], 'forward').ok
        ? 'undone'
        : 'edited'

/**
 * The baseline with the pending parts of one turn's change folded in; parts
 * already kept, undone or edited since are left as they stand. Fails when an
 * earlier turn's change to the same lines is still pending.
 */
export const keepTurnText = (base: string | null, current: string | null, before: string | null, after: string | null): TextResult => {
  if (base === before && current === after) return { ok: true, text: after }
  let text = base ?? ''
  for (const h of diffHunks(before ?? '', after ?? '')) {
    if (standingOf(h, base, current) !== 'pending') continue
    const res = patch(text, [h], 'forward')
    if (!res.ok) return { ok: false }
    text = res.text
  }
  return { ok: true, text: base === null && text === '' ? null : text }
}

/**
 * The live text with the pending parts of one turn's change taken back out;
 * kept and undone parts stay. Fails when a part was edited since.
 */
export const undoTurnText = (base: string | null, current: string | null, before: string | null, after: string | null): TextResult => {
  if (base === before && current === after) return { ok: true, text: before }
  let text = current ?? ''
  for (const h of diffHunks(before ?? '', after ?? '')) {
    const standing = standingOf(h, base, current)
    if (standing === 'edited') return { ok: false }
    if (standing !== 'pending') continue
    const res = patch(text, [h], 'reverse')
    if (!res.ok) return { ok: false }
    text = res.text
  }
  return { ok: true, text: base === null && before === null && text === '' ? null : text }
}

export type TurnTexts = { readonly before: string | null; readonly after: string | null }

/** Keeps several turns' changes (oldest first), each on the base the previous one left. Fails on the first conflict. */
export const keepTurnsText = (base: string | null, current: string | null, pairs: readonly TurnTexts[]): TextResult => {
  let text = base
  for (const p of pairs) {
    const res = keepTurnText(text, current, p.before, p.after)
    if (!res.ok) return res
    text = res.text
  }
  return { ok: true, text }
}

/** Undoes several turns' changes (given oldest first, undone newest first), each on the text the next one left. */
export const undoTurnsText = (base: string | null, current: string | null, pairs: readonly TurnTexts[]): TextResult => {
  let text = current
  for (let i = pairs.length - 1; i >= 0; i--) {
    const p = pairs[i]
    if (p === undefined) continue
    const res = undoTurnText(base, text, p.before, p.after)
    if (!res.ok) return res
    text = res.text
  }
  return { ok: true, text }
}
