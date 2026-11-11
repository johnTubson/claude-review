// VS Code's own diff editors as the review surface (§7.7): one file in the
// inline diff (Keep / Undo in its gutter), several in the multi-file diff.

import * as path from 'node:path'
import * as vscode from 'vscode'

import type { Config } from '../config'
import type { ReviewModel } from '../review/model'
import { baseUri, blobUri } from './baseDocs'
import { isInReviewDiff, isReviewDiffTab } from './reviewDiff'

const ASKED_KEY = 'claudeReview.askedInlineSettings'

/** The inline view is a VS Code-wide setting, so it changes only once the person agrees, asked once. */
export const ensureInlineSettings = async (context: vscode.ExtensionContext, config: Config): Promise<void> => {
  if (config.openFilesAs !== 'inlineDiff' || context.globalState.get<boolean>(ASKED_KEY)) return
  const diff = vscode.workspace.getConfiguration('diffEditor')
  if (diff.get<boolean>('renderSideBySide') === false) return
  const choice = await vscode.window.showInformationMessage(
    "Claude Review shows changes in VS Code's inline diff: removed lines in red between the real ones, Keep / Undo on each change. That needs inline view for every diff editor (diffEditor.renderSideBySide off).",
    'Use inline view',
    'Keep my settings',
  )
  if (choice === undefined) return
  await context.globalState.update(ASKED_KEY, true)
  if (choice === 'Use inline view') await diff.update('renderSideBySide', false, vscode.ConfigurationTarget.Global)
}

/** Moves the cursor to a line; a file already in the active editor is not opened again. */
export const revealLine = async (uri: vscode.Uri, line: number): Promise<void> => {
  const active = vscode.window.activeTextEditor
  const editor = active?.document.uri.fsPath === uri.fsPath ? active : await vscode.window.showTextDocument(uri, { preview: false })
  const last = Math.max(0, editor.document.lineCount - 1)
  const pos = new vscode.Position(Math.min(line, last), 0)
  editor.selection = new vscode.Selection(pos, pos)
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport)
}

const titleOf = (uri: vscode.Uri): string => `${path.basename(uri.fsPath)} · Claude's changes`

const isDeleted = (model: ReviewModel, uri: vscode.Uri): boolean => {
  const record = model.get(uri.fsPath)?.record
  return record !== undefined && record.entries[record.entries.length - 1]?.after === null
}

export const openDiff = async (model: ReviewModel, uri: vscode.Uri, line?: number, options: { preview?: boolean; preserveFocus?: boolean } = {}): Promise<void> => {
  const selection = line === undefined ? undefined : new vscode.Range(line, 0, line, 0)
  // A deleted file has no live side: the base against an empty document.
  const right = isDeleted(model, uri) ? blobUri('', null, path.basename(uri.fsPath)) : uri
  await vscode.commands.executeCommand('vscode.diff', baseUri(uri), right, titleOf(uri), { preview: options.preview ?? false, preserveFocus: options.preserveFocus ?? false, selection })
}

/** A file under review at a line, the way the settings say: the inline diff, or the file itself. */
export const showReview = async (model: ReviewModel, config: Config, uri: vscode.Uri, line: number): Promise<void> => {
  const state = model.get(uri.fsPath)
  if (state && isDeleted(model, uri)) return openDiff(model, uri)
  const active = vscode.window.activeTextEditor
  const isShown = active?.document.uri.fsPath === uri.fsPath
  if (config.openFilesAs === 'file' || !state || (isShown && active && isInReviewDiff(active))) return revealLine(uri, line)
  await openDiff(model, uri, line)
}

/**
 * ⌥D: the plain editor and the inline diff swap in the same group, keeping the
 * line. Decided by the active tab: in a diff editor the active text editor may
 * be its original (`claude-base:`) side.
 */
export const toggleDiff = async (model: ReviewModel): Promise<void> => {
  const group = vscode.window.tabGroups.activeTabGroup
  const current = group.activeTab
  const editor = vscode.window.activeTextEditor
  const line = editor?.selection.active.line ?? 0
  const selection = new vscode.Range(line, 0, line, 0)
  if (isReviewDiffTab(current)) {
    const uri = current.input.modified
    await vscode.window.showTextDocument(uri, group.viewColumn === undefined ? { preview: false, selection } : { viewColumn: group.viewColumn, preview: false, selection })
  } else {
    const uri = editor?.document.uri
    if (!uri || uri.scheme !== 'file' || !model.get(uri.fsPath)) return
    await openDiff(model, uri, line)
  }
  if (current && !current.isDirty && current !== vscode.window.tabGroups.activeTabGroup.activeTab) await vscode.window.tabGroups.close(current, true)
}

export const REVIEW_ALL_TITLE = "Claude's changes"

/** Files in VS Code's multi-file diff: base on the left, live on the right. */
export const reviewFiles = async (model: ReviewModel, title: string, paths: readonly string[]): Promise<void> => {
  if (paths.length === 0) return
  const resources = paths.map(p => {
    const uri = vscode.Uri.file(p)
    return [uri, baseUri(uri), isDeleted(model, uri) ? blobUri('', null, path.basename(p)) : uri] as const
  })
  await vscode.commands.executeCommand('vscode.changes', title, resources)
}

/** One turn's own change to each file: that entry's before and after blobs. */
export const reviewTurnChanges = async (model: ReviewModel, key: string): Promise<void> => {
  const turn = model.turnOf(key)
  if (!turn) return
  const resources = turn.paths.flatMap(p => {
    const s = model.get(p)
    const entry = s?.record.entries.find(en => en.turn === key && !en.isResolved)
    if (!s || !entry) return []
    const uri = vscode.Uri.file(p)
    return [[uri, blobUri(s.ledgerDir, entry.before, path.basename(p)), blobUri(s.ledgerDir, entry.after, path.basename(p))] as const]
  })
  if (resources.length > 0) await vscode.commands.executeCommand('vscode.changes', `#${turn.n} ${turn.prompt}`, resources)
}

/** One file's change in one turn, as a plain two-way diff. */
export const openTurnDiff = async (model: ReviewModel, filePath: string, key: string): Promise<void> => {
  const s = model.get(filePath)
  const entry = s?.record.entries.find(en => en.turn === key && !en.isResolved)
  if (!s || !entry) return
  const name = path.basename(filePath)
  await vscode.commands.executeCommand('vscode.diff', blobUri(s.ledgerDir, entry.before, name), blobUri(s.ledgerDir, entry.after, name), `${name} · turn #${model.turnOf(key)?.n ?? '?'}`)
}

/** Closes review diffs of files with nothing left to review, as Cursor moves on. */
export const closeFinishedReviews = async (model: ReviewModel): Promise<void> => {
  const finished = vscode.window.tabGroups.all.flatMap(group =>
    group.tabs.filter(tab => {
      if (!isReviewDiffTab(tab) || tab.isDirty) return false
      const d = model.get(tab.input.modified.fsPath)?.diff
      return d === undefined || d.kind === 'clean'
    }),
  )
  if (finished.length > 0) await vscode.window.tabGroups.close(finished, true)
}
