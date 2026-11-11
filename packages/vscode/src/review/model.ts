// What is under review in this window, and the granular signals surfaces
// subscribe to (§7.4). Pure state: the scheduler computes diffs, the ledger
// stores feed records, and nothing here touches the editor or the disk.

import type { FileRecord } from '@core/events'
import type { Ref, SessionId } from '@core/ids'
import { openSessions, openTurns, type Ledger, type OpenSession, type OpenTurn } from '@core/ledger'
import type { HunkView } from '@core/view'

import { Emitter, type Event } from '../util/emitter'

/** open doc: `d${docIdentity}:${doc.version}`; disk: `f${mtimeMs}:${size}`; or 'missing'. */
export type LiveVersion = string

export type DiffState =
  | { readonly kind: 'pending' }
  | {
      readonly kind: 'ready'
      readonly baseVersion: number
      readonly liveVersion: LiveVersion
      readonly hunks: readonly HunkView[]
      readonly added: number
      readonly removed: number
      readonly lineCount: number
      readonly layout: string
    }
  | { readonly kind: 'clean'; readonly baseVersion: number; readonly liveVersion: LiveVersion }
  | { readonly kind: 'tooLarge'; readonly bytes: number }
  | { readonly kind: 'error'; readonly message: string }

export type FileState = {
  readonly path: string
  readonly ledgerDir: string
  readonly record: FileRecord
  /** Bumped whenever the record's base ref changes: a diff computed against an older base is dropped. */
  readonly baseVersion: number
  readonly diff: DiffState
}

export type DiffResult =
  | { readonly kind: 'diff'; readonly baseVersion: number; readonly liveVersion: LiveVersion; readonly hunks: readonly HunkView[]; readonly added: number; readonly removed: number; readonly lineCount: number; readonly layout: string }
  | { readonly kind: 'tooLarge'; readonly baseVersion: number; readonly bytes: number }
  | { readonly kind: 'error'; readonly baseVersion: number; readonly message: string }

export type DiffReason = 'action' | 'ledger' | 'visible' | 'typing' | 'external' | 'startup'

export type TurnView = OpenTurn & { readonly ledgerDir: string }
export type SessionView = OpenSession & { readonly ledgerDirs: readonly string[] }

type LedgerEntry = { readonly dir: string; readonly root: string; ledger: Ledger }

const isUnderReview = (s: FileState): boolean => s.diff.kind !== 'clean'

/** Signals for one tick, fired together on a microtask so a burst of changes repaints once. */
class SignalBatch {
  private membership = false
  private turns = false
  private readonly counts = new Set<string>()
  private readonly layout = new Set<string>()
  private readonly base = new Set<string>()
  private isScheduled = false

  constructor(private readonly flush: (batch: { membership: boolean; turns: boolean; counts: ReadonlySet<string>; layout: ReadonlySet<string>; base: ReadonlySet<string> }) => void) {}

  add(kind: 'membership' | 'turns' | 'counts' | 'layout' | 'base', path?: string): void {
    if (kind === 'membership') this.membership = true
    else if (kind === 'turns') this.turns = true
    else if (path !== undefined) this[kind].add(path)
    if (this.isScheduled) return
    this.isScheduled = true
    queueMicrotask(() => {
      this.isScheduled = false
      const batch = { membership: this.membership, turns: this.turns, counts: new Set(this.counts), layout: new Set(this.layout), base: new Set(this.base) }
      this.membership = false
      this.turns = false
      this.counts.clear()
      this.layout.clear()
      this.base.clear()
      this.flush(batch)
    })
  }
}

export type KeepRecord = { readonly path: string; readonly ledgerDir: string; readonly previousBase: Ref | null }

const KEEP_STACK = 20

export class ReviewModel {
  private readonly ledgers = new Map<string, LedgerEntry>()
  private readonly states = new Map<string, FileState>()
  private ordered: readonly FileState[] | undefined
  private turnCache: { readonly key: readonly Ledger[]; readonly turns: readonly TurnView[]; readonly sessions: readonly SessionView[] } | undefined
  private readonly keeps: KeepRecord[] = []
  private readonly duplicateWarned = new Set<string>()

  private readonly membershipEmitter = new Emitter<void>()
  private readonly countsEmitter = new Emitter<ReadonlySet<string>>()
  private readonly layoutEmitter = new Emitter<ReadonlySet<string>>()
  private readonly baseEmitter = new Emitter<ReadonlySet<string>>()
  private readonly turnsEmitter = new Emitter<void>()
  private readonly signals = new SignalBatch(b => {
    if (b.membership) {
      this.ordered = undefined
      this.membershipEmitter.fire()
    }
    if (b.counts.size > 0) this.countsEmitter.fire(b.counts)
    if (b.layout.size > 0) this.layoutEmitter.fire(b.layout)
    if (b.base.size > 0) this.baseEmitter.fire(b.base)
    if (b.turns) this.turnsEmitter.fire()
  })

  readonly onMembership: Event<void> = this.membershipEmitter.event
  readonly onCounts: Event<ReadonlySet<string>> = this.countsEmitter.event
  readonly onLayout: Event<ReadonlySet<string>> = this.layoutEmitter.event
  readonly onBase: Event<ReadonlySet<string>> = this.baseEmitter.event
  readonly onTurns: Event<void> = this.turnsEmitter.event

  constructor(
    /** Asks for a diff of a path; the scheduler debounces and prioritises it. */
    private readonly requestDiff: (path: string, reason: DiffReason) => void,
    private readonly warn: (message: string) => void,
  ) {}

  /** A record exists for the path (clean or not): edits to it must be diffed. */
  has(path: string): boolean {
    return this.states.has(path)
  }

  get(path: string): FileState | undefined {
    return this.states.get(path)
  }

  /** Files under review, ledgers by root, records in the order they were first edited. */
  files(): readonly FileState[] {
    if (!this.ordered) {
      const out: FileState[] = []
      for (const l of [...this.ledgers.values()].sort((a, b) => a.root.localeCompare(b.root))) {
        for (const path of l.ledger.files.keys()) {
          const s = this.states.get(path)
          if (s && s.ledgerDir === l.dir && isUnderReview(s)) out.push(s)
        }
      }
      this.ordered = out
    }
    return this.ordered
  }

  /** Every tracked path, clean ones included. */
  trackedPaths(): readonly string[] {
    return [...this.states.keys()]
  }

  ledgerOf(dir: string): Ledger | undefined {
    return this.ledgers.get(dir)?.ledger
  }

  rootOf(dir: string): string | undefined {
    return this.ledgers.get(dir)?.root
  }

  ledgerDirs(): readonly string[] {
    return [...this.ledgers.keys()]
  }

  /** `reason` for the first diff of each record: `startup` while the window loads, behind visible editors. */
  addLedger(dir: string, root: string, ledger: Ledger, reason: DiffReason = 'ledger'): void {
    this.ledgers.set(dir, { dir, root, ledger })
    this.reconcile(dir, undefined, ledger, reason)
    this.signals.add('turns')
  }

  removeLedger(dir: string): void {
    const entry = this.ledgers.get(dir)
    if (!entry) return
    this.ledgers.delete(dir)
    this.reconcile(dir, entry.ledger, undefined)
    this.signals.add('turns')
  }

  /** A ledger moved on (§7.4): records whose object changed are compared field by field. */
  applyLedger(dir: string, current: Ledger): void {
    const entry = this.ledgers.get(dir)
    if (!entry || entry.ledger === current) return
    const previous = entry.ledger
    entry.ledger = current
    this.reconcile(dir, previous, current)
    if (current.turns !== previous.turns || current.sessions !== previous.sessions || current.files !== previous.files) this.signals.add('turns')
  }

  /** A diff the scheduler computed. Dropped when the base moved since it started. */
  applyDiff(path: string, result: DiffResult): void {
    const state = this.states.get(path)
    if (!state || state.baseVersion !== result.baseVersion) return
    const before = state.diff
    let diff: DiffState
    switch (result.kind) {
      case 'diff':
        diff =
          result.hunks.length === 0
            ? { kind: 'clean', baseVersion: result.baseVersion, liveVersion: result.liveVersion }
            : {
                kind: 'ready',
                baseVersion: result.baseVersion,
                liveVersion: result.liveVersion,
                hunks: result.hunks,
                added: result.added,
                removed: result.removed,
                lineCount: result.lineCount,
                layout: result.layout,
              }
        break
      case 'tooLarge':
        diff = { kind: 'tooLarge', bytes: result.bytes }
        break
      case 'error':
        diff = { kind: 'error', message: result.message }
        break
      default: {
        const unhandled: never = result
        throw new Error(`unknown diff result ${JSON.stringify(unhandled)}`)
      }
    }
    this.states.set(path, { ...state, diff })
    if ((before.kind === 'clean') !== (diff.kind === 'clean')) this.signals.add('membership')
    const countsOf = (d: DiffState): string => (d.kind === 'ready' ? `${d.added}|${d.removed}` : d.kind)
    if (countsOf(before) !== countsOf(diff)) this.signals.add('counts', path)
    const layoutOf = (d: DiffState): string => (d.kind === 'ready' ? d.layout : '')
    if (layoutOf(before) !== layoutOf(diff)) this.signals.add('layout', path)
    this.ordered = undefined
  }

  /** Open turns and sessions across this window's ledgers, recomputed only when a ledger changed. */
  turns(): readonly TurnView[] {
    return this.projections().turns
  }

  sessions(): readonly SessionView[] {
    return this.projections().sessions
  }

  /** By the id as a command or tree node carries it. */
  sessionOf(id: string): SessionView | undefined {
    return this.sessions().find(s => s.id === id)
  }

  turnOf(key: string): TurnView | undefined {
    return this.turns().find(t => t.key === key)
  }

  pushKeep(keep: KeepRecord): void {
    this.keeps.push(keep)
    if (this.keeps.length > KEEP_STACK) this.keeps.shift()
  }

  popKeep(): KeepRecord | undefined {
    return this.keeps.pop()
  }

  dispose(): void {
    for (const e of [this.membershipEmitter, this.countsEmitter, this.layoutEmitter, this.baseEmitter, this.turnsEmitter]) e.dispose()
  }

  private projections(): { readonly turns: readonly TurnView[]; readonly sessions: readonly SessionView[] } {
    const entries = [...this.ledgers.values()].sort((a, b) => a.root.localeCompare(b.root))
    const key = entries.map(e => e.ledger)
    const cached = this.turnCache
    if (cached && cached.key.length === key.length && cached.key.every((l, i) => l === key[i])) return cached
    const isListed = (dir: string) => (path: string) => {
      const s = this.states.get(path)
      return s !== undefined && s.ledgerDir === dir && isUnderReview(s)
    }
    const turns: TurnView[] = []
    const sessions = new Map<SessionId, SessionView>()
    for (const e of entries) {
      for (const t of openTurns(e.ledger, isListed(e.dir))) turns.push({ ...t, ledgerDir: e.dir })
      for (const s of openSessions(e.ledger, isListed(e.dir))) {
        const known = sessions.get(s.id)
        sessions.set(
          s.id,
          known
            ? { ...known, title: known.title || s.title, turnKeys: [...known.turnKeys, ...s.turnKeys.filter(k => !known.turnKeys.includes(k))], ledgerDirs: [...known.ledgerDirs, e.dir] }
            : { ...s, ledgerDirs: [e.dir] },
        )
      }
    }
    turns.sort((a, b) => a.at - b.at)
    const result = { key, turns, sessions: [...sessions.values()].sort((a, b) => a.at - b.at) }
    this.turnCache = result
    return result
  }

  /** The ledger that owns a path when two hold it (old data): the deepest root. */
  private owner(path: string): string | undefined {
    let best: LedgerEntry | undefined
    let count = 0
    for (const e of this.ledgers.values()) {
      if (!e.ledger.files.has(path)) continue
      count++
      if (!best || e.root.length > best.root.length) best = e
    }
    if (count > 1 && !this.duplicateWarned.has(path)) {
      this.duplicateWarned.add(path)
      this.warn(`${path} is recorded in ${count} ledgers; showing the one for ${best?.root ?? '?'}`)
    }
    return best?.dir
  }

  private reconcile(dir: string, previous: Ledger | undefined, current: Ledger | undefined, firstReason: DiffReason = 'ledger'): void {
    const paths = new Set<string>([...(previous?.files.keys() ?? []), ...(current?.files.keys() ?? [])])
    for (const path of paths) {
      const before = previous?.files.get(path)
      const after = current?.files.get(path)
      if (before === after) continue
      const ownerDir = this.owner(path)
      const state = this.states.get(path)
      if (ownerDir === undefined) {
        if (state) {
          this.states.delete(path)
          this.signals.add('membership')
        }
        continue
      }
      const record = this.ledgers.get(ownerDir)?.ledger.files.get(path)
      if (!record) continue
      if (!state) {
        this.states.set(path, { path, ledgerDir: ownerDir, record, baseVersion: 0, diff: { kind: 'pending' } })
        this.signals.add('membership')
        this.requestDiff(path, firstReason)
        continue
      }
      const baseChanged = state.record.base !== record.base || state.ledgerDir !== ownerDir
      this.states.set(path, { ...state, ledgerDir: ownerDir, record, baseVersion: baseChanged ? state.baseVersion + 1 : state.baseVersion })
      if (baseChanged) {
        this.signals.add('base', path)
        this.requestDiff(path, 'ledger')
      } else if (dir === ownerDir) {
        // Same base, new entries (another turn's after): the tree's per-turn counts may change.
        this.signals.add('counts', path)
      }
    }
    this.ordered = undefined
  }
}
