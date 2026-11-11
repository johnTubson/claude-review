import type { ToolCallResult } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import type { Summary } from '../types'
import { DATA, fakeWorld, type World } from './world.testkit'

const ANSWERS: readonly ToolCallResult[] = [{ deny: 'no' }, { isError: true, result: 'failed', text: 'failed' }, { result: { type: 'update', staged: true } }]
const START = { cwd: '/proj', surface: 'terminal', isInteractive: true } as const

/** The engine calls the fake world answered, the tool's own run included. */
const callsDuring = async (w: World, run: () => Promise<unknown>): Promise<string[]> => {
  const mark = w.calls.length
  await run()
  return w.calls.slice(mark)
}

test('M1: an Edit awaits exactly two reads around the tool and writes nothing before it returns', async ($, on) => {
  const w = fakeWorld(on)
  const clock = mock.clock(on, { now: 1_000 })
  w.file('/proj/a.ts', 'one\ntwo\n')
  await $.session.start(START)
  await clock.settle()
  await $.turn.start({ text: 'change a', turnId: 't1' })

  const during = await callsDuring(w, () => $.tool.call({ tool: 'Edit', file_path: '/proj/a.ts', old_string: 'two', new_string: 'TWO', replace_all: false }))
  expect(during).toEqual(['fs.read', 'tool.call', 'fs.read'])
  expect(w.batches()).toEqual([])

  await clock.settle()
  const batches = w.batches()
  expect(batches.length).toBe(1)
  expect(batches[0]?.events.map(e => e.kind)).toEqual(['session', 'turn', 'edit'])
  const edit = batches[0]?.events[2]
  expect(edit?.kind === 'edit' && edit.tool).toBe('Edit')
  expect(w.paths().filter(p => p.includes('/blobs/')).length).toBe(2)
  const meta = w.paths().find(p => p.endsWith('/meta.json'))
  expect(meta?.startsWith(`${DATA}/ledgers/`)).toBe(true)
  expect(w.read(meta ?? '')).toContain('"root":"/proj"')
})

test('a Write that creates a file reads, then stats to tell missing from too large', async ($, on) => {
  const w = fakeWorld(on)
  const clock = mock.clock(on)
  await $.session.start(START)
  await $.turn.start({ text: 'new file', turnId: 't1' })

  const during = await callsDuring(w, () => $.tool.call({ tool: 'Write', file_path: '/proj/new.ts', content: 'hello\n' }))
  expect(during).toEqual(['fs.read', 'fs.stat', 'tool.call', 'fs.read'])
  await clock.settle()
  const edit = w.batches()[0]?.events.find(e => e.kind === 'edit')
  expect(edit?.kind === 'edit' ? edit.before : 'not an edit').toBe(null)
})

test('denied, errored and staged calls record nothing and read the file once', async ($, on) => {
  const w = fakeWorld(on)
  const clock = mock.clock(on)
  w.file('/proj/a.ts', 'one\n')
  await $.session.start(START)
  await $.turn.start({ text: 'x', turnId: 't1' })

  for (const answer of ANSWERS) {
    w.nextAnswer = answer
    const during = await callsDuring(w, () => $.tool.call({ tool: 'Write', file_path: '/proj/a.ts', content: 'two\n' }).catch(() => undefined))
    expect(during.filter(c => c === 'fs.read').length).toBe(1)
  }
  await clock.settle()
  expect(w.batches()).toEqual([])
})

test('a file over 4 MiB is not recorded, and is logged once', async ($, on) => {
  const w = fakeWorld(on)
  const clock = mock.clock(on)
  w.tooLarge.add('/proj/big.json')
  await $.session.start(START)
  await $.turn.start({ text: 'x', turnId: 't1' })
  for (let i = 0; i < 2; i++) await $.tool.call({ tool: 'Write', file_path: '/proj/big.json', content: '{}' })
  await clock.settle()
  expect(w.batches()).toEqual([])
  expect(w.logs.filter(l => l.includes('big.json')).length).toBe(1)
})

test('M4: the summary never runs inside a tool call; it runs 300 ms later, once', async ($, on) => {
  const w = fakeWorld(on)
  const clock = mock.clock(on)
  w.file('/proj/a.ts', 'one\n')
  w.file('/proj/b.ts', 'one\n')
  await $.session.start(START)
  await clock.settle()
  await $.turn.start({ text: 'two files', turnId: 't1' })

  const during = await callsDuring(w, async () => {
    await $.tool.call({ tool: 'Write', file_path: '/proj/a.ts', content: 'one\ntwo\n' })
    await $.tool.call({ tool: 'Write', file_path: '/proj/b.ts', content: 'uno\n' })
  })
  expect(during.filter(c => c === 'ui.status')).toEqual([])
  await clock.settle()
  expect(w.statuses).toEqual([])

  await clock.advance(300)
  expect(w.statuses).toEqual(['2 files changed +2 −1 · /changes'])
  const summary: Summary | undefined = w.summaries.at(-1)
  expect(w.summaries.length).toBe(1)
  expect(summary?.files.map(f => [f.rel, f.added, f.removed, f.status])).toEqual([
    ['a.ts', 1, 0, 'modified'],
    ['b.ts', 1, 1, 'modified'],
  ])
  expect(summary?.turns.map(t => [t.n, t.prompt, t.paths.length])).toEqual([[1, 'two files', 2]])
  expect(summary?.sessions.map(s => [s.n, s.title, s.turnKeys.length])).toEqual([[1, 'two files', 1]])
  expect(w.read('/proj/a.ts')).toBe('one\ntwo\n')
})

test('ping is fire and forget: the batch lands and the turn completes while a window is slow', async ($, on) => {
  const w = fakeWorld(on)
  const clock = mock.clock(on)
  w.file('/proj/a.ts', 'one\n')
  w.file(`${DATA}/sockets/w1.sock`, '')
  const held = w.holdPings()
  await $.session.start(START)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.tool.call({ tool: 'Write', file_path: '/proj/a.ts', content: 'two\n' })
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(w.batches().length).toBe(1)
  expect(w.pings.map(p => p.socketPath)).toEqual([`${DATA}/sockets/w1.sock`])
  expect(JSON.parse(w.pings[0]?.body ?? '{}').ledger.startsWith(`${DATA}/ledgers/`)).toBe(true)
  held.release()
  await clock.settle()
})

test('turn.complete flushes what is queued without waiting for the timer', async ($, on) => {
  const w = fakeWorld(on)
  mock.clock(on)
  w.file('/proj/a.ts', 'one\n')
  await $.session.start(START)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.tool.call({ tool: 'Write', file_path: '/proj/a.ts', content: 'two\n' })
  expect(w.batches()).toEqual([])
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(w.batches().length).toBe(1)
})

test('a subagent turn.start is not a turn: edits stay in the main turn', async ($, on) => {
  const w = fakeWorld(on)
  const clock = mock.clock(on)
  w.file('/proj/a.ts', 'one\n')
  await $.session.start(START)
  await $.turn.start({ text: 'main prompt', turnId: 't1' })
  await $.turn.start({ text: 'subagent prompt', turnId: 'sub1', agentId: 'agent-1' })
  await $.tool.call({ tool: 'Write', file_path: '/proj/a.ts', content: 'two\n' })
  await clock.settle()
  const events = w.batches().flatMap(b => b.events)
  expect(events.filter(e => e.kind === 'turn').map(e => (e.kind === 'turn' ? e.prompt : ''))).toEqual(['main prompt'])
  const edit = events.find(e => e.kind === 'edit')
  expect(edit?.kind === 'edit' ? edit.turn : '').toBe('t1')
})

test('routing: a file in a child repo goes to that repo’s ledger, each announcing the session and turn', async ($, on) => {
  const w = fakeWorld(on, { gitRoots: ['/proj/child'] })
  const clock = mock.clock(on)
  w.file('/proj/a.ts', 'one\n')
  w.file('/proj/child/b.ts', 'one\n')
  await $.session.start(START)
  await $.turn.start({ text: 'both', turnId: 't1' })
  await $.tool.call({ tool: 'Write', file_path: '/proj/a.ts', content: 'two\n' })
  await $.tool.call({ tool: 'Write', file_path: '/proj/child/b.ts', content: 'two\n' })
  await clock.settle()
  const metas = w.paths().filter(p => p.endsWith('/meta.json'))
  expect(metas.length).toBe(2)
  expect(metas.map(m => JSON.parse(w.read(m) ?? '{}').root).sort()).toEqual(['/proj', '/proj/child'])
  for (const m of metas) {
    const dir = m.slice(0, -'/meta.json'.length)
    expect(w.batches(dir).flatMap(b => b.events.map(e => e.kind))).toEqual(['session', 'turn', 'edit'])
  }

  await $.tool.call({ tool: 'Write', file_path: '/proj/a.ts', content: 'three\n' })
  await clock.settle()
  expect(w.batches().at(-1)?.events.map(e => e.kind)).toEqual(['edit'])
  expect(w.calls.filter(c => c === 'process.run').length).toBe(2)
})

test('the poll picks up a settle VS Code wrote, then stops polling', async ($, on) => {
  const w = fakeWorld(on)
  const clock = mock.clock(on)
  w.file('/proj/a.ts', 'one\n')
  await $.session.start(START)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.tool.call({ tool: 'Write', file_path: '/proj/a.ts', content: 'two\n' })
  await clock.advance(300)
  expect(w.statuses).toEqual(['1 file changed +1 −1 · /changes'])

  const dir = w.paths().find(p => p.endsWith('/meta.json'))?.slice(0, -'/meta.json'.length) ?? ''
  const id = `${(Date.now() + 1000).toString(36).padStart(10, '0')}-x1z-000000-abcd`
  w.file(`${dir}/events/${id}.json`, JSON.stringify({ v: 2, id, at: Date.now(), writer: 'x1z', events: [{ kind: 'settle', path: '/proj/a.ts' }] }))
  await clock.advance(5000)
  expect(w.statuses).toEqual(['1 file changed +1 −1 · /changes', undefined])
  expect(w.summaries.at(-1)?.files).toEqual([])

  const lists = w.calls.filter(c => c === 'fs.list').length
  await clock.advance(20_000)
  expect(w.calls.filter(c => c === 'fs.list').length).toBe(lists)
})

test('recounting reads only the blobs whose refs changed', async ($, on) => {
  const w = fakeWorld(on)
  const clock = mock.clock(on)
  w.file('/proj/a.ts', 'one\n')
  w.file('/proj/b.ts', 'one\n')
  await $.session.start(START)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.tool.call({ tool: 'Write', file_path: '/proj/a.ts', content: 'two\n' })
  await $.tool.call({ tool: 'Write', file_path: '/proj/b.ts', content: 'two\n' })
  await clock.advance(300)

  await $.tool.call({ tool: 'Write', file_path: '/proj/b.ts', content: 'three\n' })
  await clock.settle()
  const during = await callsDuring(w, () => clock.advance(300))
  expect(during.filter(c => c === 'fs.read').length).toBe(1)
  expect(w.summaries.at(-1)?.files.map(f => [f.rel, f.added, f.removed])).toEqual([
    ['a.ts', 1, 1],
    ['b.ts', 1, 1],
  ])
})
