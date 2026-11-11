// Builds a fixture workspace and its v2 ledger, then runs test/suite inside a real VS Code.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron'

import type { LedgerEvent } from '@core/events'
import { batchId, toRef, toSessionId, type Ref } from '@core/ids'

import { FIXTURE } from './fixture'

const VSCODE_VERSION = '1.142.0'

/** test-electron 2.4.1 expects macOS builds to ship `MacOS/Electron`; recent ones ship `MacOS/Code`. */
const executablePath = async (): Promise<string> => {
  const expected = await downloadAndUnzipVSCode(VSCODE_VERSION)
  const renamed = path.join(path.dirname(expected), 'Code')
  return !existsSync(expected) && existsSync(renamed) ? renamed : expected
}

const refOf = (text: string): Ref => toRef(createHash('sha256').update(text, 'utf8').digest('hex'))

async function main(): Promise<void> {
  // Set when this runs from a terminal inside VS Code; it would start the test VS Code as plain Node.
  delete process.env.ELECTRON_RUN_AS_NODE
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'cr-')))
  const workspace = path.join(root, 'workspace')
  const dataDir = path.join(root, 'data')
  const ledger = path.join(dataDir, 'ledgers', createHash('sha256').update(workspace, 'utf8').digest('hex').slice(0, 16))
  mkdirSync(path.join(workspace, '.vscode'), { recursive: true })
  mkdirSync(path.join(ledger, 'events'), { recursive: true })
  writeFileSync(path.join(ledger, 'meta.json'), JSON.stringify({ v: 2, root: workspace, createdAt: Date.now() }))

  const blob = (text: string | null): Ref | null => {
    if (text === null) return null
    const ref = refOf(text)
    mkdirSync(path.join(ledger, 'blobs', ref.slice(0, 2)), { recursive: true })
    writeFileSync(path.join(ledger, 'blobs', ref.slice(0, 2), ref), text)
    return ref
  }
  const events: LedgerEvent[] = []
  for (const s of FIXTURE.sessions) {
    const session = toSessionId(s.id)
    events.push({ kind: 'session', session, title: s.title, cwd: workspace })
    for (const t of s.turns) {
      events.push({ kind: 'turn', session, turn: t.id, prompt: t.prompt })
      for (const e of t.edits) {
        events.push({ kind: 'edit', session, turn: t.id, path: path.join(workspace, e.file), before: blob(e.before), after: blob(e.after), tool: 'Edit' })
      }
    }
  }
  for (const [file, text] of Object.entries(FIXTURE.live)) writeFileSync(path.join(workspace, file), text)
  const at = Date.now()
  const id = batchId(at, 'fixture', 0, '0000')
  writeFileSync(path.join(ledger, 'events', `${id}.json`), JSON.stringify({ v: 2, id, at, writer: 'fixture', events }))
  writeFileSync(
    path.join(workspace, '.vscode', 'settings.json'),
    JSON.stringify({ 'claudeReview.dataDir': dataDir, 'claudeReview.confirmUndoAll': false, 'claudeReview.confirmUndoSession': false, 'diffEditor.renderSideBySide': false }),
  )

  await runTests({
    vscodeExecutablePath: await executablePath(),
    extensionDevelopmentPath: path.resolve(__dirname, '..'),
    extensionTestsPath: path.resolve(__dirname, 'suite', 'index.js'),
    launchArgs: [workspace, '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--enable-proposed-api=local.claude-review'],
    extensionTestsEnv: { FIXTURE_WORKSPACE: workspace, FIXTURE_LEDGER: ledger, FIXTURE_DATA: dataDir },
  })
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
