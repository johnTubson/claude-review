// Folding cost: 5,000 batches over 200 files, the order compaction keeps a ledger under.
import { createHash } from 'node:crypto'

import type { Batch } from '../src/events'
import { batchId, toRef, toSessionId, type Ref } from '../src/ids'
import { emptyLedger, foldBatches } from '../src/ledger'

const ref = (n: number): Ref => toRef(createHash('sha256').update(String(n)).digest('hex'))
const session = toSessionId('bench')
const batches: Batch[] = Array.from({ length: 5000 }, (_, i) => ({
  v: 2,
  id: batchId(1_700_000_000_000 + i, 'bench', i, '0000'),
  at: i,
  writer: 'bench',
  events: [{ kind: 'edit', session, turn: `t${Math.floor(i / 50)}`, path: `/w/f${i % 200}.ts`, before: ref(i), after: ref(i + 1), tool: 'Edit' }],
}))

for (let i = 0; i < 3; i++) foldBatches(emptyLedger, batches)
const start = performance.now()
const runs = 10
for (let i = 0; i < runs; i++) foldBatches(emptyLedger, batches)
const ms = (performance.now() - start) / runs
console.log(`ok   fold 5000 batches / 200 files ${ms.toFixed(2).padStart(8)} ms`)
