// Which ledgers this window shows: those whose meta.json root is one of its
// folders, above one or below one. Reads meta.json files only, never a tree;
// the ledgers folder is watched for ledgers the mod creates later.

import { promises as fs, watch, type FSWatcher } from 'node:fs'
import * as path from 'node:path'

import { parseMeta } from '@core/events'

import type { Log } from '../log'
import { Coalescer } from '../util/async'
import { listIfPresent, readTextIfPresent } from './fsx'
import { isSameTree, ledgersDir, metaFile } from './layout'

const WATCH_DEBOUNCE_MS = 50

export type DiscoveryDeps = {
  readonly dataDir: string
  readonly folders: () => readonly string[]
  readonly isOpen: (dir: string) => boolean
  readonly open: (dir: string, root: string) => Promise<void>
  readonly log: Log
}

export class Discovery {
  /** A ledger's root never changes: each meta.json is read once. */
  private readonly roots = new Map<string, string>()
  private readonly connector = new Coalescer(() => this.connectNow())
  private watcher: FSWatcher | undefined
  private debounce: NodeJS.Timeout | undefined

  constructor(private readonly deps: DiscoveryDeps) {}

  async start(): Promise<void> {
    const dir = ledgersDir(this.deps.dataDir)
    await fs.mkdir(dir, { recursive: true })
    await this.connect()
    try {
      this.watcher = watch(dir, () => {
        if (this.debounce) clearTimeout(this.debounce)
        this.debounce = setTimeout(() => void this.connect(), WATCH_DEBOUNCE_MS)
      })
      this.watcher.on('error', err => this.deps.log.error('watching the ledgers folder', err))
    } catch (err) {
      this.deps.log.error('watching the ledgers folder', err)
    }
  }

  /** Opens any ledger of this window's folders not open yet. */
  connect(): Promise<void> {
    return this.connector.run().catch((err: unknown) => this.deps.log.error('opening ledgers', err))
  }

  rootOf(dir: string): string | undefined {
    return this.roots.get(dir)
  }

  dispose(): void {
    if (this.debounce) clearTimeout(this.debounce)
    this.watcher?.close()
  }

  private async connectNow(): Promise<void> {
    const base = ledgersDir(this.deps.dataDir)
    const folders = this.deps.folders()
    const dirs = (await listIfPresent(base)).map(name => path.join(base, name))
    await Promise.all(
      dirs.map(async dir => {
        if (this.deps.isOpen(dir)) return
        let root = this.roots.get(dir)
        if (root === undefined) {
          const text = await readTextIfPresent(metaFile(dir)).catch(() => undefined)
          const meta = text === undefined ? undefined : parseMeta(text)
          if (!meta?.ok) return
          root = meta.value.root
          this.roots.set(dir, root)
        }
        const r = root
        if (folders.some(f => isSameTree(r, f))) await this.deps.open(dir, r)
      }),
    )
  }
}
