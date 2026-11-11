// Where things live, computed once per session; routing of paths to ledgers is
// cached per directory and runs only from the flush, never in a hook.

import type { EngineInterface } from 'claude-code'

import { dirnameOf } from './core/events'
import { modWriter, toSessionId, type Ref, type SessionId } from './core/ids'
import { sha256Hex } from './hash'
import type { Options } from './options'

type $ = EngineInterface

export type SessionPaths = {
  readonly home: string
  readonly dataDir: string
  readonly ledgersDir: string
  readonly socketsDir: string
  readonly cwd: string
  readonly session: SessionId
  readonly writer: string
}

export async function sessionPathsOf($: $, options: Options): Promise<SessionPaths> {
  const [home, id, cwd] = await Promise.all([$.env.get('HOME'), $.session.id(), $.session.cwd()])
  const dataDir = options.dataDir !== '' ? options.dataDir.replace(/\/+$/, '') : `${home ?? '/tmp'}/.claude/claude-review/v2`
  const session = toSessionId(id)
  return {
    home: home ?? '/tmp',
    dataDir,
    ledgersDir: `${dataDir}/ledgers`,
    socketsDir: `${dataDir}/sockets`,
    cwd,
    session,
    writer: modWriter(session),
  }
}

export const blobPath = (ledgerDir: string, ref: Ref): string => `${ledgerDir}/blobs/${ref.slice(0, 2)}/${ref}`

export type Ledgered = { readonly dir: string; readonly root: string }
export type SessionRoot = { readonly root: string; readonly isGit: boolean }

export type Routing = {
  readonly paths: SessionPaths
  readonly dirRoots: Map<string, Promise<string | undefined>>
  readonly dirsOfRoots: Map<string, Promise<string>>
  readonly rootsOfDirs: Map<string, string>
  readonly ensured: Set<string>
  sessionRoot: Promise<SessionRoot> | undefined
}

export const newRouting = (paths: SessionPaths): Routing => ({
  paths,
  dirRoots: new Map(),
  dirsOfRoots: new Map(),
  rootsOfDirs: new Map(),
  ensured: new Set(),
  sessionRoot: undefined,
})

/** The git top level of `dir`, cached per directory; one spawn on a miss. */
export function rootOfDir($: $, routing: Routing, dir: string): Promise<string | undefined> {
  const known = routing.dirRoots.get(dir)
  if (known) return known
  const found = $.process
    .run(['git', '-C', dir, 'rev-parse', '--show-toplevel'], { timeoutMs: 10_000 })
    .then(r => (r.exitCode === 0 && r.stdout.trim() !== '' ? r.stdout.trim() : undefined))
    .catch(() => undefined)
  routing.dirRoots.set(dir, found)
  return found
}

/** The git top level of the session's cwd, else the cwd. */
export function sessionRootOf($: $, routing: Routing): Promise<SessionRoot> {
  routing.sessionRoot ??= rootOfDir($, routing, routing.paths.cwd).then(root =>
    root === undefined ? { root: routing.paths.cwd, isGit: false } : { root, isGit: true },
  )
  return routing.sessionRoot
}

/** A root's ledger directory: `<ledgers>/<sha256(root) hex [0:16]>`. */
export const dirOfRoot = (routing: Routing, root: string): Promise<string> => {
  const known = routing.dirsOfRoots.get(root)
  if (known) return known
  const dir = sha256Hex(root).then(hex => {
    const d = `${routing.paths.ledgersDir}/${hex.slice(0, 16)}`
    routing.rootsOfDirs.set(d, root)
    return d
  })
  routing.dirsOfRoots.set(root, dir)
  return dir
}

/** The root of a ledger directory this session routed to. */
export const rootOfLedger = (routing: Routing, dir: string): string | undefined => routing.rootsOfDirs.get(dir)

/** §4.9: the file's git top level, else the session root. */
export async function ledgerOf($: $, routing: Routing, path: string): Promise<Ledgered> {
  const root = (await rootOfDir($, routing, dirnameOf(path))) ?? (await sessionRootOf($, routing)).root
  return { dir: await dirOfRoot(routing, root), root }
}

/** Writes meta.json the first time this session uses a ledger that lacks one. */
export async function ensureMeta($: $, routing: Routing, ledger: Ledgered): Promise<void> {
  if (routing.ensured.has(ledger.dir)) return
  const file = `${ledger.dir}/meta.json`
  if (!(await $.fs.exists(file))) await $.fs.write(file, JSON.stringify({ v: 2, root: ledger.root, createdAt: Date.now() }))
  routing.ensured.add(ledger.dir)
}
