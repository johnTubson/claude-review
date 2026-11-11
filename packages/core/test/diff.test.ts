import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { countsOf } from '../src/counts'
import { countChanges, diffHunks, diffIds, editScript, editScriptOfLines, toUnified } from '../src/diff'
import { LineInterner, splitLines } from '../src/lines'
import { patch } from '../src/patch'
import { diffHunks02 } from './support/diff02'
import { mutate, randomText, seeded } from './support/random'

describe('splitLines', () => {
  test('keeps each newline with its line, and a last line without one', () => {
    assert.deepEqual(splitLines('a\nb\r\nc'), ['a\n', 'b\r\n', 'c'])
    assert.deepEqual(splitLines('a\n'), ['a\n'])
    assert.deepEqual(splitLines(''), [])
    assert.deepEqual(splitLines('\n\n'), ['\n', '\n'])
  })

  test('agrees with the 0.2 regex split', () => {
    const random = seeded(7)
    for (let i = 0; i < 500; i++) {
      const text = randomText(random, 30)
      assert.deepEqual(splitLines(text), text.match(/[^\n]*\n|[^\n]+$/g) ?? [])
    }
  })
})

describe('LineInterner', () => {
  test('equal lines get equal ids across texts', () => {
    const interner = new LineInterner()
    const a = interner.idsOf(['x\n', 'y\n', 'x\n'])
    const b = interner.idsOf(['y\n', 'z\n'])
    assert.deepEqual([...a], [0, 1, 0])
    assert.deepEqual([...b], [1, 2])
    assert.equal(interner.size, 3)
  })
})

describe('diffHunks', () => {
  test('property: patching forward gives after, and reverse gives before (10,000 cases)', () => {
    const random = seeded(42)
    for (let i = 0; i < 10_000; i++) {
      const a = randomText(random, 40)
      const b = random() < 0.1 ? randomText(random, 40) : mutate(random, a)
      const hunks = diffHunks(a, b)
      const forward = patch(a, hunks, 'forward')
      const reverse = patch(b, hunks, 'reverse')
      assert.ok(forward.ok && forward.text === b, `case ${i} forward: ${JSON.stringify({ a, b })}`)
      assert.ok(reverse.ok && reverse.text === a, `case ${i} reverse: ${JSON.stringify({ a, b })}`)
    }
  })

  test('parity with 0.2: the same hunks', () => {
    const random = seeded(1234)
    for (let i = 0; i < 3000; i++) {
      const a = randomText(random, 60)
      const b = mutate(random, a)
      const v2 = diffHunks(a, b)
      const old = diffHunks02(a, b)
      assert.equal(v2.length, old.length, `case ${i} hunk count`)
      assert.deepEqual(countChanges(v2), countChanges(old), `case ${i} counts`)
      assert.deepEqual(v2, old, `case ${i} hunks`)
    }
  })

  test('parity with 0.2 on large changes, which take the interned path', () => {
    const random = seeded(77)
    for (let i = 0; i < 300; i++) {
      const a = randomText(random, 300)
      let b = a
      for (let k = 0; k < 12; k++) b = mutate(random, b)
      assert.deepEqual(diffHunks(a, b), diffHunks02(a, b), `case ${i}`)
    }
  })

  test('the string quick pass and the interned pass give the same ops', () => {
    const random = seeded(5)
    for (let i = 0; i < 300; i++) {
      const a = splitLines(randomText(random, 200))
      const b = splitLines(randomText(random, 200))
      const interner = new LineInterner()
      assert.deepEqual(editScriptOfLines(a, b), editScript(interner.idsOf(a), interner.idsOf(b)), `case ${i}`)
    }
  })

  test('identical texts and empty sides', () => {
    assert.deepEqual(diffHunks('a\nb\n', 'a\nb\n'), [])
    assert.deepEqual(diffHunks('', ''), [])
    const created = diffHunks('', 'a\nb\n')
    assert.deepEqual(created, [{ oldIdx: 0, oldLen: 0, newIdx: 0, newLen: 2, lines: [{ op: '+', text: 'a\n' }, { op: '+', text: 'b\n' }] }])
    const deleted = diffHunks('a\nb\n', '')
    assert.equal(deleted[0]?.oldLen, 2)
    assert.equal(deleted[0]?.newLen, 0)
  })

  test('a missing final newline is a change of that line', () => {
    const hunks = diffHunks('a\nb\n', 'a\nb')
    assert.deepEqual(countChanges(hunks), { added: 1, removed: 1 })
    assert.equal(toUnified(hunks[0] ?? { oldIdx: 0, oldLen: 0, newIdx: 0, newLen: 0, lines: [] }), '@@ -1,2 +1,2 @@\n a\n-b\n+b')
  })

  test('CRLF lines differ from LF lines', () => {
    assert.deepEqual(countChanges(diffHunks('a\r\nb\r\n', 'a\r\nb\n')), { added: 1, removed: 1 })
  })

  test('context is 3 lines and nearby hunks merge', () => {
    const base = Array.from({ length: 30 }, (_, i) => `l${i}\n`).join('')
    const near = base.replace('l5\n', 'X\n').replace('l11\n', 'Y\n')
    assert.equal(diffHunks(base, near).length, 1, 'a gap of 5 lines merges')
    const far = base.replace('l5\n', 'X\n').replace('l13\n', 'Y\n')
    const hunks = diffHunks(base, far)
    assert.equal(hunks.length, 2, 'a gap of 7 lines does not')
    assert.equal(hunks[0]?.oldIdx, 2)
    assert.equal(hunks[0]?.oldLen, 7)
  })

  test('past maxEdits the middle becomes one replace, still exact', () => {
    const a = Array.from({ length: 200 }, (_, i) => `a${i}\n`).join('')
    const b = Array.from({ length: 200 }, (_, i) => (i % 2 ? `a${i}\n` : `b${i}\n`)).join('')
    const hunks = diffHunks(a, b, { maxEdits: 10 })
    assert.equal(hunks.length, 1)
    assert.deepEqual(countChanges(hunks), { added: 199, removed: 199 })
    const forward = patch(a, hunks, 'forward')
    assert.ok(forward.ok && forward.text === b)
  })

  test('diffIds returns null past the bound', () => {
    const a = Int32Array.from([1, 2, 3])
    const b = Int32Array.from([4, 5, 6])
    assert.equal(diffIds(a, b, 5), null)
    assert.deepEqual([...(diffIds(a, b, 6) ?? [])], [1, 1, 1, 2, 2, 2])
  })
})

describe('countsOf', () => {
  test('matches countChanges of the hunks, and reads null as empty', () => {
    const random = seeded(99)
    for (let i = 0; i < 1000; i++) {
      const a = randomText(random, 40)
      const b = mutate(random, a)
      assert.deepEqual(countsOf(a, b), countChanges(diffHunks(a, b)))
    }
    assert.deepEqual(countsOf(null, 'a\nb\n'), { added: 2, removed: 0 })
    assert.deepEqual(countsOf('a\n', null), { added: 0, removed: 1 })
  })
})
