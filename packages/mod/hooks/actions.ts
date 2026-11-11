// Keep and undo from the terminal (§6.10): the same core plans the extension
// carries out, on the disk texts, then one batch per ledger and a ping. Runs
// only when /changes or the pane asks, never inside a tool call.

import type { EngineInterface } from 'claude-code'

import { diffHunks } from './core/diff'
import type { LedgerEvent } from './core/events'
import { applyLineEdits, planKeepAll, planKeepFile, planKeepHunk, planKeepTurns, planUndoAll, planUndoFile, planUndoHunk, planUndoTurns, type FileInput, type FilePlan, type TurnFileInput } from './core/plan'
import { viewHunks } from './core/view'
import { cachedLedger, loadLedger } from './ledger'
import { appendBatch, putBlob, type Recorder } from './recorder'
import { readBlob, recompute, type SummaryState } from './summary'

type $ = EngineInterface

export type ActionSession = { readonly recorder: Recorder; readonly summary: SummaryState }

export type ActionOutcome =
  | { readonly kind: 'done'; readonly paths: readonly string[] }
  | { readonly kind: 'conflicts'; readonly done: readonly string[]; readonly conflicts: readonly string[] }
  | { readonly kind: 'failed'; readonly reason: string }

export class UnreadableFileError extends Error {
  override readonly name = 'UnreadableFileError'
}

/** A file's disk text: null when missing; rejects for one over 4 MiB, which `$.fs.read` cannot read. */
export async function readDisk($: $, path: string): Promise<string | null> {
  try {
    return await $.fs.read(path)
  } catch {
    const missing = await $.fs.stat(path).then(
      () => false,
      (err: unknown) => String(err).includes('ENOENT'),
    )
    if (missing) return null
    throw new UnreadableFileError(`${path} is over 4 MiB or unreadable`)
  }
}

/** Each path's record, base and disk text, with its hunks now. */
async function inputsOf($: $, s: ActionSession, paths: readonly { readonly path: string; readonly ledger: string }[]): Promise<FileInput[]> {
  const out: FileInput[] = []
  for (const { path, ledger } of paths) {
    const folded = cachedLedger(s.recorder.ledgers, ledger) ?? (await loadLedger($, s.recorder.ledgers, ledger)).ledger
    const record = folded.files.get(path)
    if (!record) continue
    const [base, live] = await Promise.all([readBlob($, s.summary.blobs, ledger, record.base), readDisk($, path)])
    out.push({ path, ledgerDir: ledger, record, rawBase: base, base, live, hunks: viewHunks(diffHunks(base ?? '', live ?? '')) })
  }
  return out
}

/** Writes each plan's live text and records its events, one batch per ledger. */
async function carryOut($: $, s: ActionSession, plans: readonly FilePlan[], inputs: readonly FileInput[]): Promise<void> {
  const byPath = new Map(inputs.map(f => [f.path, f]))
  for (const p of plans) {
    if (!p.live) continue
    const current = byPath.get(p.path)?.live ?? null
    const target = p.live.kind === 'text' ? p.live.text : applyLineEdits(current ?? '', p.live.edits)
    if (target === null) {
      if (current !== null) await $.process.run(['rm', '-f', p.path])
    } else if (target !== current) {
      await $.fs.write(p.path, target)
    }
  }
  const byLedger = new Map<string, LedgerEvent[]>()
  for (const p of plans) {
    const events = byLedger.get(p.ledgerDir) ?? []
    if (p.keep !== undefined) events.push({ kind: 'keep', path: p.path, base: p.keep === null ? null : await putBlob($, s.recorder, p.ledgerDir, p.keep) })
    for (const turn of p.resolves) events.push({ kind: 'resolve', path: p.path, turn })
    if (p.settle) events.push({ kind: 'settle', path: p.path })
    byLedger.set(p.ledgerDir, events)
  }
  for (const [dir, events] of byLedger) if (events.length > 0) await appendBatch($, s.recorder, dir, events)
  await recompute($, s.summary)
}

async function guarded($: $, run: () => Promise<ActionOutcome>): Promise<ActionOutcome> {
  try {
    return await run()
  } catch (err) {
    return { kind: 'failed', reason: err instanceof Error ? err.message : String(err) }
  }
}

export function hunkAction($: $, s: ActionSession, file: { readonly path: string; readonly ledger: string }, index: number, keep: boolean): Promise<ActionOutcome> {
  return guarded($, async () => {
    const [f] = await inputsOf($, s, [file])
    const h = f?.hunks[index]
    if (!f || !h) return { kind: 'failed', reason: `that change is no longer there` }
    await carryOut($, s, [keep ? planKeepHunk(f, h) : planUndoHunk(f, h)], [f])
    return { kind: 'done', paths: [f.path] }
  })
}

export function filesAction($: $, s: ActionSession, files: readonly { readonly path: string; readonly ledger: string }[], keep: boolean): Promise<ActionOutcome> {
  return guarded($, async () => {
    const inputs = await inputsOf($, s, files)
    const plans = files.length === 1 ? inputs.map(keep ? planKeepFile : planUndoFile) : keep ? planKeepAll(inputs) : planUndoAll(inputs)
    await carryOut($, s, plans, inputs)
    return { kind: 'done', paths: plans.map(p => p.path) }
  })
}

/** keep|undo turn N and session N: each file's open entries of these turns, oldest first. */
export function turnsAction($: $, s: ActionSession, keys: readonly string[], keep: boolean): Promise<ActionOutcome> {
  return guarded($, async () => {
    const wanted = new Set(keys)
    const files = s.summary.current.files.map(f => ({ path: f.path, ledger: f.ledger }))
    const inputs = await inputsOf($, s, files)
    const withPairs: TurnFileInput[] = []
    for (const f of inputs) {
      const entries = f.record.entries.filter(en => wanted.has(en.turn) && !en.isResolved)
      if (entries.length === 0) continue
      const pairs = await Promise.all(
        entries.map(async en => ({
          turn: en.turn,
          before: await readBlob($, s.summary.blobs, f.ledgerDir, en.before),
          after: await readBlob($, s.summary.blobs, f.ledgerDir, en.after),
        })),
      )
      withPairs.push({ ...f, pairs })
    }
    const { plans, conflicts } = keep ? planKeepTurns(withPairs) : planUndoTurns(withPairs)
    await carryOut($, s, plans, withPairs)
    const done = plans.map(p => p.path)
    return conflicts.length > 0 ? { kind: 'conflicts', done, conflicts } : { kind: 'done', paths: done }
  })
}
