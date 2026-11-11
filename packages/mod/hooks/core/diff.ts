// Generated from packages/core/src/diff.ts by scripts/sync-core.mjs: edit the original, then run `npm run sync-core`.

// Line diff v2: greedy Myers over interned line ids, deterministic, shared by
// the mod and the extension. A "line" keeps its own '\n' (see lines.ts).

import { LineInterner, splitLines } from './lines'

export type Op = ' ' | '-' | '+'
export type Line = { readonly op: Op; readonly text: string }
/** `oldIdx`/`newIdx` are 0-based line offsets where the hunk starts. */
export type Hunk = { readonly oldIdx: number; readonly oldLen: number; readonly newIdx: number; readonly newLen: number; readonly lines: readonly Line[] }

export const OP_KEEP = 0
export const OP_DELETE = 1
export const OP_INSERT = 2

export const DEFAULT_CONTEXT = 3
export const DEFAULT_MAX_EDITS = 2000
/** Myers costs about (n+m)·D int steps: past this, the edit bound drops. */
const WORK_BUDGET = 5e7
const MIN_MAX_EDITS = 64

export type DiffOptions = { readonly context?: number; readonly maxEdits?: number }

/** A text split and interned, so a caller (the extension's worker) can keep a base prepared across diffs. */
export type PreparedText = { readonly lines: readonly string[]; readonly ids: Int32Array }

export const prepareText = (text: string, interner: LineInterner): PreparedText => {
  const lines = splitLines(text)
  return { lines, ids: interner.idsOf(lines) }
}

const backtrack = (trace: readonly Int32Array[], n: number, m: number): Uint8Array => {
  const d0 = trace.length - 1
  const ops = new Uint8Array((n + m + d0) / 2)
  let pos = ops.length
  let x = n
  let y = m
  for (let d = d0; d >= 0; d--) {
    const tr = trace[d]
    if (tr === undefined) break
    const at = (k: number): number => tr[k + d + 1] ?? 0
    const k = x - y
    const isDown = k === -d || (k !== d && at(k - 1) < at(k + 1))
    const prevK = isDown ? k + 1 : k - 1
    const prevX = d === 0 ? 0 : at(prevK)
    const prevY = d === 0 ? 0 : prevX - prevK
    while (x > prevX && y > prevY) {
      ops[--pos] = OP_KEEP
      x--
      y--
    }
    if (d > 0) ops[--pos] = x === prevX ? OP_INSERT : OP_DELETE
    x = prevX
    y = prevY
  }
  return ops
}

/**
 * Greedy Myers over `a[aStart, aStart+n)` and `b[bStart, bStart+m)`: the
 * shortest edit script (0 keep, 1 delete, 2 insert), or null when it needs more
 * than `maxEdits` edits. The trace is O(maxEdits²).
 */
const myers = <T>(a: ArrayLike<T>, aStart: number, n: number, b: ArrayLike<T>, bStart: number, m: number, maxEdits: number): Uint8Array | null => {
  const max = n + m
  if (max === 0) return new Uint8Array(0)
  const bound = Math.min(max, maxEdits)
  const off = bound + 1
  const v = new Int32Array(2 * bound + 3)
  const trace: Int32Array[] = []

  for (let d = 0; d <= max; d++) {
    if (d > maxEdits) return null
    trace.push(v.slice(off - d - 1, off + d + 2))
    for (let k = -d; k <= d; k += 2) {
      const left = v[off + k - 1] ?? 0
      const right = v[off + k + 1] ?? 0
      const isDown = k === -d || (k !== d && left < right)
      let x = isDown ? right : left + 1
      let y = x - k
      while (x < n && y < m && a[aStart + x] === b[bStart + y]) {
        x++
        y++
      }
      v[off + k] = x
      if (x >= n && y >= m) return backtrack(trace, n, m)
    }
  }
  return null
}

export const diffIds = (a: Int32Array, b: Int32Array, maxEdits: number): Uint8Array | null => myers(a, 0, a.length, b, 0, b.length, maxEdits)

/** The edit bound for a middle of n + m lines: keeps Myers near WORK_BUDGET int steps. */
const editBound = (n: number, m: number, maxEditsOption: number | undefined): number =>
  Math.min(maxEditsOption ?? DEFAULT_MAX_EDITS, Math.max(MIN_MAX_EDITS, Math.floor(WORK_BUDGET / Math.max(1, n + m))))

const replaceOps = (n: number, m: number): Uint8Array => {
  const ops = new Uint8Array(n + m)
  ops.fill(OP_DELETE, 0, n)
  ops.fill(OP_INSERT, n)
  return ops
}

export type EditScript = {
  /** Lines both texts share at the start and end, outside `ops`. */
  readonly prefix: number
  readonly suffix: number
  /** The middle's ops; past the edit bound, all its deletes then all its inserts. */
  readonly ops: Uint8Array
}

const commonEnds = <T>(a: ArrayLike<T>, b: ArrayLike<T>): { prefix: number; suffix: number } => {
  const shortest = Math.min(a.length, b.length)
  let prefix = 0
  while (prefix < shortest && a[prefix] === b[prefix]) prefix++
  let suffix = 0
  while (suffix < shortest - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++
  return { prefix, suffix }
}

/** The edit script between two interned texts. */
export const editScript = (a: Int32Array, b: Int32Array, maxEditsOption?: number): EditScript => {
  const { prefix, suffix } = commonEnds(a, b)
  const n = a.length - prefix - suffix
  const m = b.length - prefix - suffix
  const ops = myers(a, prefix, n, b, prefix, m, editBound(n, m, maxEditsOption)) ?? replaceOps(n, m)
  return { prefix, suffix, ops }
}

/**
 * Most diffs change a few lines, and for those interning every line costs more
 * than the whole search: a first pass compares the strings themselves under a
 * small edit bound, and only a bigger change pays for interning, where int
 * compares win. Equality is the same either way, so so are the ops.
 */
const QUICK_EDITS = 32

/** The edit script between two split texts. */
export const editScriptOfLines = (a: readonly string[], b: readonly string[], maxEditsOption?: number): EditScript => {
  const { prefix, suffix } = commonEnds(a, b)
  const n = a.length - prefix - suffix
  const m = b.length - prefix - suffix
  const bound = editBound(n, m, maxEditsOption)
  const quick = myers(a, prefix, n, b, prefix, m, Math.min(QUICK_EDITS, bound))
  if (quick) return { prefix, suffix, ops: quick }
  if (bound <= QUICK_EDITS) return { prefix, suffix, ops: replaceOps(n, m) }
  const interner = new LineInterner()
  const ids = myers(interner.idsOf(a.slice(prefix, prefix + n)), 0, n, interner.idsOf(b.slice(prefix, prefix + m)), 0, m, bound)
  return { prefix, suffix, ops: ids ?? replaceOps(n, m) }
}

const opChar = (op: number): Op => (op === OP_KEEP ? ' ' : op === OP_DELETE ? '-' : '+')

/** Hunks from the middle ops (which start `prefix` lines in); context lines come from around them by index. */
const hunksOf = (a: readonly string[], b: readonly string[], prefix: number, ops: Uint8Array, context: number): Hunk[] => {
  const hunks: Hunk[] = []
  const len = ops.length
  let prevOldEnd = 0
  let x = 0
  let y = 0
  let j = 0
  while (j < len) {
    if (ops[j] === OP_KEEP) {
      x++
      y++
      j++
      continue
    }
    const gs = j
    const xs = x
    const ys = y
    let ge = j
    let xe = x
    let ye = y
    while (j < len) {
      const op = ops[j]
      if (op !== OP_KEEP) {
        if (op === OP_DELETE) x++
        else y++
        ge = ++j
        xe = x
        ye = y
        continue
      }
      let r = j
      while (r < len && ops[r] === OP_KEEP) r++
      const run = r - j
      if (r < len && run <= 2 * context) {
        x += run
        y += run
        j = r
        continue
      }
      break
    }
    x = xe
    y = ye
    j = ge

    const oldStart = prefix + xs
    const oldChangeEnd = prefix + xe
    const before = Math.min(context, oldStart - prevOldEnd)
    const after = Math.min(context, a.length - oldChangeEnd)
    const lines: Line[] = []
    for (let i = oldStart - before; i < oldStart; i++) lines.push({ op: ' ', text: a[i] ?? '' })
    let ax = oldStart
    let by = prefix + ys
    for (let t = gs; t < ge; t++) {
      const op = ops[t] ?? OP_KEEP
      if (op === OP_INSERT) lines.push({ op: '+', text: b[by++] ?? '' })
      else {
        lines.push({ op: opChar(op), text: a[ax++] ?? '' })
        if (op === OP_KEEP) by++
      }
    }
    for (let i = oldChangeEnd; i < oldChangeEnd + after; i++) lines.push({ op: ' ', text: a[i] ?? '' })
    hunks.push({
      oldIdx: oldStart - before,
      oldLen: before + (xe - xs) + after,
      newIdx: prefix + ys - before,
      newLen: before + (ye - ys) + after,
      lines,
    })
    prevOldEnd = oldChangeEnd + after
  }
  return hunks
}

/** Hunks between two prepared texts; both must come from the same interner. */
export const diffPrepared = (a: PreparedText, b: PreparedText, opts?: DiffOptions): Hunk[] => {
  const script = editScript(a.ids, b.ids, opts?.maxEdits)
  return hunksOf(a.lines, b.lines, script.prefix, script.ops, opts?.context ?? DEFAULT_CONTEXT)
}

/** Hunks between two texts already split (splitLines): a caller can keep one side split across diffs. */
export const diffLines = (a: readonly string[], b: readonly string[], opts?: DiffOptions): Hunk[] => {
  const script = editScriptOfLines(a, b, opts?.maxEdits)
  return hunksOf(a, b, script.prefix, script.ops, opts?.context ?? DEFAULT_CONTEXT)
}

/** The hunks turning `before` into `after`, each with up to 3 lines of context. */
export const diffHunks = (before: string, after: string, opts?: DiffOptions): Hunk[] =>
  before === after ? [] : diffLines(splitLines(before), splitLines(after), opts)

export const countChanges = (hunks: readonly Hunk[]): { added: number; removed: number } => {
  let added = 0
  let removed = 0
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.op === '+') added++
      else if (l.op === '-') removed++
    }
  }
  return { added, removed }
}

/** One hunk as unified-diff text. */
export const toUnified = (h: Hunk): string => {
  const oldStart = h.oldLen === 0 ? h.oldIdx : h.oldIdx + 1
  const newStart = h.newLen === 0 ? h.newIdx : h.newIdx + 1
  const body = h.lines.map(l => l.op + l.text.replace(/\n$/, '')).join('\n')
  return `@@ -${oldStart},${h.oldLen} +${newStart},${h.newLen} @@\n${body}`
}
