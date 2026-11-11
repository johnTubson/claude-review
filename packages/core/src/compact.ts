// Compaction and blob GC as pure plans: the extension does the I/O around them.

import type { BatchId, Ref } from './ids'
import { snapshotFileName, timeOfBatchId, type SnapshotName } from './ids'
import type { SnapshotData } from './events'
import { emptyLedger, foldBatches, fromSnapshot, toSnapshot, wholePrefix, type BatchSlot, type Ledger } from './ledger'

export const COMPACT_AFTER_BATCHES = 256
export const COMPACT_AFTER_MS = 24 * 60 * 60 * 1000
export const BLOB_GC_EVERY_MS = 24 * 60 * 60 * 1000
/** A blob younger than this may belong to a batch still being written. */
export const BLOB_GRACE_MS = 10 * 60 * 1000

export const shouldCompact = (batchIds: readonly BatchId[], now: number): boolean => {
  if (batchIds.length > COMPACT_AFTER_BATCHES) return true
  let oldest: BatchId | undefined
  for (const id of batchIds) if (oldest === undefined || id < oldest) oldest = id
  return oldest !== undefined && now - timeOfBatchId(oldest) > COMPACT_AFTER_MS
}

export type CompactionInput = {
  /** The latest snapshot that parsed, if any. */
  readonly snapshot: SnapshotData | undefined
  /** Every snapshot file name present, the latest included. */
  readonly snapshots: readonly SnapshotName[]
  /** Batch files with id after the snapshot's `last`, sorted by id. */
  readonly batches: readonly BatchSlot[]
}

export type CompactionPlan =
  | { readonly kind: 'nothing' }
  | {
      readonly kind: 'write'
      readonly ledger: Ledger
      readonly snapshot: SnapshotData
      readonly fileName: string
      /** Batches the new snapshot holds: id ≤ its `last`. */
      readonly deleteBatches: readonly BatchId[]
      /** Snapshots older than the one this compaction started from. */
      readonly deleteSnapshots: readonly string[]
    }

const idOfSlot = (slot: BatchSlot): BatchId => (slot.state === 'whole' ? slot.batch.id : slot.id)

export const planCompaction = ({ snapshot, snapshots, batches }: CompactionInput): CompactionPlan => {
  const start = snapshot ? fromSnapshot(snapshot) : undefined
  const prefix = wholePrefix(batches)
  const ledger = foldBatches(start ?? emptyLedger, prefix)
  const last = ledger.last
  if (last === undefined || last === start?.last) return { kind: 'nothing' }
  const gen = (snapshot?.gen ?? 0) + 1
  const keepFrom = snapshot?.gen ?? 0
  return {
    kind: 'write',
    ledger,
    snapshot: toSnapshot(ledger, gen),
    fileName: snapshotFileName(gen, last),
    deleteBatches: batches.map(idOfSlot).filter(id => id <= last),
    deleteSnapshots: snapshots.filter(s => s.gen < keepFrom).map(s => snapshotFileName(s.gen, s.last)),
  }
}

export type BlobFile = { readonly ref: Ref; readonly mtimeMs: number }

/** Blobs no longer needed and old enough that no writer can still be about to reference them. */
export const planBlobGc = (needed: ReadonlySet<Ref>, blobs: readonly BlobFile[], now: number): Ref[] =>
  blobs.filter(b => !needed.has(b.ref) && now - b.mtimeMs > BLOB_GRACE_MS).map(b => b.ref)
