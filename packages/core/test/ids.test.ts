import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  batchId, batchIdOfFileName, extensionWriter, fileNameOf, isRef, modWriter, nonce4, parseSnapshotFileName, snapshotFileName, timeOfBatchId, toSessionId, turnKey,
} from '../src/ids'

describe('ids', () => {
  test('batch ids sort in time order and round-trip through file names', () => {
    const a = batchId(1000, 'm2503fa', 5, 'abcd')
    const b = batchId(1001, 'x1a2', 0, '0000')
    const c = batchId(1001, 'x1a2', 1, '0000')
    assert.ok(a < b && b < c)
    assert.equal(batchIdOfFileName(fileNameOf(a)), a)
    assert.equal(timeOfBatchId(a), 1000)
    assert.equal(batchIdOfFileName(`${a}.json.123.ab.tmp`), undefined)
    assert.equal(batchIdOfFileName('snapshot.json'), undefined)
  })

  test('rejects writers that are not 1-12 of [a-z0-9]', () => {
    assert.throws(() => batchId(1, 'Mixed', 0, '0000'))
    assert.throws(() => batchId(1, 'abcdefghijklm', 0, '0000'))
  })

  test('writers', () => {
    assert.equal(modWriter(toSessionId('2503FA-77c1-4e')), 'm2503fa')
    assert.equal(extensionWriter(36 ** 3), 'x1000')
    assert.match(nonce4(() => 0.5), /^[0-9a-z]{4}$/)
    assert.match(nonce4(() => 0), /^[0-9a-z]{4}$/)
  })

  test('turn keys and refs', () => {
    assert.equal(turnKey(toSessionId('s'), 't'), 's:t')
    assert.ok(isRef('a'.repeat(64)))
    assert.ok(!isRef('A'.repeat(64)))
  })

  test('snapshot file names', () => {
    const last = batchId(5, 'x1', 0, '0000')
    const name = snapshotFileName(7, last)
    assert.match(name, /^00000007-/)
    assert.deepEqual(parseSnapshotFileName(name), { gen: 7, last })
    assert.equal(parseSnapshotFileName('snapshot.json'), undefined)
  })
})
