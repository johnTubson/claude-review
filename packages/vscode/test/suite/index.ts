// Runs inside VS Code against the fixture runIntegration.ts made.

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'

import type { ClaudeReviewApi } from '../../src/extension'
import type { Perf } from '../../src/perf'
import { A_LIVE, FIXTURE } from '../fixture'

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

const until = async (what: string, check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<number> => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await check()) return Date.now() - start
    await sleep(20)
  }
  return assert.fail(`timed out waiting for: ${what}`)
}

/** Puts a document back to `text` and saves it: typing in the test leaves one undo stop per keystroke. */
const restore = async (doc: vscode.TextDocument, text: string): Promise<void> => {
  const edit = new vscode.WorkspaceEdit()
  edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), text)
  await vscode.workspace.applyEdit(edit)
  await doc.save()
}

const env = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

const delta = (before: Perf, after: Perf): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(after)) out[k] = v - (Object.entries(before).find(([bk]) => bk === k)?.[1] ?? 0)
  return out
}

export async function run(): Promise<void> {
  const workspace = env('FIXTURE_WORKSPACE')
  const ledger = env('FIXTURE_LEDGER')
  const file = (name: string): string => path.join(workspace, name)
  const ext = vscode.extensions.getExtension<ClaudeReviewApi>('local.claude-review')
  if (!ext) throw new Error('the extension is not installed')
  const api = await ext.activate()
  const step = (name: string): void => console.log(`  ✓ ${name}`)
  const { model, perf } = api
  const ready = (p: string) => {
    const d = model.get(p)?.diff
    return d?.kind === 'ready' ? d : undefined
  }

  // A single cold activation in a test VS Code ranges from 16 to 206 ms: E1's 30 ms is checked in
  // manual QA (Developer: Show Running Extensions), so this only reports it.
  step(`E1: activate() returned in ${api.activateMs.toFixed(1)} ms (budget 30 ms, checked in manual QA)`)

  await api.ready
  await until('the fixture ledger loads and every file is diffed', () => model.files().length === 4 && model.files().every(f => f.diff.kind === 'ready')).catch((err: unknown) => {
    console.log(`  states ${JSON.stringify(model.files().map(f => [path.basename(f.path), f.diff.kind, f.diff.kind === 'error' ? f.diff.message : '']))} perf ${JSON.stringify(perf)}`)
    throw err
  })
  assert.equal(ready(file('a.ts'))?.hunks.length, 3)
  assert.deepEqual(
    model.sessions().map(s => [s.title, s.turnKeys.length]),
    [
      ['first session', 2],
      ['second session', 2],
    ],
  )
  step('folds the ledger: 4 files, 2 sessions, a.ts has 3 changes')

  const docA = await vscode.workspace.openTextDocument(file('a.ts'))
  const editor = await vscode.window.showTextDocument(docA, { preview: false })
  editor.selection = new vscode.Selection(10, 0, 10, 0)
  // Quick diff reads the base once for a newly opened document: that is opening, not typing.
  await until('quick diff loaded the base', () => perf.baseDocsProvided > 0, 5000).catch(() => undefined)
  await sleep(500)
  let before = { ...perf }
  const keystrokes: number[] = []
  const listener = vscode.workspace.onDidChangeTextDocument(e => {
    if (e.document === docA && e.contentChanges.length > 0) keystrokes.push(Date.now())
  })
  for (let i = 0; i < 40; i++) await editor.edit(e => e.insert(new vscode.Position(10, 0), 'x'))
  listener.dispose()
  await sleep(1000)
  let d = delta(before, perf)
  assert.equal(d.baseDocsProvided, 0, 'no base document re-read')
  assert.equal(d.baseDocChangeEvents, 0, 'no base change event')
  assert.equal(d.treeFullRefreshes, 0, 'no full tree refresh')
  // E2's rule: at most one diff per pause of 150 ms or more, plus one per 600 ms of typing without
  // such a pause (max-wait), plus the one after the last keystroke. This test VS Code types slowly
  // (an untracked document takes ~10 s for 40 keystrokes), so the pauses are counted, not assumed.
  let allowed = 1
  let runStart = keystrokes[0] ?? 0
  for (let i = 1; i < keystrokes.length; i++) {
    const gap = (keystrokes[i] ?? 0) - (keystrokes[i - 1] ?? 0)
    if (gap >= 150) {
      allowed += 1 + Math.floor(((keystrokes[i - 1] ?? 0) - runStart) / 600)
      runStart = keystrokes[i] ?? 0
    }
  }
  allowed += Math.floor(((keystrokes[keystrokes.length - 1] ?? 0) - runStart) / 600)
  const typingMs = (keystrokes[keystrokes.length - 1] ?? 0) - (keystrokes[0] ?? 0)
  assert.equal(keystrokes.length, 40)
  assert.ok((d.diffsComputed ?? 0) <= allowed, `${d.diffsComputed} diffs while typing 40 chars in ${typingMs} ms (allowed ${allowed})`)
  assert.ok(perf.handlerMsMax < 5, `handlerMsMax ${perf.handlerMsMax.toFixed(2)} ms`)
  step(`E2: typing 40 chars over ${typingMs} ms: ${d.diffsComputed} diffs (rule allows ${allowed}), 0 base reads or events, 0 full tree refreshes, handlers ≤ ${perf.handlerMsMax.toFixed(2)} ms`)

  await restore(docA, A_LIVE)
  await vscode.commands.executeCommand('claudeReview.openDiff', docA.uri)
  const reviewTab = (): boolean => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input
    return input instanceof vscode.TabInputTextDiff && input.original.scheme === 'claude-base'
  }
  await until('the inline review diff opens', reviewTab)
  const diffEditor = vscode.window.activeTextEditor
  assert.equal(diffEditor?.document.uri.fsPath, file('a.ts'), 'the live side is the real file, so it stays editable')
  before = { ...perf }
  for (let i = 0; i < 20; i++) {
    await diffEditor?.edit(e => e.insert(new vscode.Position(1, 0), 'y'))
    await sleep(15)
  }
  await sleep(800)
  d = delta(before, perf)
  assert.equal(d.baseDocChangeEvents, 0, 'typing in the diff never refreshes its base')
  assert.equal(d.baseDocsProvided, 0)
  await restore(docA, A_LIVE)
  step('typing in the open review diff: 0 base reads or events')

  const tabs = (): string =>
    JSON.stringify(vscode.window.tabGroups.all.map(g => g.tabs.map(t => `${t.label}${t.isActive ? '*' : ''}${t.input instanceof vscode.TabInputTextDiff ? ' (diff)' : ''}`)))
  await vscode.commands.executeCommand('claudeReview.toggleDiff')
  await until('⌥D shows the plain file', () => !reviewTab() && vscode.window.activeTextEditor?.document.uri.fsPath === file('a.ts')).catch((err: unknown) => {
    console.log(`  tabs ${tabs()}`)
    throw err
  })
  await vscode.commands.executeCommand('claudeReview.toggleDiff')
  await until('⌥D shows the diff again', reviewTab)
  step('⌥D toggles the plain editor and the inline diff')

  await vscode.commands.executeCommand('claudeReview.reviewAll')
  await until('Review All opens the multi-file diff', () => vscode.window.tabGroups.activeTabGroup.activeTab?.label.startsWith("Claude's changes") === true).catch((err: unknown) => {
    console.log(`  tabs ${tabs()} active input ${JSON.stringify(vscode.window.tabGroups.activeTabGroup.activeTab?.input)}`)
    throw err
  })
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
  step('Review All opens the multi-file diff')

  await until('a.ts is back to the fixture and diffed', () => ready(file('a.ts'))?.hunks.length === 3 && !docA.isDirty && docA.getText() === A_LIVE)
  const first = ready(file('a.ts'))?.hunks[0]
  assert.ok(first)
  await vscode.commands.executeCommand('claudeReview.keepHunk', { path: file('a.ts'), start: first.startLine, sig: first.sig })
  await until('keepHunk leaves 2 changes', () => ready(file('a.ts'))?.hunks.length === 2)
  const removal = ready(file('a.ts'))?.hunks.find(h => h.added.length === 0)
  assert.ok(removal)
  await vscode.commands.executeCommand('claudeReview.undoHunk', { path: file('a.ts'), start: removal.startLine, sig: removal.sig })
  await until('undoHunk puts line 20 back', () => readFileSync(file('a.ts'), 'utf8').includes('line 20\n') && ready(file('a.ts'))?.hunks.length === 1)
  assert.equal(readFileSync(file('a.ts'), 'utf8'), A_LIVE.replace('line 19\n', 'line 19\nline 20\n'))
  step('keepHunk moves the base; undoHunk edits the file and saves it')

  await vscode.commands.executeCommand('claudeReview.keepFile', vscode.Uri.file(file('a.ts')))
  await until('keepFile settles a.ts', () => model.get(file('a.ts')) === undefined)
  step('keepFile settles the file')

  const turnB = model.turns().find(t => t.prompt === 'edit b')
  assert.ok(turnB)
  await vscode.commands.executeCommand('claudeReview.undoTurn', { kind: 'turn', key: turnB.key })
  await until('undoTurn puts b.ts back', () => readFileSync(file('b.ts'), 'utf8') === FIXTURE.bases['b.ts'] && model.get(file('b.ts')) === undefined).catch((err: unknown) => {
    const state = model.get(file('b.ts'))
    console.log(`  b.ts on disk ${JSON.stringify(readFileSync(file('b.ts'), 'utf8'))} state ${JSON.stringify(state?.diff.kind)} entries ${JSON.stringify(state?.record.entries)}`)
    throw err
  })
  step('undoTurn restores the file and settles it')

  const s2 = model.sessions().find(s => s.title === 'second session')
  assert.ok(s2)
  await vscode.commands.executeCommand('claudeReview.undoSession', { kind: 'session', id: s2.id })
  await until('undoSession removes c.ts and restores d.ts', () => readdirSync(workspace).includes('c.ts') === false && readFileSync(file('d.ts'), 'utf8') === FIXTURE.bases['d.ts'])
  await until('nothing left to review', () => model.files().length === 0)
  step('undoSession undoes both turns newest first, deleting the created file')

  // The fixture, then keepHunk, keepFile, undoTurn and undoSession: an undoHunk that leaves changes writes none.
  assert.equal(readdirSync(path.join(ledger, 'events')).length, 5)
  await vscode.commands.executeCommand('claudeReview.keepAll')
  await vscode.commands.executeCommand('claudeReview.undoAll')
  step('keepAll and undoAll with nothing to review are no-ops')
  console.log(`  perf ${JSON.stringify(perf)}`)
}
