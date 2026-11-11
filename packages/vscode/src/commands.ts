// Every command (§7.8): arguments parsed with zod at the boundary, timed into
// handlerMsMax, then handed to the actions and the surfaces.

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { z } from 'zod'

import { isSessionId, isTurnKey, type SessionId, type TurnKey } from '@core/ids'
import { focusedHunk } from '@core/view'

import type { ConfigSource, GroupBy } from './config'
import { importOldSessions } from './ledger/migrate'
import { CancelledError, measureAll, storageCandidates } from './ledger/storage'
import type { Log } from './log'
import { reasonOf } from './log'
import type { Perf } from './perf'
import { timed } from './perf'
import type { ActionQueue, ActionResult } from './review/actions'
import type { ReviewModel } from './review/model'
import type { ContextKeys } from './ui/contextKeys'
import { ensureInlineSettings, openDiff, openTurnDiff, REVIEW_ALL_TITLE, reviewFiles, reviewTurnChanges, showReview, toggleDiff } from './ui/diffEditors'
import type { HunkArg } from './ui/reviewDiff'
import { nodeSchema, type ChangesTree, type Node } from './ui/tree'

const lineRangeSchema = z.object({ startLineNumber: z.number().int(), endLineNumberExclusive: z.number().int() })

/** What the inline diff editor's gutter passes to `diffEditor/gutter/hunk` commands (1-based lines). */
const gutterArgSchema = z.object({
  modifiedUri: z.custom<vscode.Uri>(v => v instanceof vscode.Uri).optional(),
  originalWithModifiedChanges: z.string(),
  mapping: z.object({ original: lineRangeSchema, modified: lineRangeSchema }),
})

const hunkArgSchema = z.object({ path: z.string().min(1), start: z.number().int().nonnegative(), sig: z.string().min(1) })
const keySchema = z.string().min(1)

const asUri = (arg: unknown): vscode.Uri | undefined => (arg instanceof vscode.Uri ? arg : undefined)

const asNode = (arg: unknown): Node | undefined => {
  const parsed = nodeSchema.safeParse(arg)
  return parsed.success ? parsed.data : undefined
}

export type CommandDeps = {
  readonly context: vscode.ExtensionContext
  readonly model: ReviewModel
  readonly actions: ActionQueue
  readonly config: ConfigSource
  readonly tree: ChangesTree
  readonly contextKeys: ContextKeys
  readonly log: Log
  readonly perf: Perf
  readonly refresh: () => Promise<void>
  readonly folders: () => readonly string[]
  readonly onImported: (ledgerDir: string) => void
}

const formatBytes = (n: number): string => (n > 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : n > 1 << 20 ? `${(n / (1 << 20)).toFixed(0)} MB` : `${(n / 1024).toFixed(0)} KB`)

export const registerCommands = (deps: CommandDeps): void => {
  const { context, model, actions, config, tree, contextKeys, log, perf } = deps
  const show = (uri: vscode.Uri, line: number): Promise<void> => showReview(model, config.current, uri, line)

  const register = (id: string, run: (...args: unknown[]) => unknown): void => {
    const handler = timed(perf, log, id, (...args: unknown[]) =>
      Promise.resolve(run(...args)).catch((err: unknown) => {
        log.error(id, err)
        void vscode.window.showErrorMessage(`Claude Review: ${reasonOf(err)}`)
      }),
    )
    context.subscriptions.push(vscode.commands.registerCommand(id, handler))
  }

  const report = (result: ActionResult, verb: string): void => {
    switch (result.kind) {
      case 'moved':
        vscode.window.setStatusBarMessage('That change moved, try again', 3000)
        return
      case 'conflicts': {
        const names = result.conflicts.map(p => path.basename(p)).join(', ')
        void vscode.window.showWarningMessage(`Could not ${verb} in ${names}: a later change overlaps it. Resolve those files change by change.`)
        return
      }
      case 'done':
      case 'nothing':
        return
      default: {
        const unhandled: never = result
        throw new Error(`unknown action result ${JSON.stringify(unhandled)}`)
      }
    }
  }

  const activePath = (): string | undefined => {
    const doc = vscode.window.activeTextEditor?.document
    return doc?.uri.scheme === 'file' ? doc.uri.fsPath : undefined
  }

  /** The file a command means: its argument (a Uri or tree node), else the active editor's. */
  const targetFile = (arg: unknown): string | undefined => {
    const uri = asUri(arg)
    const node = asNode(arg)
    const p = uri?.fsPath ?? (node?.kind === 'file' ? node.path : activePath())
    return p !== undefined && model.get(p) ? p : undefined
  }

  /** The hunk a command means: its argument (hover, lens), else the one at the cursor or next below it. */
  const targetHunk = (arg: unknown): HunkArg | undefined => {
    const parsed = hunkArgSchema.safeParse(arg)
    if (parsed.success) return parsed.data
    const editor = vscode.window.activeTextEditor
    const p = activePath()
    const d = p === undefined ? undefined : model.get(p)?.diff
    if (!editor || p === undefined || d?.kind !== 'ready') return undefined
    const h = focusedHunk(d.hunks, editor.selection.active.line, d.lineCount)
    return h ? { path: p, start: h.startLine, sig: h.sig } : undefined
  }

  /** After a change or file is resolved, the cursor goes to the next change, or the next file's, like Cursor. */
  const revealNext = async (filePath: string, fromLine: number, fileIndex: number): Promise<void> => {
    const d = model.get(filePath)?.diff
    const next = d?.kind === 'ready' ? (d.hunks.find(h => h.startLine >= fromLine) ?? d.hunks[0]) : undefined
    if (next) return show(vscode.Uri.file(filePath), next.startLine)
    const files = model.files()
    const after = files[Math.min(fileIndex, files.length - 1)]
    if (after) await show(vscode.Uri.file(after.path), after.diff.kind === 'ready' ? (after.diff.hunks[0]?.startLine ?? 0) : 0)
  }

  const indexOf = (p: string): number => model.files().findIndex(f => f.path === p)

  const hunkCommand = (keep: boolean) => async (arg?: unknown) => {
    const target = targetHunk(arg)
    if (!target) return void vscode.window.setStatusBarMessage('No Claude change here', 2000)
    const wasActive = activePath() === target.path
    const line = wasActive ? (vscode.window.activeTextEditor?.selection.active.line ?? 0) : 0
    const fileIndex = indexOf(target.path)
    const result = keep ? await actions.keepHunk(target) : await actions.undoHunk(target)
    report(result, keep ? 'keep that change' : 'undo that change')
    if (wasActive && result.kind === 'done') await revealNext(target.path, line, fileIndex)
  }

  const fileCommand = (keep: boolean) => async (arg?: unknown) => {
    const p = targetFile(arg)
    if (p === undefined) return
    const fileIndex = indexOf(p)
    const wasActive = activePath() === p
    report(keep ? await actions.keepFile(p) : await actions.undoFile(p), keep ? 'keep the file' : 'undo the file')
    if (wasActive) await revealNext(p, 0, fileIndex)
  }

  const mappingCommand = (keep: boolean) => async (arg?: unknown) => {
    const parsed = gutterArgSchema.safeParse(arg)
    if (!parsed.success) return log.error('diff gutter action', parsed.error)
    const { mapping, originalWithModifiedChanges } = parsed.data
    const uri = parsed.data.modifiedUri ?? vscode.window.activeTextEditor?.document.uri
    if (!uri) return
    const zeroBased = (r: z.infer<typeof lineRangeSchema>) => ({ start: r.startLineNumber - 1, end: r.endLineNumberExclusive - 1 })
    report(
      keep ? await actions.keepMapping(uri.fsPath, originalWithModifiedChanges) : await actions.undoMapping(uri.fsPath, zeroBased(mapping.original), zeroBased(mapping.modified)),
      keep ? 'keep that change' : 'undo that change',
    )
  }

  const turnKeyOf = (arg: unknown): TurnKey | undefined => {
    const node = asNode(arg)
    const key = node?.kind === 'turn' ? node.key : node?.kind === 'file' ? node.turn : keySchema.safeParse(arg).data
    return isTurnKey(key) ? key : undefined
  }

  const sessionIdOf = (arg: unknown): SessionId | undefined => {
    const node = asNode(arg)
    const id = node?.kind === 'session' ? node.id : keySchema.safeParse(arg).data
    return isSessionId(id) ? id : undefined
  }

  const confirm = async (message: string, detail: string, button: string): Promise<boolean> =>
    (await vscode.window.showWarningMessage(message, { modal: true, detail }, button)) === button

  const setGroupBy = async (mode: GroupBy): Promise<void> => {
    tree.setGroupBy(mode)
    contextKeys.setGroupBy(mode)
    await vscode.workspace.getConfiguration('claudeReview').update('groupBy', mode, vscode.ConfigurationTarget.Global)
  }

  register('claudeReview.focus', () => vscode.commands.executeCommand('claudeReview.changes.focus'))
  register('claudeReview.refresh', deps.refresh)
  register('claudeReview.groupByFiles', () => setGroupBy('files'))
  register('claudeReview.groupByFolders', () => setGroupBy('folders'))
  register('claudeReview.groupByTurns', () => setGroupBy('turns'))
  register('claudeReview.groupBySessions', () => setGroupBy('sessions'))

  register('claudeReview.keepHunk', hunkCommand(true))
  register('claudeReview.undoHunk', hunkCommand(false))
  register('claudeReview.keepFile', fileCommand(true))
  register('claudeReview.undoFile', fileCommand(false))
  register('claudeReview.keepMapping', mappingCommand(true))
  register('claudeReview.undoMapping', mappingCommand(false))
  register('claudeReview.keepTurn', async (arg?: unknown) => {
    const key = turnKeyOf(arg)
    if (key !== undefined) report(await actions.keepTurn(key), 'keep this turn')
  })
  register('claudeReview.undoTurn', async (arg?: unknown) => {
    const key = turnKeyOf(arg)
    if (key !== undefined) report(await actions.undoTurn(key), 'undo this turn')
  })
  register('claudeReview.keepSession', async (arg?: unknown) => {
    const id = sessionIdOf(arg)
    if (id !== undefined) report(await actions.keepSession(id), 'keep this session')
  })
  register('claudeReview.undoSession', async (arg?: unknown) => {
    const id = sessionIdOf(arg)
    const session = id === undefined ? undefined : model.sessionOf(id)
    if (id === undefined || !session) return
    if (config.current.confirmUndoSession) {
      const isSure = await confirm(`Undo every change of “${session.title || id.slice(0, 8)}”?`, `${session.turnKeys.length} turn(s), newest first. ⌘Z brings them back.`, 'Undo Session')
      if (!isSure) return
    }
    report(await actions.undoSession(id), 'undo this session')
  })
  register('claudeReview.keepAll', async () => report(await actions.keepAll(), 'keep everything'))
  register('claudeReview.undoAll', async () => {
    const count = model.files().length
    if (count === 0) return
    if (config.current.confirmUndoAll) {
      const isSure = await confirm(`Undo every change Claude made to ${count} file${count === 1 ? '' : 's'}?`, 'Each file goes back to how it was before the changes under review. ⌘Z brings them back.', 'Undo All')
      if (!isSure) return
    }
    report(await actions.undoAll(), 'undo everything')
  })
  register('claudeReview.revertLastKeep', async () => {
    const r = await actions.revertLastKeep()
    if (r.kind === 'nothing') vscode.window.setStatusBarMessage('No keep to revert', 2000)
  })

  register('claudeReview.nextHunk', () => stepHunk(model, show, 1))
  register('claudeReview.prevHunk', () => stepHunk(model, show, -1))
  register('claudeReview.nextFile', (arg?: unknown) => stepFile(model, show, 1, asUri(arg)))
  register('claudeReview.prevFile', (arg?: unknown) => stepFile(model, show, -1, asUri(arg)))
  register('claudeReview.toggleDiff', () => toggleDiff(model))

  register('claudeReview.openFile', async (arg?: unknown) => {
    const uri = asUri(arg)
    if (!uri) return
    void ensureInlineSettings(context, config.current)
    const d = model.get(uri.fsPath)?.diff
    await show(uri, d?.kind === 'ready' ? (d.hunks[0]?.startLine ?? 0) : 0)
  })
  register('claudeReview.openDiff', async (arg?: unknown) => {
    const p = targetFile(arg)
    if (p === undefined) return
    void ensureInlineSettings(context, config.current)
    const d = model.get(p)?.diff
    const line = activePath() === p ? vscode.window.activeTextEditor?.selection.active.line : d?.kind === 'ready' ? d.hunks[0]?.startLine : undefined
    await openDiff(model, vscode.Uri.file(p), line)
  })
  register('claudeReview.openTurnDiff', async (arg?: unknown) => {
    const node = asNode(arg)
    if (node?.kind === 'file' && node.turn !== undefined) await openTurnDiff(model, node.path, node.turn)
  })
  register('claudeReview.reviewAll', async () => {
    void ensureInlineSettings(context, config.current)
    await reviewFiles(model, REVIEW_ALL_TITLE, model.files().map(f => f.path))
  })
  register('claudeReview.reviewTurn', async (arg?: unknown) => {
    const key = turnKeyOf(arg)
    if (key !== undefined) await reviewTurnChanges(model, key)
  })
  register('claudeReview.reviewSession', async (arg?: unknown) => {
    const id = sessionIdOf(arg)
    const session = id === undefined ? undefined : model.sessionOf(id)
    if (!session) return
    const keys = new Set(session.turnKeys)
    const paths = model.files().filter(f => f.record.entries.some(en => keys.has(en.turn) && !en.isResolved)).map(f => f.path)
    await reviewFiles(model, session.title || `Session ${session.id.slice(0, 8)}`, paths)
  })

  register('claudeReview.importOldSessions', async () => {
    const c = config.current
    const result = await importOldSessions({ sessionsDir: c.legacySessionsDir, legacyDir: c.legacyDir, dataDir: c.dataDir, folders: deps.folders(), log, onWritten: deps.onImported })
    void vscode.window.showInformationMessage(result.files === 0 ? 'No old sessions to import for this window.' : `Imported ${result.files} file(s) from old sessions.`)
  })
  register('claudeReview.cleanUpStorage', async () => {
    const c = config.current
    const measured = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Measuring old Claude Review storage…', cancellable: true },
      async (_progress, token) => {
        try {
          return await measureAll(await storageCandidates(c.legacyDir, c.legacySessionsDir), { isCancelled: () => token.isCancellationRequested })
        } catch (err) {
          if (err instanceof CancelledError) return undefined
          throw err
        }
      },
    )
    if (!measured) return
    if (measured.length === 0) return void vscode.window.showInformationMessage('Nothing old to clean up.')
    const picks = await vscode.window.showQuickPick(
      measured.map(m => ({ label: m.label, description: formatBytes(m.bytes), detail: m.path, picked: true, measured: m })),
      { canPickMany: true, title: 'Delete these old stores? (they are not used by this version)' },
    )
    if (!picks || picks.length === 0) return
    const total = picks.reduce((n, p) => n + p.measured.bytes, 0)
    if (!(await confirm(`Delete ${picks.length} item(s), ${formatBytes(total)}?`, picks.map(p => p.measured.path).join('\n'), 'Delete'))) return
    void Promise.all(picks.map(p => fs.rm(p.measured.path, { recursive: true, force: true })))
      .then(() => vscode.window.showInformationMessage(`Freed ${formatBytes(total)}.`))
      .catch((err: unknown) => log.error('cleaning up storage', err))
  })
  register('claudeReview.showStats', () => {
    log.info(`perf ${JSON.stringify(perf)}`)
    const lines = Object.entries(perf).map(([k, v]) => `${k}: ${Number.isInteger(v) ? v : v.toFixed(1)}`)
    void vscode.window.showInformationMessage(`Claude Review stats — ${lines.join(' · ')}`)
  })
}

type Show = (uri: vscode.Uri, line: number) => Promise<void>

const stepHunk = async (model: ReviewModel, show: Show, dir: 1 | -1): Promise<void> => {
  const files = model.files()
  const all = files.flatMap((f, fi) => (f.diff.kind === 'ready' ? f.diff.hunks.map(h => ({ path: f.path, fi, start: h.startLine })) : []))
  const editor = vscode.window.activeTextEditor
  const fileIdx = editor ? files.findIndex(f => f.path === editor.document.uri.fsPath) : -1
  const line = editor?.selection.active.line ?? -1
  const target =
    dir === 1
      ? (all.find(({ fi, start }) => fi > fileIdx || (fi === fileIdx && start > line)) ?? all[0])
      : ([...all].reverse().find(({ fi, start }) => fi < fileIdx || (fi === fileIdx && start < line)) ?? all[all.length - 1])
  if (target) await show(vscode.Uri.file(target.path), target.start)
}

/** The next or previous file under review, from `from` (the toolbar's file) or the active editor's. */
const stepFile = async (model: ReviewModel, show: Show, dir: 1 | -1, from: vscode.Uri | undefined): Promise<void> => {
  const files = model.files()
  if (files.length === 0) return
  const fromPath = from?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath
  const at = fromPath === undefined ? -1 : files.findIndex(f => f.path === fromPath)
  const n = files.length
  const next = at < 0 ? files[dir === 1 ? 0 : n - 1] : files[(((at + dir) % n) + n) % n]
  if (next) await show(vscode.Uri.file(next.path), next.diff.kind === 'ready' ? (next.diff.hunks[0]?.startLine ?? 0) : 0)
}
