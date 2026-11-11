// The removed text of a change, shown on hover over its lines, with Keep,
// Undo and Open diff (§7.7). O(1) for documents not under review.

import * as vscode from 'vscode'

import { hunkAtLine } from '@core/view'

import type { ReviewModel } from '../review/model'
import { commandLink, type HunkArg } from './reviewDiff'

const ENABLED = ['claudeReview.keepHunk', 'claudeReview.undoHunk', 'claudeReview.openDiff']

export const hoverProvider = (model: ReviewModel): vscode.HoverProvider => ({
  provideHover: (doc, position) => {
    const d = model.get(doc.uri.fsPath)?.diff
    if (d?.kind !== 'ready') return undefined
    const h = hunkAtLine(d.hunks, position.line, d.lineCount)
    if (!h) return undefined
    const arg: HunkArg = { path: doc.uri.fsPath, start: h.startLine, sig: h.sig }
    const removed = h.removed.flatMap(r => r.text)
    const md = new vscode.MarkdownString(undefined, true)
    md.isTrusted = { enabledCommands: ENABLED }
    if (removed.length > 0) md.appendCodeblock(removed.map(l => `- ${l}`).join('\n'), 'diff')
    else md.appendMarkdown('_Added by Claude._\n\n')
    md.appendMarkdown(
      `[Keep ⌥Y](${commandLink('claudeReview.keepHunk', arg)}) · [Undo ⌥N](${commandLink('claudeReview.undoHunk', arg)}) · [Open diff](${commandLink('claudeReview.openDiff', doc.uri)})`,
    )
    return new vscode.Hover(md, new vscode.Range(h.startLine, 0, h.endLine, 0))
  },
})
