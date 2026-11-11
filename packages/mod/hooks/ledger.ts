// The mod's view of each ledger: the latest snapshot plus every batch since,
// folded with core. Only new batch files are read on each load; the mod's own
// batches are folded in as it writes them.

import type { EngineInterface } from 'claude-code'

import { parseBatch, parseSnapshot, type Batch } from './core/events'
import { batchIdOfFileName, parseSnapshotFileName, snapshotFileName, type BatchId } from './core/ids'
import { emptyLedger, foldBatches, fromSnapshot, type BatchSlot, type Ledger } from './core/ledger'
import { logOnce } from './log'

type $ = EngineInterface

/** A batch file still not whole this long after it was written was left so by a crash. */
const GIVE_UP_AFTER_MS = 5000

type Cache = {
  readonly snapshotGen: number
  readonly base: Ledger
  ledger: Ledger
  /** Batches folded onto `base`, in id order: what a late batch is folded again with. */
  kept: Batch[]
  /** Batch ids folded or given up on. */
  readonly seen: Set<BatchId>
}

export type LoadResult = { readonly ledger: Ledger; readonly isChanged: boolean }

const byId = (a: Batch, b: Batch): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

export type Ledgers = {
  readonly caches: Map<string, Cache>
  readonly loads: Map<string, Promise<LoadResult>>
}

export const newLedgers = (): Ledgers => ({ caches: new Map(), loads: new Map() })

export const cachedLedger = (ledgers: Ledgers, dir: string): Ledger | undefined => ledgers.caches.get(dir)?.ledger

const fold = (c: Cache, batches: readonly Batch[]): void => {
  const first = batches[0]
  if (first === undefined) return
  if (c.ledger.last !== undefined && first.id <= c.ledger.last) {
    c.kept = [...c.kept, ...batches].sort(byId)
    c.ledger = foldBatches(c.base, c.kept)
  } else {
    c.kept.push(...batches)
    c.ledger = foldBatches(c.ledger, batches)
  }
}

/** Folds a batch this mod just wrote, so nothing has to read it back. */
export const applyOwn = (ledgers: Ledgers, dir: string, batch: Batch): void => {
  const c = ledgers.caches.get(dir)
  if (!c || c.seen.has(batch.id)) return
  c.seen.add(batch.id)
  fold(c, [batch])
}

/** Reads what changed on disk since the last load (2 listings, then only new files). Concurrent loads of one ledger share one. */
export function loadLedger($: $, ledgers: Ledgers, dir: string): Promise<LoadResult> {
  const running = ledgers.loads.get(dir)
  if (running) return running
  const load = loadNow($, ledgers, dir).finally(() => ledgers.loads.delete(dir))
  ledgers.loads.set(dir, load)
  return load
}

async function loadNow($: $, ledgers: Ledgers, dir: string): Promise<LoadResult> {
  const [snapshots, events] = await Promise.all([$.fs.list(`${dir}/snapshots`).catch(() => []), $.fs.list(`${dir}/events`).catch(() => [])])
  const before = ledgers.caches.get(dir)
  let c = await withSnapshot($, ledgers, dir, before, snapshots.map(e => e.name))
  if (!c) {
    c = { snapshotGen: -1, base: emptyLedger, ledger: emptyLedger, kept: [], seen: new Set() }
    ledgers.caches.set(dir, c)
  }
  const cache = c
  const baseLast = cache.base.last
  const fresh = events
    .map(e => ({ id: batchIdOfFileName(e.name), mtimeMs: e.mtimeMs }))
    .filter((f): f is { id: BatchId; mtimeMs: number } => f.id !== undefined && !cache.seen.has(f.id) && (baseLast === undefined || f.id > baseLast))
    .sort((a, b) => (a.id < b.id ? -1 : 1))
  const previous = cache.ledger
  if (fresh.length > 0) {
    const now = Date.now()
    const slots = await Promise.all(fresh.map(f => readSlot($, dir, f.id, f.mtimeMs, now)))
    const whole: Batch[] = []
    for (const slot of slots) {
      if (slot.state === 'pending') break
      if (slot.state === 'whole') {
        cache.seen.add(slot.batch.id)
        whole.push(slot.batch)
      } else {
        cache.seen.add(slot.id)
      }
    }
    fold(cache, whole)
  }
  return { ledger: cache.ledger, isChanged: cache !== before || cache.ledger !== previous }
}

async function readSlot($: $, dir: string, id: BatchId, mtimeMs: number, now: number): Promise<BatchSlot> {
  const text = await $.fs.read(`${dir}/events/${id}.json`).then(
    t => t,
    (err: unknown) => (String(err).includes('ENOENT') ? null : undefined),
  )
  // Gone: compaction folded it into a snapshot the next load reads.
  if (text === null) return { state: 'skipped', id }
  const parsed = text === undefined ? undefined : parseBatch(text)
  if (parsed?.ok && parsed.value.id === id) return { state: 'whole', batch: parsed.value }
  if (now - mtimeMs < GIVE_UP_AFTER_MS) return { state: 'pending', id }
  logOnce($, `bad:${dir}/${id}`, `skipping ${dir}/events/${id}.json: ${parsed && !parsed.ok ? parsed.reason : 'unreadable'}`)
  return { state: 'skipped', id }
}

/** A cache rebuilt on the highest snapshot that parses, when there is one newer than the cache's. */
async function withSnapshot($: $, ledgers: Ledgers, dir: string, c: Cache | undefined, names: readonly string[]): Promise<Cache | undefined> {
  const newer = names
    .map(parseSnapshotFileName)
    .filter((s): s is NonNullable<typeof s> => s !== undefined && s.gen > (c?.snapshotGen ?? -1))
    .sort((a, b) => b.gen - a.gen)
  for (const s of newer) {
    const text = await $.fs.read(`${dir}/snapshots/${snapshotFileName(s.gen, s.last)}`).catch(() => undefined)
    const parsed = text === undefined ? undefined : parseSnapshot(text)
    if (!parsed?.ok) continue
    const base = fromSnapshot(parsed.value)
    const last = base.last
    const kept = (c?.kept ?? []).filter(b => last === undefined || b.id > last)
    const next: Cache = { snapshotGen: s.gen, base, ledger: foldBatches(base, kept), kept, seen: c?.seen ?? new Set() }
    ledgers.caches.set(dir, next)
    return next
  }
  return c
}
