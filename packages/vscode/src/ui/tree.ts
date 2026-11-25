// The Changes view (§7.7): by files, folders, worktrees, turns or sessions, with inline
// Keep / Undo. A count change refreshes only that file's items; membership
// refreshes the whole tree; turns refresh it only where turns are shown.

import * as path from 'node:path'
import * as vscode from 'vscode'
import { z } from 'zod'

import { countsOf } from '@core/counts'
import type { FileRecord } from '@core/events'

import type { GroupBy } from '../config'
import type { Blobs } from '../ledger/blobs'
import type { FileState, ReviewModel } from '../review/model'
import type { Perf } from '../perf'

/** Tree nodes come back as command arguments, so they are parsed there. */
export const nodeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), path: z.string(), turn: z.string().optional() }),
  z.object({ kind: z.literal('dir'), dir: z.string() }),
  z.object({ kind: z.literal('worktree'), root: z.string() }),
  z.object({ kind: z.literal('turn'), key: z.string() }),
  z.object({ kind: z.literal('session'), id: z.string() }),
])

export type Node = z.infer<typeof nodeSchema>

const idOf = (node: Node): string => {
  switch (node.kind) {
    case 'file':
      return node.turn === undefined ? `f:${node.path}` : `f:${node.turn}:${node.path}`
    case 'dir':
      return `d:${node.dir}`
    case 'worktree':
      return `w:${node.root}`
    case 'turn':
      return `t:${node.key}`
    case 'session':
      return `s:${node.id}`
    default: {
      const unhandled: never = node
      throw new Error(`unknown node ${JSON.stringify(unhandled)}`)
    }
  }
}

type DirNode = { readonly dir: string; readonly label: string; readonly dirs: DirNode[]; readonly files: string[] }

export class ChangesTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<Node | Node[] | undefined>()
  readonly onDidChangeTreeData = this.emitter.event
  private readonly items = new Map<string, Node>()
  private folders: Map<string, DirNode> | undefined
  private folderTops: DirNode[] | undefined
  private singleRoot: DirNode | undefined
  /** A turn's own counts per file, by before|after refs, computed off the host thread's hot path. */
  private readonly turnCounts = new Map<string, { added: number; removed: number }>()
  private readonly subscriptions: { dispose(): void }[]

  constructor(
    private readonly model: ReviewModel,
    private readonly blobs: Blobs,
    private readonly perf: Perf,
    private readonly rootOfFile: (file: string) => string | undefined,
    private readonly branchOf: (root: string) => string | undefined,
    private mode: GroupBy,
  ) {
    this.subscriptions = [
      model.onMembership(() => this.refreshAll()),
      model.onCounts(paths => this.refreshFiles(paths)),
      model.onTurns(() => {
        if (this.mode === 'turns' || this.mode === 'sessions') this.refreshAll()
      }),
    ]
  }

  get groupBy(): GroupBy {
    return this.mode
  }

  setGroupBy(mode: GroupBy): void {
    if (mode === this.mode) return
    this.mode = mode
    this.refreshAll()
  }

  refreshAll(): void {
    this.perf.treeFullRefreshes++
    this.items.clear()
    this.folders = undefined
    this.folderTops = undefined
    this.singleRoot = undefined
    this.emitter.fire(undefined)
  }

  getChildren(node?: Node): Node[] {
    const out = this.childrenOf(node)
    for (const n of out) this.items.set(idOf(n), n)
    return out
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'file':
        return this.fileItem(node.path, node.turn)
      case 'dir': {
        const d = this.folderIndex().get(node.dir)
        const files = d ? this.filesUnder(d) : []
        const counts = this.sum(files)
        const item = new vscode.TreeItem(d?.label ?? path.basename(node.dir), vscode.TreeItemCollapsibleState.Expanded)
        item.id = idOf(node)
        item.resourceUri = vscode.Uri.file(node.dir)
        item.iconPath = vscode.ThemeIcon.Folder
        item.description = `+${counts.added} −${counts.removed}`
        item.contextValue = 'crDir'
        return item
      }
      case 'worktree': {
        const branch = this.branchOf(node.root)
        const counts = this.sum(this.filesOfRoot(node.root))
        const item = new vscode.TreeItem(branch ?? path.basename(node.root), vscode.TreeItemCollapsibleState.Expanded)
        item.id = idOf(node)
        item.iconPath = new vscode.ThemeIcon('git-branch')
        item.description = `${branch === undefined ? '' : `${path.basename(node.root)}  `}+${counts.added} −${counts.removed}`
        item.tooltip = node.root
        item.contextValue = 'crWorktree'
        return item
      }
      case 'turn': {
        const turn = this.model.turnOf(node.key)
        const item = new vscode.TreeItem(`#${turn?.n ?? '?'}  ${turn?.prompt || '(continuation)'}`, vscode.TreeItemCollapsibleState.Expanded)
        item.id = idOf(node)
        const count = turn?.paths.filter(p => this.isListed(p)).length ?? 0
        item.description = `${count} file${count === 1 ? '' : 's'}`
        item.iconPath = new vscode.ThemeIcon('comment-discussion')
        item.contextValue = 'crTurn'
        return item
      }
      case 'session': {
        const session = this.model.sessions().find(s => s.id === node.id)
        const item = new vscode.TreeItem(session?.title || `Session ${node.id.slice(0, 8)}`, vscode.TreeItemCollapsibleState.Expanded)
        item.id = idOf(node)
        const turns = session?.turnKeys.length ?? 0
        item.description = `${turns} turn${turns === 1 ? '' : 's'} · ${node.id.slice(0, 8)}`
        item.iconPath = new vscode.ThemeIcon('history')
        item.contextValue = 'crSession'
        return item
      }
      default: {
        const unhandled: never = node
        throw new Error(`unknown node ${JSON.stringify(unhandled)}`)
      }
    }
  }

  async resolveTreeItem(item: vscode.TreeItem, node: Node): Promise<vscode.TreeItem> {
    if (node.kind === 'file') {
      const s = this.model.get(node.path)
      const d = s?.diff
      item.tooltip = `${this.relative(node.path)}\n${d?.kind === 'ready' ? `+${d.added} −${d.removed} · ${d.hunks.length} change(s)` : (d?.kind ?? '')}`
    } else if (node.kind === 'turn') {
      item.tooltip = this.model.turnOf(node.key)?.prompt
    }
    return item
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose()
    this.emitter.dispose()
  }

  private refreshFiles(paths: ReadonlySet<string>): void {
    const nodes = [...this.items.values()].filter(n => (n.kind === 'file' && paths.has(n.path)) || n.kind === 'dir' || n.kind === 'worktree')
    if (nodes.length === 0) return
    this.perf.treeItemRefreshes++
    this.emitter.fire(nodes)
  }

  private isListed(file: string): boolean {
    const s = this.model.get(file)
    return s !== undefined && s.diff.kind !== 'clean'
  }

  private childrenOf(node?: Node): Node[] {
    const files = (): Node[] => this.model.files().map(f => ({ kind: 'file', path: f.path }))
    if (!node) {
      switch (this.mode) {
        case 'files':
          return files()
        case 'folders': {
          this.folderIndex()
          const single = this.singleRoot
          if (single) return [...single.dirs.map((c): Node => ({ kind: 'dir', dir: c.dir })), ...single.files.map((p): Node => ({ kind: 'file', path: p }))]
          return this.topLevel().map((d): Node => ({ kind: 'dir', dir: d.dir }))
        }
        case 'worktree': {
          const roots = this.worktreeRoots()
          return roots.length === 1 ? files() : roots.map((root): Node => ({ kind: 'worktree', root }))
        }
        case 'turns':
          return this.model.turns().map(t => ({ kind: 'turn', key: t.key }))
        case 'sessions':
          return this.model.sessions().map(s => ({ kind: 'session', id: s.id }))
        default: {
          const unhandled: never = this.mode
          throw new Error(`unknown mode ${String(unhandled)}`)
        }
      }
    }
    switch (node.kind) {
      case 'dir': {
        const d = this.folderIndex().get(node.dir)
        return d ? [...d.dirs.map((c): Node => ({ kind: 'dir', dir: c.dir })), ...d.files.map((p): Node => ({ kind: 'file', path: p }))] : []
      }
      case 'worktree':
        return this.filesOfRoot(node.root).map((p): Node => ({ kind: 'file', path: p }))
      case 'turn':
        return (this.model.turnOf(node.key)?.paths ?? []).filter(p => this.isListed(p)).map(p => ({ kind: 'file', path: p, turn: node.key }))
      case 'session':
        return (this.model.sessions().find(s => s.id === node.id)?.turnKeys ?? []).map(key => ({ kind: 'turn', key }))
      case 'file':
        return []
      default: {
        const unhandled: never = node
        throw new Error(`unknown node ${JSON.stringify(unhandled)}`)
      }
    }
  }

  private relative(file: string): string {
    const root = this.rootOfFile(file)
    return root ? path.relative(root, file) : file
  }

  private worktreeRoots(): string[] {
    return [...new Set(this.model.files().map(f => this.rootOfFile(f.path) ?? path.dirname(f.path)))]
  }

  private filesOfRoot(root: string): string[] {
    return this.model.files().filter(f => (this.rootOfFile(f.path) ?? path.dirname(f.path)) === root).map(f => f.path)
  }

  private fileItem(file: string, turn: string | undefined): vscode.TreeItem {
    const uri = vscode.Uri.file(file)
    const item = new vscode.TreeItem(uri, vscode.TreeItemCollapsibleState.None)
    item.id = idOf(turn === undefined ? { kind: 'file', path: file } : { kind: 'file', path: file, turn })
    const s = this.model.get(file)
    const dir = path.dirname(this.relative(file))
    const where = (this.mode === 'files' || this.mode === 'worktree') && dir !== '.' ? `${dir}  ` : ''
    item.description = `${where}${this.countsText(s, turn)}${this.statusOf(s)}`
    item.contextValue = turn === undefined ? 'crFile' : 'crFileInTurn'
    item.command = { command: 'claudeReview.openFile', title: 'Open', arguments: [uri] }
    return item
  }

  private statusOf(s: FileState | undefined): string {
    if (!s) return ''
    const last = s.record.entries[s.record.entries.length - 1]
    if (s.record.base === null) return ' new'
    if (last?.after === null) return ' deleted'
    if (s.diff.kind === 'tooLarge') return ' too large'
    return ''
  }

  private countsText(s: FileState | undefined, turn: string | undefined): string {
    if (!s) return ''
    if (turn !== undefined) return this.turnCountsText(s.record, s.ledgerDir, turn)
    switch (s.diff.kind) {
      case 'ready':
        return `+${s.diff.added} −${s.diff.removed}`
      case 'pending':
        return '…'
      case 'clean':
      case 'tooLarge':
        return ''
      case 'error':
        return '!'
      default: {
        const unhandled: never = s.diff
        throw new Error(`unknown diff state ${JSON.stringify(unhandled)}`)
      }
    }
  }

  /** A file's counts under a turn are that turn's own change: its entry's before and after. */
  private turnCountsText(record: FileRecord, ledgerDir: string, turn: string): string {
    const entry = record.entries.find(en => en.turn === turn && !en.isResolved)
    if (!entry) return ''
    const key = `${entry.before}|${entry.after}`
    const known = this.turnCounts.get(key)
    if (known) return `+${known.added} −${known.removed}`
    void Promise.all([entry.before ? this.blobs.get(ledgerDir, entry.before) : null, entry.after ? this.blobs.get(ledgerDir, entry.after) : null])
      .then(([a, b]) => {
        this.turnCounts.set(key, countsOf(a, b))
        this.refreshFiles(new Set([record.path]))
      })
      .catch(() => undefined)
    return '…'
  }

  private sum(files: readonly string[]): { added: number; removed: number } {
    let added = 0
    let removed = 0
    for (const f of files) {
      const d = this.model.get(f)?.diff
      if (d?.kind === 'ready') {
        added += d.added
        removed += d.removed
      }
    }
    return { added, removed }
  }

  private filesUnder(d: DirNode): string[] {
    return [...d.files, ...d.dirs.flatMap(c => this.filesUnder(c))]
  }

  /** The top of the folders view: one root's contents, or each root as a folder when the window has several. */
  private topLevel(): DirNode[] {
    return this.folderTops ?? []
  }

  /** Folders holding changed files as a trie under each root, single-child chains compressed (`src/ui`). */
  private folderIndex(): Map<string, DirNode> {
    if (this.folders) return this.folders
    type Trie = { readonly dir: string; readonly name: string; readonly children: Map<string, Trie>; readonly files: string[] }
    const tops = new Map<string, Trie>()
    for (const f of this.model.files()) {
      const root = this.rootOfFile(f.path) ?? path.dirname(f.path)
      let node: Trie = tops.get(root) ?? { dir: root, name: path.basename(root), children: new Map(), files: [] }
      tops.set(root, node)
      for (const segment of path.relative(root, path.dirname(f.path)).split(path.sep).filter(x => x !== '')) {
        const child: Trie = node.children.get(segment) ?? { dir: path.join(node.dir, segment), name: segment, children: new Map(), files: [] }
        node.children.set(segment, child)
        node = child
      }
      node.files.push(f.path)
    }
    const index = new Map<string, DirNode>()
    const compress = (t: Trie): DirNode => {
      let node = t
      let label = t.name
      for (let only = [...node.children.values()][0]; node.files.length === 0 && node.children.size === 1 && only; only = [...node.children.values()][0]) {
        node = only
        label = `${label}/${node.name}`
      }
      const out: DirNode = { dir: node.dir, label, dirs: [...node.children.values()].map(compress), files: node.files }
      index.set(out.dir, out)
      return out
    }
    const roots = [...tops.values()].map(t => {
      const out: DirNode = { dir: t.dir, label: t.name, dirs: [...t.children.values()].map(compress), files: t.files }
      index.set(out.dir, out)
      return out
    })
    // One root: its contents are the top; several: each root is a folder.
    this.folderTops = roots.length === 1 ? undefined : roots
    this.singleRoot = roots.length === 1 ? roots[0] : undefined
    this.folders = index
    return index
  }
}
