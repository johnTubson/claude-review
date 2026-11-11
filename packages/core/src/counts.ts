import { editScriptOfLines, OP_DELETE, OP_INSERT } from './diff'
import { splitLines } from './lines'

/** Lines added and removed from `base` to `after` (null: no file), without building hunks. */
export const countsOf = (base: string | null, after: string | null): { added: number; removed: number } => {
  const a = base ?? ''
  const b = after ?? ''
  if (a === b) return { added: 0, removed: 0 }
  const { ops } = editScriptOfLines(splitLines(a), splitLines(b))
  let added = 0
  let removed = 0
  for (const op of ops) {
    if (op === OP_INSERT) added++
    else if (op === OP_DELETE) removed++
  }
  return { added, removed }
}
