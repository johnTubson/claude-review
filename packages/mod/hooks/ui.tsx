// The terminal review (§6.9): `/changes` text (what the model reads), the
// Pane, the band above the prompt, and `open`/`vscode` through the bridge.
// Drawing reads state and disk only; every write happens in a handler.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderInput } from 'claude-code'

import type { FileRow, SessionRow, Summary, TurnRow } from '../types'
import { diffHunks, toUnified, type Hunk } from './core/diff'
import { filesAction, hunkAction, readDisk, turnsAction, type ActionOutcome, type ActionSession } from './actions'
import { readBlob } from './summary'
import { focusVsCode, openInVsCode, type Sockets } from './sockets'

type $ = EngineInterface

export const PANE = 'session-review'
const TITLE = 'Review changes'
/** Characters of diff one page carries, in the pane and in `/changes show`. */
const PAGE_CHARS = 20_000
const CODE_CLIS = ['code', '/usr/local/bin/code', '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code']

const summaryAtom = atom({ plugin: 'session-review', key: 'summary' } as const, { files: [], turns: [], sessions: [], added: 0, removed: 0 })
const selectedAtom = atom({ plugin: 'session-review', key: 'selected' } as const, null)
const pageAtom = atom({ plugin: 'session-review', key: 'page' } as const, 0)

export type UiSession = ActionSession & { readonly sockets: Sockets }

export const HELP = [
  '`/changes` lists the changes · `/changes show 1 [page]` prints file 1’s diff · `/changes open 1` opens it in VS Code’s diff editor',
  '`/changes keep|undo 1` a whole file · `1.2` one change in it · `turn 2` a whole turn · `session 1` a whole session · `all` everything',
  '`/changes vscode` shows the Claude Review view in VS Code, which does all of this with buttons.',
].join('\n')

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

const noteOf = (f: FileRow): string => (f.status === 'new' ? ', new file' : f.status === 'deleted' ? ', deleted' : '')

/** Sessions → turns → files; a file in several turns is listed under each, with its one number. */
export const listText = (summary: Summary): string => {
  const { files, turns, sessions } = summary
  if (files.length === 0) return 'No changes to review.'
  const number = new Map(files.map((f, i) => [f.path, i + 1]))
  const byPath = new Map(files.map(f => [f.path, f]))
  const rows = [`**${plural(files.length, 'file')} changed** +${summary.added} −${summary.removed}`]
  const shown = new Set<string>()
  const turnRows = (t: TurnRow, indent: string): string[] => [
    `${indent}- turn ${t.n}: “${t.prompt || '(continuation)'}” · \`keep|undo turn ${t.n}\``,
    ...t.paths.flatMap(p => {
      const f = byPath.get(p)
      if (!f) return []
      shown.add(p)
      return [`${indent}  ${number.get(p) ?? '?'}. \`${f.rel}\` +${f.added} −${f.removed}${noteOf(f)}`]
    }),
  ]
  const turnByKey = new Map(turns.map(t => [t.key, t]))
  for (const s of sessions) {
    rows.push('', `**Session ${s.n}**${s.title ? ` “${s.title}”` : ''} · \`keep|undo session ${s.n}\``)
    for (const key of s.turnKeys) {
      const t = turnByKey.get(key)
      if (t) rows.push(...turnRows(t, ''))
    }
  }
  const rest = files.filter(f => !shown.has(f.path))
  if (rest.length > 0) rows.push('', '**Other files**', ...rest.map(f => `${number.get(f.path) ?? '?'}. \`${f.rel}\` +${f.added} −${f.removed}${noteOf(f)}`))
  rows.push('', HELP)
  return rows.join('\n')
}

/** A file's hunks split into pages of at most PAGE_CHARS (a hunk bigger than a page gets one to itself). */
const pagesOf = (hunks: readonly Hunk[]): { readonly index: number; readonly source: string }[][] => {
  const pages: { index: number; source: string }[][] = []
  let page: { index: number; source: string }[] = []
  let used = 0
  hunks.forEach((h, index) => {
    const source = toUnified(h)
    if (page.length > 0 && used + source.length > PAGE_CHARS) {
      pages.push(page)
      page = []
      used = 0
    }
    page.push({ index, source })
    used += source.length
  })
  if (page.length > 0) pages.push(page)
  return pages
}

async function hunksOf($: $, s: UiSession, f: FileRow): Promise<Hunk[]> {
  const [base, live] = await Promise.all([readBlob($, s.summary.blobs, f.ledger, baseOf(s, f)), readDisk($, f.path)])
  return diffHunks(base ?? '', live ?? '')
}

/** The base ref a row was counted against, from the cached fold. */
const baseOf = (s: UiSession, f: FileRow): Parameters<typeof readBlob>[3] => s.recorder.ledgers.caches.get(f.ledger)?.ledger.files.get(f.path)?.base ?? null

async function diffText($: $, s: UiSession, n: number, page: number): Promise<string> {
  const f = s.summary.current.files[n - 1]
  if (!f) return `There is no file ${n}.`
  const hunks = await hunksOf($, s, f)
  const pages = pagesOf(hunks)
  const shown = pages[page - 1] ?? []
  const rows = [`**${n}. \`${f.rel}\`** +${f.added} −${f.removed}${noteOf(f)}${pages.length > 1 ? ` · page ${page}/${pages.length}` : ''}`]
  for (const { index, source } of shown) rows.push('', `Change **${n}.${index + 1}** · \`/changes keep ${n}.${index + 1}\` · \`/changes undo ${n}.${index + 1}\``, '```diff', source, '```')
  if (page < pages.length) rows.push('', `More: \`/changes show ${n} ${page + 1}\``)
  rows.push('', `Whole file: \`/changes keep ${n}\` · \`/changes undo ${n}\``)
  return rows.join('\n')
}

/** Runs VS Code's `code` CLI with these arguments, trying the usual install paths; true when one ran. */
async function runCode($: $, args: readonly string[]): Promise<boolean> {
  for (const cli of CODE_CLIS) {
    const ran = await $.process.run([cli, ...args], { timeoutMs: 10_000 }).catch(() => undefined)
    if (ran?.exitCode === 0) return true
  }
  return false
}

const outcomeText = (outcome: ActionOutcome, done: string): string => {
  switch (outcome.kind) {
    case 'done':
      return done
    case 'conflicts':
      return `${done} Not in ${outcome.conflicts.map(p => `\`${p.split('/').pop() ?? p}\``).join(', ')}: a later change overlaps it; resolve those files change by change.`
    case 'failed':
      return `Could not: ${outcome.reason}.`
    default: {
      const unhandled: never = outcome
      throw new Error(`unknown outcome ${JSON.stringify(unhandled)}`)
    }
  }
}

const sessionKeys = (session: SessionRow | undefined): readonly string[] => session?.turnKeys ?? []

/** One `/changes` run: the args parsed into an action, answered with what happened and the list after it. */
export async function runChanges($: $, s: UiSession, args: string): Promise<string> {
  const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const [verb, target, extra] = words
  const summary = s.summary.current
  if (verb === undefined) return listText(summary)
  if (verb === 'help') return HELP
  if (verb === 'vscode') {
    if (await focusVsCode($, s.sockets)) return 'Showing the Claude Review view in VS Code.'
    return (await runCode($, ['--reuse-window', '--command', 'claudeReview.focus'])) ? 'Showing the Claude Review view in VS Code.' : 'Could not reach VS Code; is the Claude Review extension installed?'
  }
  if ((verb === 'show' || verb === 'open') && target !== undefined && /^\d+$/.test(target)) {
    const n = Number(target)
    const page = extra !== undefined && /^\d+$/.test(extra) ? Number(extra) : 1
    if (verb === 'show') return diffText($, s, n, page)
    const f = summary.files[n - 1]
    if (!f) return `There is no file ${n}.`
    const first = (await hunksOf($, s, f))[0]
    if (await openInVsCode($, s.sockets, f.ledger, f.path, first?.newIdx ?? 0)) return `Opened \`${f.rel}\` in VS Code’s diff editor.\n\n${await diffText($, s, n, 1)}`
    return `No VS Code window has \`${f.rel}\` under review; here is the diff.\n\n${await diffText($, s, n, 1)}`
  }
  if (verb !== 'keep' && verb !== 'undo') return `Unknown: \`/changes ${args.trim()}\`.\n\n${HELP}`
  const keep = verb === 'keep'
  const done = keep ? 'Kept' : 'Undid'

  if (target === 'all') {
    const outcome = await filesAction($, s, summary.files.map(f => ({ path: f.path, ledger: f.ledger })), keep)
    return `${outcomeText(outcome, `${done} every change.`)}\n\n${listText(s.summary.current)}`
  }
  if ((target === 'turn' || target === 'session') && extra !== undefined && /^\d+$/.test(extra)) {
    const keys = target === 'turn' ? summary.turns.filter(t => t.n === Number(extra)).map(t => t.key) : sessionKeys(summary.sessions.find(x => x.n === Number(extra)))
    if (keys.length === 0) return `There is no ${target} ${extra}.`
    const outcome = await turnsAction($, s, keys, keep)
    return `${outcomeText(outcome, `${done} ${target} ${extra}.`)}\n\n${listText(s.summary.current)}`
  }
  const m = target?.match(/^(\d+)(?:\.(\d+))?$/)
  const f = m ? summary.files[Number(m[1]) - 1] : undefined
  if (!m || !f) return `There is no file ${target ?? ''}.\n\n${listText(summary)}`
  if (m[2] === undefined) {
    const outcome = await filesAction($, s, [{ path: f.path, ledger: f.ledger }], keep)
    return `${outcomeText(outcome, `${done} every change in \`${f.rel}\`.`)}\n\n${listText(s.summary.current)}`
  }
  const outcome = await hunkAction($, s, { path: f.path, ledger: f.ledger }, Number(m[2]) - 1, keep)
  const still = s.summary.current.files.findIndex(x => x.path === f.path) + 1
  const after = still > 0 ? await diffText($, s, still, 1) : listText(s.summary.current)
  return `${outcomeText(outcome, `${done} change ${target} in \`${f.rel}\`. Numbers below are current.`)}\n\n${after}`
}

// ---- handlers: buttons write here, never while drawing ----

async function select($: $, path: string | null): Promise<void> {
  await update($, selectedAtom, () => path)
  await update($, pageAtom, () => 0)
}

async function nextPage($: $, delta: number): Promise<void> {
  await update($, pageAtom, p => Math.max(0, p + delta))
}

async function act($: $, s: UiSession, run: () => Promise<ActionOutcome>): Promise<void> {
  const outcome = await run()
  if (outcome.kind === 'failed') $.ui.toast(`Could not: ${outcome.reason}`)
  if (outcome.kind === 'conflicts') $.ui.toast(`Not in ${outcome.conflicts.length} file(s): a later change overlaps it`)
  const sel = await read($, selectedAtom)
  if (sel !== null && !s.summary.current.files.some(f => f.path === sel)) await select($, null)
}

export async function openPane($: $): Promise<void> {
  await $.ui.open({ id: PANE, title: TITLE })
}

// ---- drawing ----

/** The review: the list (sessions, turns, files) with Keep/Undo per row, or one file's hunks once selected. */
export async function drawReview($: $, s: UiSession, e: RenderInput<'Pane' | 'CommandOutput'>, isInline: boolean): Promise<JSX.Element> {
  const { Box, Text, Button, Code } = $.ui.resolve(e)
  const summary = await read($, summaryAtom)
  const sel = await read($, selectedAtom)
  const page = await read($, pageAtom)

  if (summary.files.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No changes to review.</Text>
        {!isInline && (
          <Button key="close" role="dismiss" onPress={() => $.ui.close({ id: PANE })}>
            Close
          </Button>
        )}
      </Box>
    )
  }

  const file = sel === null ? undefined : summary.files.find(f => f.path === sel)
  if (file) {
    const hunks = await hunksOf($, s, file).catch(() => [])
    const pages = pagesOf(hunks)
    const at = Math.min(page, Math.max(0, pages.length - 1))
    const shown = pages[at] ?? []
    const target = { path: file.path, ledger: file.ledger }
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button key="back" onPress={() => select($, null)}>
            ← Files
          </Button>
          <Button key="file-keep" variant="primary" onPress={() => act($, s, () => filesAction($, s, [target], true))}>
            Keep file
          </Button>
          <Button key="file-undo" onPress={() => act($, s, () => filesAction($, s, [target], false))}>
            Undo file
          </Button>
        </Box>
        <Text bold>
          {file.rel}
          {noteOf(file)} <Text color="green">+{file.added}</Text> <Text color="red">−{file.removed}</Text>
        </Text>
        {hunks.length === 0 && <Text dimColor>The file exists only on one side; use Keep or Undo file.</Text>}
        {shown.map(({ index, source }) => (
          <Box key={`hunk-${index}`} flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Text dimColor>
                Change {index + 1}/{hunks.length}
              </Text>
              <Button key={`keep-${index}`} plain onPress={() => act($, s, () => hunkAction($, s, target, index, true))}>
                <Text color="green">✓ Keep</Text>
              </Button>
              <Button key={`undo-${index}`} plain onPress={() => act($, s, () => hunkAction($, s, target, index, false))}>
                <Text color="red">↶ Undo</Text>
              </Button>
            </Box>
            <Code source={source} format="diff" path={file.path} />
          </Box>
        ))}
        {pages.length > 1 && (
          <Box flexDirection="row" gap={1}>
            {at > 0 && (
              <Button key="prev-page" onPress={() => nextPage($, -1)}>
                ← Previous changes
              </Button>
            )}
            <Text dimColor>
              Page {at + 1}/{pages.length}
            </Text>
            {at + 1 < pages.length && (
              <Button key="next-page" onPress={() => nextPage($, 1)}>
                Next changes →
              </Button>
            )}
          </Box>
        )}
      </Box>
    )
  }

  const byPath = new Map(summary.files.map(f => [f.path, f]))
  const turnByKey = new Map(summary.turns.map(t => [t.key, t]))
  const all = summary.files.map(f => ({ path: f.path, ledger: f.ledger }))
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Text bold>
          {plural(summary.files.length, 'file')} <Text color="green">+{summary.added}</Text> <Text color="red">−{summary.removed}</Text>
        </Text>
        <Button key="all-keep" variant="primary" onPress={() => act($, s, () => filesAction($, s, all, true))}>
          Keep all
        </Button>
        <Button key="all-undo" onPress={() => act($, s, () => filesAction($, s, all, false))}>
          Undo all
        </Button>
      </Box>
      {summary.sessions.map(session => (
        <Box key={`session:${session.id}`} flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text bold>{session.title || `Session ${session.n}`}</Text>
            <Button key={`session-keep:${session.id}`} plain onPress={() => act($, s, () => turnsAction($, s, session.turnKeys, true))}>
              <Text color="green">✓ Keep</Text>
            </Button>
            <Button key={`session-undo:${session.id}`} plain onPress={() => act($, s, () => turnsAction($, s, session.turnKeys, false))}>
              <Text color="red">↶ Undo</Text>
            </Button>
          </Box>
          {session.turnKeys.map(key => {
            const t = turnByKey.get(key)
            if (!t) return null
            return (
              <Box key={`turn:${key}`} flexDirection="column">
                <Box flexDirection="row" gap={1}>
                  <Text>
                    #{t.n} <Text dimColor>{t.prompt || '(continuation)'}</Text>
                  </Text>
                  <Button key={`turn-keep:${key}`} plain onPress={() => act($, s, () => turnsAction($, s, [key], true))}>
                    <Text color="green">✓ Keep</Text>
                  </Button>
                  <Button key={`turn-undo:${key}`} plain onPress={() => act($, s, () => turnsAction($, s, [key], false))}>
                    <Text color="red">↶ Undo</Text>
                  </Button>
                </Box>
                {t.paths.map(p => {
                  const f = byPath.get(p)
                  if (!f) return null
                  const target = { path: f.path, ledger: f.ledger }
                  return (
                    <Box key={`file:${key}:${p}`} flexDirection="row" gap={1}>
                      <Button key={`open:${key}:${p}`} plain onPress={() => select($, f.path)}>
                        {f.rel} <Text color="green">+{f.added}</Text> <Text color="red">−{f.removed}</Text>
                      </Button>
                      <Button key={`keep:${key}:${p}`} plain onPress={() => act($, s, () => filesAction($, s, [target], true))}>
                        <Text color="green">✓</Text>
                      </Button>
                      <Button key={`undo:${key}:${p}`} plain onPress={() => act($, s, () => filesAction($, s, [target], false))}>
                        <Text color="red">↶</Text>
                      </Button>
                    </Box>
                  )
                })}
              </Box>
            )
          })}
        </Box>
      ))}
    </Box>
  )
}

/** One row above the prompt, `◆ N files +a −r`, reading nothing but the summary. */
export async function drawBand($: $, s: UiSession, e: RenderInput<'AbovePrompt'>): Promise<JSX.Element | undefined> {
  const summary = await read($, summaryAtom)
  if (summary.files.length === 0 || e.props.hasSurvey) return undefined
  const { Box, Text, Button } = $.ui.resolve(e)
  const all = summary.files.map(f => ({ path: f.path, ledger: f.ledger }))
  return (
    <Box flexDirection="row" gap={1}>
      <Text>
        ◆ {plural(summary.files.length, 'file')} <Text color="green">+{summary.added}</Text> <Text color="red">−{summary.removed}</Text>
      </Text>
      <Button key="band-review" onPress={() => openPane($)}>
        Review
      </Button>
      <Button key="band-keep" onPress={() => act($, s, () => filesAction($, s, all, true))}>
        Keep all
      </Button>
      <Button key="band-undo" onPress={() => act($, s, () => filesAction($, s, all, false))}>
        Undo all
      </Button>
    </Box>
  )
}
