// The 0.2 diff (claude-review-vscode core/diff.ts), kept only as the parity and bench reference.
// Unchanged except that its non-null assertions became defaults.

export type Op = ' ' | '-' | '+'
export type Line = { op: Op; text: string }
/** `oldIdx`/`newIdx` are 0-based line offsets where the hunk starts. */
export type Hunk = { oldIdx: number; oldLen: number; newIdx: number; newLen: number; lines: Line[] }
export type PatchResult = { ok: true; text: string } | { ok: false }

const CONTEXT = 3
/** Past this many edits the diff stops searching and reports one replace of the differing middle. */
const MAX_EDITS = 2000

export const splitLines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? []

/** Myers O(ND) shortest edit script over the lines; null when it would pass MAX_EDITS. */
const myers = (a: string[], b: string[]): Op[] | null => {
  const n = a.length
  const m = b.length
  const max = n + m
  const off = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []

  for (let d = 0; d <= max; d++) {
    if (d > MAX_EDITS) return null
    trace.push(v.slice(off - d - 1, off + d + 2))
    for (let k = -d; k <= d; k += 2) {
      const isDown = k === -d || (k !== d && (v[off + k - 1] ?? 0) < (v[off + k + 1] ?? 0))
      let x = isDown ? (v[off + k + 1] ?? 0) : (v[off + k - 1] ?? 0) + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[off + k] = x
      if (x >= n && y >= m) return backtrack(trace, n, m)
    }
  }

  return null
}

const backtrack = (trace: Int32Array[], n: number, m: number): Op[] => {
  const ops: Op[] = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d >= 0; d--) {
    const tr = trace[d] ?? new Int32Array(0)
    const at = (k: number) => tr[k + d + 1] ?? 0
    const k = x - y
    const isDown = k === -d || (k !== d && at(k - 1) < at(k + 1))
    const prevK = isDown ? k + 1 : k - 1
    const prevX = d === 0 ? 0 : at(prevK)
    const prevY = d === 0 ? 0 : prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push(' ')
      x--
      y--
    }
    if (d > 0) ops.push(x === prevX ? '+' : '-')
    x = prevX
    y = prevY
  }

  return ops.reverse()
}

type Item = Line & { ai: number; bi: number }

const editItems = (a: string[], b: string[]): Item[] => {
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) {
    suf++
  }
  const midA = a.slice(pre, a.length - suf)
  const midB = b.slice(pre, b.length - suf)
  const mid: Op[] = myers(midA, midB) ?? [
    ...midA.map((): Op => '-'),
    ...midB.map((): Op => '+'),
  ]
  const ops: Op[] = [...Array<Op>(pre).fill(' '), ...mid, ...Array<Op>(suf).fill(' ')]

  const items: Item[] = []
  let ai = 0
  let bi = 0
  for (const op of ops) {
    const text = (op === '+' ? b[bi] : a[ai]) ?? ''
    items.push({ op, text, ai, bi })
    if (op !== '+') ai++
    if (op !== '-') bi++
  }

  return items
}

/** The hunks turning `before` into `after`, each with up to 3 lines of context. */
export const diffHunks02 = (before: string, after: string): Hunk[] => {
  if (before === after) return []
  const items = editItems(splitLines(before), splitLines(after))
  const hunks: Hunk[] = []
  let lastEnd = 0
  let i = 0

  while (i < items.length) {
    if (items[i]?.op === ' ') {
      i++
      continue
    }
    const start = Math.max(lastEnd, i - CONTEXT)
    let end = i
    let j = i
    while (j < items.length) {
      if (items[j]?.op !== ' ') {
        end = ++j
        continue
      }
      let r = j
      while (r < items.length && items[r]?.op === ' ') r++
      if (r < items.length && r - j <= 2 * CONTEXT) j = r
      else break
    }
    const stop = Math.min(items.length, end + CONTEXT)
    const slice = items.slice(start, stop)
    hunks.push({
      oldIdx: slice[0]?.ai ?? 0,
      newIdx: slice[0]?.bi ?? 0,
      oldLen: slice.filter(l => l.op !== '+').length,
      newLen: slice.filter(l => l.op !== '-').length,
      lines: slice.map(({ op, text }) => ({ op, text })),
    })
    lastEnd = stop
    i = stop
  }

  return hunks
}

