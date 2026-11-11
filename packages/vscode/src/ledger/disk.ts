// Reading a ledger's snapshots and batches as they stand on disk. Writers only
// ever create files, so anything listed may be half-written or already gone.

import { promises as fs } from 'node:fs'
import * as path from 'node:path'

import { parseBatch, parseSnapshot, type SnapshotData } from '@core/events'
import { batchIdOfFileName, parseSnapshotFileName, snapshotFileName, type BatchId, type SnapshotName } from '@core/ids'
import type { BatchSlot } from '@core/ledger'

import { mapLimit } from '../util/async'
import { isMissing, listIfPresent } from './fsx'
import { eventsDir, snapshotsDir } from './layout'

/** A batch still not whole this long after it was first seen was left so by a crash. */
export const GIVE_UP_AFTER_MS = 5000
const READ_PARALLEL = 16

export type LoadedSnapshot = { readonly name: SnapshotName; readonly data: SnapshotData }

export const listSnapshots = async (ledgerDir: string): Promise<SnapshotName[]> =>
  (await listIfPresent(snapshotsDir(ledgerDir)))
    .map(parseSnapshotFileName)
    .filter((s): s is SnapshotName => s !== undefined)
    .sort((a, b) => b.gen - a.gen)

/** The highest snapshot above `aboveGen` that parses, falling back to lower ones. */
export const loadLatestSnapshot = async (ledgerDir: string, names: readonly SnapshotName[], aboveGen = -1): Promise<LoadedSnapshot | undefined> => {
  for (const name of names) {
    if (name.gen <= aboveGen) break
    const text = await fs.readFile(path.join(snapshotsDir(ledgerDir), snapshotFileName(name.gen, name.last)), 'utf8').catch(() => undefined)
    const parsed = text === undefined ? undefined : parseSnapshot(text)
    if (parsed?.ok) return { name, data: parsed.value }
  }
  return undefined
}

export const listBatchIds = async (ledgerDir: string): Promise<BatchId[]> =>
  (await listIfPresent(eventsDir(ledgerDir)))
    .map(batchIdOfFileName)
    .filter((id): id is BatchId => id !== undefined)
    .sort()

export type SlotOptions = {
  readonly now: number
  /** When each id was first seen not whole; the reader keeps it across scans. */
  readonly firstBad: Map<BatchId, number>
  readonly onSkip: (id: BatchId, reason: string) => void
}

/** Reads batches (sorted ids) into slots: whole, pending (maybe mid-write), or skipped (gone, or bad for too long). */
export const readSlots = (ledgerDir: string, ids: readonly BatchId[], opts: SlotOptions): Promise<BatchSlot[]> =>
  mapLimit(ids, READ_PARALLEL, async (id): Promise<BatchSlot> => {
    let text: string
    try {
      text = await fs.readFile(path.join(eventsDir(ledgerDir), `${id}.json`), 'utf8')
    } catch (err) {
      // Gone: compaction folded it into a snapshot the reader loads next.
      if (isMissing(err)) return { state: 'skipped', id }
      throw err
    }
    const parsed = parseBatch(text)
    if (parsed.ok && parsed.value.id === id) {
      opts.firstBad.delete(id)
      return { state: 'whole', batch: parsed.value }
    }
    const first = opts.firstBad.get(id)
    if (first === undefined) {
      opts.firstBad.set(id, opts.now)
      return { state: 'pending', id }
    }
    if (opts.now - first < GIVE_UP_AFTER_MS) return { state: 'pending', id }
    opts.firstBad.delete(id)
    opts.onSkip(id, parsed.ok ? 'its id does not match its name' : parsed.reason)
    return { state: 'skipped', id }
  })
