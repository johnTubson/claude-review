// Ledger v2's data: batches of events, snapshots and meta. Each batch is
// written once and never changed. The mod runs this with no npm, so the guards
// at this trust boundary are written by hand.

import { isBatchId, isRef, isSessionId, isTurnKey, type BatchId, type Ref, type SessionId, type TurnKey } from './ids'

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string }

export type EntryTool = 'Edit' | 'Write' | 'NotebookEdit' | 'Bash' | 'Import'

export type EntryData = {
  readonly turn: TurnKey
  readonly before: Ref | null
  readonly after: Ref | null
  readonly isResolved: boolean
  readonly tool: EntryTool
}
export type TurnData = { readonly key: TurnKey; readonly session: SessionId; readonly turn: string; readonly prompt: string }
export type SessionData = { readonly id: SessionId; readonly title: string; readonly cwd: string }

export type LedgerEvent =
  | { readonly kind: 'session'; readonly session: SessionId; readonly title: string; readonly cwd: string }
  | { readonly kind: 'turn'; readonly session: SessionId; readonly turn: string; readonly prompt: string }
  | {
      readonly kind: 'edit'
      readonly session: SessionId
      readonly turn: string
      readonly path: string
      readonly before: Ref | null
      readonly after: Ref | null
      readonly tool: EntryTool
    }
  | { readonly kind: 'keep'; readonly path: string; readonly base: Ref | null }
  | { readonly kind: 'resolve'; readonly path: string; readonly turn: TurnKey | null }
  | { readonly kind: 'settle'; readonly path: string }
  | {
      readonly kind: 'import'
      readonly path: string
      readonly base: Ref | null
      readonly entries: readonly EntryData[]
      readonly turns: readonly TurnData[]
      readonly sessions: readonly SessionData[]
    }

export type EventKind = LedgerEvent['kind']

export type Batch = { readonly v: 2; readonly id: BatchId; readonly at: number; readonly writer: string; readonly events: readonly LedgerEvent[] }

export type Entry = EntryData
export type Turn = TurnData & { readonly n: number; readonly at: number }
export type Session = SessionData & { readonly n: number; readonly at: number }
export type FileRecord = { readonly path: string; readonly base: Ref | null; readonly entries: readonly Entry[] }

export type SnapshotData = {
  readonly v: 2
  readonly gen: number
  readonly last: BatchId | null
  readonly files: readonly FileRecord[]
  readonly turns: readonly Turn[]
  readonly sessions: readonly Session[]
}

export type Meta = { readonly v: 2; readonly root: string; readonly createdAt: number }

// ---- guards ----

type Fields = { readonly [key: string]: unknown }

const isFields = (v: unknown): v is Fields => typeof v === 'object' && v !== null && !Array.isArray(v)
const isString = (v: unknown): v is string => typeof v === 'string'
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const isRefOrNull = (v: unknown): v is Ref | null => v === null || isRef(v)
const TOOLS: ReadonlySet<string> = new Set<EntryTool>(['Edit', 'Write', 'NotebookEdit', 'Bash', 'Import'])
const isTool = (v: unknown): v is EntryTool => isString(v) && TOOLS.has(v)

/** Absolute and normalized: no trailing slash, no empty, `.` or `..` segments. */
export const isNormalPath = (v: unknown): v is string => {
  if (!isString(v) || !v.startsWith('/')) return false
  if (v === '/') return true
  if (v.endsWith('/')) return false
  for (const segment of v.slice(1).split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return false
  }
  return true
}

/** `path` made absolute against `cwd` (itself absolute) and normalized as isNormalPath requires. */
export const normalizePath = (path: string, cwd: string): string => {
  const parts: string[] = []
  for (const segment of (path.startsWith('/') ? path : `${cwd}/${path}`).split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') parts.pop()
    else parts.push(segment)
  }
  return `/${parts.join('/')}`
}

/** The directory holding a normalized path. */
export const dirnameOf = (path: string): string => {
  const cut = path.lastIndexOf('/')
  return cut <= 0 ? '/' : path.slice(0, cut)
}

const fail = (reason: string): { readonly ok: false; readonly reason: string } => ({ ok: false, reason })

/** Every item through `parse`, or undefined at the first that fails. */
const parseAll = <T>(v: unknown, parse: (item: unknown) => T | undefined): T[] | undefined => {
  if (!Array.isArray(v)) return undefined
  const out: T[] = []
  for (const item of v) {
    const parsed = parse(item)
    if (parsed === undefined) return undefined
    out.push(parsed)
  }
  return out
}

const parseEntry = (v: unknown): Entry | undefined =>
  isFields(v) && isTurnKey(v.turn) && isRefOrNull(v.before) && isRefOrNull(v.after) && typeof v.isResolved === 'boolean' && isTool(v.tool)
    ? { turn: v.turn, before: v.before, after: v.after, isResolved: v.isResolved, tool: v.tool }
    : undefined

const parseTurnData = (v: unknown): TurnData | undefined =>
  isFields(v) && isTurnKey(v.key) && isSessionId(v.session) && isString(v.turn) && isString(v.prompt)
    ? { key: v.key, session: v.session, turn: v.turn, prompt: v.prompt }
    : undefined

const parseSessionData = (v: unknown): SessionData | undefined =>
  isFields(v) && isSessionId(v.id) && isString(v.title) && isString(v.cwd) ? { id: v.id, title: v.title, cwd: v.cwd } : undefined

export const parseEvent = (v: unknown): LedgerEvent | undefined => {
  if (!isFields(v)) return undefined
  switch (v.kind) {
    case 'session':
      return isSessionId(v.session) && isString(v.title) && isString(v.cwd)
        ? { kind: 'session', session: v.session, title: v.title, cwd: v.cwd }
        : undefined
    case 'turn':
      return isSessionId(v.session) && isString(v.turn) && isString(v.prompt)
        ? { kind: 'turn', session: v.session, turn: v.turn, prompt: v.prompt }
        : undefined
    case 'edit':
      return isSessionId(v.session) && isString(v.turn) && isNormalPath(v.path) && isRefOrNull(v.before) && isRefOrNull(v.after) && isTool(v.tool)
        ? { kind: 'edit', session: v.session, turn: v.turn, path: v.path, before: v.before, after: v.after, tool: v.tool }
        : undefined
    case 'keep':
      return isNormalPath(v.path) && isRefOrNull(v.base) ? { kind: 'keep', path: v.path, base: v.base } : undefined
    case 'resolve':
      return isNormalPath(v.path) && (v.turn === null || isTurnKey(v.turn)) ? { kind: 'resolve', path: v.path, turn: v.turn } : undefined
    case 'settle':
      return isNormalPath(v.path) ? { kind: 'settle', path: v.path } : undefined
    case 'import': {
      const entries = parseAll(v.entries, parseEntry)
      const turns = parseAll(v.turns, parseTurnData)
      const sessions = parseAll(v.sessions, parseSessionData)
      return isNormalPath(v.path) && isRefOrNull(v.base) && entries && turns && sessions
        ? { kind: 'import', path: v.path, base: v.base, entries, turns, sessions }
        : undefined
    }
    default:
      return undefined
  }
}

const parseJson = (text: string): Parsed<unknown> => {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (err) {
    return fail(`not JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export const parseBatch = (text: string): Parsed<Batch> => {
  const json = parseJson(text)
  if (!json.ok) return json
  const v = json.value
  if (!isFields(v)) return fail('not an object')
  if (v.v !== 2) return fail(`version ${String(v.v)}`)
  if (!isBatchId(v.id)) return fail('bad id')
  if (typeof v.at !== 'number' || !Number.isFinite(v.at)) return fail('bad at')
  if (!isString(v.writer)) return fail('bad writer')
  if (!Array.isArray(v.events)) return fail('no events')
  const events: LedgerEvent[] = []
  for (const [i, raw] of v.events.entries()) {
    const e = parseEvent(raw)
    if (e === undefined) return fail(`event ${i} is not a ledger event`)
    events.push(e)
  }
  return { ok: true, value: { v: 2, id: v.id, at: v.at, writer: v.writer, events } }
}

const parseFileRecord = (v: unknown): FileRecord | undefined => {
  if (!isFields(v) || !isNormalPath(v.path) || !isRefOrNull(v.base)) return undefined
  const entries = parseAll(v.entries, parseEntry)
  return entries ? { path: v.path, base: v.base, entries } : undefined
}

const parseTurn = (v: unknown): Turn | undefined => {
  const data = parseTurnData(v)
  return data && isFields(v) && isCount(v.n) && typeof v.at === 'number' ? { ...data, n: v.n, at: v.at } : undefined
}

const parseSession = (v: unknown): Session | undefined => {
  const data = parseSessionData(v)
  return data && isFields(v) && isCount(v.n) && typeof v.at === 'number' ? { ...data, n: v.n, at: v.at } : undefined
}

export const parseSnapshot = (text: string): Parsed<SnapshotData> => {
  const json = parseJson(text)
  if (!json.ok) return json
  const v = json.value
  if (!isFields(v)) return fail('not an object')
  if (v.v !== 2) return fail(`version ${String(v.v)}`)
  if (!isCount(v.gen)) return fail('bad gen')
  if (!(v.last === null || isBatchId(v.last))) return fail('bad last')
  const files = parseAll(v.files, parseFileRecord)
  const turns = parseAll(v.turns, parseTurn)
  const sessions = parseAll(v.sessions, parseSession)
  if (!files) return fail('bad files')
  if (!turns) return fail('bad turns')
  if (!sessions) return fail('bad sessions')
  return { ok: true, value: { v: 2, gen: v.gen, last: v.last, files, turns, sessions } }
}

export const parseMeta = (text: string): Parsed<Meta> => {
  const json = parseJson(text)
  if (!json.ok) return json
  const v = json.value
  if (!isFields(v)) return fail('not an object')
  if (v.v !== 2) return fail(`version ${String(v.v)}`)
  if (!isNormalPath(v.root)) return fail('bad root')
  if (typeof v.createdAt !== 'number') return fail('bad createdAt')
  return { ok: true, value: { v: 2, root: v.root, createdAt: v.createdAt } }
}
