import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { dirnameOf, isNormalPath, normalizePath, parseBatch, parseMeta, parseSnapshot } from '../src/events'
import { batch, ref, S1 } from './support/fixtures'

describe('events', () => {
  const good = batch([
    { kind: 'session', session: S1, title: 'fix it', cwd: '/w' },
    { kind: 'turn', session: S1, turn: 't1', prompt: 'fix it' },
    { kind: 'edit', session: S1, turn: 't1', path: '/w/a.ts', before: ref('a'), after: null, tool: 'Edit' },
  ])

  test('a whole batch parses back to itself', () => {
    assert.deepEqual(parseBatch(JSON.stringify(good)), { ok: true, value: good })
  })

  test('a partial file is not whole', () => {
    const text = JSON.stringify(good)
    for (const cut of [0, 1, 10, text.length - 1]) assert.equal(parseBatch(text.slice(0, cut)).ok, false)
  })

  test('the guard rejects bad events, refs, tools and paths', () => {
    const bad = (e: unknown): boolean => parseBatch(JSON.stringify({ ...good, events: [e] })).ok
    assert.equal(bad({ kind: 'nope' }), false)
    assert.equal(bad({ kind: 'keep', path: '/a', base: 'xyz' }), false)
    assert.equal(bad({ kind: 'keep', path: 'rel/a', base: null }), false)
    assert.equal(bad({ kind: 'edit', session: 's', turn: 't', path: '/a', before: null, after: null, tool: 'Rm' }), false)
    assert.equal(bad({ kind: 'resolve', path: '/a', turn: 'noColon' }), false)
    assert.equal(bad({ kind: 'resolve', path: '/a', turn: null }), true)
    assert.equal(parseBatch(JSON.stringify({ ...good, v: 1 })).ok, false)
  })

  test('isNormalPath', () => {
    assert.ok(isNormalPath('/'))
    assert.ok(isNormalPath('/a/b c/d.ts'))
    for (const p of ['a', '/a/', '/a//b', '/a/./b', '/a/../b', '']) assert.ok(!isNormalPath(p), p)
  })

  test('normalizePath and dirnameOf', () => {
    assert.equal(normalizePath('a/./b/../c.ts', '/w'), '/w/a/c.ts')
    assert.equal(normalizePath('/x//y/', '/w'), '/x/y')
    assert.equal(normalizePath('../../..', '/w'), '/')
    assert.ok(isNormalPath(normalizePath('./q', '/w/')))
    assert.equal(dirnameOf('/w/a.ts'), '/w')
    assert.equal(dirnameOf('/a'), '/')
  })

  test('snapshot and meta', () => {
    const snap = { v: 2, gen: 3, last: null, files: [], turns: [], sessions: [] }
    assert.deepEqual(parseSnapshot(JSON.stringify(snap)), { ok: true, value: snap })
    assert.equal(parseSnapshot(JSON.stringify({ ...snap, gen: -1 })).ok, false)
    assert.equal(parseMeta(JSON.stringify({ v: 2, root: '/w', createdAt: 1 })).ok, true)
    assert.equal(parseMeta(JSON.stringify({ root: '/w', importedSessions: [] })).ok, false)
  })
})
