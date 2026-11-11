// One shadow repo per ledger (index per session) that snapshots the work tree
// around mutating Bash commands. Only the before-snapshot is on the command's
// critical path; the after-snapshot, sizes and contents run behind the barrier.

import type { EngineInterface } from 'claude-code'

import { decodeBase64, decodeUtf8With } from './core/bytes'
import {
  chunkBySize, CONTENTS, CONTENTS_CHUNK_BYTES, EXCLUDE, GC, INIT, NEWEST_INDEX, parseBatchCheck, parseContents, parseSnapshot, parseSnapshotDiff, REBASELINE, SIZES, SNAPSHOT,
  SNAPSHOT_DIFF, type SnapshotChange, type SnapshotResult,
} from './core/shadowScripts'
import { log, logOnce, reasonOf } from './log'
import type { Options } from './options'
import { dirOfRoot, ensureMeta, sessionRootOf, type Routing } from './paths'
import { captureMany, type Capture, type CurrentTurn, type Recorder } from './recorder'

type $ = EngineInterface

const SCRIPT_TIMEOUT_MS = 120_000
const GC_EVERY_MS = 24 * 60 * 60 * 1000
const SHADOW_MAX_KIB = 512 * 1024
const MIN_GIT: readonly [number, number] = [2, 26]

export type ShadowPlace = { readonly root: string; readonly ledgerDir: string; readonly gitDir: string; readonly index: string }

export type Shadow = {
  readonly routing: Routing
  readonly options: Options
  /** Set once warm-up finds a git root and a recent enough git. */
  place: ShadowPlace | undefined
  /** Settles when warm-up is done; never rejects. */
  warmed: Promise<void>
  isRebaselining: boolean
  /** `$.process.run` calls made so far, for debugTimings and tests. */
  spawns: number
}

export const newShadow = (routing: Routing, options: Options): Shadow => ({
  routing,
  options,
  place: undefined,
  warmed: Promise.resolve(),
  isRebaselining: false,
  spawns: 0,
})

type ScriptResult = { readonly ok: true; readonly stdout: string } | { readonly ok: false; readonly reason: string }

async function runScript($: $, shadow: Shadow, script: string, args: readonly string[], cwd: string, stdin?: string): Promise<ScriptResult> {
  shadow.spawns++
  try {
    const ran = await $.process.run(['/bin/sh', '-c', script, 'sh', ...args], stdin === undefined ? { cwd, timeoutMs: SCRIPT_TIMEOUT_MS } : { cwd, timeoutMs: SCRIPT_TIMEOUT_MS, stdin })
    if (ran.isStdoutTruncated) return { ok: false, reason: 'output over 4 MiB' }
    if (ran.exitCode !== 0) return { ok: false, reason: `exit ${ran.exitCode}: ${ran.stderr.trim().slice(0, 300)}` }
    return { ok: true, stdout: ran.stdout }
  } catch (err) {
    return { ok: false, reason: reasonOf(err) }
  }
}

const isRecentGit = (versionLine: string): boolean => {
  const match = /git version (\d+)\.(\d+)/.exec(versionLine)
  const major = Number(match?.[1] ?? 0)
  const minor = Number(match?.[2] ?? 0)
  return major > MIN_GIT[0] || (major === MIN_GIT[0] && minor >= MIN_GIT[1])
}

const safeName = (session: string): string => session.replace(/[^A-Za-z0-9_-]/g, '_')

/** Schedules the warm-up off the session's start; `shadow.warmed` covers it from now, so an early Bash call waits for it. */
export function startWarmUp($: $, shadow: Shadow): void {
  shadow.warmed = new Promise(resolve => {
    $.clock.after(0, () => {
      void warmUp($, shadow)
        .catch((err: unknown) => logOnce($, 'shadow-warm', `Bash changes are not recorded: ${reasonOf(err)}`))
        .finally(resolve)
    })
  })
}

async function warmUp($: $, shadow: Shadow): Promise<void> {
  const { root, isGit } = await sessionRootOf($, shadow.routing)
  if (!isGit) return
  const ledgerDir = await dirOfRoot(shadow.routing, root)
  const gitDir = `${ledgerDir}/shadow.git`
  await ensureMeta($, shadow.routing, { dir: ledgerDir, root })
  await maybeGc($, shadow, ledgerDir, gitDir, root)
  const init = await runScript($, shadow, INIT, [gitDir], root)
  if (!init.ok) throw new Error(`could not set up the shadow repo: ${init.reason}`)
  const version = init.stdout.trim().split('\n').at(-1) ?? ''
  if (!isRecentGit(version)) {
    logOnce($, 'old-git', `Bash changes are not recorded: needs git 2.26 or newer (${version})`)
    return
  }
  const excluded = await runScript($, shadow, EXCLUDE, [gitDir, root], root)
  if (!excluded.ok) throw new Error(`could not write the shadow's excludes: ${excluded.reason}`)
  const place: ShadowPlace = { root, ledgerDir, gitDir, index: `${gitDir}/index.${safeName(shadow.routing.paths.session)}` }
  const newest = await runScript($, shadow, NEWEST_INDEX, [gitDir], root)
  const seed = newest.ok ? newest.stdout.trim() : ''
  // No candidate cap: off the critical path, and what makes the first Bash snapshot cheap.
  const base = await runScript($, shadow, REBASELINE, [place.index, gitDir, root, seed, String(shadow.options.maxFileBytes), '0'], root)
  if (!base.ok) throw new Error(`could not snapshot the work tree: ${base.reason}`)
  shadow.place = place
}

const parseGcState = (text: string | undefined): { blobsAt?: number; shadowAt?: number } => {
  if (text === undefined) return {}
  try {
    const v: unknown = JSON.parse(text)
    if (typeof v !== 'object' || v === null) return {}
    const blobsAt = 'blobsAt' in v && typeof v.blobsAt === 'number' ? v.blobsAt : undefined
    const shadowAt = 'shadowAt' in v && typeof v.shadowAt === 'number' ? v.shadowAt : undefined
    return { ...(blobsAt === undefined ? {} : { blobsAt }), ...(shadowAt === undefined ? {} : { shadowAt }) }
  } catch {
    // A torn gc.json only means the next GC runs early.
    return {}
  }
}

/** At most once a day per ledger: week-old indexes go, and a store over 512 MB is dropped to be rebuilt. */
async function maybeGc($: $, shadow: Shadow, ledgerDir: string, gitDir: string, root: string): Promise<void> {
  const file = `${ledgerDir}/gc.json`
  const state = parseGcState(await $.fs.read(file).catch(() => undefined))
  const now = Date.now()
  if (state.shadowAt !== undefined && now - state.shadowAt < GC_EVERY_MS) return
  if (!(await $.fs.exists(gitDir))) return
  const ran = await runScript($, shadow, GC, [gitDir, String(SHADOW_MAX_KIB)], root)
  if (!ran.ok) {
    logOnce($, 'shadow-gc', `shadow GC failed: ${ran.reason}`)
    return
  }
  if (ran.stdout.trim() === 'removed') log($, `the shadow repo for ${root} passed 512 MB and was removed; it is rebuilt now`)
  await $.fs.write(file, JSON.stringify({ ...state, shadowAt: now }))
}

/** The before-snapshot: one spawn. */
export async function snapshot($: $, shadow: Shadow, place: ShadowPlace): Promise<SnapshotResult> {
  const ran = await runScript(
    $,
    shadow,
    SNAPSHOT,
    [place.index, place.gitDir, place.root, '', String(shadow.options.maxFileBytes), String(shadow.options.maxSnapshotCandidates)],
    place.root,
  )
  return ran.ok ? parseSnapshot(ran.stdout) : { kind: 'failed', reason: ran.reason }
}

/** A snapshot that could not be used: the command runs unrecorded; too many paths start a rebaseline. */
export function onUnusable($: $, shadow: Shadow, place: ShadowPlace, result: Exclude<SnapshotResult, { kind: 'tree' }>): void {
  switch (result.kind) {
    case 'tooMany':
      logOnce($, 'too-many', `${result.count} changed paths in ${place.root}: this Bash command is not recorded; re-baselining in the background`)
      startRebaseline($, shadow, place)
      return
    case 'failed':
      logOnce($, `snapshot-failed:${result.reason}`, `Bash changes are not recorded: ${result.reason}`)
      return
    default: {
      const unhandled: never = result
      throw new Error(`unknown snapshot result ${JSON.stringify(unhandled)}`)
    }
  }
}

/** One at a time, off the barrier: Bash runs unrecorded while it does. */
export function startRebaseline($: $, shadow: Shadow, place: ShadowPlace): void {
  if (shadow.isRebaselining) return
  shadow.isRebaselining = true
  void runScript($, shadow, REBASELINE, [place.index, place.gitDir, place.root, '', String(shadow.options.maxFileBytes), '0'], place.root)
    .then(ran => {
      if (!ran.ok) logOnce($, 'rebaseline', `re-baselining ${place.root} failed: ${ran.reason}`)
    })
    .finally(() => {
      shadow.isRebaselining = false
    })
}

type Sized = { readonly sha: string; readonly size: number }

const textDecoder = new TextDecoder()
const decodeText = (bytes: Uint8Array): string | undefined => decodeUtf8With(b => textDecoder.decode(b), bytes)

/** After the command: what changed, its sizes, then its texts; captures what is text and small enough. */
export async function afterBash($: $, shadow: Shadow, place: ShadowPlace, recorder: Recorder, beforeTree: string, turn: CurrentTurn): Promise<void> {
  const started = Date.now()
  const spawnsBefore = shadow.spawns
  const { options } = shadow
  const ran = await runScript(
    $,
    shadow,
    SNAPSHOT_DIFF,
    [place.index, place.gitDir, place.root, '', String(options.maxFileBytes), String(options.maxSnapshotCandidates), beforeTree],
    place.root,
  )
  if (!ran.ok) {
    logOnce($, `after-failed:${ran.reason}`, `could not see what a Bash command changed: ${ran.reason}`)
    return
  }
  const diff = parseSnapshotDiff(ran.stdout)
  if (diff.kind === 'tooMany') {
    onUnusable($, shadow, place, diff)
    return
  }
  if (diff.kind === 'failed') {
    logOnce($, `after-failed:${diff.reason}`, `could not see what a Bash command changed: ${diff.reason}`)
    return
  }
  const big = new Set(diff.big)
  for (const path of diff.big) logOnce($, `big:${place.root}/${path}`, `${place.root}/${path} is over ${options.maxFileBytes} bytes, so Bash changes to it are not recorded`)
  // A file that grew past the cap was unstaged, which reads as a deletion: it is not one.
  let changes: readonly SnapshotChange[] = diff.changes.filter(c => !big.has(c.path))
  if (changes.length > options.maxBashFiles) {
    log($, `a Bash command changed ${changes.length} files; recording the first ${options.maxBashFiles}`)
    changes = changes.slice(0, options.maxBashFiles)
  }
  if (changes.length === 0) return

  const shas = [...new Set(changes.flatMap(c => [c.oldSha, c.newSha]).filter((s): s is string => s !== null))]
  const sizesRan = await runScript($, shadow, SIZES, [place.gitDir], place.root, `${shas.join('\n')}\n`)
  if (!sizesRan.ok) {
    logOnce($, `sizes:${sizesRan.reason}`, `could not size Bash changes: ${sizesRan.reason}`)
    return
  }
  const infos = parseBatchCheck(sizesRan.stdout)
  const sizeOf = (sha: string | null): number | undefined => {
    if (sha === null) return 0
    const info = infos.get(sha)
    return info?.kind === 'blob' ? info.size : undefined
  }
  const small = changes.filter(c => {
    const sizes = [sizeOf(c.oldSha), sizeOf(c.newSha)]
    const isSmall = sizes.every(s => s !== undefined && s <= options.maxFileBytes)
    if (!isSmall) logOnce($, `big:${place.root}/${c.path}`, `${place.root}/${c.path} is over ${options.maxFileBytes} bytes, so Bash changes to it are not recorded`)
    return isSmall
  })
  if (small.length === 0) return

  const wanted: Sized[] = [...new Set(small.flatMap(c => [c.oldSha, c.newSha]).filter((s): s is string => s !== null))].map(sha => ({ sha, size: sizeOf(sha) ?? 0 }))
  const texts = new Map<string, string>()
  const results = await Promise.all(
    chunkBySize(wanted, CONTENTS_CHUNK_BYTES).map(chunk => runScript($, shadow, CONTENTS, [place.gitDir], place.root, `${chunk.join('\n')}\n`)),
  )
  for (const result of results) {
    if (!result.ok) {
      logOnce($, `contents:${result.reason}`, `could not read Bash changes: ${result.reason}`)
      return
    }
    const bytes = decodeBase64(result.stdout)
    const parsed = bytes === undefined ? undefined : parseContents(bytes, decodeText)
    if (parsed?.kind !== 'ok') {
      logOnce($, 'contents-parse', `could not read Bash changes: ${parsed?.kind === 'failed' ? parsed.reason : 'bad base64'}`)
      return
    }
    for (const [sha, text] of parsed.texts) texts.set(sha, text)
  }

  const at = Date.now()
  const captures: Capture[] = []
  for (const c of small) {
    const before = c.oldSha === null ? null : texts.get(c.oldSha)
    const after = c.newSha === null ? null : texts.get(c.newSha)
    // Binary on either side: not reviewable as text.
    if (before === undefined || after === undefined) continue
    captures.push({ path: `${place.root}/${c.path}`, before, after, tool: 'Bash', turn, at })
  }
  captureMany($, recorder, captures)
  if (options.debugTimings) log($, `Bash after: ${shadow.spawns - spawnsBefore} spawns, ${captures.length} files, ${Date.now() - started} ms`)
}
