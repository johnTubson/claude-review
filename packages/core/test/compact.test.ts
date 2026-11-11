import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { planBlobGc, planCompaction, shouldCompact } from '../src/compact'
import { batchId, parseSnapshotFileName, snapshotFileName } from '../src/ids'
import { emptyLedger, foldBatches, toSnapshot } from '../src/ledger'
import { batch, nextId, ref, S1 } from './support/fixtures'

describe('compaction', () => {
  test('shouldCompact on count or age', () => {
    const now = Date.now()
    assert.equal(shouldCompact([batchId(now, 'x1', 0, '0000')], now), false)
    assert.equal(shouldCompact([batchId(now - 25 * 3600_000, 'x1', 0, '0000')], now), true)
    assert.equal(shouldCompact(Array.from({ length: 257 }, (_, i) => batchId(now, 'x1', i, '0000')), now), true)
    assert.equal(shouldCompact([], now), false)
  })

  test('folds the whole prefix, deletes what the snapshot holds and old snapshots', () => {
    const b0 = batch([{ kind: 'edit', session: S1, turn: 't', path: '/a', before: null, after: ref('1'), tool: 'Edit' }])
    const s1 = toSnapshot(foldBatches(emptyLedger, [b0]), 4)
    const b1 = batch([{ kind: 'edit', session: S1, turn: 't', path: '/a', before: ref('1'), after: ref('2'), tool: 'Edit' }])
    const pending = nextId()
    const b2 = batch([{ kind: 'settle', path: '/a' }])
    const old = { gen: 3, last: b0.id }
    const plan = planCompaction({
      snapshot: s1,
      snapshots: [old, { gen: 4, last: b0.id }],
      batches: [{ state: 'whole', batch: b1 }, { state: 'pending', id: pending }, { state: 'whole', batch: b2 }],
    })
    assert.equal(plan.kind, 'write')
    if (plan.kind !== 'write') return
    assert.equal(plan.snapshot.gen, 5)
    assert.equal(plan.snapshot.last, b1.id)
    assert.deepEqual(parseSnapshotFileName(plan.fileName), { gen: 5, last: b1.id })
    assert.deepEqual(plan.deleteBatches, [b1.id], 'never a batch after the pending one')
    assert.deepEqual(plan.deleteSnapshots, [snapshotFileName(old.gen, old.last)])
    assert.equal(plan.ledger.files.get('/a')?.entries[0]?.after, ref('2'))
  })

  test('nothing to do without new whole batches', () => {
    assert.deepEqual(planCompaction({ snapshot: undefined, snapshots: [], batches: [{ state: 'pending', id: nextId() }] }), { kind: 'nothing' })
  })

  test('blob GC keeps needed and young blobs', () => {
    const now = 1_000_000_000
    const needed = new Set([ref('keep')])
    const blobs = [
      { ref: ref('keep'), mtimeMs: 0 },
      { ref: ref('old'), mtimeMs: now - 11 * 60_000 },
      { ref: ref('young'), mtimeMs: now - 60_000 },
    ]
    assert.deepEqual(planBlobGc(needed, blobs, now), [ref('old')])
  })
})
