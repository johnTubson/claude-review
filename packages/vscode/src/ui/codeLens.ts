// Keep / Undo above each change (opt-in, §7.7): lenses refresh only when an
// open document's layout changes.

import * as vscode from 'vscode'

import type { Perf } from '../perf'
import type { ReviewModel } from '../review/model'
import type { HunkArg } from './reviewDiff'

export class ReviewLenses implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>()
  readonly onDidChangeCodeLenses = this.emitter.event
  private readonly subscription: { dispose(): void }

  constructor(
    private readonly model: ReviewModel,
    private readonly perf: Perf,
    private readonly isEnabled: () => boolean,
  ) {
    this.subscription = model.onLayout(paths => {
      if (!this.isEnabled()) return
      if (!vscode.workspace.textDocuments.some(d => d.uri.scheme === 'file' && paths.has(d.uri.fsPath))) return
      this.perf.lensRefreshes++
      this.emitter.fire()
    })
  }

  refresh(): void {
    this.emitter.fire()
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.isEnabled()) return []
    const d = this.model.get(doc.uri.fsPath)?.diff
    if (d?.kind !== 'ready') return []
    return d.hunks.flatMap(h => {
      const range = new vscode.Range(h.startLine, 0, h.startLine, 0)
      const arg: HunkArg = { path: doc.uri.fsPath, start: h.startLine, sig: h.sig }
      return [
        new vscode.CodeLens(range, { title: 'Keep', command: 'claudeReview.keepHunk', arguments: [arg] }),
        new vscode.CodeLens(range, { title: 'Undo', command: 'claudeReview.undoHunk', arguments: [arg] }),
      ]
    })
  }

  dispose(): void {
    this.subscription.dispose()
    this.emitter.dispose()
  }
}
