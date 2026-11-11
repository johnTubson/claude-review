// Keep and undo, one at a time (§7.6): settle the files' diffs, plan from the
// model, write the live text as one undoable edit, then append one batch per
// ledger. Whole-text targets become minimal line edits through the diff
// worker, so no diff runs on the host thread.

import type { LedgerEvent } from '@core/events'
import type { SessionId, TurnKey } from '@core/ids'
import { splitLines } from '@core/lines'
import { hunkBySig, type HunkView } from '@core/view'

import type { Blobs } from '../ledger/blobs'
import { forDiff } from '../ledger/blobs'
import type { LedgerStore } from '../ledger/store'
import type { Log } from '../log'
import type { DiffRunner } from './diffPool'
import type { LineEdit, LiveEdit, LiveTexts, LiveWriter } from './live'
import type { ReviewModel } from './model'
import {
  planKeepAll, planKeepFile, planKeepHunk, planKeepMapping, planKeepTurns, planUndoAll, planUndoFile, planUndoHunk, planUndoMapping, planUndoTurns,
  type FileInput, type FilePlan, type LineRange, type TurnFileInput,
} from '@core/plan'
import type { DiffScheduler } from './scheduler'

export type HunkTarget = { readonly path: string; readonly start: number; readonly sig: string }

export type ActionResult =
  | { readonly kind: 'done'; readonly paths: readonly string[] }
  | { readonly kind: 'moved' }
  | { readonly kind: 'conflicts'; readonly done: readonly string[]; readonly conflicts: readonly string[] }
  | { readonly kind: 'nothing' }

export type ActionDeps = {
  readonly model: ReviewModel
  readonly scheduler: DiffScheduler
  readonly store: (ledgerDir: string) => LedgerStore | undefined
  readonly blobs: Blobs
  readonly live: LiveTexts
  readonly writer: LiveWriter
  readonly runner: DiffRunner
  readonly log: Log
  /** These paths' next text changes come from an action, not typing. */
  readonly markActionPaths: (paths: readonly string[]) => void
}

export class ActionQueue {
  private chain: Promise<unknown> = Promise.resolve()
  private running = 0

  constructor(private readonly deps: ActionDeps) {}

  keepHunk(target: HunkTarget): Promise<ActionResult> {
    return this.hunkAction(target, (f, h) => planKeepHunk(f, h))
  }

  undoHunk(target: HunkTarget): Promise<ActionResult> {
    return this.hunkAction(target, (f, h) => planUndoHunk(f, h))
  }

  keepMapping(path: string, originalWithModifiedChanges: string): Promise<ActionResult> {
    return this.fileAction([path], ([f]) => (f ? [planKeepMapping(f, originalWithModifiedChanges)] : []))
  }

  undoMapping(path: string, original: LineRange, modified: LineRange): Promise<ActionResult> {
    return this.fileAction([path], ([f]) => (f ? [planUndoMapping(f, original, modified, splitLines(f.base ?? ''), splitLines(f.live ?? ''))] : []))
  }

  keepFile(path: string): Promise<ActionResult> {
    return this.fileAction([path], files => files.map(planKeepFile))
  }

  undoFile(path: string): Promise<ActionResult> {
    return this.fileAction([path], files => files.map(planUndoFile))
  }

  keepAll(): Promise<ActionResult> {
    return this.fileAction(this.deps.model.files().map(f => f.path), planKeepAll)
  }

  undoAll(): Promise<ActionResult> {
    return this.fileAction(this.deps.model.files().map(f => f.path), planUndoAll)
  }

  keepTurn(key: TurnKey): Promise<ActionResult> {
    return this.turnsAction([key], planKeepTurns)
  }

  undoTurn(key: TurnKey): Promise<ActionResult> {
    return this.turnsAction([key], planUndoTurns)
  }

  keepSession(id: SessionId): Promise<ActionResult> {
    return this.turnsAction(this.deps.model.sessionOf(id)?.turnKeys ?? [], planKeepTurns)
  }

  undoSession(id: SessionId): Promise<ActionResult> {
    return this.turnsAction(this.deps.model.sessionOf(id)?.turnKeys ?? [], planUndoTurns)
  }

  /** Puts the base back as it was before the last keep. */
  revertLastKeep(): Promise<ActionResult> {
    return this.enqueue(async () => {
      const last = this.deps.model.popKeep()
      const store = last ? this.deps.store(last.ledgerDir) : undefined
      if (!last || !store) return { kind: 'nothing' }
      await store.append([{ kind: 'keep', path: last.path, base: last.previousBase }])
      this.deps.scheduler.request(last.path, 'action')
      return { kind: 'done', paths: [last.path] }
    })
  }

  /** Resolves once no action is queued or running: a surface that closes editors waits for saves to land. */
  idle(): Promise<void> {
    return this.running === 0 ? Promise.resolve() : this.chain.then(() => this.idle())
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    this.running++
    const run = this.chain.then(task).finally(() => {
      this.running--
    })
    // The chain only orders actions; each caller still sees its own failure.
    this.chain = run.catch((err: unknown) => this.deps.log.error('a review action', err))
    return run
  }

  private hunkAction(target: HunkTarget, plan: (f: FileInput, h: HunkView) => FilePlan): Promise<ActionResult> {
    return this.enqueue(async () => {
      await this.deps.scheduler.settle([target.path])
      const state = this.deps.model.get(target.path)
      const h = state?.diff.kind === 'ready' ? hunkBySig(state.diff.hunks, target.sig, target.start) : undefined
      if (!h) return { kind: 'moved' }
      const [f] = await this.inputs([target.path])
      if (!f) return { kind: 'moved' }
      await this.carryOut([plan(f, h)])
      return { kind: 'done', paths: [target.path] }
    })
  }

  private fileAction(paths: readonly string[], plan: (files: readonly FileInput[]) => readonly FilePlan[]): Promise<ActionResult> {
    return this.enqueue(async () => {
      await this.deps.scheduler.settle(paths)
      const files = await this.inputs(paths)
      if (files.length === 0) return { kind: 'nothing' }
      const plans = plan(files)
      await this.carryOut(plans)
      return { kind: 'done', paths: plans.map(p => p.path) }
    })
  }

  private turnsAction(keys: readonly TurnKey[], plan: (files: readonly TurnFileInput[]) => { plans: readonly FilePlan[]; conflicts: readonly string[] }): Promise<ActionResult> {
    return this.enqueue(async () => {
      const wanted = new Set(keys)
      const paths = this.deps.model
        .files()
        .filter(s => s.record.entries.some(en => wanted.has(en.turn) && !en.isResolved))
        .map(s => s.path)
      await this.deps.scheduler.settle(paths)
      const files = await this.inputs(paths)
      const withPairs = await Promise.all(
        files.map(async (f): Promise<TurnFileInput> => {
          const entries = f.record.entries.filter(en => wanted.has(en.turn) && !en.isResolved)
          const pairs = await Promise.all(
            entries.map(async en => ({ turn: en.turn, before: await this.text(f.ledgerDir, en.before), after: await this.text(f.ledgerDir, en.after) })),
          )
          return { ...f, pairs }
        }),
      )
      const { plans, conflicts } = plan(withPairs)
      if (plans.length === 0 && conflicts.length === 0) return { kind: 'nothing' }
      await this.carryOut(plans)
      const done = plans.map(p => p.path)
      return conflicts.length > 0 ? { kind: 'conflicts', done, conflicts } : { kind: 'done', paths: done }
    })
  }

  private async text(ledgerDir: string, ref: Parameters<Blobs['get']>[1] | null): Promise<string | null> {
    return ref === null ? null : forDiff(await this.deps.blobs.get(ledgerDir, ref))
  }

  /** Each path's record, base and live text as the editor holds them, with its settled hunks. */
  private async inputs(paths: readonly string[]): Promise<FileInput[]> {
    const out = await Promise.all(
      paths.map(async (path): Promise<FileInput | undefined> => {
        const state = this.deps.model.get(path)
        if (!state) return undefined
        const rawBase = state.record.base === null ? null : await this.deps.blobs.get(state.ledgerDir, state.record.base)
        const probe = await this.deps.live.probe(path)
        const live = await probe.read()
        return {
          path,
          ledgerDir: state.ledgerDir,
          record: state.record,
          rawBase,
          base: rawBase === null ? null : forDiff(rawBase),
          live: live === null ? null : forDiff(live),
          hunks: state.diff.kind === 'ready' ? state.diff.hunks : [],
        }
      }),
    )
    return out.filter((f): f is FileInput => f !== undefined)
  }

  /** Line edits turning `current` into `target`, from the worker's hunks. */
  private async linesBetween(path: string, current: string, target: string): Promise<LineEdit[]> {
    if (current === target) return []
    const { hunks } = await this.deps.runner.diff({ baseKey: '', base: () => current, live: target })
    return hunks.map(h => ({
      start: h.hunk.oldIdx,
      end: h.hunk.oldIdx + h.hunk.oldLen,
      text: h.hunk.lines
        .filter(l => l.op !== '-')
        .map(l => l.text)
        .join(''),
    }))
  }

  private async carryOut(plans: readonly FilePlan[]): Promise<void> {
    const { blobs, writer, store, model, scheduler, markActionPaths } = this.deps
    const liveEdits: LiveEdit[] = []
    for (const p of plans) {
      if (!p.live) continue
      if (p.live.kind === 'lines') {
        liveEdits.push({ kind: 'lines', path: p.path, edits: p.live.edits })
        continue
      }
      const target = p.live.text
      const current = await (await this.deps.live.probe(p.path)).read()
      if (target === null) {
        if (current !== null) liveEdits.push({ kind: 'delete', path: p.path })
      } else if (current === null) {
        liveEdits.push({ kind: 'create', path: p.path, text: target })
      } else {
        const edits = await this.linesBetween(p.path, forDiff(current), target)
        if (edits.length > 0) liveEdits.push({ kind: 'lines', path: p.path, edits })
      }
    }
    const touched = plans.map(p => p.path)
    markActionPaths(touched)
    if (liveEdits.length > 0) await writer.apply(liveEdits)

    const byLedger = new Map<string, LedgerEvent[]>()
    for (const p of plans) {
      const events = byLedger.get(p.ledgerDir) ?? []
      if (p.keep !== undefined) {
        const base = p.keep === null ? null : await blobs.put(p.ledgerDir, p.keep)
        const previousBase = model.get(p.path)?.record.base ?? null
        events.push({ kind: 'keep', path: p.path, base })
        model.pushKeep({ path: p.path, ledgerDir: p.ledgerDir, previousBase })
      }
      for (const turn of p.resolves) events.push({ kind: 'resolve', path: p.path, turn })
      if (p.settle) events.push({ kind: 'settle', path: p.path })
      byLedger.set(p.ledgerDir, events)
    }
    await Promise.all(
      [...byLedger].map(async ([dir, events]) => {
        const s = store(dir)
        if (!s) throw new Error(`no ledger open for ${dir}`)
        if (events.length > 0) await s.append(events)
      }),
    )
    for (const path of touched) scheduler.request(path, 'action')
  }
}
