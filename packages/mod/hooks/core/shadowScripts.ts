// Generated from packages/core/src/shadowScripts.ts by scripts/sync-core.mjs: edit the original, then run `npm run sync-core`.

// The shell scripts the mod runs against a ledger's shadow repo (§6.6), and
// parsers for what they print. Kept here, pure, so `node --test` can run the
// scripts against real temp repos. Each runs as
//   /bin/sh -c SCRIPT sh <args...>   with cwd = the work tree root.
// Every git command writes only to the shadow: GIT_DIR and GIT_INDEX_FILE point
// there; the user's repo is only ever read.

/**
 * Stages what `git add -A` would, minus files over MAX bytes, which it never
 * reads: they are untracked and excluded first (and remembered in
 * shadow-large.txt), so neither the hash nor the object store sees them.
 * Args: 1 index, 2 gitDir, 3 root, 4 seed index ('' for none), 5 maxBytes,
 * 6 maxCandidates (0: no cap). Prints `!toomany <n>` and stops past the cap;
 * otherwise leaves the oversized candidates' paths, NUL-separated, in "$L.big".
 */
const STAGE_BODY = String.raw`set -e
export GIT_INDEX_FILE="$1" GIT_DIR="$2" GIT_WORK_TREE="$3"
MAX="$5" CAP="$6" L="$2/cand.$$"
trap 'rm -f "$L" "$L.big"' EXIT
if [ ! -f "$1" ] && [ -n "$4" ] && [ -f "$4" ]; then cp "$4" "$1"; fi
# The only walk: lstat + untracked cache, honors .gitignore/info/exclude, reads no file content.
git ls-files -z -o -m -d --exclude-standard > "$L"
N=$(tr -cd '\000' < "$L" | wc -c | tr -d ' ')
if [ "$CAP" -gt 0 ] && [ "$N" -gt "$CAP" ]; then printf '!toomany %s\n' "$N"; exit 0; fi
: > "$L.big"
if [ "$N" -gt 0 ]; then
  # Candidates over MAX: "./" prefix so a name starting with "-" is not read as a find option.
  # printf prefixes in one pass; rebuilding "$@" per name is quadratic (33 s for 2,500 names).
  xargs -0 sh -c 'printf "./%s\000" "$@"' sh < "$L" \
    | xargs -0 sh -c 'find "$@" -prune -type f -size +"$0"c -print0 2>/dev/null || true' "$MAX" > "$L.big"
  if [ -s "$L.big" ]; then
    # -f: the shadow has no HEAD, so without it git refuses to unstage content that differs from both sides.
    xargs -0 git --literal-pathspecs rm -q -f --cached --ignore-unmatch -- < "$L.big" >/dev/null 2>&1 || true
    tr '\000' '\n' < "$L.big" | sed -e 's|^\./||' -e 's/[][*?\\]/\\&/g' -e 's/^[#!]/\\&/' -e 's/ $/\\ /' -e 's|^|/|' \
      | tee -a "$2/info/exclude" >> "$2/../shadow-large.txt"
  fi
  # Exit 1 is an ignored (oversized) pathspec reported and skipped, the rest staged.
  # A path that vanished since the walk is fatal (128): one plain add instead, large files excluded by now.
  RC=0
  git --literal-pathspecs add -A --ignore-errors --pathspec-from-file="$L" --pathspec-file-nul >/dev/null 2>&1 || RC=$?
  if [ "$RC" -gt 1 ]; then git add -A --ignore-errors -- . >/dev/null 2>&1 || true; fi
fi
`

/** STAGE alone, for tests. */
export const STAGE = STAGE_BODY

/** The before-snapshot, on the critical path. Args 1–6 as STAGE. Prints the tree, or `!toomany <n>`. */
export const SNAPSHOT = `${STAGE_BODY}git write-tree\n`

/** STAGE with no cap, then the tree. Args 1–5 as STAGE, 6 = 0. */
export const REBASELINE = SNAPSHOT

/**
 * The after-snapshot and its diff. Args 1–6 as STAGE, 7 the before tree.
 * Prints the tree on line 1, then NUL-separated diff-tree records, then
 * `!big` and the oversized candidates' paths, each NUL-terminated.
 */
export const SNAPSHOT_DIFF = `${STAGE_BODY}T=$(git write-tree); printf '%s\\n' "$T"
[ "$T" = "$7" ] || git diff-tree -r -z --raw --no-abbrev --no-renames --no-ext-diff "$7" "$T"
if [ -s "$L.big" ]; then printf '!big\\000'; tr '\\000' '\\n' < "$L.big" | sed -e 's|^\\./||' | tr '\\n' '\\000'; fi
`

/** Object sizes. Arg 1 gitDir; the shas on stdin, one per line. */
export const SIZES = String.raw`GIT_DIR="$1" exec git cat-file --batch-check='%(objectname) %(objecttype) %(objectsize)'`

/** Object contents as base64, so binary bytes cross a text pipe. Arg 1 gitDir; shas on stdin. */
export const CONTENTS = String.raw`set -e
GIT_DIR="$1" git cat-file --batch | base64`

/** Creates the shadow repo if missing and (re)applies its config. Arg 1 gitDir. */
export const INIT = String.raw`set -e
[ -f "$1/HEAD" ] || git init --bare -q "$1"
export GIT_DIR="$1"
git config gc.auto 0
git config core.bare false
git config core.autocrlf false
git config core.untrackedCache true
git config index.version 4
git config core.quotePath false
git config advice.addEmbeddedRepo false
git config advice.addIgnoredFile false
git --version`

/**
 * Rebuilds the shadow's info/exclude: the user's repo's own info/exclude plus
 * every oversized path seen. Args 1 gitDir, 2 root.
 */
export const EXCLUDE = String.raw`set -e
OWN=$(git -C "$2" rev-parse --git-path info/exclude 2>/dev/null || true)
case "$OWN" in /*) ;; ?*) OWN="$2/$OWN" ;; esac
{ [ -n "$OWN" ] && [ -f "$OWN" ] && cat "$OWN"; [ -f "$1/../shadow-large.txt" ] && sort -u "$1/../shadow-large.txt"; true; } > "$1/info/exclude.tmp"
mv "$1/info/exclude.tmp" "$1/info/exclude"`

/** The newest index to seed a new session's from. Arg 1 gitDir. Prints a path or nothing. */
export const NEWEST_INDEX = String.raw`ls -t "$1"/index.* 2>/dev/null | head -n 1`

/**
 * Daily GC. Args 1 gitDir, 2 max KiB. Removes indexes older than 7 days; when
 * the store is over the limit and no index changed in 10 minutes, deletes the
 * whole shadow (rebuilt lazily). Prints `removed` or `kept <KiB>`.
 */
export const GC = String.raw`set -e
find "$1" -maxdepth 1 -name 'index.*' -mtime +7 -exec rm -f {} +
KIB=$(GIT_DIR="$1" git count-objects -v | awk '/^size(-pack)?:/ { s += $2 } END { print s + 0 }')
if [ "$KIB" -gt "$2" ] && [ -z "$(find "$1" -maxdepth 1 -name 'index.*' -mmin -10)" ]; then rm -rf "$1"; echo removed; else echo "kept $KIB"; fi`

// ---- parsers ----

export type SnapshotChange = {
  readonly path: string
  readonly status: 'A' | 'M' | 'D'
  /** null for an added file */
  readonly oldSha: string | null
  /** null for a deleted file */
  readonly newSha: string | null
}

export type SnapshotResult =
  | { readonly kind: 'tree'; readonly tree: string }
  | { readonly kind: 'tooMany'; readonly count: number }
  | { readonly kind: 'failed'; readonly reason: string }

export type SnapshotDiff =
  | { readonly kind: 'diff'; readonly tree: string; readonly changes: readonly SnapshotChange[]; readonly big: readonly string[]; readonly skipped: number }
  | { readonly kind: 'tooMany'; readonly count: number }
  | { readonly kind: 'failed'; readonly reason: string }

const SHA = /^[0-9a-f]{40}$/
const ZERO_SHA = '0000000000000000000000000000000000000000'
const TOO_MANY = /^!toomany (\d+)/
/** Gitlinks (nested repos) and symlinks are not file contents to review. */
const SKIPPED_MODES: ReadonlySet<string> = new Set(['160000', '120000'])

export const parseSnapshot = (stdout: string): SnapshotResult => {
  const line = stdout.trim()
  const many = TOO_MANY.exec(line)
  if (many) return { kind: 'tooMany', count: Number(many[1]) }
  return SHA.test(line) ? { kind: 'tree', tree: line } : { kind: 'failed', reason: `unexpected output: ${line.slice(0, 200)}` }
}

export const parseSnapshotDiff = (stdout: string): SnapshotDiff => {
  const nl = stdout.indexOf('\n')
  const first = nl < 0 ? stdout : stdout.slice(0, nl)
  const many = TOO_MANY.exec(first)
  if (many) return { kind: 'tooMany', count: Number(many[1]) }
  if (!SHA.test(first)) return { kind: 'failed', reason: `unexpected output: ${first.slice(0, 200)}` }
  const tokens = nl < 0 ? [] : stdout.slice(nl + 1).split('\0')
  const changes: SnapshotChange[] = []
  const big: string[] = []
  let skipped = 0
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i] ?? ''
    if (token === '!big') {
      for (i++; i < tokens.length; i++) if ((tokens[i] ?? '') !== '') big.push(tokens[i] ?? '')
      break
    }
    if (token === '') {
      i++
      continue
    }
    const path = tokens[i + 1]
    const fields = token.startsWith(':') ? token.slice(1).split(' ') : []
    const [oldMode, newMode, oldSha, newSha, status] = fields
    if (path === undefined || fields.length !== 5 || oldMode === undefined || newMode === undefined || oldSha === undefined || newSha === undefined) {
      return { kind: 'failed', reason: `bad diff-tree record: ${token.slice(0, 200)}` }
    }
    i += 2
    if (SKIPPED_MODES.has(oldMode) || SKIPPED_MODES.has(newMode) || (status !== 'A' && status !== 'M' && status !== 'D')) {
      skipped++
      continue
    }
    changes.push({
      path,
      status,
      oldSha: status === 'A' || oldSha === ZERO_SHA ? null : oldSha,
      newSha: status === 'D' || newSha === ZERO_SHA ? null : newSha,
    })
  }
  return { kind: 'diff', tree: first, changes, big, skipped }
}

export type ObjectInfo = { readonly kind: 'blob'; readonly size: number } | { readonly kind: 'other'; readonly type: string } | { readonly kind: 'missing' }

/** `git cat-file --batch-check` output, by sha. */
export const parseBatchCheck = (stdout: string): Map<string, ObjectInfo> => {
  const out = new Map<string, ObjectInfo>()
  for (const line of stdout.split('\n')) {
    const [sha, type, size] = line.trim().split(' ')
    if (sha === undefined || sha === '') continue
    if (type === 'missing') out.set(sha, { kind: 'missing' })
    else if (type === 'blob' && size !== undefined) out.set(sha, { kind: 'blob', size: Number(size) })
    else if (type !== undefined) out.set(sha, { kind: 'other', type })
  }
  return out
}

export type ContentsResult =
  | { readonly kind: 'ok'; readonly texts: ReadonlyMap<string, string>; readonly binary: ReadonlySet<string>; readonly missing: ReadonlySet<string> }
  | { readonly kind: 'failed'; readonly reason: string }

/** Strict UTF-8: undefined for bytes that are not valid text. */
export type Utf8Decoder = (bytes: Uint8Array) => string | undefined

const NEWLINE = 10
const SPACE = 32

/**
 * `git cat-file --batch` output (already base64-decoded): `<sha> blob <size>\n`,
 * the bytes, `\n` per object; `<sha> missing\n` for an unknown sha. A blob that
 * is not valid UTF-8 or holds a NUL is binary.
 */
export const parseContents = (bytes: Uint8Array, decode: Utf8Decoder): ContentsResult => {
  const texts = new Map<string, string>()
  const binary = new Set<string>()
  const missing = new Set<string>()
  let at = 0
  while (at < bytes.length) {
    const nl = bytes.indexOf(NEWLINE, at)
    if (nl < 0) return { kind: 'failed', reason: `truncated header at byte ${at}` }
    let header = ''
    for (let i = at; i < nl; i++) header += String.fromCharCode(bytes[i] ?? SPACE)
    const [sha, type, sizeText] = header.split(' ')
    if (sha === undefined || !SHA.test(sha)) return { kind: 'failed', reason: `bad header: ${header.slice(0, 100)}` }
    if (type === 'missing') {
      missing.add(sha)
      at = nl + 1
      continue
    }
    const size = Number(sizeText)
    if (type !== 'blob' || !Number.isSafeInteger(size) || size < 0) return { kind: 'failed', reason: `bad header: ${header.slice(0, 100)}` }
    const start = nl + 1
    const end = start + size
    if (end + 1 > bytes.length || bytes[end] !== NEWLINE) return { kind: 'failed', reason: `truncated object ${sha}` }
    const body = bytes.subarray(start, end)
    const text = body.includes(0) ? undefined : decode(body)
    if (text === undefined) binary.add(sha)
    else texts.set(sha, text)
    at = end + 1
  }
  return { kind: 'ok', texts, binary, missing }
}

/** Groups shas so each group's raw bytes stay ≤ `limit`, so its base64 stays under 4 MiB of stdout. */
export const chunkBySize = (sizes: readonly { readonly sha: string; readonly size: number }[], limit: number): string[][] => {
  const chunks: string[][] = []
  let current: string[] = []
  let total = 0
  for (const { sha, size } of sizes) {
    // The header and trailing newline cross too.
    const cost = size + 64
    if (current.length > 0 && total + cost > limit) {
      chunks.push(current)
      current = []
      total = 0
    }
    current.push(sha)
    total += cost
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

export const CONTENTS_CHUNK_BYTES = 2_900_000
