// The review baseline as a document (`claude-base:<fsPath>`): the left side of
// every review diff and quick diff's original. And blob texts by ref
// (`claude-blob:/<ledgerId>/<ref>/<basename>`) for a turn's own diff.

import * as path from 'node:path'
import * as vscode from 'vscode'

import { isRef } from '@core/ids'

import type { Blobs } from '../ledger/blobs'
import type { LiveTexts } from '../review/live'
import type { ReviewModel } from '../review/model'
import type { Perf } from '../perf'

export const BASE_SCHEME = 'claude-base'
export const BLOB_SCHEME = 'claude-blob'

export const baseUri = (file: vscode.Uri): vscode.Uri => vscode.Uri.from({ scheme: BASE_SCHEME, path: file.path })
export const fileOfBase = (uri: vscode.Uri): vscode.Uri => vscode.Uri.file(uri.path)

/** `claude-blob:/<ledger dir name>/<ref>/<basename>`; `claude-blob:/empty/<basename>` is an empty document. */
export const blobUri = (ledgerDir: string, ref: string | null, basename: string): vscode.Uri =>
  vscode.Uri.from({ scheme: BLOB_SCHEME, path: ref === null ? `/empty/${basename}` : `/${path.basename(ledgerDir)}/${ref}/${basename}` })

export class BaseDocuments implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>()
  readonly onDidChange = this.emitter.event
  /** The base ref each open base document holds pinned in the blob cache. */
  private readonly pinned = new Map<string, string>()
  private readonly subscriptions: vscode.Disposable[]

  constructor(
    private readonly model: ReviewModel,
    private readonly blobs: Blobs,
    private readonly live: LiveTexts,
    private readonly perf: Perf,
  ) {
    this.subscriptions = [
      // Only a moved base re-reads a base document; typing never does.
      { dispose: model.onBase(paths => this.fireFor(paths)).dispose },
      { dispose: model.onMembership(() => this.fireFor(new Set(this.openPaths().filter(p => !this.isUnderReview(p))))).dispose },
      vscode.workspace.onDidCloseTextDocument(doc => {
        if (doc.uri.scheme !== BASE_SCHEME) return
        const ref = this.pinned.get(doc.uri.path)
        if (ref !== undefined && isRef(ref)) this.blobs.unpin(ref)
        this.pinned.delete(doc.uri.path)
      }),
    ]
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    this.perf.baseDocsProvided++
    const file = fileOfBase(uri).fsPath
    const state = this.model.get(file)
    // A file with nothing left to review diffs against itself, so it shows no change.
    if (!state || state.diff.kind === 'clean') return (await (await this.live.probe(file)).read()) ?? ''
    const ref = state.record.base
    if (ref === null) return ''
    const previous = this.pinned.get(uri.path)
    if (previous !== ref) {
      this.blobs.pin(ref)
      if (previous !== undefined && isRef(previous)) this.blobs.unpin(previous)
      this.pinned.set(uri.path, ref)
    }
    return this.blobs.get(state.ledgerDir, ref)
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose()
    this.emitter.dispose()
  }

  private isUnderReview(file: string): boolean {
    const s = this.model.get(file)
    return s !== undefined && s.diff.kind !== 'clean'
  }

  private openPaths(): string[] {
    return vscode.workspace.textDocuments.filter(d => d.uri.scheme === BASE_SCHEME).map(d => fileOfBase(d.uri).fsPath)
  }

  private fireFor(paths: ReadonlySet<string>): void {
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme !== BASE_SCHEME || !paths.has(fileOfBase(doc.uri).fsPath)) continue
      this.perf.baseDocChangeEvents++
      this.emitter.fire(doc.uri)
    }
  }
}

/** Immutable blob texts, for a turn's before/after diff. */
export class BlobDocuments implements vscode.TextDocumentContentProvider {
  constructor(
    private readonly blobs: Blobs,
    private readonly ledgerDirOf: (name: string) => string | undefined,
  ) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const [, ledger, ref] = uri.path.split('/')
    if (ledger === 'empty' || ref === undefined || !isRef(ref)) return ''
    const dir = ledger === undefined ? undefined : this.ledgerDirOf(ledger)
    return dir === undefined ? '' : this.blobs.get(dir, ref)
  }
}

/** A source control whose only job is quick diff against the review baseline. */
export const registerQuickDiff = (model: ReviewModel): vscode.Disposable => {
  const scm = vscode.scm.createSourceControl('claudeReview', 'Claude Review')
  scm.quickDiffProvider = {
    // Asked once per document: any tracked file answers, so one Claude edits later still shows bars.
    provideOriginalResource: uri => (uri.scheme === 'file' && model.has(uri.fsPath) ? baseUri(uri) : undefined),
  }
  return scm
}
