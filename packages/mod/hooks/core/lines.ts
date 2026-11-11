// Generated from packages/core/src/lines.ts by scripts/sync-core.mjs: edit the original, then run `npm run sync-core`.

// Lines and their interned ids: the diff compares ints, never strings.

/** Each line keeps its own '\n', so joining them gives the text back byte for byte. */
export const splitLines = (text: string): string[] => {
  const out: string[] = []
  let start = 0
  while (start < text.length) {
    const nl = text.indexOf('\n', start)
    if (nl < 0) {
      out.push(text.slice(start))
      break
    }
    out.push(text.slice(start, nl + 1))
    start = nl + 1
  }
  return out
}

/** Gives each distinct line one int, so equal lines compare as equal ints across texts interned by the same instance. */
export class LineInterner {
  private readonly ids = new Map<string, number>()

  get size(): number {
    return this.ids.size
  }

  idsOf(lines: readonly string[]): Int32Array {
    const out = new Int32Array(lines.length)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ''
      let id = this.ids.get(line)
      if (id === undefined) {
        id = this.ids.size
        this.ids.set(line, id)
      }
      out[i] = id
    }
    return out
  }
}
