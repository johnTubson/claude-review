import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

import { isReadOnlyCommand } from './core/bashReadOnly'
import type { EntryTool } from './core/events'
import { loadLedger, newLedgers, type Ledgers } from './ledger'
import { log, logOnce, reasonOf } from './log'
import { DEFAULT_OPTIONS, parseOptions, type Options } from './options'
import { dirOfRoot, newRouting, sessionPathsOf, sessionRootOf, type Routing } from './paths'
import { capture, flush, newRecorder, type CurrentTurn, type Recorder } from './recorder'
import { afterBash, newShadow, onUnusable, snapshot, startWarmUp, type Shadow } from './shadow'
import { newSockets, type Sockets } from './sockets'
import { newSummary, recompute, stopSummary, type SummaryState } from './summary'
import { drawBand, drawReview, openPane, runChanges } from './ui'

type $ = EngineInterface

const CURRENT_TURN_REF = { plugin: 'session-review', key: 'currentTurn' } as const
const NO_TURN: CurrentTurn = { id: 'turn', prompt: '' }

type Session = {
  readonly routing: Routing
  readonly shadow: Shadow
  readonly recorder: Recorder
  readonly summary: SummaryState
  readonly sockets: Sockets
}

/** `string` for the text, `null` for a missing file, `undefined` for one over 4 MiB or unreadable. */
async function readText($: $, path: string, rpcs: { n: number }): Promise<string | null | undefined> {
  rpcs.n++
  try {
    return await $.fs.read(path)
  } catch {
    rpcs.n++
    // A failed read only says it failed: the stat tells a missing file from one too large to read.
    return $.fs.stat(path).then(
      () => undefined,
      (err: unknown) => (String(err).includes('ENOENT') ? null : undefined),
    )
  }
}

/** An Edit or Write held for review is not on disk yet. */
const isStaged = (ran: ToolCallResult): boolean => {
  const result: unknown = ran.result
  return typeof result === 'object' && result !== null && 'staged' in result && result.staged === true
}

/** Off the session's start: the session root's ledger and the first summary. */
async function warmUp($: $, routing: Routing, summary: SummaryState): Promise<void> {
  try {
    const { root } = await sessionRootOf($, routing)
    await loadLedger($, summary.ledgers, await dirOfRoot(routing, root))
    await recompute($, summary)
  } catch (err) {
    log($, `could not read the review: ${reasonOf(err)}`)
  }
}

const promptOf = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 60)

/** This module instance's state: a hot reload starts it over, and session.start fills it again. */
type Mod = {
  options: Options
  readonly ledgers: Ledgers
  session: Session | undefined
  currentTurn: CurrentTurn | undefined
  /** Bash's after-snapshot (P3) runs behind this; edits wait for it so they never interleave. */
  barrier: Promise<void>
}

const mod: Mod = { options: DEFAULT_OPTIONS, ledgers: newLedgers(), session: undefined, currentTurn: undefined, barrier: Promise.resolve() }

async function recordFileTool<R extends ToolCallResult>($: $, tool: EntryTool, path: string, run: () => Promise<R>): Promise<R> {
  const s = mod.session
  if (s === undefined) {
    logOnce($, 'no-session', 'a tool ran before the session started; its change is not recorded')
    return run()
  }
  await mod.barrier
  const started = Date.now()
  const rpcs = { n: 0 }
  const before = await readText($, path, rpcs)
  const ran = await run()
  if (ran.deny !== undefined || ran.isError === true || isStaged(ran)) return ran
  if (before === undefined) {
    logOnce($, `large:${path}`, `${path} is over 4 MiB or unreadable, so its changes are not recorded`)
    return ran
  }
  const after = await readText($, path, rpcs)
  if (after !== undefined && after !== before) {
    capture($, s.recorder, { path, before, after, tool, turn: mod.currentTurn ?? NO_TURN, at: Date.now() })
  }
  if (mod.options.debugTimings) log($, `${tool} recorded: ${rpcs.n} rpc, ${Date.now() - started} ms`)
  return ran
}

/** §6.6: read-only commands cost nothing; a mutating one costs one spawn before it runs, the rest after, behind the barrier. */
async function recordBash<R extends ToolCallResult>($: $, command: string, run: () => Promise<R>): Promise<R> {
  const s = mod.session
  if (!mod.options.bash || s === undefined || isReadOnlyCommand(command)) return run()
  const { shadow } = s
  if (shadow.isRebaselining) {
    logOnce($, 'rebaselining', 'Bash commands run unrecorded while the work tree is re-baselined')
    return run()
  }
  await mod.barrier
  await shadow.warmed
  const place = shadow.place
  if (place === undefined) return run()
  const turn = mod.currentTurn ?? NO_TURN
  const started = Date.now()
  const before = await snapshot($, shadow, place)
  if (mod.options.debugTimings) log($, `Bash snapshot: ${Date.now() - started} ms, 1 spawn`)
  if (before.kind !== 'tree') {
    onUnusable($, shadow, place, before)
    return run()
  }
  const ran = await run()
  if (ran.deny !== undefined || ran.isReadOnly === true) return ran
  mod.barrier = afterBash($, shadow, place, s.recorder, before.tree, turn).catch((err: unknown) =>
    logOnce($, `after:${reasonOf(err)}`, `could not record a Bash command's changes: ${reasonOf(err)}`),
  )
  return ran
}

async function startSession($: $): Promise<void> {
  if (mod.session) stopSummary(mod.session.summary)
  const paths = await sessionPathsOf($, mod.options)
  const routing = newRouting(paths)
  const summary = newSummary(routing, mod.ledgers)
  const sockets = newSockets(paths.socketsDir)
  const recorder = newRecorder(routing, mod.ledgers, sockets, summary)
  const shadow = newShadow(routing, mod.options)
  mod.session = { routing, shadow, recorder, summary, sockets }
  // `/review` is a built-in, so the command is `/changes`.
  await $.command
    .register({
      name: 'changes',
      description: 'Review the files Claude changed: keep or undo each change, file, turn or session',
      argumentHint: '[show|open N] [keep|undo N | N.M | turn N | session N | all] [vscode]',
    })
    .catch((err: unknown) => log($, `could not register /changes: ${reasonOf(err)}`))
  if (mod.options.bash) startWarmUp($, shadow)
  if (mod.currentTurn === undefined) {
    // A hot reload starts the module over mid-turn: the turn it was in is in $.state.
    const held = await $.state.get(CURRENT_TURN_REF).catch(() => undefined)
    mod.currentTurn = held?.value ?? undefined
  }
  $.clock.after(0, () => {
    void warmUp($, routing, summary)
  })
}

async function changes($: $, args: string): Promise<string> {
  const s = mod.session
  if (s === undefined) return 'The review is not ready yet; try again in a moment.'
  // What Claude just changed lands first, then keeps and undos made in VS Code since the last poll.
  await mod.barrier
  await flush($, s.recorder)
  await Promise.all([...s.summary.scope].map(dir => loadLedger($, mod.ledgers, dir).catch(() => undefined)))
  await recompute($, s.summary)
  if (args.trim() === '') void openPane($)
  return runChanges($, s, args)
}

async function startTurn($: $, text: string, turnId: string): Promise<void> {
  mod.currentTurn = { id: turnId, prompt: promptOf(text) }
  await $.state.set(CURRENT_TURN_REF, mod.currentTurn).catch((err: unknown) => logOnce($, 'turn-state', `could not keep the current turn: ${reasonOf(err)}`))
}

async function completeTurn($: $): Promise<void> {
  const s = mod.session
  if (s === undefined) return
  await mod.barrier
  await flush($, s.recorder)
}

async function endSession($: $, remainingMs: number): Promise<void> {
  const s = mod.session
  if (s === undefined) return
  stopSummary(s.summary)
  const left = remainingMs - 100
  if (left > 0) await Promise.race([flush($, s.recorder), $.clock.sleep(left)]).catch(() => undefined)
}

export const register: Register = (on, rawOptions) => {
  mod.options = parseOptions(rawOptions)

  on('session.start', async ($, e, next) => {
    await startSession($)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await startTurn($, e.text, e.turnId)
    return next(e)
  })

  on('tool.call', { tool: 'Edit' }, ($, e, next) => recordFileTool($, 'Edit', e.file_path, () => next(e))).catch(($, e, next) => next(e))
  on('tool.call', { tool: 'Write' }, ($, e, next) => recordFileTool($, 'Write', e.file_path, () => next(e))).catch(($, e, next) => next(e))
  on('tool.call', { tool: 'NotebookEdit' }, ($, e, next) => recordFileTool($, 'NotebookEdit', e.notebook_path, () => next(e))).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Bash' }, ($, e, next) => recordBash($, e.command, () => next(e))).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) await completeTurn($)
    return next(e)
  })

  on('command.run', { command: 'changes' }, async ($, e) => ({ text: await changes($, e.args) }))

  on('ui.render', { component: 'Pane', requestId: 'session-review' }, async ($, e, next) => {
    const s = mod.session
    return s === undefined ? next(e) : drawReview($, s, e, false)
  })

  // Surfaces with no pane slot draw the review inline, as the bare /changes row.
  on('ui.render', { component: 'CommandOutput', props: { command: 'changes' } }, async ($, e, next) => {
    const s = mod.session
    return s === undefined || e.props.isErrored || e.props.args.trim() !== '' ? next(e) : drawReview($, s, e, true)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = mod.session
    if (s === undefined || !mod.options.band || (e.surface !== 'terminal' && e.surface !== 'desktop')) return next(e)
    return (await drawBand($, s, e)) ?? next(e)
  })

  on('session.end', async ($, e, next) => {
    await endSession($, next.budget.remainingMs)
    return next(e)
  })
}
