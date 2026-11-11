// The extension's settings (§7.8), parsed once and again on each change: no
// code below reads VS Code's configuration for these itself.

import * as os from 'node:os'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { z } from 'zod'

const settingsSchema = z.object({
  openFilesAs: z.enum(['inlineDiff', 'file']).catch('inlineDiff'),
  groupBy: z.enum(['files', 'folders', 'turns', 'sessions']).catch('files'),
  quickDiff: z.boolean().catch(true),
  codeLens: z.boolean().catch(false),
  addedLines: z.boolean().catch(true),
  removedMarkers: z.boolean().catch(true),
  followEdits: z.enum(['off', 'openDiff']).catch('off'),
  confirmUndoAll: z.boolean().catch(true),
  confirmUndoSession: z.boolean().catch(true),
  maxDiffBytes: z.number().int().positive().catch(4 * 1024 * 1024),
  dataDir: z.string().catch(''),
})

export type GroupBy = z.infer<typeof settingsSchema>['groupBy']

export type Config = Omit<z.infer<typeof settingsSchema>, 'dataDir'> & {
  /** Where v2 ledgers and sockets live: the setting, else ~/.claude/claude-review/v2. */
  readonly dataDir: string
  /** 0.2's data dir, read only by migration and cleanup. */
  readonly legacyDir: string
  /** 0.1's sessions, read only by importOldSessions and cleanup. */
  readonly legacySessionsDir: string
}

const expandHome = (p: string): string => p.replace(/^~(?=$|\/)/, os.homedir())

export const readConfig = (): Config => {
  const c = vscode.workspace.getConfiguration('claudeReview')
  const parsed = settingsSchema.parse({
    openFilesAs: c.get('openFilesAs'),
    groupBy: c.get('groupBy'),
    quickDiff: c.get('quickDiff'),
    codeLens: c.get('codeLens'),
    addedLines: c.get('decorations.addedLines'),
    removedMarkers: c.get('decorations.removedMarkers'),
    followEdits: c.get('followEdits'),
    confirmUndoAll: c.get('confirmUndoAll'),
    confirmUndoSession: c.get('confirmUndoSession'),
    maxDiffBytes: c.get('maxDiffBytes'),
    dataDir: c.get('dataDir'),
  })
  const claude = path.join(os.homedir(), '.claude')
  return {
    ...parsed,
    dataDir: parsed.dataDir ? expandHome(parsed.dataDir) : path.join(claude, 'claude-review', 'v2'),
    legacyDir: path.join(claude, 'claude-review'),
    legacySessionsDir: path.join(claude, 'session-review'),
  }
}

export class ConfigSource implements vscode.Disposable {
  private value = readConfig()
  private readonly emitter = new vscode.EventEmitter<{ readonly previous: Config; readonly current: Config }>()
  readonly onDidChange = this.emitter.event
  private readonly subscription = vscode.workspace.onDidChangeConfiguration(e => {
    if (!e.affectsConfiguration('claudeReview')) return
    const previous = this.value
    this.value = readConfig()
    this.emitter.fire({ previous, current: this.value })
  })

  get current(): Config {
    return this.value
  }

  dispose(): void {
    this.subscription.dispose()
    this.emitter.dispose()
  }
}
