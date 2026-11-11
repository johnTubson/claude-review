// `$(sparkle) 3 files +40 −12`: what is under review, one click from the view.

import * as vscode from 'vscode'

import type { ReviewModel } from '../review/model'

export class ReviewStatus implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('claudeReview.status', vscode.StatusBarAlignment.Left, 102)
  private readonly subscriptions: { dispose(): void }[]

  constructor(private readonly model: ReviewModel) {
    this.item.name = 'Claude Review'
    this.item.command = 'claudeReview.focus'
    this.item.tooltip = 'Show the changes Claude made'
    this.subscriptions = [model.onMembership(() => this.update()), model.onCounts(() => this.update())]
    this.update()
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose()
    this.item.dispose()
  }

  private update(): void {
    const files = this.model.files()
    if (files.length === 0) {
      this.item.hide()
      return
    }
    let added = 0
    let removed = 0
    for (const f of files) {
      if (f.diff.kind !== 'ready') continue
      added += f.diff.added
      removed += f.diff.removed
    }
    const text = `$(sparkle) ${files.length} ${files.length === 1 ? 'file' : 'files'} +${added} −${removed}`
    if (this.item.text !== text) this.item.text = text
    this.item.show()
  }
}
