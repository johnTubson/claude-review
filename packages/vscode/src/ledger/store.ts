// One ledger as this window sees it: the newest snapshot plus every whole batch
// after it, folded with core. A watcher on events/ and the mod's pings trigger
// scans; this window's own batches fold in as it writes them.

import { promises as fs, watch, type FSWatcher } from 'node:fs'
import * as path from 'node:path'

import type { Batch, LedgerEvent } from '@core/events'
import { batchId, extensionWriter, nonce4, type BatchId } from '@core/ids'
import { emptyLedger, foldBatches, fromSnapshot, wholePrefix, type Ledger } from '@core/ledger'

import type { Log } from '../log'
import type { Perf } from '../perf'
import { Coalescer } from '../util/async'
import { Emitter, type Event } from '../util/emitter'
import { listBatchIds, listSnapshots, loadLatestSnapshot, readSlots } from './disk'
import { writeAtomic } from './fsx'
import { blobsDir, eventsDir, snapshotsDir } from './layout'

export type LedgerChange = { readonly dir: string; readonly previous: Ledger; readonly current: Ledger }

const WATCH_DEBOUNCE_MS = 10

/** One writer name and counter per extension host, so ids from two stores never collide. */
const writer = extensionWriter(process.pid)
let counter = 0

const byId = (a: Batch, b: Batch): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

export class LedgerStore {
  private snapshotGen = -1
  private base: Ledger = emptyLedger
  private current: Ledger = emptyLedger
  /** Batches folded onto `base`, in id order: what a late batch is folded again with. Compaction bounds it. */
  private kept: Batch[] = []
  /** Batch ids folded or given up on. */
  private readonly seen = new Set<BatchId>()
  private readonly firstBad = new Map<BatchId, number>()
  private readonly scanner = new Coalescer(() => this.scanNow())
  private readonly changes = new Emitter<LedgerChange>()
  private watcher: FSWatcher | undefined
  private debounce: NodeJS.Timeout | undefined
  private isDisposed = false
  /** Batch ids on disk at the last scan: what compaction decides by. */
  private onDisk: readonly BatchId[] = []

  readonly onChange: Event<LedgerChange> = this.changes.event

  constructor(
    readonly dir: string,
    private readonly log: Log,
    private readonly perf: Perf,
  ) {}

  get ledger(): Ledger {
    return this.current
  }

  get batchIdsOnDisk(): readonly BatchId[] {
    return this.onDisk
  }

  async start(): Promise<void> {
    await Promise.all([eventsDir(this.dir), snapshotsDir(this.dir), blobsDir(this.dir)].map(d => fs.mkdir(d, { recursive: true })))
    await this.scan()
    try {
      this.watcher = watch(eventsDir(this.dir), () => {
        if (this.debounce) clearTimeout(this.debounce)
        this.debounce = setTimeout(() => void this.scan(), WATCH_DEBOUNCE_MS)
      })
      this.watcher.on('error', err => this.log.error(`watching ${eventsDir(this.dir)}`, err))
    } catch (err) {
      this.log.error(`watching ${eventsDir(this.dir)}`, err)
    }
  }

  /** Reads what landed since the last scan. One runs at a time; calls meanwhile share the next. */
  scan(): Promise<void> {
    return this.scanner.run().catch((err: unknown) => this.log.error(`scanning ${this.dir}`, err))
  }

  /** Writes one batch (tmp + rename) and folds it at once. */
  async append(events: readonly LedgerEvent[]): Promise<Batch> {
    const at = Date.now()
    const batch: Batch = { v: 2, id: batchId(at, writer, counter++, nonce4(Math.random)), at, writer, events }
    await writeAtomic(path.join(eventsDir(this.dir), `${batch.id}.json`), JSON.stringify(batch))
    if (!this.seen.has(batch.id)) {
      this.seen.add(batch.id)
      this.fold([batch])
    }
    return batch
  }

  dispose(): void {
    this.isDisposed = true
    if (this.debounce) clearTimeout(this.debounce)
    this.watcher?.close()
    this.changes.dispose()
  }

  private fold(batches: readonly Batch[]): void {
    const first = batches[0]
    if (first === undefined) return
    const previous = this.current
    if (previous.last !== undefined && first.id <= previous.last) {
      this.kept = [...this.kept, ...batches].sort(byId)
      this.current = foldBatches(this.base, this.kept)
    } else {
      this.kept.push(...batches)
      this.current = foldBatches(previous, batches)
    }
    this.perf.batchesFolded += batches.length
    if (this.current !== previous && !this.isDisposed) this.changes.fire({ dir: this.dir, previous, current: this.current })
  }

  private async scanNow(): Promise<void> {
    if (this.isDisposed) return
    this.perf.ledgerScans++
    const [names, ids] = await Promise.all([listSnapshots(this.dir), listBatchIds(this.dir)])
    this.onDisk = ids
    const top = names[0]
    if (top !== undefined && top.gen > this.snapshotGen) await this.reloadFrom(names)

    const baseLast = this.base.last
    const fresh = ids.filter(id => !this.seen.has(id) && (baseLast === undefined || id > baseLast))
    if (fresh.length === 0) return
    const slots = await readSlots(this.dir, fresh, {
      now: Date.now(),
      firstBad: this.firstBad,
      onSkip: (id, reason) => this.log.warn(`skipping ${id}.json in ${this.dir}: ${reason}`),
    })
    for (const slot of slots) {
      if (slot.state === 'pending') break
      this.seen.add(slot.state === 'whole' ? slot.batch.id : slot.id)
    }
    this.fold(wholePrefix(slots))
  }

  /** A newer snapshot: start over from it plus what was folded after its `last`. */
  private async reloadFrom(names: Parameters<typeof loadLatestSnapshot>[1]): Promise<void> {
    const loaded = await loadLatestSnapshot(this.dir, names, this.snapshotGen)
    if (!loaded) return
    const previous = this.current
    this.snapshotGen = loaded.name.gen
    this.base = fromSnapshot(loaded.data)
    const last = this.base.last
    this.kept = this.kept.filter(b => last === undefined || b.id > last)
    for (const id of this.seen) if (last !== undefined && id <= last) this.seen.delete(id)
    this.current = foldBatches(this.base, this.kept)
    if (this.current !== previous && !this.isDisposed) this.changes.fire({ dir: this.dir, previous, current: this.current })
  }
}
