import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { diffHunks } from '../src/diff'
import { keepTurnsText, keepTurnText, standingOf, undoTurnsText, undoTurnText } from '../src/model'
import { keepHunk, patch, undoHunk } from '../src/patch'

const lines = (...ls: string[]): string => ls.map(l => `${l}\n`).join('')

describe('patch', () => {
  test('applies a hunk that moved', () => {
    const before = lines('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h')
    const after = lines('a', 'b', 'c', 'D', 'e', 'f', 'g', 'h')
    const moved = lines('x', 'y', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h')
    const res = patch(moved, diffHunks(before, after), 'forward')
    assert.ok(res.ok)
    assert.equal(res.text, lines('x', 'y', 'a', 'b', 'c', 'D', 'e', 'f', 'g', 'h'))
  })

  test('fails when the lines are gone', () => {
    assert.deepEqual(patch(lines('q'), diffHunks(lines('a'), lines('b')), 'forward'), { ok: false })
  })

  test('keepHunk and undoHunk', () => {
    const base = lines('a', 'b', 'c')
    const live = lines('a', 'B', 'c')
    const [h] = diffHunks(base, live)
    assert.ok(h)
    assert.equal(keepHunk(base, h), live)
    assert.equal(undoHunk(live, h), base)
  })
})

describe('turns', () => {
  const t0 = lines('one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten')
  const t1 = t0.replace('two\n', 'TWO\n')
  const t2 = t1.replace('nine\n', 'NINE\n')

  test('standingOf', () => {
    const [h] = diffHunks(t0, t1)
    assert.ok(h)
    assert.equal(standingOf(h, t0, t1), 'pending')
    assert.equal(standingOf(h, t1, t1), 'kept')
    assert.equal(standingOf(h, t0, t0), 'undone')
    assert.equal(standingOf(h, t0, t0.replace('two\n', 'zwei\n')), 'edited')
  })

  test('keepTurnText moves only that turn into the base', () => {
    assert.deepEqual(keepTurnText(t0, t2, t1, t2), { ok: true, text: t0.replace('nine\n', 'NINE\n') })
  })

  test('undoTurnText takes only that turn out of the live text', () => {
    assert.deepEqual(undoTurnText(t0, t2, t0, t1), { ok: true, text: t2.replace('TWO\n', 'two\n') })
  })

  test('a created file undone goes back to absent', () => {
    assert.deepEqual(undoTurnText(null, 'x\n', null, 'x\n'), { ok: true, text: null })
  })

  test('keepTurnsText keeps oldest first on an evolving base', () => {
    assert.deepEqual(keepTurnsText(t0, t2, [{ before: t0, after: t1 }, { before: t1, after: t2 }]), { ok: true, text: t2 })
  })

  test('undoTurnsText undoes newest first on an evolving current', () => {
    assert.deepEqual(undoTurnsText(t0, t2, [{ before: t0, after: t1 }, { before: t1, after: t2 }]), { ok: true, text: t0 })
  })

  test('undoTurnsText fails on the first conflict', () => {
    const edited = t2.replace('TWO\n', 'deux\n')
    assert.deepEqual(undoTurnsText(t0, edited, [{ before: t0, after: t1 }, { before: t1, after: t2 }]), { ok: false })
  })
})
