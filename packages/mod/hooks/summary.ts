// What the terminal shows: one row per file still under review, recomputed
// off the tool path (debounced), counting only records whose (base, last after)
// refs changed, from blobs alone.

import type { EngineInterface, Timer } from 'claude-code'

import type { FileRow, SessionRow, Summary, TurnRow } from '../types'
import { countsOf } from './core/counts'
import type { Ref } from './core/ids'
import { openSessions, openTurns, type Ledger } from './core/ledger'
import { cachedLedger, loadLedger, type Ledgers } from './ledger'
import { logOnce, reasonOf } from './log'
import { blobPath, dirOfRoot, rootOfLedger, sessionRootOf, type Routing } from './paths'

type $ = EngineInterface

const DEBOUNCE_MS = 300
const POLL_MS = 5000
const BLOB_CACHE_BYTES = 16 * 1024 * 1024

const SUMMARY_REF = { plugin: 'session-review', key: 'summary' } as const
export const EMPTY_SUMMARY: Summary = { files: [], turns: [], sessions: [], added: 0, removed: 0 }

/** Texts by ref, least recently used evicted past a byte budget (UTF-16: 2 bytes a char). */
export type BlobCache = { readonly texts: Map<string, string>; bytes: number; readonly maxBytes: number }

export const newBlobCache = (maxBytes: number): BlobCache => ({ texts: new Map(), bytes: 0, maxBytes })

export async function readBlob($: $, cache: BlobCache, ledgerDir: string, ref: Ref | null): Promise<string | null> {
  if (ref === null) return null
  const key = `${ledgerDir}|${ref}`
  const hit = cache.texts.get(key)
  if (hit !== undefined) {
    cache.texts.delete(key)
    cache.texts.set(key, hit)
    return hit
  }
  const text = await $.fs.read(blobPath(ledgerDir, ref))
  cache.texts.set(key, text)
  cache.bytes += text.length * 2
  for (const [k, v] of cache.texts) {
    if (cache.bytes <= cache.maxBytes) break
    cache.texts.delete(k)
    cache.bytes -= v.length * 2
  }
  return text
}

type Counts = { readonly added: number; readonly removed: number }

export type SummaryState = {
  readonly routing: Routing
  readonly ledgers: Ledgers
  readonly scope: Set<string>
  readonly blobs: BlobCache
  timer: Timer | undefined
  poll: Timer | undefined
  chain: Promise<void>
  memo: Map<string, Counts>
  signature: string
  status: string | undefined
  current: Summary
  /** How many recomputes ran: tests read it to prove none ran inside a hook. */
  runs: number
}

export const newSummary = (routing: Routing, ledgers: Ledgers): SummaryState => ({
  routing,
  ledgers,
  scope: new Set(),
  blobs: newBlobCache(BLOB_CACHE_BYTES),
  timer: undefined,
  poll: undefined,
  chain: Promise.resolve(),
  memo: new Map(),
  signature: JSON.stringify(EMPTY_SUMMARY),
  status: undefined,
  current: EMPTY_SUMMARY,
  runs: 0,
})

/** Schedules a recompute; calls inside the window share one. */
export function markDirty($: $, s: SummaryState, ledgerDir?: string): void {
  if (ledgerDir !== undefined) s.scope.add(ledgerDir)
  s.timer ??= $.clock.after(DEBOUNCE_MS, () => {
    s.timer = undefined
    void recompute($, s)
  })
}

export const stopSummary = (s: SummaryState): void => {
  s.timer?.cancel()
  s.poll?.cancel()
  s.timer = undefined
  s.poll = undefined
}

export function recompute($: $, s: SummaryState): Promise<void> {
  const run = s.chain.then(() => recomputeNow($, s)).catch((err: unknown) => logOnce($, `summary:${reasonOf(err)}`, `could not update the summary: ${reasonOf(err)}`))
  s.chain = run
  return run
}

async function countsFor($: $, s: SummaryState, dir: string, base: Ref | null, after: Ref | null, used: Map<string, Counts>): Promise<Counts> {
  const key = `${base}|${after}`
  const known = used.get(key) ?? s.memo.get(key)
  if (known) {
    used.set(key, known)
    return known
  }
  const [a, b] = await Promise.all([readBlob($, s.blobs, dir, base), readBlob($, s.blobs, dir, after)])
  const counts = countsOf(a, b)
  used.set(key, counts)
  return counts
}

async function rowsOf($: $, s: SummaryState, dir: string, ledger: Ledger, used: Map<string, Counts>): Promise<FileRow[]> {
  const root = rootOfLedger(s.routing, dir)
  const rows = await Promise.all(
    [...ledger.files.values()].map(async (record): Promise<FileRow | undefined> => {
      const newest = record.entries[record.entries.length - 1]
      if (!newest || newest.after === record.base) return undefined
      let counts: Counts
      try {
        counts = await countsFor($, s, dir, record.base, newest.after, used)
      } catch (err) {
        logOnce($, `counts:${record.path}`, `could not count ${record.path}: ${reasonOf(err)}`)
        counts = { added: 0, removed: 0 }
      }
      const rel = root !== undefined && record.path.startsWith(`${root}/`) ? record.path.slice(root.length + 1) : record.path
      const status = record.base === null ? 'new' : newest.after === null ? 'deleted' : 'modified'
      return { path: record.path, rel, added: counts.added, removed: counts.removed, status, ledger: dir }
    }),
  )
  return rows.filter((r): r is FileRow => r !== undefined)
}

const ordered = <T extends { n: number }>(rows: Iterable<{ readonly at: number; readonly row: T }>): T[] =>
  [...rows].sort((a, b) => a.at - b.at).map(({ row }, i) => ({ ...row, n: i + 1 }))

async function recomputeNow($: $, s: SummaryState): Promise<void> {
  s.runs++
  const { root } = await sessionRootOf($, s.routing)
  s.scope.add(await dirOfRoot(s.routing, root))
  const used = new Map<string, Counts>()
  const files: FileRow[] = []
  const turnRows = new Map<string, { at: number; row: TurnRow }>()
  const sessionRows = new Map<string, { at: number; row: SessionRow }>()
  for (const dir of [...s.scope].sort()) {
    const ledger = cachedLedger(s.ledgers, dir) ?? (await loadLedger($, s.ledgers, dir)).ledger
    const rows = await rowsOf($, s, dir, ledger, used)
    files.push(...rows)
    const listed = new Set(rows.map(r => r.path))
    for (const t of openTurns(ledger, p => listed.has(p))) {
      const known = turnRows.get(t.key)
      if (known) known.row.paths.push(...t.paths.filter(p => !known.row.paths.includes(p)))
      else turnRows.set(t.key, { at: t.at, row: { key: t.key, n: 0, prompt: t.prompt, session: t.session, paths: [...t.paths] } })
    }
    for (const sess of openSessions(ledger, p => listed.has(p))) {
      const known = sessionRows.get(sess.id)
      if (known) {
        known.row.turnKeys.push(...sess.turnKeys.filter(k => !known.row.turnKeys.includes(k)))
        if (known.row.title === '' && sess.title !== '') known.row.title = sess.title
      } else sessionRows.set(sess.id, { at: sess.at, row: { id: sess.id, n: 0, title: sess.title, turnKeys: [...sess.turnKeys] } })
    }
  }
  s.memo = used
  const summary: Summary = {
    files,
    turns: ordered(turnRows.values()),
    sessions: ordered(sessionRows.values()),
    added: files.reduce((n, f) => n + f.added, 0),
    removed: files.reduce((n, f) => n + f.removed, 0),
  }
  s.current = summary
  const signature = JSON.stringify(summary)
  if (signature !== s.signature) {
    s.signature = signature
    await $.state.set(SUMMARY_REF, summary)
  }
  const status = files.length === 0 ? undefined : `${files.length} ${files.length === 1 ? 'file' : 'files'} changed +${summary.added} −${summary.removed} · /changes`
  if (status !== s.status) {
    s.status = status
    $.ui.status(status)
  }
  pollWhile($, s, files.length > 0)
}

/** While anything is under review, picks up keeps and undos made in VS Code. */
function pollWhile($: $, s: SummaryState, isNeeded: boolean): void {
  if (!isNeeded) {
    s.poll?.cancel()
    s.poll = undefined
    return
  }
  s.poll ??= $.clock.every(POLL_MS, () => {
    void reload($, s)
  })
}

async function reload($: $, s: SummaryState): Promise<void> {
  const results = await Promise.all([...s.scope].map(dir => loadLedger($, s.ledgers, dir).catch(() => undefined)))
  if (results.some(r => r?.isChanged === true)) await recompute($, s)
}
