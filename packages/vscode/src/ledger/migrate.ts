// One-time imports of what older versions recorded (§8):
//  - 0.2 ledgers (~/.claude/claude-review/ledgers/*): automatic, per open folder,
//    once per old ledger (marked by migrated-v2.json).
//  - 0.1 sessions (~/.claude/session-review/*/review.json): on command only.
// Each pending record becomes one v2 `import` event in the ledger that owns its
// path. Only metadata and the blobs pending records name are read (stat first,
// 4 MiB at most); the old per-session shadow repos are never opened.

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'

import type { EntryData, LedgerEvent, SessionData, TurnData } from '@core/events'
import { batchId, isRef, isSessionId, isTurnKey, MIGRATION_WRITER, nonce4, turnKey, type Ref } from '@core/ids'
import { emptyLedger02, foldEvents02, fromSnapshot02, idOfFileName02, parseEventText02, toImportEvents, type Event02, type FileRecord02, type Ledger02, type Turn02 } from '@core/legacy02'

import type { Log } from '../log'
import { isMissing, listIfPresent, readTextIfPresent, writeAtomic } from './fsx'
import { blobPath, eventsDir, isSameTree, ledgerDirFor, metaFile } from './layout'

/** The `$.fs.read` cap: a blob this large was never a reviewable text. */
export const MAX_MIGRATED_BLOB_BYTES = 4 * 1024 * 1024

export type MigrateDeps = {
  /** Where 0.2 kept its ledgers' parent: ~/.claude/claude-review. */
  readonly legacyDir: string
  /** The v2 data dir. */
  readonly dataDir: string
  readonly folders: readonly string[]
  readonly log: Log
  /** Called with each v2 ledger an import batch landed in, so an open store scans it now. */
  readonly onWritten: (ledgerDir: string) => void
}

export type MigrateResult = { readonly ledgers: number; readonly files: number; readonly skippedBlobs: number }

let counter = 0

/** The git work tree holding `dir`, found by walking up for `.git`; undefined outside one. */
const gitRootOf = async (dir: string, cache: Map<string, string | undefined>): Promise<string | undefined> => {
  const seen: string[] = []
  let d = dir
  for (;;) {
    if (cache.has(d)) {
      const found = cache.get(d)
      for (const s of seen) cache.set(s, found)
      return found
    }
    seen.push(d)
    const hasGit = await fs.stat(path.join(d, '.git')).then(
      () => true,
      () => false,
    )
    if (hasGit) {
      for (const s of seen) cache.set(s, d)
      return d
    }
    const up = path.dirname(d)
    if (up === d) {
      for (const s of seen) cache.set(s, undefined)
      return undefined
    }
    d = up
  }
}

const writeMetaIfMissing = async (ledgerDir: string, root: string): Promise<void> => {
  if ((await readTextIfPresent(metaFile(ledgerDir))) !== undefined) return
  await writeAtomic(metaFile(ledgerDir), JSON.stringify({ v: 2, root, createdAt: Date.now() }))
}

/** Copies one blob into a v2 ledger (sharded), unless it is there; false when missing or too large. */
const copyBlob = async (from: string, toLedger: string, ref: Ref, log: Log): Promise<boolean> => {
  const to = blobPath(toLedger, ref)
  if (await fs.stat(to).then(() => true, () => false)) return true
  const stat = await fs.stat(from).catch(() => undefined)
  if (!stat) {
    log.warn(`migration: blob ${ref} is missing from ${path.dirname(from)}`)
    return false
  }
  if (stat.size > MAX_MIGRATED_BLOB_BYTES) {
    log.warn(`migration: skipping blob ${ref} (${stat.size} bytes, over 4 MiB)`)
    return false
  }
  await fs.mkdir(path.dirname(to), { recursive: true })
  await fs.copyFile(from, to)
  return true
}

const refsOfImport = (e: Extract<LedgerEvent, { kind: 'import' }>): Ref[] =>
  [e.base, ...e.entries.flatMap(en => [en.before, en.after])].filter((r): r is Ref => r !== null)

/** Writes one import batch (writer `xmig`) into a v2 ledger. */
const appendImports = async (ledgerDir: string, events: readonly LedgerEvent[]): Promise<void> => {
  if (events.length === 0) return
  const at = Date.now()
  const id = batchId(at, MIGRATION_WRITER, counter++, nonce4(Math.random))
  await writeAtomic(path.join(eventsDir(ledgerDir), `${id}.json`), JSON.stringify({ v: 2, id, at, writer: MIGRATION_WRITER, events }))
}

type OldLedger = { readonly dir: string; readonly root: string; readonly ledger: Ledger02 }

const readOldLedger = async (dir: string, log: Log): Promise<Ledger02 | undefined> => {
  const snapshotText = await readTextIfPresent(path.join(dir, 'snapshot.json'))
  let start = emptyLedger02
  if (snapshotText !== undefined) {
    let json: unknown
    try {
      json = JSON.parse(snapshotText)
    } catch (err) {
      log.error(`migration: ${dir}/snapshot.json`, err)
      return undefined
    }
    const parsed = fromSnapshot02(json)
    if (!parsed) {
      log.warn(`migration: ${dir}/snapshot.json is not a 0.2 snapshot`)
      return undefined
    }
    start = parsed
  }
  const names = (await listIfPresent(path.join(dir, 'events'))).filter(n => idOfFileName02(n) !== undefined)
  const events: Event02[] = []
  for (const name of names) {
    const text = await readTextIfPresent(path.join(dir, 'events', name))
    const e = text === undefined ? undefined : parseEventText02(text)
    if (e) events.push(e)
  }
  return foldEvents02(start, events)
}

const newestTurnAt = (record: FileRecord02, turns: ReadonlyMap<string, Turn02>): number =>
  Math.max(0, ...record.entries.map(en => turns.get(en.turn)?.at ?? 0))

/** §8.1: every 0.2 ledger of `folders` not migrated yet. Idempotent: `import` ignores paths already present. */
export const migrate02 = async (deps: MigrateDeps): Promise<MigrateResult> => {
  const { legacyDir, dataDir, folders, log } = deps
  const ledgersRoot = path.join(legacyDir, 'ledgers')
  const old: OldLedger[] = []
  for (const name of await listIfPresent(ledgersRoot)) {
    const dir = path.join(ledgersRoot, name)
    const metaText = await readTextIfPresent(path.join(dir, 'meta.json')).catch(() => undefined)
    if (metaText === undefined) continue
    if ((await readTextIfPresent(path.join(dir, 'migrated-v2.json'))) !== undefined) continue
    let root: unknown
    try {
      const meta: unknown = JSON.parse(metaText)
      root = typeof meta === 'object' && meta !== null && 'root' in meta ? meta.root : undefined
    } catch {
      // A torn meta.json: this ledger is tried again next time.
      continue
    }
    if (typeof root !== 'string' || !folders.some(f => isSameTree(root, f))) continue
    const ledger = await readOldLedger(dir, log)
    if (ledger) old.push({ dir, root, ledger })
  }
  if (old.length === 0) return { ledgers: 0, files: 0, skippedBlobs: 0 }

  // When two old ledgers hold the same path, the record with the latest turn wins.
  const winner = new Map<string, { readonly from: OldLedger; readonly at: number }>()
  for (const o of old) {
    for (const record of o.ledger.files.values()) {
      const at = newestTurnAt(record, o.ledger.turns)
      const known = winner.get(record.path)
      if (!known || at > known.at) winner.set(record.path, { from: o, at })
    }
  }

  const gitCache = new Map<string, string | undefined>()
  const routes = new Map<string, string>()
  for (const [p, { from }] of winner) routes.set(p, (await gitRootOf(path.dirname(p), gitCache)) ?? from.root)

  let files = 0
  let skippedBlobs = 0
  const byTarget = new Map<string, { root: string; events: LedgerEvent[] }>()
  for (const o of old) {
    const mine = new Map([...o.ledger.files].filter(([p]) => winner.get(p)?.from === o))
    const plan = toImportEvents({ ...o.ledger, files: mine }, p => routes.get(p) ?? o.root)
    for (const s of plan.skipped) log.warn(`migration: skipping ${s.path}: ${s.reason}`)
    for (const [root, events] of plan.events) {
      const target = ledgerDirFor(dataDir, root)
      for (const e of events) {
        if (e.kind !== 'import') continue
        const copied = await Promise.all(refsOfImport(e).map(ref => copyBlob(path.join(o.dir, 'blobs', ref), target, ref, log)))
        if (copied.some(ok => !ok)) {
          skippedBlobs++
          log.warn(`migration: skipping ${e.path}: a blob it needs could not be copied`)
          continue
        }
        const slot = byTarget.get(target) ?? { root, events: [] }
        slot.events.push(e)
        byTarget.set(target, slot)
        files++
      }
    }
  }
  for (const [target, { root, events }] of byTarget) {
    await writeMetaIfMissing(target, root)
    await appendImports(target, events)
    deps.onWritten(target)
  }
  const to = [...byTarget.keys()]
  await Promise.all(old.map(o => writeAtomic(path.join(o.dir, 'migrated-v2.json'), JSON.stringify({ at: Date.now(), lastId: o.ledger.lastId ?? null, to }))))
  log.info(`migrated ${files} pending file(s) from ${old.length} 0.2 ledger(s)`)
  return { ledgers: old.length, files, skippedBlobs }
}

// ---- 0.1 sessions ----

const refSchema = z.string().regex(/^[0-9a-f]{64}$/).nullable()
/** The shape review.json had in 0.1. */
const legacyReviewSchema = z.object({
  sessionId: z.string().min(1),
  cwd: z.string().min(1),
  files: z.array(
    z.object({
      path: z.string(),
      baseRef: refSchema,
      entries: z.array(z.object({ turnId: z.string(), beforeRef: refSchema, afterRef: refSchema, isResolved: z.boolean() })),
    }),
  ),
  turns: z.array(z.object({ turnId: z.string(), prompt: z.string() })),
})

const importedFile = (ledgerDir: string): string => path.join(ledgerDir, 'imported-v1.json')
const importedSchema = z.array(z.string())

const parseJsonOrUndefined = (text: string | undefined): unknown => {
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    // Torn or foreign: treated as absent.
    return undefined
  }
}

const toRefOrNull = (v: string | null): Ref | null | undefined => (v === null ? null : isRef(v) ? v : undefined)

export type ImportSessionsDeps = MigrateDeps & { readonly sessionsDir: string }

/** The `importOldSessions` command: 0.1 sessions of `folders`, each once. Reads review.json and the blobs it names only. */
export const importOldSessions = async (deps: ImportSessionsDeps): Promise<MigrateResult> => {
  const { sessionsDir, dataDir, folders, log } = deps
  const gitCache = new Map<string, string | undefined>()
  let files = 0
  let skippedBlobs = 0
  const touched = new Set<string>()
  for (const name of await listIfPresent(sessionsDir)) {
    const dir = path.join(sessionsDir, name)
    const text = await readTextIfPresent(path.join(dir, 'review.json')).catch(() => undefined)
    if (text === undefined) continue
    const parsed = legacyReviewSchema.safeParse(parseJsonOrUndefined(text))
    if (!parsed.success) continue
    const review = parsed.data
    if (review.files.length === 0 || !folders.some(f => isSameTree(review.cwd, f)) || !isSessionId(review.sessionId)) continue
    const sessionId = review.sessionId
    const sessionRoot = (await gitRootOf(review.cwd, gitCache)) ?? review.cwd
    const imported = importedSchema.safeParse(parseJsonOrUndefined(await readTextIfPresent(importedFile(ledgerDirFor(dataDir, sessionRoot)))) ?? [])
    if (imported.success && imported.data.includes(sessionId)) continue

    const prompts = new Map(review.turns.map(t => [t.turnId, t.prompt]))
    const session: SessionData = { id: sessionId, title: review.turns[0]?.prompt ?? '', cwd: review.cwd }
    const byTarget = new Map<string, { root: string; events: LedgerEvent[] }>()
    for (const f of review.files) {
      if (!path.isAbsolute(f.path)) continue
      const base = toRefOrNull(f.baseRef)
      const entries: EntryData[] = []
      for (const en of f.entries) {
        const before = toRefOrNull(en.beforeRef)
        const after = toRefOrNull(en.afterRef)
        if (before === undefined || after === undefined) continue
        entries.push({ turn: turnKey(sessionId, en.turnId), before, after, isResolved: en.isResolved, tool: 'Import' })
      }
      if (base === undefined) continue
      const turns: TurnData[] = [...new Set(f.entries.map(en => en.turnId))].flatMap(turn => {
        const key = turnKey(sessionId, turn)
        return isTurnKey(key) ? [{ key, session: sessionId, turn, prompt: prompts.get(turn) ?? '' }] : []
      })
      const root = (await gitRootOf(path.dirname(f.path), gitCache)) ?? sessionRoot
      const target = ledgerDirFor(dataDir, root)
      const event: Extract<LedgerEvent, { kind: 'import' }> = { kind: 'import', path: path.normalize(f.path), base, entries, turns, sessions: [session] }
      const copied = await Promise.all(refsOfImport(event).map(ref => copyBlob(path.join(dir, ref), target, ref, log)))
      if (copied.some(ok => !ok)) {
        skippedBlobs++
        continue
      }
      const slot = byTarget.get(target) ?? { root, events: [] }
      slot.events.push(event)
      byTarget.set(target, slot)
      files++
    }
    for (const [target, { root, events }] of byTarget) {
      await writeMetaIfMissing(target, root)
      await appendImports(target, events)
      touched.add(target)
    }
    const markDir = ledgerDirFor(dataDir, sessionRoot)
    const already = imported.success ? imported.data : []
    await writeAtomic(importedFile(markDir), JSON.stringify([...already, sessionId]))
  }
  for (const t of touched) deps.onWritten(t)
  return { ledgers: touched.size, files, skippedBlobs }
}

/** Whether a 0.2 ledger dir was migrated: what cleanUpStorage offers to delete. */
export const isMigrated02 = async (dir: string): Promise<boolean> =>
  (await readTextIfPresent(path.join(dir, 'migrated-v2.json')).catch((err: unknown) => {
    if (isMissing(err)) return undefined
    throw err
  })) !== undefined
