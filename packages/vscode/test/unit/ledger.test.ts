import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import * as http from 'node:http'
import * as path from 'node:path'
import { after, describe, test } from 'node:test'

import type { Batch, LedgerEvent } from '@core/events'
import { batchId, nonce4 } from '@core/ids'
import { emptyLedger, foldBatches, type Ledger } from '@core/ledger'

import { Blobs, BlobTooLargeError } from '../../src/ledger/blobs'
import { Bridge } from '../../src/ledger/bridge'
import { compact } from '../../src/ledger/compactor'
import { readSlots } from '../../src/ledger/disk'
import { Discovery } from '../../src/ledger/discovery'
import { blobPath, eventsDir, gcFile, ledgerDirFor, snapshotsDir } from '../../src/ledger/layout'
import { LedgerStore } from '../../src/ledger/store'
import type { Worktree } from '../../src/ledger/worktrees'
import { cleanTemps, perf, ref, S1, sleep, tempDir, testLog, until } from './support'

after(cleanTemps)

const shape = (l: Ledger): unknown => ({ files: [...l.files.values()], turns: [...l.turns.values()], sessions: [...l.sessions.values()] })

/** A writer like the mod: `$.fs.write` is not atomic, so the file can be read half-written. */
const writeLikeMod = (dir: string, batch: Batch): void => {
  const text = JSON.stringify(batch)
  const file = path.join(eventsDir(dir), `${batch.id}.json`)
  const cut = Math.floor(text.length / 2)
  writeFileSync(file, text.slice(0, cut))
  writeFileSync(file, text)
}

let modCounter = 0
const modBatch = (events: readonly LedgerEvent[], at = Date.now()): Batch => ({ v: 2, id: batchId(at, 'mtest', modCounter++, nonce4(Math.random)), at, writer: 'mtest', events })

describe('LedgerStore + compactor under concurrency', () => {
  test('two stores and a compactor while a third writer appends 1,000 batches: nothing lost, folds agree', async () => {
    const dir = path.join(tempDir(), 'ledger')
    const log = testLog()
    const a = new LedgerStore(dir, log, perf())
    const b = new LedgerStore(dir, log, perf())
    await Promise.all([a.start(), b.start()])
    const written: Batch[] = []
    let isWriting = true
    let compactions = 0
    const compactor = (async () => {
      while (isWriting) {
        const r = await compact(dir, log, { minAgeMs: 50 })
        if (r.kind === 'compacted') compactions++
        await sleep(5)
      }
    })()
    for (let i = 0; i < 1000; i++) {
      const path_ = `/w/f${i % 50}.ts`
      const batch = modBatch([
        ...(i % 100 === 0 ? [{ kind: 'turn' as const, session: S1, turn: `t${i / 100}`, prompt: `prompt ${i}` }] : []),
        { kind: 'edit', session: S1, turn: `t${Math.floor(i / 100)}`, path: path_, before: ref(`${i}`), after: ref(`${i + 1}`), tool: 'Edit' },
      ])
      writeLikeMod(dir, batch)
      written.push(batch)
      if (i % 97 === 0) written.push(await a.append([{ kind: 'keep', path: path_, base: ref(`${i + 1}`) }]))
      if (i % 50 === 0) await sleep(1)
    }
    isWriting = false
    await compactor
    const expected = foldBatches(emptyLedger, [...written].sort((x, y) => (x.id < y.id ? -1 : 1)))
    for (const store of [a, b]) {
      await until('the store catches up', async () => {
        await store.scan()
        return store.ledger.last === expected.last
      })
      assert.deepEqual(shape(store.ledger), shape(expected))
    }
    assert.ok(compactions > 0, 'compaction ran meanwhile')
    assert.ok(readdirSync(snapshotsDir(dir)).length <= 2, 'old snapshots are deleted')
    a.dispose()
    b.dispose()
  })

  test('a half-written batch holds back later ones until it is whole', async () => {
    const dir = path.join(tempDir(), 'ledger')
    const store = new LedgerStore(dir, testLog(), perf())
    await store.start()
    const first = modBatch([{ kind: 'edit', session: S1, turn: 't', path: '/w/a', before: null, after: ref('1'), tool: 'Write' }])
    const second = modBatch([{ kind: 'edit', session: S1, turn: 't', path: '/w/b', before: null, after: ref('2'), tool: 'Write' }])
    const firstFile = path.join(eventsDir(dir), `${first.id}.json`)
    writeFileSync(firstFile, JSON.stringify(first).slice(0, 20))
    writeFileSync(path.join(eventsDir(dir), `${second.id}.json`), JSON.stringify(second))
    await store.scan()
    assert.equal(store.ledger.files.size, 0, 'nothing folds ahead of the pending batch')
    writeFileSync(firstFile, JSON.stringify(first))
    await store.scan()
    assert.deepEqual([...store.ledger.files.keys()], ['/w/a', '/w/b'])
    store.dispose()
  })

  test('a batch still bad after 5 s is skipped, once', async () => {
    const dir = path.join(tempDir(), 'ledger')
    mkdirSync(eventsDir(dir), { recursive: true })
    const bad = modBatch([])
    writeFileSync(path.join(eventsDir(dir), `${bad.id}.json`), '{"v":2,')
    const firstBad = new Map()
    const skipped: string[] = []
    const opts = (now: number) => ({ now, firstBad, onSkip: (id: string) => void skipped.push(id) })
    assert.equal((await readSlots(dir, [bad.id], opts(1000)))[0]?.state, 'pending')
    assert.equal((await readSlots(dir, [bad.id], opts(4000)))[0]?.state, 'pending')
    assert.equal((await readSlots(dir, [bad.id], opts(6001)))[0]?.state, 'skipped')
    assert.deepEqual(skipped, [bad.id])
  })

  test('a late batch refolds from the snapshot', async () => {
    const dir = path.join(tempDir(), 'ledger')
    const store = new LedgerStore(dir, testLog(), perf())
    await store.start()
    const early = modBatch([{ kind: 'edit', session: S1, turn: 't', path: '/w/a', before: ref('0'), after: ref('1'), tool: 'Edit' }], 1000)
    const later = modBatch([{ kind: 'keep', path: '/w/a', base: ref('1') }], 2000)
    writeFileSync(path.join(eventsDir(dir), `${later.id}.json`), JSON.stringify(later))
    await store.scan()
    assert.equal(store.ledger.files.size, 0, 'a keep alone has no record to move')
    writeFileSync(path.join(eventsDir(dir), `${early.id}.json`), JSON.stringify(early))
    await store.scan()
    assert.equal(store.ledger.files.get('/w/a')?.base, ref('1'), 'the edit folded first, then the keep')
    store.dispose()
  })
})

describe('blob GC', () => {
  test('keeps every needed ref and young blobs, and keeps the mod’s shadowAt', async () => {
    const dir = path.join(tempDir(), 'ledger')
    const log = testLog()
    const store = new LedgerStore(dir, log, perf())
    await store.start()
    const blobs = new Blobs(64 * 1024 * 1024, () => 4 * 1024 * 1024)
    const needed = await blobs.put(dir, 'needed\n')
    const kept = await blobs.put(dir, 'kept by a young batch\n')
    const unneededOld = await blobs.put(dir, 'old garbage\n')
    const unneededYoung = await blobs.put(dir, 'young garbage\n')
    const hourAgo = Date.now() / 1000 - 3600
    for (const r of [needed, kept, unneededOld]) utimesSync(blobPath(dir, r), hourAgo, hourAgo)
    writeFileSync(gcFile(dir), JSON.stringify({ shadowAt: 42 }))
    await store.append([{ kind: 'edit', session: S1, turn: 't', path: '/w/a', before: null, after: needed, tool: 'Write' }])
    writeLikeMod(dir, modBatch([{ kind: 'keep', path: '/w/a', base: kept }], Date.now() + 10_000))
    const result = await compact(dir, log, { minAgeMs: 0 })
    assert.equal(result.kind, 'compacted')
    const exists = (r: string): boolean => readdirSync(path.join(dir, 'blobs', r.slice(0, 2))).includes(r)
    assert.ok(exists(needed))
    assert.ok(exists(kept), 'a batch the snapshot does not hold yet still keeps its blobs')
    assert.ok(!exists(unneededOld))
    assert.ok(exists(unneededYoung), 'younger than 10 minutes')
    const gc: unknown = JSON.parse(readFileSync(gcFile(dir), 'utf8'))
    assert.ok(typeof gc === 'object' && gc !== null && 'shadowAt' in gc && gc.shadowAt === 42 && 'blobsAt' in gc)
    store.dispose()
  })

  test('a held lock skips; a stale one is taken over', async () => {
    const dir = path.join(tempDir(), 'ledger')
    mkdirSync(eventsDir(dir), { recursive: true })
    writeLikeMod(dir, modBatch([{ kind: 'settle', path: '/w/a' }], 1000))
    mkdirSync(path.join(dir, 'compact.lock'))
    assert.deepEqual(await compact(dir, testLog(), { minAgeMs: 0 }), { kind: 'locked' })
    const old = Date.now() / 1000 - 120
    utimesSync(path.join(dir, 'compact.lock'), old, old)
    assert.equal((await compact(dir, testLog(), { minAgeMs: 0 })).kind, 'compacted')
    assert.equal(readdirSync(dir).includes('compact.lock'), false)
  })
})

describe('Blobs', () => {
  test('LRU by bytes, pinned texts stay, and a blob over the limit is refused before it is read', async () => {
    const dir = path.join(tempDir(), 'ledger')
    const writer = new Blobs(1 << 30, () => 1 << 30)
    const big = 'x'.repeat(100)
    const refs = await Promise.all(['a', 'b', 'c'].map(c => writer.put(dir, c.repeat(100))))
    const blobs = new Blobs(450, () => 150)
    const [ra, rb, rc] = refs
    assert.ok(ra && rb && rc)
    blobs.pin(ra)
    for (const r of refs) await blobs.get(dir, r)
    assert.ok(blobs.cachedBytes <= 450)
    assert.equal(await blobs.get(dir, ra), 'a'.repeat(100))
    const tooBig = await writer.put(dir, big.repeat(2))
    await assert.rejects(blobs.get(dir, tooBig), BlobTooLargeError)
  })
})

describe('Discovery', () => {
  test('opens only ledgers whose root is in or around a folder, and ones created later', async () => {
    const dataDir = tempDir()
    const make = (root: string): string => {
      const dir = ledgerDirFor(dataDir, root)
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ v: 2, root, createdAt: 1 }))
      return dir
    }
    const inside = make('/work/app/sub')
    const above = make('/work')
    make('/elsewhere')
    const opened = new Set<string>()
    const discovery = new Discovery({ dataDir, folders: () => ['/work/app'], isOpen: d => opened.has(d), open: async d => void opened.add(d), worktreesOf: async () => [], onWorktrees: () => undefined, log: testLog() })
    await discovery.start()
    assert.deepEqual([...opened].sort(), [above, inside].sort())
    const later = make('/work/app/later')
    await until('the watcher opens a new ledger', () => opened.has(later))
    discovery.dispose()
  })

  test('also opens the ledgers of the git worktrees of a folder, and reports their branches', async () => {
    const dataDir = tempDir()
    const make = (root: string): string => {
      const dir = ledgerDirFor(dataDir, root)
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ v: 2, root, createdAt: 1 }))
      return dir
    }
    const main = make('/work/app')
    const sibling = make('/work/app-push')
    make('/work/other')
    const opened = new Set<string>()
    let reported: readonly Worktree[] = []
    const discovery = new Discovery({
      dataDir,
      folders: () => ['/work/app'],
      isOpen: d => opened.has(d),
      open: async d => void opened.add(d),
      worktreesOf: async () => [
        { root: '/work/app', branch: 'develop' },
        { root: '/work/app-push', branch: 'feat/push' },
      ],
      onWorktrees: found => void (reported = found),
      log: testLog(),
    })
    await discovery.start()
    assert.deepEqual([...opened].sort(), [main, sibling].sort())
    assert.deepEqual(reported.map(w => w.branch), ['develop', 'feat/push'])
    discovery.dispose()
  })

  test('a folder whose worktrees cannot be listed still opens its own ledgers, and the failure is logged', async () => {
    const dataDir = tempDir()
    const dir = ledgerDirFor(dataDir, '/work/app')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ v: 2, root: '/work/app', createdAt: 1 }))
    const opened = new Set<string>()
    const errors: string[] = []
    const log = { ...testLog(), error: (what: string) => void errors.push(what) }
    const discovery = new Discovery({
      dataDir,
      folders: () => ['/work/app'],
      isOpen: d => opened.has(d),
      open: async d => void opened.add(d),
      worktreesOf: () => Promise.reject(new Error('git is not installed')),
      onWorktrees: () => undefined,
      log,
    })
    await discovery.start()
    assert.deepEqual([...opened], [dir])
    assert.equal(errors.length, 1)
    discovery.dispose()
  })
})

describe('Bridge', () => {
  const post = (socketPath: string, url: string, body: string): Promise<{ status: number; text: string }> =>
    new Promise((resolve, reject) => {
      const req = http.request({ socketPath, path: url, method: 'POST' }, res => {
        let text = ''
        res.on('data', (c: Buffer) => (text += c.toString()))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
      })
      req.on('error', reject)
      req.end(body)
    })

  test('routes ping, open and focus; rejects bad bodies; clears stale sockets', async () => {
    const dataDir = tempDir('cr-b-')
    mkdirSync(path.join(dataDir, 'sockets'))
    writeFileSync(path.join(dataDir, 'sockets', 'dead.sock'), '')
    const pings: string[] = []
    let focused = 0
    const bridge = new Bridge(
      { onPing: l => void pings.push(l), onOpen: async r => r.path === '/w/a.ts', onFocus: async () => void focused++ },
      testLog(),
    )
    await bridge.start(dataDir)
    assert.equal(readdirSync(path.join(dataDir, 'sockets')).includes('dead.sock'), false)
    const socket = bridge.socketPath ?? ''
    assert.equal((await post(socket, '/ping', JSON.stringify({ ledger: '/x' }))).status, 204)
    assert.deepEqual(pings, ['/x'])
    assert.equal((await post(socket, '/ping', '{"nope":1}')).status, 400)
    assert.deepEqual(await post(socket, '/open', JSON.stringify({ ledger: '/x', path: '/w/a.ts', line: 3 })), { status: 200, text: '{"opened":true}' })
    assert.equal((await post(socket, '/open', JSON.stringify({ ledger: '/x', path: '/w/b.ts' }))).status, 404)
    assert.equal((await post(socket, '/focus', '')).status, 204)
    assert.equal(focused, 1)
    bridge.dispose()
  })
})
