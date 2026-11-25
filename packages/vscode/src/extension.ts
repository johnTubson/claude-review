// The composition root (§7.2). activate() only creates and registers; every
// file read, socket, migration and diff starts after it returns.

import * as path from 'node:path'
import * as vscode from 'vscode'

import { shouldCompact } from '@core/compact'

import { registerCommands } from './commands'
import { ConfigSource } from './config'
import { Blobs } from './ledger/blobs'
import { Bridge } from './ledger/bridge'
import { BLOB_WARN_BYTES, compact } from './ledger/compactor'
import { Discovery } from './ledger/discovery'
import { migrate02 } from './ledger/migrate'
import { LedgerStore } from './ledger/store'
import { worktreesOf } from './ledger/worktrees'
import { createLog, reasonOf } from './log'
import { newPerf, timed, type Perf } from './perf'
import { ActionQueue } from './review/actions'
import { WorkerPool } from './review/diffPool'
import { DocIdentities, vscodeLiveTexts, vscodeLiveWriter } from './review/edits'
import { ReviewModel } from './review/model'
import { DiffScheduler, realTimers } from './review/scheduler'
import { BASE_SCHEME, BaseDocuments, BLOB_SCHEME, BlobDocuments, registerQuickDiff } from './ui/baseDocs'
import { ReviewLenses } from './ui/codeLens'
import { ContextKeys } from './ui/contextKeys'
import { Decorations } from './ui/decorations'
import { closeFinishedReviews, showReview } from './ui/diffEditors'
import { editedPaths, follow } from './ui/follow'
import { hoverProvider } from './ui/hover'
import { promptOnce } from './ui/prompts'
import { ReviewStatus } from './ui/statusBar'
import { rootOfFile as rootOfFileIn } from './ui/grouping'
import { ChangesTree } from './ui/tree'

const BLOB_CACHE_BYTES = 64 * 1024 * 1024
const COMPACT_DELAY_MS = 5000

export type ClaudeReviewApi = {
  readonly model: ReviewModel
  readonly scheduler: DiffScheduler
  readonly actions: ActionQueue
  readonly perf: Perf
  readonly stores: ReadonlyMap<string, LedgerStore>
  /** Resolves once the deferred start (bridge, discovery, migration) has run. */
  readonly ready: Promise<void>
  /** How long activate() itself took (E1). */
  readonly activateMs: number
}

const folderPaths = (): string[] => (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath)

export function activate(context: vscode.ExtensionContext): ClaudeReviewApi {
  const started = performance.now()
  const log = createLog()
  const perf = newPerf()
  const config = new ConfigSource()
  const subs = context.subscriptions
  subs.push(log, config)

  const blobs = new Blobs(BLOB_CACHE_BYTES, () => config.current.maxDiffBytes)
  const stores = new Map<string, LedgerStore>()
  const identities = new DocIdentities()
  const live = vscodeLiveTexts(identities)
  const pool = new WorkerPool(context.asAbsolutePath(path.join('dist', 'diffWorker.js')), log)
  const actionPaths = new Set<string>()
  let scheduler: DiffScheduler | undefined
  const model = new ReviewModel(
    (p, reason) => scheduler?.request(p, reason),
    m => log.warn(m),
  )
  scheduler = new DiffScheduler({ model, live, runner: pool, readBlob: (d, r) => blobs.get(d, r), maxDiffBytes: () => config.current.maxDiffBytes, perf, log, timers: realTimers, concurrency: 2 })
  const sched = scheduler
  const actions = new ActionQueue({
    model,
    scheduler: sched,
    store: d => stores.get(d),
    blobs,
    live,
    writer: vscodeLiveWriter,
    runner: pool,
    log,
    markActionPaths: ps => ps.forEach(p => actionPaths.add(p)),
  })
  subs.push({ dispose: () => pool.dispose() }, { dispose: () => sched.dispose() }, model)

  const branches = new Map<string, string>()
  const rootOfFile = (file: string): string | undefined => {
    const state = model.get(file)
    return rootOfFileIn(file, folderPaths(), state && model.rootOf(state.ledgerDir))
  }
  const tree = new ChangesTree(model, blobs, perf, rootOfFile, root => branches.get(root), config.current.groupBy)
  const view = vscode.window.createTreeView('claudeReview.changes', { treeDataProvider: tree, showCollapseAll: true })
  const contextKeys = new ContextKeys(model)
  contextKeys.setGroupBy(config.current.groupBy)
  const baseDocs = new BaseDocuments(model, blobs, live, perf)
  const blobDocs = new BlobDocuments(blobs, name => [...stores.keys()].find(d => path.basename(d) === name))
  const lenses = new ReviewLenses(model, perf, () => config.current.codeLens)
  const decorations = new Decorations(model, perf, () => config.current, vscode.Uri.file(context.asAbsolutePath(path.join('media', 'removed.svg'))))
  let quickDiff = config.current.quickDiff ? registerQuickDiff(model) : undefined
  const updateBadge = (): void => {
    const n = model.files().length
    view.badge = n === 0 ? undefined : { value: n, tooltip: `${n} file${n === 1 ? '' : 's'} to review` }
  }
  subs.push(
    tree,
    view,
    contextKeys,
    baseDocs,
    lenses,
    decorations,
    new ReviewStatus(model),
    vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, baseDocs),
    vscode.workspace.registerTextDocumentContentProvider(BLOB_SCHEME, blobDocs),
    vscode.languages.registerHoverProvider({ scheme: 'file' }, hoverProvider(model)),
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, lenses),
    { dispose: () => quickDiff?.dispose() },
    model.onMembership(() => {
      updateBadge()
      // An action's own re-diff can finish before its save: closing that editor then would drop the save.
      void actions
        .idle()
        .then(() => closeFinishedReviews(model))
        .catch((err: unknown) => log.error('closing finished reviews', err))
      syncWatchers()
    }),
  )

  // ---- per-file watchers: only paths under review, never `**/*` ----
  const watchers = new Map<string, vscode.Disposable>()
  const isOpen = (p: string): boolean => vscode.workspace.textDocuments.some(d => d.uri.scheme === 'file' && d.uri.fsPath === p)
  const syncWatchers = (): void => {
    const tracked = new Set(model.trackedPaths())
    for (const [p, w] of watchers) {
      if (tracked.has(p)) continue
      w.dispose()
      watchers.delete(p)
    }
    for (const p of tracked) {
      if (watchers.has(p)) continue
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(p)), path.basename(p)))
      const onDisk = (): void => {
        if (!isOpen(p)) sched.request(p, 'external')
      }
      watchers.set(p, vscode.Disposable.from(w, w.onDidChange(onDisk), w.onDidCreate(onDisk), w.onDidDelete(onDisk)))
    }
  }
  subs.push({ dispose: () => watchers.forEach(w => w.dispose()) })

  // ---- document listeners ----
  subs.push(
    vscode.workspace.onDidChangeTextDocument(
      timed(perf, log, 'onDidChangeTextDocument', e => {
        if (e.document.uri.scheme !== 'file' || e.contentChanges.length === 0) return
        const p = e.document.uri.fsPath
        if (!model.has(p)) return
        const isAction = actionPaths.delete(p)
        sched.request(p, isAction ? 'action' : 'typing')
      }),
    ),
    vscode.workspace.onDidOpenTextDocument(doc => identities.onOpen(doc)),
    vscode.workspace.onDidCloseTextDocument(
      timed(perf, log, 'onDidCloseTextDocument', doc => {
        if (doc.uri.scheme === 'file' && model.has(doc.uri.fsPath)) sched.request(doc.uri.fsPath, 'external')
      }),
    ),
    vscode.window.onDidChangeVisibleTextEditors(
      timed(perf, log, 'onDidChangeVisibleTextEditors', editors => {
        for (const ed of editors) if (ed.document.uri.scheme === 'file' && model.has(ed.document.uri.fsPath)) sched.request(ed.document.uri.fsPath, 'visible')
      }),
    ),
    config.onDidChange(({ previous, current }) => {
      if (previous.quickDiff !== current.quickDiff) {
        quickDiff?.dispose()
        quickDiff = current.quickDiff ? registerQuickDiff(model) : undefined
        decorations.reconfigure()
      }
      if (previous.addedLines !== current.addedLines || previous.removedMarkers !== current.removedMarkers) decorations.reconfigure()
      if (previous.codeLens !== current.codeLens) lenses.refresh()
      if (previous.groupBy !== current.groupBy) {
        tree.setGroupBy(current.groupBy)
        contextKeys.setGroupBy(current.groupBy)
      }
    }),
  )

  // ---- ledgers ----
  let isStarting = true
  const compacting = new Set<string>()
  const compactTimers = new Map<string, NodeJS.Timeout>()
  const maybeCompact = (store: LedgerStore): void => {
    if (compacting.has(store.dir) || compactTimers.has(store.dir) || !shouldCompact(store.batchIdsOnDisk, Date.now())) return
    compactTimers.set(
      store.dir,
      setTimeout(() => {
        compactTimers.delete(store.dir)
        compacting.add(store.dir)
        void compact(store.dir, log)
          .then(async result => {
            if (result.kind !== 'compacted') return
            await store.scan()
            const warned = `claudeReview.blobWarning:${store.dir}`
            if (result.gc && result.gc.blobBytes > BLOB_WARN_BYTES && !context.globalState.get<boolean>(warned)) {
              await context.globalState.update(warned, true)
              void vscode.window.showWarningMessage(`Claude Review keeps over 1 GB of file versions for ${model.rootOf(store.dir) ?? store.dir}. Keep or undo the changes under review to let them go.`)
            }
          })
          .catch((err: unknown) => log.error(`compacting ${store.dir}`, err))
          .finally(() => compacting.delete(store.dir))
      }, COMPACT_DELAY_MS),
    )
  }
  subs.push({ dispose: () => compactTimers.forEach(t => clearTimeout(t)) })

  const openStore = async (dir: string, root: string): Promise<void> => {
    if (stores.has(dir)) return
    const store = new LedgerStore(dir, log, perf)
    stores.set(dir, store)
    subs.push(store)
    await store.start()
    model.addLedger(dir, root, store.ledger, isStarting ? 'startup' : 'ledger')
    subs.push(
      store.onChange(change => {
        model.applyLedger(change.dir, change.current)
        if (config.current.followEdits === 'openDiff') void follow(model, editedPaths(change.previous, change.current)).catch((err: unknown) => log.error('following edits', err))
        maybeCompact(store)
      }),
    )
    maybeCompact(store)
  }

  const discovery = new Discovery({
    dataDir: config.current.dataDir,
    folders: folderPaths,
    isOpen: d => stores.has(d),
    open: openStore,
    worktreesOf,
    onWorktrees: found => {
      branches.clear()
      for (const w of found) if (w.branch !== undefined) branches.set(w.root, w.branch)
    },
    log,
  })
  subs.push(discovery)
  const bridge = new Bridge(
    {
      onPing: ledger => {
        const store = stores.get(ledger)
        if (store) void store.scan()
        else void discovery.connect()
      },
      onOpen: async ({ path: p, line }) => {
        if (!model.get(p)) return false
        await showReview(model, config.current, vscode.Uri.file(p), line ?? 0)
        return true
      },
      onFocus: async () => {
        await vscode.commands.executeCommand('claudeReview.focus')
      },
    },
    log,
  )
  subs.push(bridge, vscode.workspace.onDidChangeWorkspaceFolders(() => void discovery.connect()))

  registerCommands({
    context,
    model,
    actions,
    config,
    tree,
    contextKeys,
    log,
    perf,
    folders: folderPaths,
    refresh: async () => {
      await discovery.connect()
      await Promise.all([...stores.values()].map(s => s.scan()))
      tree.refreshAll()
    },
    onImported: dir => {
      const store = stores.get(dir)
      if (store) void store.scan()
      else void discovery.connect()
    },
  })

  const ready = new Promise<void>(resolve => {
    setImmediate(() => {
      void (async () => {
        const c = config.current
        await bridge.start(c.dataDir).catch((err: unknown) => log.error('starting the bridge (pings fall back to the file watcher)', err))
        await discovery.start()
        isStarting = false
        // Migration runs once per old ledger and lands as new batches the discovery then opens.
        void migrate02({ legacyDir: c.legacyDir, dataDir: c.dataDir, folders: folderPaths(), log, onWritten: () => undefined })
          .then(r => (r.files > 0 ? discovery.connect() : undefined))
          .catch((err: unknown) => log.error('migrating 0.2 ledgers', err))
        for (const ed of vscode.window.visibleTextEditors) if (ed.document.uri.scheme === 'file' && model.has(ed.document.uri.fsPath)) sched.request(ed.document.uri.fsPath, 'visible')
        void promptOnce(context).catch((err: unknown) => log.error('prompts', err))
      })()
        .catch((err: unknown) => log.error(`starting: ${reasonOf(err)}`, err))
        .finally(resolve)
    })
  })

  return { model, scheduler: sched, actions, perf, stores, ready, activateMs: performance.now() - started }
}

export function deactivate(): void {}
