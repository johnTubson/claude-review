import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { emptyLedger, foldBatches } from '../src/ledger'
import { batchId } from '../src/ids'
import { foldEvents02, fromSnapshot02, idOfFileName02, parseEventText02, toImportEvents, type Event02 } from '../src/legacy02'
import { ref } from './support/fixtures'

const ev = (n: number, e: Record<string, unknown>): Event02 => {
  const parsed = parseEventText02(JSON.stringify({ id: `0000000000-src-${n.toString(36).padStart(6, '0')}-n`, at: n, ...e }))
  if (!parsed) throw new Error(`bad fixture ${n}`)
  return parsed
}

describe('legacy02', () => {
  const events = [
    ev(2, { kind: 'edit', session: 's', turn: 't1', path: '/w/a', before: ref('0'), after: ref('1') }),
    ev(1, { kind: 'turn', session: 's', turn: 't1', prompt: 'p' }),
    ev(3, { kind: 'edit', session: 's', turn: 't1', path: 'relative', before: null, after: ref('1') }),
    ev(4, { kind: 'edit', session: 's', turn: 't1', path: '/x/b', before: null, after: ref('2') }),
  ]

  test('folds 0.2 events in id order', () => {
    const l = foldEvents02(fromSnapshot02({ lastId: undefined, files: [], turns: [] }) ?? { files: new Map(), turns: new Map(), lastId: undefined }, events)
    assert.equal(l.turns.get('s:t1')?.prompt, 'p')
    assert.equal(l.files.size, 3)
    assert.equal(idOfFileName02('lnzz000000-mod-000001-ab12.json'), 'lnzz000000-mod-000001-ab12')
    assert.equal(parseEventText02('{"id":'), undefined)
  })

  test('toImportEvents routes records, collects refs and skips what v2 cannot hold', () => {
    const l = foldEvents02({ files: new Map(), turns: new Map(), lastId: undefined }, events)
    const plan = toImportEvents(l, p => (p.startsWith('/x') ? 'X' : 'W'))
    assert.deepEqual([...plan.events.keys()].sort(), ['W', 'X'])
    assert.deepEqual(plan.skipped.map(s => s.path), ['relative'])
    assert.deepEqual([...plan.refs].sort(), [ref('0'), ref('1'), ref('2')].sort())
    const w = plan.events.get('W') ?? []
    const folded = foldBatches(emptyLedger, [{ v: 2, id: batchId(1, 'xmig', 0, '0000'), at: 1, writer: 'xmig', events: w }])
    assert.equal(folded.files.get('/w/a')?.entries[0]?.tool, 'Import')
    assert.equal(folded.sessions.size, 1)
    assert.equal(folded.turns.size, 1)
  })
})
