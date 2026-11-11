// Live texts through VS Code: open documents first, the disk otherwise; and
// action edits as one WorkspaceEdit, so ⌘Z brings them back, then saved.

import { promises as fs } from 'node:fs'
import * as vscode from 'vscode'

import { applyLineEdits } from '@core/plan'

import { isMissing, writeAtomic } from '../ledger/fsx'
import type { LiveEdit, LiveProbe, LiveTexts, LiveWriter } from './live'

const openDocument = (path: string): vscode.TextDocument | undefined =>
  vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && d.uri.fsPath === path)

/** A document's identity: new each time it opens, so a reopened one never matches an old version. */
export class DocIdentities {
  private readonly ids = new WeakMap<vscode.TextDocument, number>()
  private next = 1

  onOpen(doc: vscode.TextDocument): void {
    this.ids.set(doc, this.next++)
  }

  of(doc: vscode.TextDocument): number {
    let id = this.ids.get(doc)
    if (id === undefined) {
      id = this.next++
      this.ids.set(doc, id)
    }
    return id
  }
}

/** Length of an open document without copying its text. */
export const documentLength = (doc: vscode.TextDocument): number => doc.offsetAt(doc.lineAt(doc.lineCount - 1).range.end)

export const vscodeLiveTexts = (identities: DocIdentities): LiveTexts => ({
  probe: async (path: string): Promise<LiveProbe> => {
    const doc = openDocument(path)
    if (doc) return { version: `d${identities.of(doc)}:${doc.version}`, size: documentLength(doc), read: async () => doc.getText() }
    try {
      const stat = await fs.stat(path)
      return { version: `f${stat.mtimeMs}:${stat.size}`, size: stat.size, read: () => fs.readFile(path, 'utf8') }
    } catch (err) {
      if (!isMissing(err)) throw err
      return { version: 'missing', size: 0, read: async () => null }
    }
  },
})

/** Open in an editor tab the person can see: a plain tab, or the live side of a diff. */
const isInTab = (path: string): boolean =>
  vscode.window.tabGroups.all.some(g =>
    g.tabs.some(t => (t.input instanceof vscode.TabInputText && t.input.uri.fsPath === path) || (t.input instanceof vscode.TabInputTextDiff && t.input.modified.fsPath === path)),
  )

const endOfLine = (doc: vscode.TextDocument, line: number): vscode.Position =>
  line >= doc.lineCount ? doc.lineAt(doc.lineCount - 1).range.end : new vscode.Position(line, 0)

/**
 * Files open in an editor tab change through one WorkspaceEdit, so ⌘Z brings
 * them back, and are saved. Any other file is written on disk directly: a
 * document no tab holds (opened in the background, or left loaded after its
 * editor closed) can be saved without the write reaching the disk (seen on VS
 * Code 1.142), and such a file has no editor to undo in anyway.
 */
export const vscodeLiveWriter: LiveWriter = {
  apply: async (edits: readonly LiveEdit[]): Promise<void> => {
    const edit = new vscode.WorkspaceEdit()
    const touched: vscode.TextDocument[] = []
    const onDisk: Promise<void>[] = []
    for (const e of edits) {
      const uri = vscode.Uri.file(e.path)
      const doc = isInTab(e.path) ? openDocument(e.path) : undefined
      switch (e.kind) {
        case 'delete':
          if (doc) edit.deleteFile(uri, { ignoreIfNotExists: true })
          else onDisk.push(fs.rm(e.path, { force: true }))
          break
        case 'create':
          if (doc) edit.replace(uri, new vscode.Range(new vscode.Position(0, 0), endOfLine(doc, doc.lineCount)), e.text)
          else onDisk.push(writeAtomic(e.path, e.text))
          if (doc) touched.push(doc)
          break
        case 'lines':
          if (doc) {
            // Every range in one WorkspaceEdit refers to the document before it, and these never overlap.
            for (const l of e.edits) edit.replace(uri, new vscode.Range(new vscode.Position(l.start, 0), endOfLine(doc, l.end)), l.text)
            touched.push(doc)
          } else {
            onDisk.push(fs.readFile(e.path, 'utf8').then(text => writeAtomic(e.path, applyLineEdits(text, e.edits))))
          }
          break
        default: {
          const unhandled: never = e
          throw new Error(`unknown live edit ${JSON.stringify(unhandled)}`)
        }
      }
    }
    await Promise.all(onDisk)
    if (edit.size === 0) return
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error('VS Code did not apply the edit')
    await Promise.all(touched.map(async doc => (doc.isDirty ? doc.save() : undefined)))
  },
}
