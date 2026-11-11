// Whether a Bash command certainly changes nothing on disk, so the mod can skip
// the shadow snapshot around it. Conservative: anything the lexer or the rules
// are unsure of is "not read-only", which costs a snapshot, never a missed edit.

type Word = { readonly text: string }
type Lexed = { readonly ok: true; readonly commands: readonly (readonly Word[])[] } | { readonly ok: false }

const SAFE_DUPS: ReadonlySet<string> = new Set(['2>&1', '1>&2', '>&2'])
const DEV_NULL = '/dev/null'
const SAFE_NULL_FDS: ReadonlySet<string> = new Set(['', '1', '2', '&'])

const isBlank = (c: string): boolean => c === ' ' || c === '\t' || c === '\r'
const isDigits = (s: string): boolean => /^\d+$/.test(s)

/** Splits a command line into simple commands of words, dropping the redirects it accepts. */
const lex = (command: string): Lexed => {
  const commands: Word[][] = []
  let words: Word[] = []
  let word = ''
  let isInWord = false
  let wasQuoted = false
  let i = 0

  const endWord = (): void => {
    if (isInWord) words.push({ text: word })
    word = ''
    isInWord = false
    wasQuoted = false
  }
  const endCommand = (): void => {
    endWord()
    if (words.length > 0) commands.push(words)
    words = []
  }
  /** The next unquoted word after optional blanks, for a redirect target. */
  const readTarget = (): string | undefined => {
    while (i < command.length && isBlank(command[i] ?? '')) i++
    const start = i
    while (i < command.length && !/[\s|&;<>()'"`$\\]/.test(command[i] ?? '')) i++
    return i > start ? command.slice(start, i) : undefined
  }

  while (i < command.length) {
    const c = command[i] ?? ''
    const next = command[i + 1] ?? ''
    if (isBlank(c)) {
      endWord()
      i++
    } else if (c === '\n' || c === ';') {
      endCommand()
      i++
    } else if (c === '#' && !isInWord) {
      while (i < command.length && command[i] !== '\n') i++
    } else if (c === "'") {
      const close = command.indexOf("'", i + 1)
      if (close < 0) return { ok: false }
      word += command.slice(i + 1, close)
      isInWord = true
      wasQuoted = true
      i = close + 1
    } else if (c === '"') {
      i++
      let isClosed = false
      while (i < command.length) {
        const d = command[i] ?? ''
        if (d === '"') {
          isClosed = true
          i++
          break
        }
        // Substitutions still run inside double quotes.
        if (d === '`' || (d === '$' && command[i + 1] === '(')) return { ok: false }
        if (d === '\\' && i + 1 < command.length) {
          word += command[i + 1] ?? ''
          i += 2
          continue
        }
        word += d
        i++
      }
      if (!isClosed) return { ok: false }
      isInWord = true
      wasQuoted = true
    } else if (c === '\\') {
      if (next === '\n') {
        i += 2
        continue
      }
      word += next
      isInWord = true
      i += 2
    } else if (c === '`' || c === '(' || c === ')') {
      return { ok: false }
    } else if (c === '$' && next === '(') {
      return { ok: false }
    } else if (c === '|') {
      endCommand()
      i += next === '|' || next === '&' ? 2 : 1
    } else if (c === '&') {
      if (next === '&') {
        endCommand()
        i += 2
      } else if (next === '>') {
        endWord()
        i += 2
        if (command[i] === '>' || readTarget() !== DEV_NULL) return { ok: false }
      } else {
        return { ok: false }
      }
    } else if (c === '>') {
      const fd = isInWord && !wasQuoted && isDigits(word) ? word : ''
      if (fd !== '') {
        word = ''
        isInWord = false
      } else {
        endWord()
      }
      if (next === '>' || next === '|' || next === '(') return { ok: false }
      if (next === '&') {
        i += 2
        const target = readTarget()
        if (target === undefined || !SAFE_DUPS.has(`${fd}>&${target}`)) return { ok: false }
      } else {
        i++
        if (!SAFE_NULL_FDS.has(fd) || readTarget() !== DEV_NULL) return { ok: false }
      }
    } else if (c === '<') {
      if (next === '<' || next === '(' || next === '>' || next === '&') return { ok: false }
      endWord()
      i++
      if (readTarget() === undefined) return { ok: false }
    } else {
      word += c
      isInWord = true
      i++
    }
  }
  endCommand()
  return { ok: true, commands }
}

const ALLOW: ReadonlySet<string> = new Set(
  (
    'cd pushd popd pwd true false test [ echo printf ls cat head tail wc grep egrep fgrep rg ag fd stat du df ' +
    'which whereis type printenv date uname whoami id ps lsof uptime basename dirname realpath readlink jq cut tr ' +
    'nl column diff cmp comm md5 shasum sha256sum sleep seq expr less more man'
  ).split(' '),
)

const DENY_PROGRAMS: ReadonlySet<string> = new Set(['xargs', 'sudo', 'exec', 'eval', 'source', '.'])
const FIND_DENY: ReadonlySet<string> = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls'])
const GIT_READ: ReadonlySet<string> = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'blame', 'grep', 'describe', 'shortlog', 'cat-file', 'merge-base', 'rev-list', 'show-ref',
])
const GIT_LIST_FLAGS: ReadonlySet<string> = new Set(['-a', '-r', '-v', '-l', '--list', '--show-current'])
const GIT_CONFIG_READ: ReadonlySet<string> = new Set(['--get', '--get-all', '--get-regexp', '--list', '-l'])
const GIT_CONFIG_WRITE = /^(--unset|--add|--replace-all|--rename-section|--remove-section|--edit|-e$)/
/** Where a program path may live; a relative one could be the repo's own script. */
const SYSTEM_BIN = /^\/(usr\/(local\/)?)?s?bin\/|^\/opt\/homebrew\/bin\//
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

const isOption = (arg: string): boolean => arg.startsWith('-') && arg !== '-'
const shortFlagsHave = (arg: string, flag: string): boolean => arg.startsWith('-') && !arg.startsWith('--') && arg.includes(flag)

const programOf = (word: string): string | undefined => {
  if (!word.includes('/')) return word
  if (!SYSTEM_BIN.test(word)) return undefined
  return word.slice(word.lastIndexOf('/') + 1)
}

const isReadOnlyGit = (args: readonly string[]): boolean => {
  if (args.some(a => a.startsWith('--output'))) return false
  let i = 0
  while (i < args.length) {
    const a = args[i] ?? ''
    if (a === '--no-pager' || a === '-P' || a === '--no-optional-locks') i++
    else if (a === '-C') i += 2
    else break
  }
  const sub = args[i]
  const rest = args.slice(i + 1)
  if (sub === undefined) return false
  if (GIT_READ.has(sub)) return !(sub === 'grep' && rest.some(a => a === '-O' || a.startsWith('--open-files-in-pager')))
  switch (sub) {
    case 'branch':
    case 'tag':
    case 'remote':
      return rest.every(a => GIT_LIST_FLAGS.has(a))
    case 'stash':
    case 'worktree':
      return rest.length === 1 && rest[0] === 'list'
    case 'config':
      return rest.some(a => GIT_CONFIG_READ.has(a)) && !rest.some(a => GIT_CONFIG_WRITE.test(a))
    default:
      return false
  }
}

const isReadOnlySimple = (words: readonly Word[]): boolean => {
  let i = 0
  while (i < words.length && ASSIGNMENT.test(words[i]?.text ?? '')) i++
  const first = words[i]
  if (first === undefined) return true
  const program = programOf(first.text)
  if (program === undefined || DENY_PROGRAMS.has(program)) return false
  const args = words.slice(i + 1).map(w => w.text)

  switch (program) {
    case 'find':
      return !args.some(a => FIND_DENY.has(a))
    case 'sort':
      return !args.some(a => a.startsWith('--output') || shortFlagsHave(a, 'o'))
    case 'uniq':
      return args.filter(a => !isOption(a)).length <= 1
    case 'yq':
      return !args.some(a => a === '--inplace' || shortFlagsHave(a, 'i'))
    case 'git':
      return isReadOnlyGit(args)
    case 'command':
      return args[0] === '-v'
    case 'env':
      return args.every(a => ASSIGNMENT.test(a))
    case 'tree':
      return !args.some(a => a === '-o' || a.startsWith('-o'))
    case 'file':
      return !args.some(a => shortFlagsHave(a, 'C'))
    case 'hostname':
      return args.every(isOption)
    default:
      return ALLOW.has(program)
  }
}

export const isReadOnlyCommand = (command: string): boolean => {
  const lexed = lex(command)
  if (!lexed.ok) return false
  return lexed.commands.every(isReadOnlySimple)
}
