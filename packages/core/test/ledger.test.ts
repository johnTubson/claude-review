import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { parseSnapshot } from '../src/events'
import { turnKey } from '../src/ids'
import { emptyLedger, foldBatches, fromSnapshot, openSessions, openTurns, refsOf, refsOfBatches, toSnapshot, wholePrefix } from '../src/ledger'
import { batch, nextId, ref, S1, S2 } from './support/fixtures'

const A = '/w/a.ts'
const B = '/w/b.ts'
const T1 = turnKey(S1, 't1')
const T2 = turnKey(S1, 't2')
const T3 = turnKey(S2, 't1')

describe('foldBatches', () => {
  const b1 = batch([
    { kind: 'session', session: S1, title: '', cwd: '/w' },
    { kind: 'turn', session: S1, turn: 't1', prompt: 'first' },
    { kind: 'edit', session: S1, turn: 't1', path: A, before: ref('0'), after: ref('1'), tool: 'Edit' },
  ])
  const b2 = batch([
    { kind: 'edit', session: S1, turn: 't1', path: A, before: ref('1'), after: ref('2'), tool: 'Write' },
    { kind: 'edit', session: S1, turn: 't2', path: A, before: ref('2'), after: ref('3'), tool: 'Bash' },
    { kind: 'session', session: S1, title: 'titled later', cwd: '/w' },
  ])

  test('edit creates a record, extends the open entry of its turn, else appends', () => {
    const l = foldBatches(emptyLedger, [b1, b2])
    const rec = l.files.get(A)
    assert.equal(rec?.base, ref('0'))
    assert.deepEqual(
      rec?.entries.map(e => [e.turn, e.before, e.after, e.tool]),
      [
        [T1, ref('0'), ref('2'), 'Write'],
        [T2, ref('2'), ref('3'), 'Bash'],
      ],
    )
    assert.equal(l.turns.get(T1)?.prompt, 'first')
    assert.equal(l.turns.get(T2)?.n, 2)
    assert.equal(l.sessions.get(S1)?.title, 'titled later', 'an empty title is filled')
    assert.equal(l.last, b2.id)
  })

  test('never mutates its input and skips batches at or before last', () => {
    const l1 = foldBatches(emptyLedger, [b1])
    const snapshot = JSON.stringify(toSnapshot(l1, 1))
    const l2 = foldBatches(l1, [b1, b2])
    assert.equal(JSON.stringify(toSnapshot(l1, 1)), snapshot)
    assert.equal(foldBatches(l2, [b1, b2]), l2, 'nothing new: the same ledger')
    assert.equal(emptyLedger.files.size, 0)
  })

  test('keep, resolve, settle', () => {
    const l = foldBatches(emptyLedger, [
      b1,
      b2,
      batch([{ kind: 'keep', path: A, base: ref('2') }]),
      batch([{ kind: 'resolve', path: A, turn: T1 }]),
    ])
    assert.equal(l.files.get(A)?.base, ref('2'))
    assert.deepEqual(l.files.get(A)?.entries.map(e => e.isResolved), [true, false])
    const all = foldBatches(l, [batch([{ kind: 'resolve', path: A, turn: null }])])
    assert.deepEqual(all.files.get(A)?.entries.map(e => e.isResolved), [true, true])
    const settled = foldBatches(all, [batch([{ kind: 'settle', path: A }])])
    assert.equal(settled.files.has(A), false)
    const again = foldBatches(settled, [batch([{ kind: 'edit', session: S1, turn: 't3', path: A, before: ref('9'), after: ref('10'), tool: 'Edit' }])])
    assert.equal(again.files.get(A)?.base, ref('9'), 'a later edit starts a new baseline')
  })

  test('an edit after resolve opens a new entry for the same turn', () => {
    const l = foldBatches(emptyLedger, [
      b1,
      batch([{ kind: 'resolve', path: A, turn: T1 }]),
      batch([{ kind: 'edit', session: S1, turn: 't1', path: A, before: ref('1'), after: ref('5'), tool: 'Edit' }]),
    ])
    assert.equal(l.files.get(A)?.entries.length, 2)
  })

  test('import only creates missing records and adds its sessions and turns', () => {
    const imported = {
      kind: 'import' as const,
      path: A,
      base: ref('x'),
      entries: [{ turn: T3, before: ref('x'), after: ref('y'), isResolved: false, tool: 'Import' as const }],
      turns: [{ key: T3, session: S2, turn: 't1', prompt: 'old' }],
      sessions: [{ id: S2, title: 'old session', cwd: '/w' }],
    }
    const l = foldBatches(emptyLedger, [b1, batch([imported, { ...imported, path: B }])])
    assert.equal(l.files.get(A)?.base, ref('0'), 'the recorded edit wins')
    assert.equal(l.files.get(B)?.base, ref('x'))
    assert.equal(l.sessions.get(S2)?.title, 'old session')
    assert.equal(l.turns.get(T3)?.prompt, 'old')
  })
})

describe('projections and snapshots', () => {
  const l = foldBatches(emptyLedger, [
    batch([
      { kind: 'session', session: S1, title: 'one', cwd: '/w' },
      { kind: 'edit', session: S1, turn: 't1', path: A, before: null, after: ref('1'), tool: 'Write' },
      { kind: 'edit', session: S1, turn: 't2', path: B, before: ref('b'), after: ref('b2'), tool: 'Edit' },
      { kind: 'edit', session: S2, turn: 't1', path: B, before: ref('b2'), after: ref('b3'), tool: 'Edit' },
      { kind: 'resolve', path: B, turn: turnKey(S1, 't2') },
    ]),
  ])

  test('openTurns and openSessions', () => {
    assert.deepEqual(
      openTurns(l).map(t => [t.key, t.paths]),
      [
        [T1, [A]],
        [T3, [B]],
      ],
    )
    assert.deepEqual(
      openSessions(l).map(s => [s.id, s.title, s.turnKeys]),
      [
        [S1, 'one', [T1]],
        [S2, '', [T3]],
      ],
    )
    assert.deepEqual(openTurns(l, p => p !== A).map(t => t.key), [T3])
  })

  test('refsOf and refsOfBatches', () => {
    assert.deepEqual([...refsOf(l)].sort(), [ref('1'), ref('b'), ref('b2'), ref('b3')].sort())
    assert.deepEqual([...refsOfBatches([batch([{ kind: 'keep', path: A, base: ref('k') }])])], [ref('k')])
  })

  test('snapshot round trip', () => {
    const parsed = parseSnapshot(JSON.stringify(toSnapshot(l, 4)))
    assert.ok(parsed.ok)
    const back = fromSnapshot(parsed.value)
    assert.deepEqual([...back.files.values()], [...l.files.values()])
    assert.deepEqual([...back.turns.values()], [...l.turns.values()])
    assert.deepEqual([...back.sessions.values()], [...l.sessions.values()])
    assert.equal(back.last, l.last)
  })

  test('wholePrefix stops at the first pending batch and passes skipped ones', () => {
    const w1 = batch([])
    const w2 = batch([])
    assert.deepEqual(
      wholePrefix([{ state: 'whole', batch: w1 }, { state: 'skipped', id: nextId() }, { state: 'whole', batch: w2 }, { state: 'pending', id: nextId() }, { state: 'whole', batch: batch([]) }]),
      [w1, w2],
    )
  })
})
