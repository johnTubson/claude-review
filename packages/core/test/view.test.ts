import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { diffHunks } from '../src/diff'
import { focusedHunk, hunkAtLine, hunkBySig, hunkSig, layoutSignature, viewHunks } from '../src/view'

const base = Array.from({ length: 30 }, (_, i) => `line ${i + 1}\n`).join('')
const live = base.replace('line 3\n', 'line 3 changed\n').replace('line 20\n', '').replace('line 28\n', 'line 28\nnew line\n')

describe('view', () => {
  test('viewHunks places added lines and removed blocks', () => {
    const views = viewHunks(diffHunks(base, live))
    assert.equal(views.length, 3)
    assert.deepEqual(views[0]?.added, [2])
    assert.deepEqual(views[0]?.removed, [{ line: 2, text: ['line 3'] }])
    assert.deepEqual(views[1]?.added, [])
    assert.deepEqual(views[1]?.removed, [{ line: 19, text: ['line 20'] }])
    assert.deepEqual(views[2]?.added, [27])
  })

  test('hunkAtLine and focusedHunk', () => {
    const views = viewHunks(diffHunks(base, live))
    assert.equal(hunkAtLine(views, 2, 30)?.index, 0)
    assert.equal(hunkAtLine(views, 10, 30), undefined)
    assert.equal(focusedHunk(views, 10, 30)?.index, 1)
    assert.equal(focusedHunk(views, 29, 30)?.index, 2)
  })

  test('layoutSignature ignores content-only changes inside added lines', () => {
    const a = layoutSignature(viewHunks(diffHunks(base, live)))
    const b = layoutSignature(viewHunks(diffHunks(base, live.replace('line 3 changed', 'line 3 changed again'))))
    assert.equal(a, b)
    const c = layoutSignature(viewHunks(diffHunks(base, live.replace('new line\n', 'new line\nanother\n'))))
    assert.notEqual(a, c)
  })

  test('hunkSig identifies content, and hunkBySig re-finds a moved hunk', () => {
    const views = viewHunks(diffHunks(base, live))
    const target = views[2]
    assert.ok(target)
    const shifted = viewHunks(diffHunks(`zero\n${base}`, `zero\n${live}`))
    assert.equal(hunkSig(shifted[2]?.hunk ?? target.hunk), target.sig)
    assert.equal(hunkBySig(shifted, target.sig, target.startLine)?.startLine, target.startLine + 1)
    assert.equal(hunkBySig(shifted, 'nope', 0), undefined)
  })
})
