import { expect, mock, test, type Engine, type MockClock } from 'claude-code/testing'

import { DATA, fakeWorld, TREE_BEFORE, type World } from './world.testkit'

const ROOT = '/repo'
const START = { cwd: ROOT, surface: 'terminal', isInteractive: true } as const

/** A session in a git repo, warmed up and inside turn t1. */
const started = async ($: Engine, clock: MockClock): Promise<void> => {
  await $.session.start(START)
  await clock.settle()
  await $.turn.start({ text: 'run things', turnId: 't1' })
}

const bash = (command: string) => ({ tool: 'Bash' as const, command })

const callsDuring = async (w: World, run: () => Promise<unknown>): Promise<string[]> => {
  const mark = w.calls.length
  await run()
  return w.calls.slice(mark)
}

const edits = (w: World) => w.batches().flatMap(b => b.events.flatMap(e => (e.kind === 'edit' ? [e] : [])))

test('warm-up: init, excludes, a seeded rebaseline with no cap, all off the critical path', async ($, on) => {
  const w = fakeWorld(on, { gitRoots: [ROOT], cwd: ROOT })
  const clock = mock.clock(on)
  const during = await callsDuring(w, () => $.session.start(START))
  expect(during.filter(c => c.startsWith('script:'))).toEqual([])
  await clock.settle()
  expect(w.shadow.runs.map(r => r.name)).toEqual(['INIT', 'EXCLUDE', 'NEWEST_INDEX', 'REBASELINE/SNAPSHOT'])
  const [init, exclude, , rebaseline] = w.shadow.runs
  const gitDir = init?.args[0] ?? ''
  expect(gitDir.startsWith(`${DATA}/ledgers/`) && gitDir.endsWith('/shadow.git')).toBe(true)
  expect(exclude?.args).toEqual([gitDir, ROOT])
  expect(rebaseline?.args).toEqual([`${gitDir}/index.Session-1abc`, gitDir, ROOT, '', '2097152', '0'])
  expect(w.paths().some(p => p.endsWith('/meta.json'))).toBe(true)
})

test('M2: a read-only command makes no spawn and no fs call', async ($, on) => {
  const w = fakeWorld(on, { gitRoots: [ROOT], cwd: ROOT })
  const clock = mock.clock(on)
  await started($, clock)
  for (const command of ['ls -la', 'git status && git diff', 'grep -rn "a > b" src']) {
    const during = await callsDuring(w, () => $.tool.call(bash(command)))
    expect(during).toEqual(['tool.call'])
  }
  await clock.settle()
  expect(w.shadow.runs.length).toBe(4)
})

test('M3: a mutating command spawns once before it runs, then diff, sizes and contents after', async ($, on) => {
  const w = fakeWorld(on, { gitRoots: [ROOT], cwd: ROOT })
  const clock = mock.clock(on)
  await started($, clock)
  w.shadow.diff = {
    changes: [
      { status: 'M', path: 'src/a.ts', before: 'one\n', after: 'two\n' },
      { status: 'A', path: 'new file.ts', after: 'hi\n' },
      { status: 'D', path: 'gone.ts', before: 'bye\n' },
    ],
  }
  const during = await callsDuring(w, () => $.tool.call(bash('npm test')))
  expect(during.slice(0, during.indexOf('tool.call') + 1)).toEqual(['process.run', 'script:REBASELINE/SNAPSHOT', 'tool.call'])
  const snap = w.shadow.runs[4]
  expect(snap?.args.slice(1)).toEqual([snap?.args[1] ?? '', ROOT, '', '2097152', '2000'])

  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(w.shadow.runs.slice(5).map(r => r.name)).toEqual(['SNAPSHOT_DIFF', 'SIZES', 'CONTENTS'])
  expect(w.shadow.runs[5]?.args[6]).toBe(TREE_BEFORE)
  expect(edits(w).map(e => [e.path, e.tool, e.before === null, e.after === null])).toEqual([
    [`${ROOT}/src/a.ts`, 'Bash', false, false],
    [`${ROOT}/new file.ts`, 'Bash', true, false],
    [`${ROOT}/gone.ts`, 'Bash', false, true],
  ])
})

test('an unchanged tree costs one spawn after, nothing more', async ($, on) => {
  const w = fakeWorld(on, { gitRoots: [ROOT], cwd: ROOT })
  const clock = mock.clock(on)
  await started($, clock)
  await $.tool.call(bash('make'))
  await clock.settle()
  expect(w.shadow.runs.slice(4).map(r => r.name)).toEqual(['REBASELINE/SNAPSHOT', 'SNAPSHOT_DIFF'])
  expect(w.batches()).toEqual([])
})

test('a file that grew past the cap is reported !big and not taken for a deletion', async ($, on) => {
  const w = fakeWorld(on, { gitRoots: [ROOT], cwd: ROOT })
  const clock = mock.clock(on)
  await started($, clock)
  w.shadow.diff = { changes: [{ status: 'D', path: 'app.log', before: 'small\n' }], big: ['app.log'] }
  await $.tool.call(bash('./run.sh'))
  await clock.settle()
  expect(w.shadow.runs.slice(5).map(r => r.name)).toEqual(['SNAPSHOT_DIFF'])
  expect(w.batches()).toEqual([])
  expect(w.logs.some(l => l.includes('/repo/app.log is over 2097152 bytes'))).toBe(true)
})

test('a blob over maxFileBytes drops that file before contents are read', async ($, on) => {
  const w = fakeWorld(on, { gitRoots: [ROOT], cwd: ROOT })
  const clock = mock.clock(on)
  await started($, clock)
  w.shadow.diff = { changes: [{ status: 'M', path: 'data.json', before: '{}', after: '[]' }] }
  w.shadow.answers.set('SIZES', run => ({ exitCode: 0, stdout: (run.stdin ?? '').split('\n').filter(Boolean).map(sha => `${sha} blob 3000000`).join('\n') }))
  await $.tool.call(bash('./gen.sh'))
  await clock.settle()
  expect(w.shadow.runs.slice(5).map(r => r.name)).toEqual(['SNAPSHOT_DIFF', 'SIZES'])
  expect(w.batches()).toEqual([])
})

test('binary contents are skipped, text beside them is recorded', async ($, on) => {
  const w = fakeWorld(on, { gitRoots: [ROOT], cwd: ROOT })
  const clock = mock.clock(on)
  await started($, clock)
  w.shadow.diff = {
    changes: [
      { status: 'A', path: 'image.png', after: Uint8Array.from([137, 80, 78, 71, 0, 1]) },
      { status: 'A', path: 'latin1.txt', after: Uint8Array.from([0xe9, 10]) },
      { status: 'A', path: 'ok.txt', after: '﻿kept bom\n' },
    ],
  }
  await $.tool.call(bash('./build.sh'))
  await clock.settle()
  expect(edits(w).map(e => e.path)).toEqual([`${ROOT}/ok.txt`])
  const blob = w.paths().find(p => p.includes('/blobs/'))
  expect(w.read(blob ?? '')).toBe('﻿kept bom\n')
})

test('contents over 2.9 MB are read in chunks so no stdout passes 4 MiB', async ($, on) => {
  const w = fakeWorld(on, { gitRoots: [ROOT], cwd: ROOT })
  const clock = mock.clock(on)
  await started($, clock)
  const big = (c: string) => `${c.repeat(99)}\n`.repeat(15_000)
  w.shadow.diff = {
    changes: [
      { status: 'A', path: 'one.txt', after: big('a') },
      { status: 'A', path: 'two.txt', after: big('b') },
    ],
  }
  await $.tool.call(bash('./gen.sh'))
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(w.shadow.runs.slice(5).map(r => r.name)).toEqual(['SNAPSHOT_DIFF', 'SIZES', 'CONTENTS', 'CONTENTS'])
  expect(w.logs).toEqual([])
  expect(edits(w).length).toBe(2)
})

test('a failed snapshot still runs the command, unrecorded', async ($, on) => {
  const w = fakeWorld(on, { gitRoots: [ROOT], cwd: ROOT })
  const clock = mock.clock(on)
  await started($, clock)
  w.shadow.answers.set('REBASELINE/SNAPSHOT', () => ({ exitCode: 1, stdout: '' }))
  await $.tool.call(bash('npm test'))
  await clock.settle()
  expect(w.ranCommands).toEqual(['npm test'])
  expect(w.shadow.runs.slice(4).map(r => r.name)).toEqual(['REBASELINE/SNAPSHOT'])
  expect(w.logs.some(l => l.includes('Bash changes are not recorded'))).toBe(true)
})

test('too many changed paths: unrecorded, a background rebaseline, and Bash untracked while it runs', async ($, on) => {
  const w = fakeWorld(on, { gitRoots: [ROOT], cwd: ROOT })
  const clock = mock.clock(on)
  await started($, clock)
  let snapshots = 0
  w.shadow.answers.set('REBASELINE/SNAPSHOT', run => {
    snapshots++
    return run.args[5] === '0' ? { exitCode: 0, stdout: `${TREE_BEFORE}\n` } : { exitCode: 0, stdout: '!toomany 2500\n' }
  })
  await $.tool.call(bash('npm install'))
  expect(w.ranCommands).toEqual(['npm install'])
  await clock.settle()
  expect(w.shadow.runs.slice(4).map(r => [r.name, r.args[5]])).toEqual([
    ['REBASELINE/SNAPSHOT', '2000'],
    ['REBASELINE/SNAPSHOT', '0'],
  ])
  expect(snapshots).toBe(2)
})

test('a session outside git never spawns for Bash', async ($, on) => {
  const w = fakeWorld(on, { cwd: '/plain' })
  const clock = mock.clock(on)
  await $.session.start({ ...START, cwd: '/plain' })
  await clock.settle()
  await $.turn.start({ text: 'x', turnId: 't1' })
  const during = await callsDuring(w, () => $.tool.call(bash('npm test')))
  expect(during).toEqual(['tool.call'])
  expect(w.shadow.runs).toEqual([])
})

test('an edit after a Bash command waits for the barrier: it never interleaves', async ($, on) => {
  const w = fakeWorld(on, { gitRoots: [ROOT], cwd: ROOT })
  const clock = mock.clock(on)
  await started($, clock)
  w.file(`${ROOT}/x.ts`, 'one\n')
  w.shadow.diff = { changes: [{ status: 'M', path: 'x.ts', before: 'zero\n', after: 'one\n' }] }
  await $.tool.call(bash('./fmt.sh'))
  const mark = w.calls.length
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/x.ts`, content: 'two\n' })
  const order = w.calls.slice(mark).filter(c => c.startsWith('script:') || c === 'fs.read')
  expect(order.indexOf('script:CONTENTS')).toBeLessThan(order.indexOf('fs.read'))
  await clock.settle()
  expect(edits(w).map(e => e.tool)).toEqual(['Bash', 'Write'])
})
