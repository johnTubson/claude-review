import { expect, mock, test, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { DATA, fakeWorld } from './world.testkit'

const START = { cwd: '/proj', surface: 'terminal', isInteractive: true } as const
const lines = (n: number, tag = ''): string => Array.from({ length: n }, (_, i) => `line ${i + 1}${tag}\n`).join('')
const A0 = lines(30)
const A1 = A0.replace('line 3\n', 'line 3 changed\n').replace('line 25\n', 'line 25 changed\n')
const A2 = A1.replace('line 12\n', 'line 12 by turn 2\n')
const B0 = 'b\n'

const PANE = {
  plugin: 'session-review',
  component: 'Pane',
  requestId: 'session-review',
  props: { title: 'Review changes', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const
const BAND = { plugin: 'session-review', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 100, scroll: { offset: 0, bodyRows: 3 }, view: {} } } as const

/** Two turns of one session: a.ts in both, b.ts created in the first. */
const reviewed = async ($: Engine, on: On) => {
  const w = fakeWorld(on)
  const clock = mock.clock(on)
  w.file('/proj/a.ts', A0)
  await $.session.start(START)
  await $.turn.start({ text: 'first prompt', turnId: 't1' })
  await $.tool.call({ tool: 'Write', file_path: '/proj/a.ts', content: A1 })
  await $.tool.call({ tool: 'Write', file_path: '/proj/b.ts', content: B0 })
  await $.turn.start({ text: 'second prompt', turnId: 't2' })
  await $.tool.call({ tool: 'Write', file_path: '/proj/a.ts', content: A2 })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
  await clock.advance(300)
  const changes = async (args: string): Promise<string> =>
    (await $.command.run({ command: 'changes', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })).text ?? ''
  return { w, clock, changes }
}

test('/changes lists sessions, turns and numbered files, and opens the pane', async ($, on) => {
  const { w, changes } = await reviewed($, on)
  const text = await changes('')
  expect(text).toContain('**2 files changed**')
  expect(text).toContain('**Session 1** “first prompt”')
  expect(text).toContain('- turn 1: “first prompt”')
  expect(text).toContain('- turn 2: “second prompt”')
  expect(text).toContain('1. `a.ts` +3 −3')
  expect(text).toContain('2. `b.ts` +1 −0, new file')
  expect(w.calls).toContain('ui.open')
  const shown = await changes('show 1')
  expect(shown).toContain('Change **1.1**')
  expect(shown).toContain('+line 3 changed')
})

test('keep 1.1 moves the base; undo 2 deletes a created file; undo turn 2 takes back only that turn', async ($, on) => {
  const { w, changes } = await reviewed($, on)
  const kept = await changes('keep 1.1')
  expect(kept).toContain('Kept change 1.1')
  expect(w.read('/proj/a.ts')).toBe(A2)
  expect(w.batches().at(-1)?.events.map(e => e.kind)).toEqual(['keep'])
  await changes('undo 2')
  expect(w.read('/proj/b.ts')).toBe(undefined)
  expect(w.batches().at(-1)?.events.map(e => e.kind)).toEqual(['resolve', 'settle'])
  const undone = await changes('undo turn 2')
  expect(undone).toContain('Undid turn 2.')
  expect(w.read('/proj/a.ts')).toBe(A1)
})

test('keep session 1 settles everything; the summary empties', async ($, on) => {
  const { w, changes } = await reviewed($, on)
  const text = await changes('keep session 1')
  expect(text).toContain('Kept session 1.')
  expect(text).toContain('No changes to review.')
  expect(w.read('/proj/a.ts')).toBe(A2)
  expect(w.summaries.at(-1)?.files).toEqual([])
})

test('open 1 asks VS Code over the bridge, and falls back to the text diff', async ($, on) => {
  const { w, changes } = await reviewed($, on)
  const fallback = await changes('open 1')
  expect(fallback).toContain('No VS Code window has `a.ts` under review')
  w.file(`${DATA}/sockets/w1.sock`, '')
  w.file(`${DATA}/sockets/w2.sock`, '')
  const opened = await changes('open 1')
  expect(opened).toContain('Opened `a.ts`')
  const open = w.pings.filter(p => p.url.endsWith('/open'))
  expect(open.length).toBe(1)
  expect(JSON.parse(open[0]?.body ?? '{}').path).toBe('/proj/a.ts')
})

test('the pane lists the review and its buttons act, on every surface', async ($, on) => {
  const { w } = await reviewed($, on)
  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /2 files/ })).toBeDefined()
    expect(await ui.find({ key: 'all-keep' })).toBeDefined()
    await ui.unmount()
  }
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'open:Session-1abc:t1:/proj/a.ts' })
  expect(await ui.find({ key: 'file-keep' })).toBeDefined()
  await ui.press({ key: 'undo-0' })
  expect(w.read('/proj/a.ts')).toBe(A2.replace('line 3 changed\n', 'line 3\n'))
  await ui.press({ key: 'back' })
  await ui.press({ key: 'all-keep' })
  expect(await ui.find({ type: 'Text', text: /No changes to review/ })).toBeDefined()
  await ui.unmount()
})

test('the band shows above the prompt on terminal and desktop, and Undo all undoes', async ($, on) => {
  // The engine's own row, which the band steps aside for once nothing is left.
  on('ui.render', { component: 'AbovePrompt' }, ($$, e) => {
    const { Text } = $$.ui.resolve(e)
    return <Text>engine</Text>
  })
  const { w } = await reviewed($, on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /◆ 2 files/ })).toBeDefined()
    await ui.unmount()
  }
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'band-undo' })
  expect(w.read('/proj/a.ts')).toBe(A0)
  expect(w.read('/proj/b.ts')).toBe(undefined)
  expect(await ui.find({ key: 'band-review' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /engine/ })).toBeDefined()
  await ui.unmount()
})
