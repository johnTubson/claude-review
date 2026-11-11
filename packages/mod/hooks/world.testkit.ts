// A fake machine beneath the mod for `claude plugin test`: an in-memory disk,
// git roots, sockets and a tool that writes files. Every `$` call it answers is
// recorded in `calls`, so a test can count what a hook awaited.

import type { On, ToolCallResult } from 'claude-code'

import type { Summary } from '../types'

import { parseBatch, type Batch } from './core/events'
import { CONTENTS, EXCLUDE, GC, INIT, NEWEST_INDEX, REBASELINE, SIZES, SNAPSHOT, SNAPSHOT_DIFF } from './core/shadowScripts'

export const HOME = '/home'
export const DATA = `${HOME}/.claude/claude-review/v2`

type File = { text: string; mtimeMs: number }

export type ScriptName = 'INIT' | 'EXCLUDE' | 'NEWEST_INDEX' | 'REBASELINE/SNAPSHOT' | 'SNAPSHOT_DIFF' | 'SIZES' | 'CONTENTS' | 'GC' | 'other'
export type ScriptRun = { readonly name: ScriptName; readonly args: readonly string[]; readonly stdin: string | undefined }
export type ScriptAnswer = { readonly exitCode: number; readonly stdout: string }
export type FakeChange = { readonly status: 'A' | 'M' | 'D'; readonly path: string; readonly before?: string | Uint8Array; readonly after?: string | Uint8Array }

/** The shadow repo as the scripts would report it. */
export type FakeShadow = {
  readonly runs: ScriptRun[]
  /** What the next SNAPSHOT_DIFF reports. */
  diff: { readonly changes: readonly FakeChange[]; readonly big?: readonly string[] }
  /** Overrides by script; the default answers a healthy repo. */
  readonly answers: Map<ScriptName, (run: ScriptRun) => ScriptAnswer>
  /** Sizes SIZES reports over the real ones. */
  readonly sizeOverrides: Map<string, number>
}

const SCRIPTS: readonly (readonly [string, ScriptName])[] = [
  [INIT, 'INIT'],
  [EXCLUDE, 'EXCLUDE'],
  [NEWEST_INDEX, 'NEWEST_INDEX'],
  [REBASELINE, 'REBASELINE/SNAPSHOT'],
  [SNAPSHOT, 'REBASELINE/SNAPSHOT'],
  [SNAPSHOT_DIFF, 'SNAPSHOT_DIFF'],
  [SIZES, 'SIZES'],
  [CONTENTS, 'CONTENTS'],
  [GC, 'GC'],
]

export const TREE_BEFORE = '1'.repeat(40)
export const TREE_AFTER = '2'.repeat(40)

const encoder = new TextEncoder()
const bytesOf = (v: string | Uint8Array): Uint8Array => (typeof v === 'string' ? encoder.encode(v) : v)
const toBase64 = (bytes: Uint8Array): string => {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const codes = new Uint8Array(Math.ceil(bytes.length / 3) * 4)
  let o = 0
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    codes[o++] = abc.charCodeAt((n >> 18) & 63)
    codes[o++] = abc.charCodeAt((n >> 12) & 63)
    codes[o++] = i + 1 < bytes.length ? abc.charCodeAt((n >> 6) & 63) : 61
    codes[o++] = i + 2 < bytes.length ? abc.charCodeAt(n & 63) : 61
  }
  return new TextDecoder().decode(codes)
}

export type World = {
  readonly calls: string[]
  readonly logs: string[]
  readonly statuses: (string | undefined)[]
  /** Every summary the mod wrote to $.state, in order. */
  readonly summaries: Summary[]
  readonly pings: { readonly socketPath: string; readonly body: string; readonly url: string }[]
  file: (path: string, text: string) => void
  read: (path: string) => string | undefined
  paths: () => string[]
  /** Every whole batch on disk, in id order. */
  batches: (ledgerFilter?: string) => Batch[]
  tooLarge: Set<string>
  /** Holds every ping until `release` is called. */
  holdPings: () => { release: () => void }
  /** What the next tool call answers instead of writing (a deny, an error, a staged edit). */
  nextAnswer: ToolCallResult | undefined
  readonly shadow: FakeShadow
  /** Every Bash command the tool ran. */
  readonly ranCommands: string[]
}

export const fakeWorld = (on: On, options: { readonly gitRoots?: readonly string[]; readonly cwd?: string } = {}): World => {
  const disk = new Map<string, File>()
  const calls: string[] = []
  const logs: string[] = []
  const statuses: (string | undefined)[] = []
  const summaries: Summary[] = []
  const pings: { socketPath: string; body: string; url: string }[] = []
  const gitRoots = options.gitRoots ?? []
  const cwd = options.cwd ?? '/proj'
  let gate: Promise<void> | undefined
  let tick = 1_700_000_000_000

  // `{ deny }` is how a hook beneath makes the plugin's call reject.
  const enoent = (path: string): { deny: string } => ({ deny: `ENOENT: no such file or directory, '${path}'` })
  const write = (path: string, text: string): void => {
    disk.set(path, { text, mtimeMs: tick++ })
  }
  const children = (dir: string): string[] =>
    [...disk.keys()].filter(p => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/')).map(p => p.slice(dir.length + 1))
  const isDir = (dir: string): boolean => [...disk.keys()].some(p => p.startsWith(`${dir}/`))

  const world: World = {
    calls,
    logs,
    statuses,
    summaries,
    pings,
    file: write,
    read: path => disk.get(path)?.text,
    paths: () => [...disk.keys()].sort(),
    batches: filter =>
      [...disk.entries()]
        .filter(([p]) => p.includes('/events/') && (filter === undefined || p.startsWith(filter)))
        .sort(([a], [b]) => (a.slice(a.lastIndexOf('/')) < b.slice(b.lastIndexOf('/')) ? -1 : 1))
        .flatMap(([, f]) => {
          const parsed = parseBatch(f.text)
          return parsed.ok ? [parsed.value] : []
        }),
    tooLarge: new Set(),
    holdPings: () => {
      let release = (): void => {}
      gate = new Promise(resolve => {
        release = resolve
      })
      return { release }
    },
    nextAnswer: undefined,
    shadow: { runs: [], diff: { changes: [] }, answers: new Map(), sizeOverrides: new Map() },
    ranCommands: [],
  }

  const blobs = new Map<string, Uint8Array>()
  let shaCounter = 0
  const shaFor = (v: string | Uint8Array): string => {
    const sha = (++shaCounter).toString(16).padStart(40, 'a')
    blobs.set(sha, bytesOf(v))
    return sha
  }
  const defaultAnswer = (run: ScriptRun): ScriptAnswer => {
    switch (run.name) {
      case 'INIT':
        return { exitCode: 0, stdout: 'git version 2.33.0\n' }
      case 'REBASELINE/SNAPSHOT':
        return { exitCode: 0, stdout: `${TREE_BEFORE}\n` }
      case 'SNAPSHOT_DIFF': {
        const { changes, big = [] } = world.shadow.diff
        const zero = '0'.repeat(40)
        let out = `${TREE_AFTER}\n`
        for (const c of changes) {
          const oldSha = c.before === undefined ? zero : shaFor(c.before)
          const newSha = c.after === undefined ? zero : shaFor(c.after)
          out += `:${c.before === undefined ? '000000' : '100644'} ${c.after === undefined ? '000000' : '100644'} ${oldSha} ${newSha} ${c.status}\0${c.path}\0`
        }
        if (big.length > 0) out += `!big\0${big.map(b => `${b}\0`).join('')}`
        return { exitCode: 0, stdout: out }
      }
      case 'SIZES':
        return {
          exitCode: 0,
          stdout: (run.stdin ?? '')
            .split('\n')
            .filter(sha => sha !== '')
            .map(sha => {
              const b = blobs.get(sha)
              return b === undefined ? `${sha} missing` : `${sha} blob ${world.shadow.sizeOverrides.get(sha) ?? b.length}`
            })
            .join('\n'),
        }
      case 'CONTENTS': {
        const parts: Uint8Array[] = []
        for (const sha of (run.stdin ?? '').split('\n').filter(x => x !== '')) {
          const b = blobs.get(sha)
          if (b === undefined) {
            parts.push(encoder.encode(`${sha} missing\n`))
            continue
          }
          parts.push(encoder.encode(`${sha} blob ${b.length}\n`), b, encoder.encode('\n'))
        }
        const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
        let at = 0
        for (const p of parts) {
          all.set(p, at)
          at += p.length
        }
        return { exitCode: 0, stdout: toBase64(all) }
      }
      case 'GC':
        return { exitCode: 0, stdout: 'kept 10\n' }
      case 'EXCLUDE':
      case 'NEWEST_INDEX':
      case 'other':
        return { exitCode: 0, stdout: '' }
      default: {
        const unhandled: never = run.name
        throw new Error(`unknown script ${String(unhandled)}`)
      }
    }
  }

  on('session.id', () => (calls.push('session.id'), { value: 'Session-1abc' }))
  on('session.cwd', () => (calls.push('session.cwd'), { value: cwd }))
  on('env.get', (_$, e) => (calls.push('env.get'), { value: e.name === 'HOME' ? HOME : undefined }))
  on('fs.read', (_$, e) => {
    calls.push('fs.read')
    if (world.tooLarge.has(e.path)) return { deny: `EFBIG: ${e.path} is over 4 MiB` }
    const file = disk.get(e.path)
    if (file === undefined) return enoent(e.path)
    return { value: file.text }
  })
  on('fs.stat', (_$, e) => {
    calls.push('fs.stat')
    const file = disk.get(e.path)
    if (file === undefined && !world.tooLarge.has(e.path)) return enoent(e.path)
    return { value: { kind: 'file' as const, size: file?.text.length ?? 5_000_000, mtimeMs: file?.mtimeMs ?? 1, isLink: false } }
  })
  on('fs.write', (_$, e) => {
    calls.push('fs.write')
    write(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', (_$, e) => (calls.push('fs.exists'), { value: disk.has(e.path) || isDir(e.path) }))
  on('fs.list', (_$, e) => {
    calls.push('fs.list')
    if (!isDir(e.path)) return enoent(e.path)
    return {
      value: children(e.path).map(name => {
        const f = disk.get(`${e.path}/${name}`)
        return { name, kind: 'file' as const, size: f?.text.length ?? 0, mtimeMs: f?.mtimeMs ?? 0, isLink: false }
      }),
    }
  })
  on('process.run', (_$, e) => {
    calls.push('process.run')
    if (e.argv[0] === '/bin/sh' && e.argv[1] === '-c') {
      const script = e.argv[2] ?? ''
      const name = SCRIPTS.find(([text]) => text === script)?.[1] ?? 'other'
      const run: ScriptRun = { name, args: e.argv.slice(4), stdin: e.init?.stdin }
      world.shadow.runs.push(run)
      calls.push(`script:${name}`)
      const answer = (world.shadow.answers.get(name) ?? defaultAnswer)(run)
      return { value: { exitCode: answer.exitCode, stdout: answer.stdout, stderr: answer.exitCode === 0 ? '' : 'boom', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const [cmd, flag, dir, sub] = e.argv
    if (cmd === 'rm' && flag === '-f' && dir !== undefined) {
      disk.delete(dir)
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (cmd === 'git' && flag === '-C' && sub === 'rev-parse' && dir !== undefined) {
      const root = [...gitRoots].sort((a, b) => b.length - a.length).find(r => dir === r || dir.startsWith(`${r}/`))
      return { value: { exitCode: root ? 0 : 128, stdout: root ? `${root}\n` : '', stderr: root ? '' : 'fatal: not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('http.fetch', async (_$, e) => {
    calls.push('http.fetch')
    pings.push({ socketPath: e.init?.socketPath ?? '', body: typeof e.init?.body === 'string' ? e.init.body : '', url: e.url })
    if (gate) await gate
    return { value: { status: 204, ok: true, headers: {}, text: '' } }
  })
  on('ui.status', (_$, e) => (calls.push('ui.status'), statuses.push(e.text), { value: undefined }))
  on('ui.toast', (_$, e) => (calls.push('ui.toast'), logs.push(`toast ${e.text}`), { value: undefined }))
  on('ui.open', () => (calls.push('ui.open'), { value: { isPlaced: true as const } }))
  on('ui.close', () => (calls.push('ui.close'), { value: undefined }))
  on('command.register', () => (calls.push('command.register'), { value: { command: 'changes' } }))
  on('ui.log', (_$, e) => (calls.push('ui.log'), logs.push(e.text), { value: undefined }))

  on('state.set', (_$, e, next) => {
    if (e.plugin === 'session-review' && e.key === 'summary') summaries.push(e.value)
    return next(e)
  })

  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', (_$, e) => {
    calls.push('tool.call')
    const answer = world.nextAnswer
    if (answer !== undefined) {
      world.nextAnswer = undefined
      return answer
    }
    if (e.tool === 'Bash') {
      world.ranCommands.push(e.command)
      return { result: { stdout: '', stderr: '', interrupted: false } }
    }
    if (e.tool === 'Write') write(e.file_path, e.content)
    else if (e.tool === 'Edit') write(e.file_path, (disk.get(e.file_path)?.text ?? '').replace(e.old_string, e.new_string))
    return { result: { type: 'update' } }
  })
  return world
}
