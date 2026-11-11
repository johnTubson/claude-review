// Context keys menus and keybindings test (§7.7), each set only when its value
// changes, and the `Change 2/8 · File 1/3` position item. reviewedPaths is an
// object: `in` on it is O(1), on an array O(n).

import * as vscode from 'vscode'

import { focusedHunk, hunkAtLine } from '@core/view'

import type { GroupBy } from '../config'
import type { ReviewModel } from '../review/model'

export class ContextKeys implements vscode.Disposable {
  private readonly values = new Map<string, string>()
  private readonly position: vscode.StatusBarItem
  private readonly subscriptions: { dispose(): void }[]

  constructor(private readonly model: ReviewModel) {
    this.position = vscode.window.createStatusBarItem('claudeReview.position', vscode.StatusBarAlignment.Left, 101)
    this.position.name = 'Claude Review: position'
    this.position.command = 'claudeReview.nextHunk'
    this.position.tooltip = 'Next change (⌥])'
    this.subscriptions = [
      this.position,
      model.onMembership(() => this.updateFiles()),
      model.onLayout(paths => {
        const active = vscode.window.activeTextEditor?.document.uri.fsPath
        if (active !== undefined && paths.has(active)) this.updateCursor()
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateCursor()),
      vscode.window.onDidChangeTextEditorSelection(e => {
        if (e.textEditor === vscode.window.activeTextEditor) this.updateCursor()
      }),
    ]
    this.updateFiles()
  }

  setGroupBy(mode: GroupBy): void {
    this.set('claudeReview.groupBy', mode)
  }

  updateFiles(): void {
    const files = this.model.files()
    this.set('claudeReview.hasChanges', files.length > 0)
    const paths: Record<string, true> = {}
    for (const f of files) paths[f.path] = true
    this.set('claudeReview.reviewedPaths', paths)
    this.updateCursor()
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose()
  }

  private set(key: string, value: boolean | string | Readonly<Record<string, true>>): void {
    const signature = typeof value === 'object' ? Object.keys(value).join('\n') : String(value)
    if (this.values.get(key) === signature) return
    this.values.set(key, signature)
    void vscode.commands.executeCommand('setContext', key, value)
  }

  private updateCursor(): void {
    const editor = vscode.window.activeTextEditor
    const d = editor ? this.model.get(editor.document.uri.fsPath)?.diff : undefined
    if (!editor || d?.kind !== 'ready') {
      this.set('claudeReview.hunkAtCursor', false)
      this.position.hide()
      return
    }
    const line = editor.selection.active.line
    this.set('claudeReview.hunkAtCursor', hunkAtLine(d.hunks, line, d.lineCount) !== undefined)
    const at = hunkAtLine(d.hunks, line, d.lineCount)?.index ?? focusedHunk(d.hunks, line, d.lineCount)?.index
    const files = this.model.files()
    const fileIndex = files.findIndex(f => f.path === editor.document.uri.fsPath)
    const change = at === undefined ? `${d.hunks.length} changes` : `Change ${at + 1}/${d.hunks.length}`
    const text = `$(diff) ${change} · File ${fileIndex + 1}/${files.length}`
    if (this.position.text !== text) this.position.text = text
    this.position.show()
  }
}
