import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, describe, mock, test } from 'node:test'

import { emptyLedger02, foldEvents02, idOfFileName02, parseEventText02 } from '@core/legacy02'

import { blobPath, ledgerDirFor } from '../../src/ledger/layout'
import { importOldSessions, migrate02 } from '../../src/ledger/migrate'
import { measureAll, storageCandidates } from '../../src/ledger/storage'
import { LedgerStore } from '../../src/ledger/store'
import { cleanTemps, perf, ref, tempDir, testLog } from './support'

after(cleanTemps)

let n = 0
const event02 = (at: number, e: Record<string, unknown>): string => {
  const id = `${at.toString(36).padStart(10, '0')}-mod-${(n++).toString(36).padStart(6, '0')}-ab`
  return JSON.stringify({ id, at, ...e })
}

/** A 0.2 ledger: meta.json, one file per event, flat blobs, and a per-session shadow repo that must stay unopened. */
const oldLedger = (legacyDir: string, name: string, root: string, events: readonly string[], blobs: readonly string[]): string => {
  const dir = path.join(legacyDir, 'ledgers', name)
  mkdirSync(path.join(dir, 'events'), { recursive: true })
  mkdirSync(path.join(dir, 'blobs'), { recursive: true })
  mkdirSync(path.join(dir, 'sessions', 's1', 'shadow.git', 'objects'), { recursive: true })
  writeFileSync(path.join(dir, 'sessions', 's1', 'shadow.git', 'objects', 'pack'), 'x')
  writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ root, importedSessions: [] }))
  for (const e of events) {
    const parsed: unknown = JSON.parse(e)
    const id = typeof parsed === 'object' && parsed !== null && 'id' in parsed && typeof parsed.id === 'string' ? parsed.id : 'bad'
    writeFileSync(path.join(dir, 'events', `${id}.json`), e)
  }
  for (const text of blobs) writeFileSync(path.join(dir, 'blobs', ref(text)), text)
  return dir
}

/** Every path the fs layer is asked about while `run` runs. */
const watchPaths = async <T>(run: () => Promise<T>): Promise<{ result: T; paths: string[] }> => {
  const paths: string[] = []
  const methods = ['readdir', 'readFile', 'stat', 'lstat', 'open', 'copyFile'] as const
  const mocks = methods.map(m => {
    const original = fsp[m].bind(fsp)
    return mock.method(fsp, m, (...args: unknown[]) => {
      paths.push(String(args[0]))
      return Reflect.apply(original, fsp, args)
    })
  })
  try {
    return { result: await run(), paths }
  } finally {
    for (const m of mocks) m.mock.restore()
  }
}

describe('migration from 0.2', () => {
  test('routes, copies blobs, skips big ones, picks the newest record, never opens sessions, runs once', async () => {
    const base = tempDir('cr-mig-')
    const legacyDir = path.join(base, 'legacy')
    const dataDir = path.join(base, 'v2')
    const work = path.join(base, 'work')
    mkdirSync(path.join(work, 'child', '.git'), { recursive: true })
    const big = 'B'.repeat(5 * 1024 * 1024)
    const log = testLog()
    oldLedger(
      legacyDir,
      'aaaa',
      work,
      [
        event02(10, { kind: 'turn', session: 's1', turn: 't1', prompt: 'old prompt' }),
        event02(11, { kind: 'edit', session: 's1', turn: 't1', path: `${work}/a.ts`, before: ref('a0'), after: ref('a1') }),
      ],
      ['a0', 'a1'],
    )
    oldLedger(
      legacyDir,
      'bbbb',
      work,
      [
        event02(20, { kind: 'turn', session: 's2', turn: 't1', prompt: 'new prompt' }),
        event02(21, { kind: 'edit', session: 's2', turn: 't1', path: `${work}/a.ts`, before: ref('a1'), after: ref('a2') }),
        event02(22, { kind: 'edit', session: 's2', turn: 't1', path: `${work}/child/b.ts`, before: null, after: ref('b1') }),
        event02(23, { kind: 'edit', session: 's2', turn: 't1', path: `${work}/big.txt`, before: null, after: ref(big) }),
        event02(24, { kind: 'edit', session: 's2', turn: 't1', path: `${work}/done.ts`, before: ref('d0'), after: ref('d1') }),
        event02(25, { kind: 'settle', path: `${work}/done.ts` }),
      ],
      ['a1', 'a2', 'b1', big, 'd0', 'd1'],
    )
    oldLedger(legacyDir, 'cccc', '/somewhere/else', [event02(30, { kind: 'edit', session: 's3', turn: 't', path: '/somewhere/else/x', before: null, after: ref('x') })], ['x'])

    const written: string[] = []
    const deps = { legacyDir, dataDir, folders: [work], log, onWritten: (d: string) => void written.push(d) }
    const { result, paths } = await watchPaths(() => migrate02(deps))
    assert.deepEqual(result, { ledgers: 2, files: 2, skippedBlobs: 1 })
    assert.deepEqual(paths.filter(p => p.includes(`${path.sep}sessions`)), [], 'sessions/*/shadow.git is never opened')
    assert.ok(log.lines.some(l => l.includes('over 4 MiB')), 'the big blob is skipped with a log line')

    const workLedger = ledgerDirFor(dataDir, work)
    const childLedger = ledgerDirFor(dataDir, path.join(work, 'child'))
    assert.deepEqual([...written].sort(), [childLedger, workLedger].sort())
    const store = new LedgerStore(workLedger, log, perf())
    await store.start()
    assert.deepEqual([...store.ledger.files.keys()], [`${work}/a.ts`])
    assert.equal(store.ledger.files.get(`${work}/a.ts`)?.entries[0]?.after, ref('a2'), 'the newer record wins')
    assert.equal([...store.ledger.sessions.values()][0]?.title, 'new prompt')
    assert.ok(existsSync(blobPath(workLedger, ref('a2'))))
    store.dispose()
    const child = new LedgerStore(childLedger, log, perf())
    await child.start()
    assert.deepEqual([...child.ledger.files.keys()], [`${work}/child/b.ts`])
    child.dispose()
    assert.equal(JSON.parse(readFileSync(path.join(childLedger, 'meta.json'), 'utf8')).root, path.join(work, 'child'))
    assert.ok(existsSync(path.join(legacyDir, 'ledgers', 'aaaa', 'migrated-v2.json')))
    assert.ok(!existsSync(path.join(legacyDir, 'ledgers', 'cccc', 'migrated-v2.json')), 'another folder’s ledger is left alone')

    assert.deepEqual(await migrate02(deps), { ledgers: 0, files: 0, skippedBlobs: 0 }, 'once per old ledger')
    const candidates = await storageCandidates(legacyDir, path.join(base, 'nosessions'))
    assert.deepEqual(candidates.map(c => path.basename(c.path)).sort(), ['aaaa', 'bbbb', 'shadow.git'])
    const measured = await measureAll(candidates, { isCancelled: () => false })
    assert.ok(measured.every(m => m.bytes > 0 && m.files > 0))
  })

  const REAL = path.join(os.homedir(), '.claude', 'claude-review', 'ledgers', '7c35f208d9cc5d26')
  test('a copy of a real 0.2 ledger migrates every pending file', { skip: !existsSync(REAL) && 'no real 0.2 ledger on this machine' }, async () => {
    const base = tempDir('cr-real-')
    const legacyDir = path.join(base, 'legacy')
    const copy = path.join(legacyDir, 'ledgers', '7c35f208d9cc5d26')
    for (const part of ['meta.json', 'events', 'blobs', 'snapshot.json']) {
      if (existsSync(path.join(REAL, part))) cpSync(path.join(REAL, part), path.join(copy, part), { recursive: true })
    }
    mkdirSync(path.join(copy, 'sessions', 'decoy', 'shadow.git'), { recursive: true })
    const root: unknown = JSON.parse(readFileSync(path.join(copy, 'meta.json'), 'utf8')).root
    assert.equal(typeof root, 'string')
    const names = readdirSync(path.join(copy, 'events')).filter(nm => idOfFileName02(nm) !== undefined)
    const legacy = foldEvents02(
      emptyLedger02,
      names.flatMap(nm => {
        const e = parseEventText02(readFileSync(path.join(copy, 'events', nm), 'utf8'))
        return e ? [e] : []
      }),
    )
    const log = testLog()
    const { result, paths } = await watchPaths(() => migrate02({ legacyDir, dataDir: path.join(base, 'v2'), folders: [String(root)], log, onWritten: () => undefined }))
    assert.deepEqual(paths.filter(p => p.includes(`${path.sep}sessions`)), [])
    assert.equal(result.files + result.skippedBlobs, legacy.files.size)
    assert.deepEqual(log.lines.filter(l => l.startsWith('error')), [])
  })
})

describe('importOldSessions (0.1)', () => {
  test('imports pending files of this window’s sessions once, reading only review.json and its blobs', async () => {
    const base = tempDir('cr-v1-')
    const sessionsDir = path.join(base, 'session-review')
    const dataDir = path.join(base, 'v2')
    const work = path.join(base, 'work')
    mkdirSync(work, { recursive: true })
    const session = path.join(sessionsDir, 'sess-1')
    mkdirSync(path.join(session, 'shadow.git'), { recursive: true })
    for (const t of ['x0', 'x1']) writeFileSync(path.join(session, ref(t)), t)
    writeFileSync(
      path.join(session, 'review.json'),
      JSON.stringify({
        sessionId: 'sess-1',
        cwd: work,
        files: [{ path: `${work}/x.ts`, baseRef: ref('x0'), entries: [{ turnId: 't1', beforeRef: ref('x0'), afterRef: ref('x1'), isResolved: false }] }],
        turns: [{ turnId: 't1', prompt: 'fix x' }],
      }),
    )
    const deps = { sessionsDir, legacyDir: base, dataDir, folders: [work], log: testLog(), onWritten: () => undefined }
    const { result, paths } = await watchPaths(() => importOldSessions(deps))
    assert.deepEqual(result, { ledgers: 1, files: 1, skippedBlobs: 0 })
    assert.deepEqual(paths.filter(p => p.includes('shadow.git')), [])
    const store = new LedgerStore(ledgerDirFor(dataDir, work), testLog(), perf())
    await store.start()
    assert.equal(store.ledger.files.get(`${work}/x.ts`)?.entries[0]?.tool, 'Import')
    assert.equal([...store.ledger.turns.values()][0]?.prompt, 'fix x')
    store.dispose()
    assert.equal((await importOldSessions(deps)).files, 0, 'each session once')
  })
})
