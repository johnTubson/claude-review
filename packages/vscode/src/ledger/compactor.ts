// Compaction (§4.7): fold a ledger's batches into a new snapshot, delete what it
// holds, and once a day delete blobs nothing needs. Only the extension runs it,
// under a directory lock, from disk truth rather than memory.

import { promises as fs } from 'node:fs'
import * as path from 'node:path'

import { BLOB_GC_EVERY_MS, planBlobGc, planCompaction, type BlobFile } from '@core/compact'
import { isRef, timeOfBatchId } from '@core/ids'
import { refsOf, refsOfBatches } from '@core/ledger'

import type { Log } from '../log'
import { listBatchIds, listSnapshots, loadLatestSnapshot, readSlots } from './disk'
import { isExisting, listIfPresent, readTextIfPresent, writeAtomic, writeDurable } from './fsx'
import { blobsDir, compactLockDir, eventsDir, gcFile, snapshotsDir } from './layout'

const STALE_LOCK_MS = 60_000
/**
 * A writer names its batch by the time, then writes it: a batch younger than
 * this may still land behind ids already folded, and a reader would then never
 * see it. Only batches older than this are compacted.
 */
export const COMPACT_MIN_AGE_MS = 60_000
/** Past this many bytes of blobs in one ledger, the user is told once. */
export const BLOB_WARN_BYTES = 1024 * 1024 * 1024

export type CompactionResult =
  | { readonly kind: 'locked' }
  | { readonly kind: 'nothing' }
  | {
      readonly kind: 'compacted'
      readonly gen: number
      readonly deletedBatches: number
      readonly deletedSnapshots: number
      readonly gc: { readonly deletedBlobs: number; readonly blobBytes: number } | undefined
    }

type GcState = { readonly blobsAt?: number; readonly shadowAt?: number }

const parseGcState = (text: string | undefined): GcState => {
  if (text === undefined) return {}
  try {
    const v: unknown = JSON.parse(text)
    if (typeof v !== 'object' || v === null) return {}
    return {
      ...('blobsAt' in v && typeof v.blobsAt === 'number' ? { blobsAt: v.blobsAt } : {}),
      ...('shadowAt' in v && typeof v.shadowAt === 'number' ? { shadowAt: v.shadowAt } : {}),
    }
  } catch {
    // The mod writes gc.json without a rename; a torn one only means GC runs early.
    return {}
  }
}

/** `mkdir` is the lock: atomic on every local file system. A lock older than a minute was left by a crash. */
const acquire = async (ledgerDir: string): Promise<boolean> => {
  const lock = compactLockDir(ledgerDir)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fs.mkdir(lock)
      await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, at: Date.now() }))
      return true
    } catch (err) {
      if (!isExisting(err)) throw err
      const stat = await fs.stat(lock).catch(() => undefined)
      if (attempt > 0 || (stat && Date.now() - stat.mtimeMs <= STALE_LOCK_MS)) return false
      await fs.rm(lock, { recursive: true, force: true })
    }
  }
  return false
}

const release = async (ledgerDir: string): Promise<void> => {
  const lock = compactLockDir(ledgerDir)
  await fs.rm(path.join(lock, 'owner.json'), { force: true })
  await fs.rmdir(lock).catch(() => undefined)
}

type SizedBlob = BlobFile & { readonly size: number }

const listBlobs = async (ledgerDir: string): Promise<SizedBlob[]> => {
  const out: SizedBlob[] = []
  for (const shard of await listIfPresent(blobsDir(ledgerDir))) {
    const dir = path.join(blobsDir(ledgerDir), shard)
    for (const name of await listIfPresent(dir).catch(() => [])) {
      if (!isRef(name)) continue
      const stat = await fs.stat(path.join(dir, name)).catch(() => undefined)
      if (stat) out.push({ ref: name, mtimeMs: stat.mtimeMs, size: stat.size })
    }
  }
  return out
}

export type CompactOptions = { readonly now?: () => number; readonly minAgeMs?: number }

export const compact = async (ledgerDir: string, log: Log, options: CompactOptions = {}): Promise<CompactionResult> => {
  const now = options.now ?? Date.now
  const minAgeMs = options.minAgeMs ?? COMPACT_MIN_AGE_MS
  if (!(await acquire(ledgerDir))) return { kind: 'locked' }
  try {
    const names = await listSnapshots(ledgerDir)
    const latest = await loadLatestSnapshot(ledgerDir, names)
    const baseLast = latest?.data.last ?? undefined
    const ids = (await listBatchIds(ledgerDir)).filter(id => baseLast === undefined || id > baseLast)
    const slots = await readSlots(ledgerDir, ids, {
      now: now(),
      // Compaction never waits on a batch: one not whole now stops the prefix, and the next compaction gets it.
      firstBad: new Map(),
      onSkip: () => undefined,
    })
    const cutoff = now() - minAgeMs
    const old = slots.filter(slot => timeOfBatchId(slot.state === 'whole' ? slot.batch.id : slot.id) <= cutoff)
    const plan = planCompaction({ snapshot: latest?.data, snapshots: names, batches: old })
    if (plan.kind === 'nothing') return { kind: 'nothing' }

    await writeDurable(path.join(snapshotsDir(ledgerDir), plan.fileName), JSON.stringify(plan.snapshot))
    await Promise.all(plan.deleteBatches.map(id => fs.rm(path.join(eventsDir(ledgerDir), `${id}.json`), { force: true })))
    await Promise.all(plan.deleteSnapshots.map(name => fs.rm(path.join(snapshotsDir(ledgerDir), name), { force: true })))

    let gc: { deletedBlobs: number; blobBytes: number } | undefined
    const state = parseGcState(await readTextIfPresent(gcFile(ledgerDir)))
    if (state.blobsAt === undefined || now() - state.blobsAt > BLOB_GC_EVERY_MS) {
      const last = plan.ledger.last
      // Batches the snapshot does not hold (young, or after a pending one) still name blobs.
      const remaining = slots.flatMap(s => (s.state === 'whole' && last !== undefined && s.batch.id > last ? [s.batch] : []))
      const needed = new Set([...refsOf(plan.ledger), ...refsOfBatches(remaining)])
      const blobs = await listBlobs(ledgerDir)
      const doomed = planBlobGc(needed, blobs, now())
      await Promise.all(doomed.map(ref => fs.rm(path.join(blobsDir(ledgerDir), ref.slice(0, 2), ref), { force: true })))
      const doomedSet = new Set(doomed)
      const blobBytes = blobs.reduce((n, b) => (doomedSet.has(b.ref) ? n : n + b.size), 0)
      // gc.json is shared with the mod (shadowAt): re-read so its field is not lost.
      const fresh = parseGcState(await readTextIfPresent(gcFile(ledgerDir)))
      await writeAtomic(gcFile(ledgerDir), JSON.stringify({ ...fresh, blobsAt: now() }))
      gc = { deletedBlobs: doomed.length, blobBytes }
    }
    log.trace(`compacted ${ledgerDir}: snapshot ${plan.snapshot.gen}, ${plan.deleteBatches.length} batches folded`)
    return { kind: 'compacted', gen: plan.snapshot.gen, deletedBatches: plan.deleteBatches.length, deletedSnapshots: plan.deleteSnapshots.length, gc }
  } finally {
    await release(ledgerDir)
  }
}
