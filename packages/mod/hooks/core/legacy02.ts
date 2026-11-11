// Generated from packages/core/src/legacy02.ts by scripts/sync-core.mjs: edit the original, then run `npm run sync-core`.

// A frozen copy of the 0.2 ledger's parser and fold, for migration only: 0.2
// wrote one JSON file per event plus snapshot.json. Never extend this; v2 data
// lives in events.ts and ledger.ts.

import { isNormalPath, type EntryData, type LedgerEvent, type SessionData, type TurnData } from './events'
import { isRef, isSessionId, isTurnKey, type Ref } from './ids'

export type Entry02 = { readonly turn: string; readonly before: string | null; readonly after: string | null; readonly isResolved: boolean }
export type Turn02 = { readonly key: string; readonly session: string; readonly turn: string; readonly prompt: string; readonly n: number; readonly at: number }
export type FileRecord02 = { readonly path: string; readonly base: string | null; readonly entries: readonly Entry02[] }
export type Ledger02 = { readonly files: ReadonlyMap<string, FileRecord02>; readonly turns: ReadonlyMap<string, Turn02>; readonly lastId: string | undefined }

type Stamp = { readonly id: string; readonly at: number }
export type Event02 =
  | (Stamp & { readonly kind: 'turn'; readonly session: string; readonly turn: string; readonly prompt: string })
  | (Stamp & { readonly kind: 'edit'; readonly session: string; readonly turn: string; readonly path: string; readonly before: string | null; readonly after: string | null })
  | (Stamp & { readonly kind: 'keep'; readonly path: string; readonly base: string | null })
  | (Stamp & { readonly kind: 'resolve'; readonly path: string; readonly turn: string | null })
  | (Stamp & { readonly kind: 'settle'; readonly path: string })
  | (Stamp & { readonly kind: 'import'; readonly path: string; readonly base: string | null; readonly entries: readonly Entry02[]; readonly turns: readonly Omit<Turn02, 'n' | 'at'>[] })

export const emptyLedger02: Ledger02 = { files: new Map(), turns: new Map(), lastId: undefined }

type Fields = { readonly [key: string]: unknown }
const isFields = (v: unknown): v is Fields => typeof v === 'object' && v !== null && !Array.isArray(v)
const isString = (v: unknown): v is string => typeof v === 'string'
const isRef02 = (v: unknown): v is string | null => v === null || (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v))

const parseEntry02 = (v: unknown): Entry02 | undefined =>
  isFields(v) && isString(v.turn) && isRef02(v.before) && isRef02(v.after) && typeof v.isResolved === 'boolean'
    ? { turn: v.turn, before: v.before, after: v.after, isResolved: v.isResolved }
    : undefined

const parseTurnData02 = (v: unknown): Omit<Turn02, 'n' | 'at'> | undefined =>
  isFields(v) && isString(v.key) && isString(v.session) && isString(v.turn) && isString(v.prompt)
    ? { key: v.key, session: v.session, turn: v.turn, prompt: v.prompt }
    : undefined

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

export const parseEvent02 = (v: unknown): Event02 | undefined => {
  if (!isFields(v) || !isString(v.id) || typeof v.at !== 'number') return undefined
  const { id, at } = v
  switch (v.kind) {
    case 'turn':
      return isString(v.session) && isString(v.turn) && isString(v.prompt) ? { id, at, kind: 'turn', session: v.session, turn: v.turn, prompt: v.prompt } : undefined
    case 'edit':
      return isString(v.session) && isString(v.turn) && isString(v.path) && isRef02(v.before) && isRef02(v.after)
        ? { id, at, kind: 'edit', session: v.session, turn: v.turn, path: v.path, before: v.before, after: v.after }
        : undefined
    case 'keep':
      return isString(v.path) && isRef02(v.base) ? { id, at, kind: 'keep', path: v.path, base: v.base } : undefined
    case 'resolve':
      return isString(v.path) && (v.turn === null || isString(v.turn)) ? { id, at, kind: 'resolve', path: v.path, turn: v.turn } : undefined
    case 'settle':
      return isString(v.path) ? { id, at, kind: 'settle', path: v.path } : undefined
    case 'import': {
      const entries = parseAll(v.entries, parseEntry02)
      const turns = parseAll(v.turns, parseTurnData02)
      return isString(v.path) && isRef02(v.base) && entries && turns ? { id, at, kind: 'import', path: v.path, base: v.base, entries, turns } : undefined
    }
    default:
      return undefined
  }
}

export const parseEventText02 = (text: string): Event02 | undefined => {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    // A 0.2 writer crashed mid-write; 0.2 skipped such files too.
    return undefined
  }
  return parseEvent02(json)
}

/** 0.2's event file names: `<10 time>-<source>-<6 counter>-<nonce>.json`. */
export const idOfFileName02 = (name: string): string | undefined =>
  /^[0-9a-z]{10}-[0-9a-z]+-[0-9a-z]{6}-[0-9a-z]*\.json$/i.test(name) ? name.slice(0, -5) : undefined

const addTurn02 = (turns: Map<string, Turn02>, data: Omit<Turn02, 'n' | 'at'>, at: number): void => {
  const known = turns.get(data.key)
  if (!known) turns.set(data.key, { ...data, n: turns.size + 1, at })
  else if (known.prompt === '' && data.prompt !== '') turns.set(data.key, { ...known, prompt: data.prompt })
}

const applyOne02 = (files: Map<string, FileRecord02>, turns: Map<string, Turn02>, e: Event02): void => {
  switch (e.kind) {
    case 'turn':
      addTurn02(turns, { key: `${e.session}:${e.turn}`, session: e.session, turn: e.turn, prompt: e.prompt }, e.at)
      return
    case 'edit': {
      const key = `${e.session}:${e.turn}`
      addTurn02(turns, { key, session: e.session, turn: e.turn, prompt: '' }, e.at)
      const file = files.get(e.path)
      if (!file) {
        files.set(e.path, { path: e.path, base: e.before, entries: [{ turn: key, before: e.before, after: e.after, isResolved: false }] })
        return
      }
      const open = file.entries.find(en => en.turn === key && !en.isResolved)
      const entries = open
        ? file.entries.map(en => (en === open ? { ...en, after: e.after } : en))
        : [...file.entries, { turn: key, before: e.before, after: e.after, isResolved: false }]
      files.set(e.path, { ...file, entries })
      return
    }
    case 'keep': {
      const file = files.get(e.path)
      if (file) files.set(e.path, { ...file, base: e.base })
      return
    }
    case 'resolve': {
      const file = files.get(e.path)
      if (!file) return
      files.set(e.path, { ...file, entries: file.entries.map(en => (e.turn === null || en.turn === e.turn ? { ...en, isResolved: true } : en)) })
      return
    }
    case 'settle':
      files.delete(e.path)
      return
    case 'import':
      for (const t of e.turns) addTurn02(turns, t, e.at)
      if (!files.has(e.path)) files.set(e.path, { path: e.path, base: e.base, entries: e.entries })
      return
    default: {
      const unhandled: never = e
      throw new Error(`unknown 0.2 event ${JSON.stringify(unhandled)}`)
    }
  }
}

/** Folds 0.2 events (any order: they are sorted by id here) onto a 0.2 ledger. */
export const foldEvents02 = (ledger: Ledger02, events: readonly Event02[]): Ledger02 => {
  const sorted = [...events].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const files = new Map(ledger.files)
  const turns = new Map(ledger.turns)
  let lastId = ledger.lastId
  for (const e of sorted) {
    if (lastId !== undefined && e.id <= lastId) continue
    applyOne02(files, turns, e)
    lastId = e.id
  }
  return { files, turns, lastId }
}

const parseTurn02 = (v: unknown): Turn02 | undefined => {
  const data = parseTurnData02(v)
  return data && isFields(v) && typeof v.n === 'number' && typeof v.at === 'number' ? { ...data, n: v.n, at: v.at } : undefined
}

/** 0.2's snapshot.json as a ledger, or undefined when it is not one. */
export const fromSnapshot02 = (v: unknown): Ledger02 | undefined => {
  if (!isFields(v) || !(v.lastId === undefined || isString(v.lastId))) return undefined
  const files = parseAll(v.files, f => {
    if (!isFields(f) || !isString(f.path) || !isRef02(f.base)) return undefined
    const entries = parseAll(f.entries, parseEntry02)
    return entries ? { path: f.path, base: f.base, entries } : undefined
  })
  const turns = parseAll(v.turns, parseTurn02)
  if (!files || !turns) return undefined
  return { files: new Map(files.map(f => [f.path, f])), turns: new Map(turns.map(t => [t.key, t])), lastId: v.lastId }
}

// ---- 0.2 → v2 ----

export type ImportPlan = {
  /** v2 import events per target (whatever `route` returns, a ledger dir in practice). */
  readonly events: ReadonlyMap<string, readonly LedgerEvent[]>
  readonly refs: ReadonlySet<Ref>
  /** Records that could not be expressed in v2 (a relative path, a malformed id), with why. */
  readonly skipped: readonly { readonly path: string; readonly reason: string }[]
}

const toRefOrNull = (v: string | null): Ref | null | undefined => (v === null ? null : isRef(v) ? v : undefined)

/** One v2 `import` event per pending 0.2 record, grouped by the ledger `route` sends its path to. */
export const toImportEvents = (ledger: Ledger02, route: (path: string) => string): ImportPlan => {
  const events = new Map<string, LedgerEvent[]>()
  const refs = new Set<Ref>()
  const skipped: { path: string; reason: string }[] = []

  for (const file of ledger.files.values()) {
    if (!isNormalPath(file.path)) {
      skipped.push({ path: file.path, reason: 'not an absolute, normalized path' })
      continue
    }
    const base = toRefOrNull(file.base)
    if (base === undefined) {
      skipped.push({ path: file.path, reason: 'bad base ref' })
      continue
    }
    const entries: EntryData[] = []
    const turns = new Map<string, TurnData>()
    const sessions = new Map<string, SessionData>()
    let reason: string | undefined
    for (const en of file.entries) {
      const before = toRefOrNull(en.before)
      const after = toRefOrNull(en.after)
      const turn = ledger.turns.get(en.turn)
      if (!isTurnKey(en.turn) || before === undefined || after === undefined) {
        reason = 'bad entry'
        break
      }
      entries.push({ turn: en.turn, before, after, isResolved: en.isResolved, tool: 'Import' })
      if (turn && isSessionId(turn.session) && isTurnKey(turn.key)) {
        turns.set(turn.key, { key: turn.key, session: turn.session, turn: turn.turn, prompt: turn.prompt })
        if (!sessions.has(turn.session)) sessions.set(turn.session, { id: turn.session, title: turn.prompt, cwd: '' })
      }
    }
    if (reason !== undefined) {
      skipped.push({ path: file.path, reason })
      continue
    }
    if (base) refs.add(base)
    for (const en of entries) {
      if (en.before) refs.add(en.before)
      if (en.after) refs.add(en.after)
    }
    const target = route(file.path)
    const list = events.get(target) ?? []
    list.push({ kind: 'import', path: file.path, base, entries, turns: [...turns.values()], sessions: [...sessions.values()] })
    events.set(target, list)
  }
  return { events, refs, skipped }
}
