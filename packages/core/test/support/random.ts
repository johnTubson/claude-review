/** mulberry32: a seeded PRNG, so a failing property case can be replayed. */
export const seeded = (seed: number): (() => number) => {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const pick = <T>(random: () => number, items: readonly T[]): T => {
  const item = items[Math.floor(random() * items.length)]
  if (item === undefined) throw new Error('pick from an empty list')
  return item
}

const VOCAB = ['a\n', 'b\n', 'c\n', 'd\n', '\n', 'foo()\n', '  return x\n', '}\n', 'a\r\n', 'b\r\n']

/** A text of up to `maxLines` lines from a small vocabulary (so lines repeat), sometimes without a final newline. */
export const randomText = (random: () => number, maxLines: number): string => {
  const n = Math.floor(random() * (maxLines + 1))
  let text = ''
  for (let i = 0; i < n; i++) text += pick(random, VOCAB)
  if (text.length > 0 && random() < 0.2) text = text.replace(/\r?\n$/, '')
  return text
}

/** `text` with a few random line inserts, deletes and replaces. */
export const mutate = (random: () => number, text: string): string => {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const edits = Math.floor(random() * 6)
  for (let e = 0; e < edits; e++) {
    const at = Math.floor(random() * (lines.length + 1))
    const roll = random()
    if (roll < 0.33) lines.splice(at, 0, pick(random, VOCAB))
    else if (roll < 0.66) lines.splice(at, 1)
    else lines.splice(at, 1, pick(random, VOCAB))
  }
  return lines.join('')
}
