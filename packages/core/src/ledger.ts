// The review of one workspace root: a pure fold of its batches. The mod and the
// extension fold the same batches with this code, so they always agree.
//
// A file's baseline is its text before the oldest change nobody has reviewed,
// whichever session made it. Keeping moves the baseline; undoing changes the
// file itself; once nothing is left the file settles and its record goes, so a
// later edit starts a new baseline from what it found.

import type { Batch, Entry, FileRecord, LedgerEvent, Session, SessionData, SnapshotData, Turn, TurnData } from './events'
import { turnKey, type BatchId, type Ref, type SessionId, type TurnKey } from './ids'

export type Ledger = {
  /** In the order each file was first edited. */
  readonly files: ReadonlyMap<string, FileRecord>
  /** In the order each turn was first seen. */
  readonly turns: ReadonlyMap<TurnKey, Turn>
  /** In the order each session was first seen. */
  readonly sessions: ReadonlyMap<SessionId, Session>
  readonly last: BatchId | undefined
}

export const emptyLedger: Ledger = { files: new Map(), turns: new Map(), sessions: new Map(), last: undefined }

type Draft = { files: Map<string, FileRecord>; turns: Map<TurnKey, Turn>; sessions: Map<SessionId, Session> }

const addTurn = (turns: Map<TurnKey, Turn>, data: TurnData, at: number): void => {
  const known = turns.get(data.key)
  if (!known) turns.set(data.key, { ...data, n: turns.size + 1, at })
  else if (known.prompt === '' && data.prompt !== '') turns.set(data.key, { ...known, prompt: data.prompt })
}

const addSession = (sessions: Map<SessionId, Session>, data: SessionData, at: number): void => {
  const known = sessions.get(data.id)
  if (!known) sessions.set(data.id, { ...data, n: sessions.size + 1, at })
  else if (known.title === '' && data.title !== '') sessions.set(data.id, { ...known, title: data.title })
}

const applyOne = ({ files, turns, sessions }: Draft, e: LedgerEvent, at: number): void => {
  switch (e.kind) {
    case 'session':
      addSession(sessions, { id: e.session, title: e.title, cwd: e.cwd }, at)
      return
    case 'turn':
      addTurn(turns, { key: turnKey(e.session, e.turn), session: e.session, turn: e.turn, prompt: e.prompt }, at)
      return
    case 'edit': {
      const key = turnKey(e.session, e.turn)
      addTurn(turns, { key, session: e.session, turn: e.turn, prompt: '' }, at)
      const file = files.get(e.path)
      if (!file) {
        files.set(e.path, { path: e.path, base: e.before, entries: [{ turn: key, before: e.before, after: e.after, isResolved: false, tool: e.tool }] })
        return
      }
      const open = file.entries.find(en => en.turn === key && !en.isResolved)
      const entries: readonly Entry[] = open
        ? file.entries.map(en => (en === open ? { ...en, after: e.after, tool: e.tool } : en))
        : [...file.entries, { turn: key, before: e.before, after: e.after, isResolved: false, tool: e.tool }]
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
      const entries = file.entries.map(en => (e.turn === null || en.turn === e.turn ? { ...en, isResolved: true } : en))
      files.set(e.path, { ...file, entries })
      return
    }
    case 'settle':
      files.delete(e.path)
      return
    case 'import':
      for (const s of e.sessions) addSession(sessions, s, at)
      for (const t of e.turns) addTurn(turns, t, at)
      // An edit recorded since takes precedence over the imported record.
      if (!files.has(e.path)) files.set(e.path, { path: e.path, base: e.base, entries: e.entries })
      return
    default: {
      const unhandled: never = e
      throw new Error(`unknown ledger event ${JSON.stringify(unhandled)}`)
    }
  }
}

/** Folds `batches` (sorted by id) into a new ledger, skipping any at or before `ledger.last`. The input is untouched. */
export const foldBatches = (ledger: Ledger, batches: readonly Batch[]): Ledger => {
  let draft: Draft | undefined
  let last = ledger.last
  for (const batch of batches) {
    if (last !== undefined && batch.id <= last) continue
    draft ??= { files: new Map(ledger.files), turns: new Map(ledger.turns), sessions: new Map(ledger.sessions) }
    for (const e of batch.events) applyOne(draft, e, batch.at)
    last = batch.id
  }
  return draft ? { ...draft, last } : ledger
}

// ---- batch files as readers find them ----

export type BatchSlot =
  | { readonly state: 'whole'; readonly batch: Batch }
  /** Not (yet) parseable: a writer may still be mid-write. */
  | { readonly state: 'pending'; readonly id: BatchId }
  /** Still bad after the grace period: a crash left it so. */
  | { readonly state: 'skipped'; readonly id: BatchId }

/**
 * The whole batches up to the first pending one, in id order: a later batch is
 * never folded ahead of an earlier one that has not landed whole yet.
 */
export const wholePrefix = (slots: readonly BatchSlot[]): Batch[] => {
  const out: Batch[] = []
  for (const slot of slots) {
    if (slot.state === 'pending') break
    if (slot.state === 'whole') out.push(slot.batch)
  }
  return out
}

// ---- projections ----

export type OpenTurn = Turn & { readonly paths: readonly string[] }
export type OpenSession = Session & { readonly turnKeys: readonly TurnKey[] }

/** The turns that still have a change waiting, in turn order, each with the files it waits in. */
export const openTurns = (ledger: Ledger, isListed: (path: string) => boolean = () => true): OpenTurn[] => {
  const paths = new Map<TurnKey, string[]>()
  for (const f of ledger.files.values()) {
    if (!isListed(f.path)) continue
    for (const en of f.entries) {
      if (en.isResolved) continue
      const list = paths.get(en.turn)
      if (!list) paths.set(en.turn, [f.path])
      else if (list[list.length - 1] !== f.path) list.push(f.path)
    }
  }
  const out: OpenTurn[] = []
  for (const t of ledger.turns.values()) {
    const list = paths.get(t.key)
    if (list) out.push({ ...t, paths: list })
  }
  return out
}

/**
 * The sessions with an open turn, in session order, each with its open turns
 * oldest first. A session known only from its turns (no session event) is
 * listed after the known ones, untitled.
 */
export const openSessions = (ledger: Ledger, isListed: (path: string) => boolean = () => true): OpenSession[] => {
  const turnsOf = new Map<SessionId, TurnKey[]>()
  for (const t of openTurns(ledger, isListed)) {
    const list = turnsOf.get(t.session)
    if (list) list.push(t.key)
    else turnsOf.set(t.session, [t.key])
  }
  const out: OpenSession[] = []
  for (const s of ledger.sessions.values()) {
    const keys = turnsOf.get(s.id)
    if (!keys) continue
    out.push({ ...s, turnKeys: keys })
    turnsOf.delete(s.id)
  }
  let n = ledger.sessions.size
  for (const [id, keys] of turnsOf) {
    const first = keys[0]
    const at = first === undefined ? 0 : (ledger.turns.get(first)?.at ?? 0)
    out.push({ id, title: '', cwd: '', n: ++n, at, turnKeys: keys })
  }
  return out
}

/** Every blob the ledger still needs: what blob GC must keep. */
export const refsOf = (ledger: Ledger): Set<Ref> => {
  const refs = new Set<Ref>()
  for (const f of ledger.files.values()) {
    if (f.base) refs.add(f.base)
    for (const en of f.entries) {
      if (en.before) refs.add(en.before)
      if (en.after) refs.add(en.after)
    }
  }
  return refs
}

/** Every blob the batches mention. */
export const refsOfBatches = (batches: readonly Batch[]): Set<Ref> => {
  const refs = new Set<Ref>()
  const add = (ref: Ref | null): void => {
    if (ref) refs.add(ref)
  }
  for (const b of batches) {
    for (const e of b.events) {
      switch (e.kind) {
        case 'edit':
          add(e.before)
          add(e.after)
          break
        case 'keep':
          add(e.base)
          break
        case 'import':
          add(e.base)
          for (const en of e.entries) {
            add(en.before)
            add(en.after)
          }
          break
        case 'session':
        case 'turn':
        case 'resolve':
        case 'settle':
          break
        default: {
          const unhandled: never = e
          throw new Error(`unknown ledger event ${JSON.stringify(unhandled)}`)
        }
      }
    }
  }
  return refs
}

// ---- snapshots ----

export const toSnapshot = (ledger: Ledger, gen: number): SnapshotData => ({
  v: 2,
  gen,
  last: ledger.last ?? null,
  files: [...ledger.files.values()],
  turns: [...ledger.turns.values()],
  sessions: [...ledger.sessions.values()],
})

export const fromSnapshot = (snapshot: SnapshotData): Ledger => ({
  files: new Map(snapshot.files.map(f => [f.path, f])),
  turns: new Map(snapshot.turns.map(t => [t.key, t])),
  sessions: new Map(snapshot.sessions.map(s => [s.id, s])),
  last: snapshot.last ?? undefined,
})
