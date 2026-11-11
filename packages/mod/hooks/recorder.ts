// Captures are queued synchronously by the hooks; one flush at a time routes,
// hashes, writes blobs and one batch per ledger, then pings. Nothing here runs
// on a tool's critical path.

import type { EngineInterface, Timer } from 'claude-code'

import { normalizePath, type Batch, type EntryTool, type LedgerEvent } from './core/events'
import { batchId, nonce4, turnKey, type Ref } from './core/ids'
import { refsOf } from './core/ledger'
import { refOf } from './hash'
import { applyOwn, cachedLedger, type Ledgers } from './ledger'
import { log, reasonOf } from './log'
import { blobPath, ensureMeta, ledgerOf, type Ledgered, type Routing } from './paths'
import { ping, type Sockets } from './sockets'
import { markDirty, type SummaryState } from './summary'

type $ = EngineInterface

export type CurrentTurn = { readonly id: string; readonly prompt: string }

export type Capture = {
  readonly path: string
  readonly before: string | null
  readonly after: string | null
  readonly tool: EntryTool
  readonly turn: CurrentTurn
  readonly at: number
}

type Routed = { readonly capture: Capture; readonly path: string; readonly ledger: Ledgered }

export type Recorder = {
  readonly routing: Routing
  readonly ledgers: Ledgers
  readonly sockets: Sockets
  readonly summary: SummaryState
  queue: Capture[]
  timer: Timer | undefined
  chain: Promise<void>
  counter: number
  readonly knownBlobs: Map<string, Set<Ref>>
  /** `<ledger dir>|<session or turn key>` already announced in that ledger. */
  readonly announced: Set<string>
}

export const newRecorder = (routing: Routing, ledgers: Ledgers, sockets: Sockets, summary: SummaryState): Recorder => ({
  routing,
  ledgers,
  sockets,
  summary,
  queue: [],
  timer: undefined,
  chain: Promise.resolve(),
  counter: 0,
  knownBlobs: new Map(),
  announced: new Set(),
})

/** Synchronous: queues the change and schedules a flush. Never hashes or writes. */
export function capture($: $, r: Recorder, change: Capture): void {
  r.queue.push(change)
  r.timer ??= $.clock.after(0, () => {
    r.timer = undefined
    void flush($, r)
  })
}

export function captureMany($: $, r: Recorder, changes: readonly Capture[]): void {
  for (const c of changes) capture($, r, c)
}

/** Writes everything queued so far; resolves once it has landed. Never rejects. */
export function flush($: $, r: Recorder): Promise<void> {
  r.timer?.cancel()
  r.timer = undefined
  const run = r.chain.then(() => flushNow($, r))
  r.chain = run
  return run
}

async function flushNow($: $, r: Recorder): Promise<void> {
  const taken = r.queue
  r.queue = []
  if (taken.length === 0) return
  let routed: Routed[]
  try {
    routed = await Promise.all(
      taken.map(async c => {
        const path = normalizePath(c.path, r.routing.paths.cwd)
        return { capture: c, path, ledger: await ledgerOf($, r.routing, path) }
      }),
    )
  } catch (err) {
    log($, `could not record ${taken.map(c => c.path).join(', ')}: ${reasonOf(err)}`)
    return
  }
  const byLedger = new Map<string, Routed[]>()
  for (const x of routed) {
    const list = byLedger.get(x.ledger.dir)
    if (list) list.push(x)
    else byLedger.set(x.ledger.dir, [x])
  }
  await Promise.all(
    [...byLedger.values()].map(group =>
      writeLedger($, r, group).catch((err: unknown) => log($, `could not record ${group.map(x => x.path).join(', ')}: ${reasonOf(err)}`)),
    ),
  )
}

const knownOf = (r: Recorder, dir: string): Set<Ref> => {
  let known = r.knownBlobs.get(dir)
  if (!known) {
    const cached = cachedLedger(r.ledgers, dir)
    known = cached ? refsOf(cached) : new Set()
    r.knownBlobs.set(dir, known)
  }
  return known
}

async function writeBlob($: $, dir: string, ref: Ref, text: string): Promise<void> {
  const file = blobPath(dir, ref)
  // A blob already on disk is not rewritten: $.fs.write is not atomic, and a reader may be reading it.
  if (!(await $.fs.exists(file))) await $.fs.write(file, text)
}

async function writeLedger($: $, r: Recorder, group: readonly Routed[]): Promise<void> {
  const first = group[0]
  if (first === undefined) return
  const { ledger } = first
  const { session, cwd } = r.routing.paths
  await ensureMeta($, r.routing, ledger)

  const refs = new Map<string, Ref>()
  await Promise.all(
    [...new Set(group.flatMap(x => [x.capture.before, x.capture.after]).filter((t): t is string => t !== null))].map(async text => {
      refs.set(text, await refOf(text))
    }),
  )
  const known = knownOf(r, ledger.dir)
  const missing = [...refs].filter(([, ref]) => !known.has(ref))
  // Blobs land before the batch that names them.
  await Promise.all(missing.map(([text, ref]) => writeBlob($, ledger.dir, ref, text)))
  for (const [, ref] of missing) known.add(ref)
  const refOrNull = (text: string | null): Ref | null => (text === null ? null : (refs.get(text) ?? null))

  const events: LedgerEvent[] = []
  const announcing: string[] = []
  const sessionKey = `${ledger.dir}|${session}`
  if (!r.announced.has(sessionKey)) {
    events.push({ kind: 'session', session, title: first.capture.turn.prompt, cwd })
    announcing.push(sessionKey)
  }
  for (const { capture: c, path } of group) {
    const turnAnnounce = `${ledger.dir}|${turnKey(session, c.turn.id)}`
    if (!r.announced.has(turnAnnounce) && !announcing.includes(turnAnnounce)) {
      events.push({ kind: 'turn', session, turn: c.turn.id, prompt: c.turn.prompt })
      announcing.push(turnAnnounce)
    }
    events.push({ kind: 'edit', session, turn: c.turn.id, path, before: refOrNull(c.before), after: refOrNull(c.after), tool: c.tool })
  }

  await appendBatch($, r, ledger.dir, events)
  for (const key of announcing) r.announced.add(key)
}

/** Writes one batch, folds it into the cached ledger, pings the windows and marks the summary dirty. */
export async function appendBatch($: $, r: Recorder, ledgerDir: string, events: readonly LedgerEvent[]): Promise<Batch> {
  const { writer } = r.routing.paths
  const at = Date.now()
  const batch: Batch = { v: 2, id: batchId(at, writer, r.counter++, nonce4(Math.random)), at, writer, events }
  await $.fs.write(`${ledgerDir}/events/${batch.id}.json`, JSON.stringify(batch))
  applyOwn(r.ledgers, ledgerDir, batch)
  ping($, r.sockets, ledgerDir)
  markDirty($, r.summary, ledgerDir)
  return batch
}

/** Writes a text's blob into a ledger unless this writer knows it is there; answers its ref. */
export async function putBlob($: $, r: Recorder, ledgerDir: string, text: string): Promise<Ref> {
  const ref = await refOf(text)
  const known = knownOf(r, ledgerDir)
  if (!known.has(ref)) {
    await writeBlob($, ledgerDir, ref, text)
    known.add(ref)
  }
  return ref
}
