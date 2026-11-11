import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync, ftruncateSync, chmodSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, describe, test } from 'node:test'

import { decodeUtf8With } from '../src/bytes'
import {
  chunkBySize, CONTENTS, EXCLUDE, GC, INIT, NEWEST_INDEX, parseBatchCheck, parseContents, parseSnapshot, parseSnapshotDiff, REBASELINE, SIZES, SNAPSHOT, SNAPSHOT_DIFF, STAGE,
} from '../src/shadowScripts'

const MAX = 2 * 1024 * 1024
const tmpRoots: string[] = []
after(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true })
})

const textDecoder = new TextDecoder()
const decode = (bytes: Uint8Array): string | undefined => decodeUtf8With(b => textDecoder.decode(b), bytes)

type Run = { readonly stdout: string; readonly status: number | null; readonly stderr: string }

const sh = (script: string, args: readonly string[], cwd: string, opts: { input?: string; env?: NodeJS.ProcessEnv } = {}): Run => {
  const ran = spawnSync('/bin/sh', ['-c', script, 'sh', ...args], { cwd, input: opts.input, env: opts.env ?? process.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { stdout: ran.stdout, status: ran.status, stderr: ran.stderr }
}

/** A user repo at `root` and a ledger dir holding the shadow. */
const setup = (): { root: string; ledger: string; gitDir: string; index: (s: string) => string } => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'cr-shadow-'))
  tmpRoots.push(base)
  const root = path.join(base, 'work')
  const ledger = path.join(base, 'ledger')
  mkdirSync(root, { recursive: true })
  mkdirSync(ledger, { recursive: true })
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0)
  const gitDir = path.join(ledger, 'shadow.git')
  const init = sh(INIT, [gitDir], root)
  assert.equal(init.status, 0, init.stderr)
  assert.equal(sh(EXCLUDE, [gitDir, root], root).status, 0)
  return { root, ledger, gitDir, index: s => path.join(gitDir, `index.${s}`) }
}

const snapshot = (s: ReturnType<typeof setup>, session = 's1', cap = 2000): ReturnType<typeof parseSnapshot> => {
  const ran = sh(SNAPSHOT, [s.index(session), s.gitDir, s.root, '', String(MAX), String(cap)], s.root)
  assert.equal(ran.status, 0, ran.stderr)
  return parseSnapshot(ran.stdout)
}

const snapshotDiff = (s: ReturnType<typeof setup>, before: string, session = 's1'): ReturnType<typeof parseSnapshotDiff> => {
  const ran = sh(SNAPSHOT_DIFF, [s.index(session), s.gitDir, s.root, '', String(MAX), '2000', before], s.root)
  assert.equal(ran.status, 0, ran.stderr)
  return parseSnapshotDiff(ran.stdout)
}

const treeOf = (r: ReturnType<typeof parseSnapshot>): string => {
  assert.equal(r.kind, 'tree')
  return r.kind === 'tree' ? r.tree : ''
}

const sparse = (file: string, bytes: number): void => {
  const fd = openSync(file, 'w')
  ftruncateSync(fd, bytes)
  closeSync(fd)
}

const duKiB = (dir: string): number => Number(spawnSync('du', ['-sk', dir], { encoding: 'utf8' }).stdout.split('\t')[0])

describe('shadow scripts on real repos', () => {
  test('SNAPSHOT_DIFF finds added, modified and deleted files', () => {
    const s = setup()
    writeFileSync(path.join(s.root, 'a.txt'), 'a\n')
    writeFileSync(path.join(s.root, 'c.txt'), 'c\n')
    const before = treeOf(snapshot(s))
    writeFileSync(path.join(s.root, 'a.txt'), 'a2\n')
    writeFileSync(path.join(s.root, 'b.txt'), 'b\n')
    rmSync(path.join(s.root, 'c.txt'))
    const diff = snapshotDiff(s, before)
    assert.equal(diff.kind, 'diff')
    if (diff.kind !== 'diff') return
    assert.deepEqual(diff.changes.map(c => [c.status, c.path, c.oldSha === null, c.newSha === null]).sort(), [
      ['A', 'b.txt', true, false],
      ['D', 'c.txt', false, true],
      ['M', 'a.txt', false, false],
    ])
    const again = snapshotDiff(s, diff.tree)
    assert.ok(again.kind === 'diff' && again.changes.length === 0 && again.tree === diff.tree)
  })

  test('honors .gitignore and never touches the user repo', () => {
    const s = setup()
    writeFileSync(path.join(s.root, '.gitignore'), 'ignored/\n')
    mkdirSync(path.join(s.root, 'ignored'))
    writeFileSync(path.join(s.root, 'ignored', 'x.txt'), 'x\n')
    const before = treeOf(snapshot(s))
    writeFileSync(path.join(s.root, 'ignored', 'y.txt'), 'y\n')
    const diff = snapshotDiff(s, before)
    assert.ok(diff.kind === 'diff' && diff.changes.length === 0)
    assert.equal(existsSync(path.join(s.root, '.git', 'index')), false, 'the user repo index was never written')
  })

  test('a 50 MB untracked file is never hashed and is remembered as large', () => {
    const s = setup()
    writeFileSync(path.join(s.root, 'small.txt'), 'small\n')
    const before = treeOf(snapshot(s))
    const objectsBefore = duKiB(path.join(s.gitDir, 'objects'))
    sparse(path.join(s.root, 'big.bin'), 50 * 1024 * 1024)
    const diff = snapshotDiff(s, before)
    assert.ok(diff.kind === 'diff')
    if (diff.kind !== 'diff') return
    assert.deepEqual(diff.changes, [])
    assert.deepEqual(diff.big, ['big.bin'])
    assert.ok(duKiB(path.join(s.gitDir, 'objects')) - objectsBefore < 1024, 'objects grew by less than 1 MB')
    assert.match(readFileSync(path.join(s.ledger, 'shadow-large.txt'), 'utf8'), /^\/big\.bin$/m)
    const next = snapshotDiff(s, diff.tree)
    assert.ok(next.kind === 'diff' && next.changes.length === 0 && next.big.length === 0, 'the next snapshot does not list it')
  })

  test('a staged file that grows past the cap is untracked and excluded', () => {
    const s = setup()
    writeFileSync(path.join(s.root, 'grows.log'), 'x\n')
    const before = treeOf(snapshot(s))
    sparse(path.join(s.root, 'grows.log'), 3 * 1024 * 1024)
    const diff = snapshotDiff(s, before)
    assert.ok(diff.kind === 'diff')
    if (diff.kind !== 'diff') return
    assert.deepEqual(diff.big, ['grows.log'], 'reported, so the D is not taken for a deletion')
    assert.deepEqual(diff.changes.map(c => [c.status, c.path]), [['D', 'grows.log']])
    assert.match(readFileSync(path.join(s.gitDir, 'info', 'exclude'), 'utf8'), /^\/grows\.log$/m)
  })

  test('2,500 new files trip the cap; REBASELINE then stages them', () => {
    const s = setup()
    treeOf(snapshot(s))
    mkdirSync(path.join(s.root, 'many'))
    for (let i = 0; i < 2500; i++) writeFileSync(path.join(s.root, 'many', `f${i}.txt`), `${i}\n`)
    assert.deepEqual(snapshot(s), { kind: 'tooMany', count: 2500 })
    const ran = sh(REBASELINE, [s.index('s1'), s.gitDir, s.root, '', String(MAX), '0'], s.root)
    const tree = treeOf(parseSnapshot(ran.stdout))
    const listed = spawnSync('git', ['ls-tree', '-r', '--name-only', tree], { env: { ...process.env, GIT_DIR: s.gitDir }, encoding: 'utf8' }).stdout.trim().split('\n')
    assert.equal(listed.length, 2500)
    assert.equal(snapshot(s).kind, 'tree', 'and the next capped snapshot is cheap again')
  })

  test('a candidate deleted between the walk and the add still yields a tree', () => {
    const s = setup()
    writeFileSync(path.join(s.root, 'keep.txt'), 'k\n')
    const before = treeOf(snapshot(s))
    writeFileSync(path.join(s.root, 'vanish.txt'), 'v\n')
    writeFileSync(path.join(s.root, 'keep.txt'), 'k2\n')
    const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim()
    const bin = path.join(path.dirname(s.ledger), 'bin')
    mkdirSync(bin)
    writeFileSync(path.join(bin, 'git'), `#!/bin/sh\n"${realGit}" "$@"; rc=$?\ncase "$*" in *ls-files*) rm -f "$VANISH";; esac\nexit $rc\n`)
    chmodSync(path.join(bin, 'git'), 0o755)
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, VANISH: path.join(s.root, 'vanish.txt') }
    const ran = sh(SNAPSHOT_DIFF, [s.index('s1'), s.gitDir, s.root, '', String(MAX), '2000', before], s.root, { env })
    assert.equal(ran.status, 0, ran.stderr)
    const diff = parseSnapshotDiff(ran.stdout)
    assert.ok(diff.kind === 'diff')
    if (diff.kind !== 'diff') return
    assert.deepEqual(diff.changes.map(c => [c.status, c.path]), [['M', 'keep.txt']])
  })

  test('awkward file names, small and large', () => {
    const s = setup()
    const before = treeOf(snapshot(s))
    const names = ['new\nline.txt', 'with space.txt', 'star*.txt', '[bracket].txt', '-dash.txt', '#hash.txt', '!bang.txt', 'ünïcödé.txt', 'trailing .txt']
    for (const n of names) writeFileSync(path.join(s.root, n), `${n}\n`)
    const bigNames = ['big [x]*.bin', '-big.bin', '#big.bin']
    for (const n of bigNames) sparse(path.join(s.root, n), 3 * 1024 * 1024)
    const diff = snapshotDiff(s, before)
    assert.ok(diff.kind === 'diff')
    if (diff.kind !== 'diff') return
    assert.deepEqual(diff.changes.map(c => c.path).sort(), [...names].sort())
    assert.deepEqual([...diff.big].sort(), [...bigNames].sort())
    const next = snapshotDiff(s, diff.tree)
    assert.ok(next.kind === 'diff' && next.changes.length === 0 && next.big.length === 0, 'each large name is excluded by its escaped pattern')
  })

  test('SIZES and CONTENTS read blobs back, in chunks, telling text from binary', () => {
    const s = setup()
    const empty = treeOf(snapshot(s, 's0'))
    writeFileSync(path.join(s.root, 'text.txt'), 'héllo\nworld\n')
    writeFileSync(path.join(s.root, 'nul.bin'), Buffer.from([104, 0, 105]))
    writeFileSync(path.join(s.root, 'latin1.txt'), Buffer.from([0xe9, 0x0a]))
    writeFileSync(path.join(s.root, 'empty.txt'), '')
    const diff = snapshotDiff(s, empty, 's0')
    assert.ok(diff.kind === 'diff')
    if (diff.kind !== 'diff') return
    const shas = diff.changes.flatMap(c => (c.newSha ? [c.newSha] : []))
    const sizes = parseBatchCheck(sh(SIZES, [s.gitDir], s.root, { input: `${shas.join('\n')}\n0123456789012345678901234567890123456789\n` }).stdout)
    assert.equal(sizes.get('0123456789012345678901234567890123456789')?.kind, 'missing')
    const sized = shas.map(sha => {
      const info = sizes.get(sha)
      return { sha, size: info?.kind === 'blob' ? info.size : -1 }
    })
    const chunks = chunkBySize(sized, 70)
    assert.ok(chunks.length >= 2, 'the small limit splits the objects')
    const texts = new Map<string, string>()
    const binary = new Set<string>()
    for (const chunk of chunks) {
      const out = sh(CONTENTS, [s.gitDir], s.root, { input: `${chunk.join('\n')}\n` }).stdout
      const parsed = parseContents(Uint8Array.from(Buffer.from(out.replace(/\s+/g, ''), 'base64')), decode)
      assert.equal(parsed.kind, 'ok')
      if (parsed.kind !== 'ok') return
      for (const [k, v] of parsed.texts) texts.set(k, v)
      for (const b of parsed.binary) binary.add(b)
    }
    const shaOf = (p: string): string => diff.changes.find(c => c.path === p)?.newSha ?? ''
    assert.equal(texts.get(shaOf('text.txt')), 'héllo\nworld\n')
    assert.equal(texts.get(shaOf('empty.txt')), '')
    assert.ok(binary.has(shaOf('nul.bin')))
    assert.ok(binary.has(shaOf('latin1.txt')))
  })

  test('a new session seeds its index from the newest one and re-hashes nothing', () => {
    const s = setup()
    writeFileSync(path.join(s.root, 'a.txt'), 'a\n')
    const first = treeOf(snapshot(s, 's1'))
    const newest = sh(NEWEST_INDEX, [s.gitDir], s.root).stdout.trim()
    assert.equal(newest, s.index('s1'))
    const ran = sh(SNAPSHOT, [s.index('s2'), s.gitDir, s.root, newest, String(MAX), '2000'], s.root)
    assert.equal(treeOf(parseSnapshot(ran.stdout)), first)
    assert.ok(existsSync(s.index('s2')))
  })

  test('GC drops week-old indexes and keeps a small store', () => {
    const s = setup()
    treeOf(snapshot(s, 'old'))
    treeOf(snapshot(s, 'new'))
    const weekAgo = Date.now() / 1000 - 8 * 24 * 3600
    utimesSync(s.index('old'), weekAgo, weekAgo)
    const ran = sh(GC, [s.gitDir, String(512 * 1024)], s.root)
    assert.match(ran.stdout, /^kept \d+/)
    assert.deepEqual(readdirSync(s.gitDir).filter(n => n.startsWith('index.')), ['index.new'])
  })

  test('GC deletes a store over the limit once no index changed for 10 minutes', () => {
    const s = setup()
    writeFileSync(path.join(s.root, 'a.txt'), 'a\n')
    treeOf(snapshot(s))
    const old = Date.now() / 1000 - 3600
    utimesSync(s.index('s1'), old, old)
    assert.equal(sh(GC, [s.gitDir, '0'], s.root).stdout.trim(), 'removed')
    assert.equal(existsSync(s.gitDir), false)
    assert.ok(statSync(s.ledger).isDirectory())
  })

  test('STAGE alone stages without printing', () => {
    const s = setup()
    writeFileSync(path.join(s.root, 'a.txt'), 'a\n')
    const ran = sh(STAGE, [s.index('s1'), s.gitDir, s.root, '', String(MAX), '0'], s.root)
    assert.equal(ran.status, 0)
    assert.equal(ran.stdout, '')
  })
})

describe('shadow parsers', () => {
  test('parseSnapshotDiff skips gitlinks and symlinks and rejects junk', () => {
    const sha = 'a'.repeat(40)
    const z = '0'.repeat(40)
    const out = `${sha}\n:000000 160000 ${z} ${sha} A\0sub\0:000000 120000 ${z} ${sha} A\0link\0:100644 100644 ${sha} ${sha} M\0f\0!big\0x y\0`
    assert.deepEqual(parseSnapshotDiff(out), { kind: 'diff', tree: sha, changes: [{ path: 'f', status: 'M', oldSha: sha, newSha: sha }], big: ['x y'], skipped: 2 })
    assert.equal(parseSnapshotDiff('fatal: oops').kind, 'failed')
    assert.deepEqual(parseSnapshotDiff('!toomany 3\n'), { kind: 'tooMany', count: 3 })
  })

  test('parseContents fails on a truncated object', () => {
    const sha = 'b'.repeat(40)
    const bytes = new TextEncoder().encode(`${sha} blob 10\nabc`)
    assert.equal(parseContents(bytes, decode).kind, 'failed')
  })
})
