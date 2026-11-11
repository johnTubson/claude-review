// Added lines and removed-line markers in plain editors of files under review
// (§7.7). Painted only when a file's layout changes or an editor appears;
// ranges are cached per (path, layout). Never webviews, never insets.

import * as vscode from 'vscode'

import type { Config } from '../config'
import type { Perf } from '../perf'
import type { ReviewModel } from '../review/model'
import { isInReviewDiff } from './reviewDiff'

type Ranges = { readonly layout: string; readonly added: readonly vscode.Range[]; readonly removed: readonly vscode.Range[] }

export class Decorations implements vscode.Disposable {
  private readonly cache = new Map<string, Ranges>()
  private addedType: vscode.TextEditorDecorationType
  private removedType: vscode.TextEditorDecorationType
  private readonly subscriptions: { dispose(): void }[]

  constructor(
    private readonly model: ReviewModel,
    private readonly perf: Perf,
    private readonly config: () => Config,
    private readonly removedIcon: vscode.Uri,
  ) {
    this.addedType = this.makeAdded()
    this.removedType = this.makeRemoved()
    this.subscriptions = [
      model.onLayout(paths => this.paintPaths(paths)),
      model.onMembership(() => this.paintAll()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.paintAll()),
    ]
  }

  /** Settings that change what is drawn rebuild the decoration types. */
  reconfigure(): void {
    this.addedType.dispose()
    this.removedType.dispose()
    this.addedType = this.makeAdded()
    this.removedType = this.makeRemoved()
    this.paintAll()
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose()
    this.addedType.dispose()
    this.removedType.dispose()
  }

  private makeAdded(): vscode.TextEditorDecorationType {
    return vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    })
  }

  private makeRemoved(): vscode.TextEditorDecorationType {
    return vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      borderStyle: 'solid',
      borderWidth: '1px 0 0 0',
      borderColor: new vscode.ThemeColor('editorGutter.deletedBackground'),
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      // Quick diff already marks the gutter.
      ...(this.config().quickDiff ? {} : { gutterIconPath: this.removedIcon, gutterIconSize: 'contain' }),
    })
  }

  private paintPaths(paths: ReadonlySet<string>): void {
    for (const editor of vscode.window.visibleTextEditors) if (paths.has(editor.document.uri.fsPath)) this.paint(editor)
  }

  private paintAll(): void {
    for (const editor of vscode.window.visibleTextEditors) this.paint(editor)
  }

  private paint(editor: vscode.TextEditor): void {
    if (editor.document.uri.scheme !== 'file') return
    const path = editor.document.uri.fsPath
    const d = this.model.get(path)?.diff
    const config = this.config()
    if (d?.kind !== 'ready' || isInReviewDiff(editor)) {
      if (this.cache.delete(path) || d !== undefined) {
        editor.setDecorations(this.addedType, [])
        editor.setDecorations(this.removedType, [])
      }
      return
    }
    let ranges = this.cache.get(path)
    if (ranges?.layout !== d.layout) {
      const lastLine = Math.max(0, editor.document.lineCount - 1)
      const added: vscode.Range[] = []
      const removed: vscode.Range[] = []
      for (const h of d.hunks) {
        for (const line of h.added) added.push(new vscode.Range(line, 0, line, 0))
        for (const r of h.removed) {
          const at = Math.min(r.line, lastLine)
          removed.push(new vscode.Range(at, 0, at, 0))
        }
      }
      ranges = { layout: d.layout, added, removed }
      this.cache.set(path, ranges)
    }
    this.perf.decorationPaints++
    editor.setDecorations(this.addedType, config.addedLines ? ranges.added : [])
    editor.setDecorations(this.removedType, config.removedMarkers ? ranges.removed : [])
  }
}
