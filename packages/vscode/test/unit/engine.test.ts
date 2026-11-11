import assert from 'node:assert/strict'
import * as path from 'node:path'
import { after, describe, test } from 'node:test'

import { toSessionId, turnKey } from '@core/ids'

import { WorkerPool } from '../../src/review/diffPool'
import { disposeHarnesses, flush, harness, type Harness } from './engineHarness'
import { cleanTemps, testLog } from './support'

after(() => {
  disposeHarnesses()
  cleanTemps()
})

const lines = (n: number, tag = ''): string => Array.from({ length: n }, (_, i) => `line ${i + 1}${tag}\n`).join('')
const BASE = lines(30)
const LIVE = BASE.replace('line 3\n', 'line 3 changed\n').replace('line 20\n', '').replace('line 28\n', 'line 28\nnew line\n')
const A = '/w/a.ts'
const B = '/w/b.ts'

const ready = (h: Harness, p: string) => {
  const d = h.model.get(p)?.diff
  return d?.kind === 'ready' ? d : undefined
}

const records = (h: Harness): string[] => [...h.store.ledger.files.keys()]

describe('scheduler', () => {
  test('typing waits for 150 ms of quiet, but never more than 600 ms', async () => {
    const h = await harness()
    await h.edit(A, BASE, LIVE)
    await h.settled()
    const runs = h.runner.runs
    for (let i = 0; i < 3; i++) {
      h.live.set(A, `${LIVE}x${i}\n`, true)
      h.scheduler.request(A, 'typing')
      await h.timers.advance(100)
    }
    assert.equal(h.runner.runs, runs, 'still typing: no diff')
    await h.timers.advance(60)
    assert.equal(h.runner.runs, runs + 1, 'one diff after a 150 ms pause')
    for (let i = 0; i < 8; i++) {
      h.live.set(A, `${LIVE}y${i}\n`, true)
      h.scheduler.request(A, 'typing')
      await h.timers.advance(100)
    }
    assert.equal(h.runner.runs, runs + 2, 'max-wait forced one diff during 800 ms of typing')
  })

  test('skips a diff when neither base nor live moved, and never for ledger or action', async () => {
    const h = await harness()
    await h.edit(A, BASE, LIVE)
    await h.settled()
    const runs = h.runner.runs
    for (const reason of ['visible', 'external', 'startup', 'typing'] as const) h.scheduler.request(A, reason)
    await h.timers.advance(200)
    await h.settled()
    assert.equal(h.runner.runs, runs)
    assert.ok(h.perf.diffsSkipped >= 1)
    h.scheduler.request(A, 'action')
    await h.settled()
    assert.equal(h.runner.runs, runs + 1)
  })

  test('a result superseded by a newer request is dropped', async () => {
    const h = await harness()
    await h.edit(A, BASE, LIVE)
    await h.settled()
    h.runner.hold()
    h.live.set(A, `${LIVE}old\n`, true)
    h.scheduler.request(A, 'visible')
    await flush()
    h.live.set(A, BASE, true)
    h.scheduler.request(A, 'visible')
    h.runner.release()
    await h.settled()
    assert.equal(h.model.get(A)?.diff.kind, 'clean', 'only the newest text was applied')
  })

  test('a file over maxDiffBytes is tooLarge and never read: 20 MB on disk, 6 MB open', async () => {
    const h = await harness()
    h.live.sizes.set(A, 20 * 1024 * 1024)
    h.live.sizes.set(B, 6 * 1024 * 1024)
    h.live.set(B, 'x', true)
    await h.edit(A, BASE, LIVE)
    await h.edit(B, BASE, LIVE)
    h.live.sizes.set(A, 20 * 1024 * 1024)
    h.live.sizes.set(B, 6 * 1024 * 1024)
    h.live.reads.length = 0
    h.scheduler.request(A, 'visible')
    h.scheduler.request(B, 'visible')
    await h.settled()
    assert.deepEqual(h.model.get(A)?.diff, { kind: 'tooLarge', bytes: 20 * 1024 * 1024 })
    assert.deepEqual(h.model.get(B)?.diff, { kind: 'tooLarge', bytes: 6 * 1024 * 1024 })
    assert.deepEqual(h.live.reads, [], 'neither text was read')
  })
})

describe('model signals', () => {
  test('fire once per change, and not at all when nothing changed', async () => {
    const h = await harness()
    const seen: string[] = []
    h.model.onMembership(() => seen.push('membership'))
    h.model.onCounts(ps => seen.push(`counts ${[...ps].join()}`))
    h.model.onLayout(ps => seen.push(`layout ${[...ps].join()}`))
    h.model.onBase(ps => seen.push(`base ${[...ps].join()}`))
    await h.edit(A, BASE, LIVE)
    await h.settled()
    assert.deepEqual(seen, ['membership', `counts ${A}`, `layout ${A}`])
    seen.length = 0
    h.live.set(A, LIVE.replace('line 3 changed', 'line 3 CHANGED'), true)
    h.scheduler.request(A, 'typing')
    await h.timers.advance(200)
    await h.settled()
    assert.deepEqual(seen, [], 'a change inside an added line moves no hunk and no count')
    h.scheduler.request(A, 'action')
    await h.settled()
    assert.deepEqual(seen, [])
  })
})

describe('actions (§7.6)', () => {
  const twoTurns = async (): Promise<Harness> => {
    const h = await harness()
    const t1 = BASE.replace('line 5\n', 'line 5 by t1\n')
    const t2 = t1.replace('line 25\n', 'line 25 by t2\n')
    await h.edit(A, BASE, t1, 't1')
    await h.edit(A, t1, t2, 't2')
    await h.edit(B, null, 'new file\n', 't2')
    await h.settled()
    return h
  }

  test('keepHunk moves the base; settles once nothing is left', async () => {
    const h = await harness()
    await h.edit(A, BASE, LIVE)
    await h.settled()
    const views = ready(h, A)?.hunks ?? []
    assert.equal(views.length, 3)
    for (const v of views) {
      const r = await h.actions.keepHunk({ path: A, start: v.startLine, sig: v.sig })
      assert.equal(r.kind, 'done')
      await h.settled()
    }
    assert.deepEqual(records(h), [], 'the last kept hunk settles the file')
    assert.equal(h.live.text(A), LIVE, 'keeping never edits the file')
  })

  test('undoHunk edits only that range; deleting a created file undoes it', async () => {
    const h = await harness()
    await h.edit(A, BASE, LIVE)
    await h.edit(B, null, 'only\n')
    await h.settled()
    const [first] = ready(h, A)?.hunks ?? []
    assert.ok(first)
    await h.actions.undoHunk({ path: A, start: first.startLine, sig: first.sig })
    await h.settled()
    assert.equal(h.live.text(A), LIVE.replace('line 3 changed\n', 'line 3\n'))
    assert.equal(ready(h, A)?.hunks.length, 2)
    const [created] = ready(h, B)?.hunks ?? []
    assert.ok(created)
    await h.actions.undoHunk({ path: B, start: created.startLine, sig: created.sig })
    await h.settled()
    assert.equal(h.live.text(B), null)
    assert.deepEqual(records(h), [A])
  })

  test('a hunk is found again by its sig after the text moved; a gone one is reported', async () => {
    const h = await harness()
    await h.edit(A, BASE, LIVE)
    await h.settled()
    const third = ready(h, A)?.hunks[2]
    assert.ok(third)
    h.live.set(A, `inserted\nlines\n${LIVE}`, true)
    h.scheduler.request(A, 'typing')
    const r = await h.actions.undoHunk({ path: A, start: third.startLine, sig: third.sig })
    assert.equal(r.kind, 'done', 'settle flushed the typing first, then the sig matched')
    assert.ok(!h.live.text(A)?.includes('new line'))
    assert.deepEqual(await h.actions.keepHunk({ path: A, start: 0, sig: 'deadbeef' }), { kind: 'moved' })
  })

  test('keepMapping and undoMapping, as the diff gutter sends them', async () => {
    const h = await harness()
    await h.edit(A, BASE, LIVE)
    await h.settled()
    await h.actions.keepMapping(A, BASE.replace('line 3\n', 'line 3 changed\n'))
    await h.settled()
    assert.equal(ready(h, A)?.hunks.length, 2)
    const removal = ready(h, A)?.hunks.find(v => v.added.length === 0)
    assert.ok(removal)
    const baseLine = removal.hunk.oldIdx + removal.hunk.lines.findIndex(l => l.op === '-')
    const liveLine = removal.removed[0]?.line ?? 0
    await h.actions.undoMapping(A, { start: baseLine, end: baseLine + 1 }, { start: liveLine, end: liveLine })
    await h.settled()
    assert.ok(h.live.text(A)?.includes('line 20\n'))
    assert.equal(ready(h, A)?.hunks.length, 1)
  })

  test('keepFile settles; undoFile puts the base back and settles', async () => {
    const h = await harness()
    await h.edit(A, BASE, LIVE)
    await h.edit(B, null, 'created\n')
    await h.settled()
    await h.actions.keepFile(A)
    await h.actions.undoFile(B)
    await h.settled()
    assert.deepEqual(records(h), [])
    assert.equal(h.live.text(A), LIVE)
    assert.equal(h.live.text(B), null)
  })

  test('keepTurn and undoTurn act on one turn and leave the other', async () => {
    const h = await twoTurns()
    await h.actions.undoTurn(turnKey(toSessionId('s1'), 't1'))
    await h.settled()
    assert.equal(h.live.text(A), BASE.replace('line 25\n', 'line 25 by t2\n'))
    await h.actions.keepTurn(turnKey(toSessionId('s1'), 't2'))
    await h.settled()
    assert.deepEqual(records(h), [], 'nothing left after t1 undone and t2 kept')
    assert.equal(h.live.text(B), 'new file\n')
  })

  test('an undo over a later overlapping edit reports the conflict and leaves that file', async () => {
    const h = await twoTurns()
    h.live.set(A, (h.live.text(A) ?? '').replace('line 5 by t1\n', 'line 5 rewritten\n'), true)
    h.scheduler.request(A, 'typing')
    const r = await h.actions.undoTurn(turnKey(toSessionId('s1'), 't1'))
    assert.deepEqual(r, { kind: 'conflicts', done: [], conflicts: [A] })
    assert.ok(h.live.text(A)?.includes('rewritten'))
  })

  test('keepSession keeps its turns oldest first; undoSession undoes newest first', async () => {
    const kept = await twoTurns()
    await kept.actions.keepSession(toSessionId('s1'))
    await kept.settled()
    assert.deepEqual(records(kept), [])
    const undone = await twoTurns()
    await undone.actions.undoSession(toSessionId('s1'))
    await undone.settled()
    assert.equal(undone.live.text(A), BASE)
    assert.equal(undone.live.text(B), null)
    assert.deepEqual(records(undone), [])
    assert.equal(undone.live.applied.length, 1, 'one undoable edit for the whole session')
  })

  test('keepAll and undoAll', async () => {
    const kept = await twoTurns()
    await kept.actions.keepAll()
    await kept.settled()
    assert.deepEqual(records(kept), [])
    assert.ok(kept.live.text(A)?.includes('by t2'))
    const undone = await twoTurns()
    await undone.actions.undoAll()
    await undone.settled()
    assert.deepEqual(records(undone), [])
    assert.equal(undone.live.text(A), BASE)
  })

  test('revertLastKeep puts the previous base back', async () => {
    const h = await harness()
    await h.edit(A, BASE, LIVE)
    await h.settled()
    const [first] = ready(h, A)?.hunks ?? []
    assert.ok(first)
    await h.actions.keepHunk({ path: A, start: first.startLine, sig: first.sig })
    await h.settled()
    assert.equal(ready(h, A)?.hunks.length, 2)
    await h.actions.revertLastKeep()
    await h.settled()
    assert.equal(ready(h, A)?.hunks.length, 3)
    assert.deepEqual(await h.actions.revertLastKeep(), { kind: 'nothing' })
  })

  test('an action marks its paths so their next edit is not taken for typing', async () => {
    const h = await harness()
    await h.edit(A, BASE, LIVE)
    await h.settled()
    await h.actions.undoFile(A)
    assert.deepEqual([...h.actionPaths], [A])
  })
})

describe('WorkerPool', () => {
  const workerFile = path.resolve(__dirname, '..', '..', 'dist', 'diffWorker.js')

  test('diffs in a worker, sends the base once, and restarts after a crash', async () => {
    const pool = new WorkerPool(workerFile, testLog())
    let sentBase = 0
    const base = (): string => {
      sentBase++
      return BASE
    }
    const first = await pool.diff({ baseKey: 'k1', base, live: LIVE })
    assert.equal(first.hunks.length, 3)
    assert.deepEqual([first.added, first.removed], [2, 2])
    const second = await pool.diff({ baseKey: 'k1', base, live: BASE })
    assert.equal(second.hunks.length, 0)
    assert.equal(sentBase, 1, 'the worker kept the base')
    const big = lines(20_000)
    const third = await pool.diff({ baseKey: 'k2', base: () => big, live: big.replace('line 9999\n', 'x\n') })
    assert.deepEqual([third.hunks.length, third.added, third.removed, third.hunks[0]?.hunk.lines.length], [1, 1, 1, 8])
    pool.dispose()
    const again = new WorkerPool(workerFile, testLog())
    assert.equal((await again.diff({ baseKey: 'k1', base: () => BASE, live: LIVE })).hunks.length, 3)
    again.dispose()
  })
})
