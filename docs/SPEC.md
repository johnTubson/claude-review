# Claude Review 1.0 — clean-slate, performance-first implementation spec

> For: an implementing model working phase by phase (§9). Read §0–§4 fully before writing code. Every MUST is testable; §1.3 budgets are acceptance criteria. This file is the spec of record; the 0.2 code at `~/Desktop/claude-review-vscode` is reference only.

## 0. Context

**What exists (0.2, read-only reference, never modify):** `~/Desktop/claude-review-vscode`

- VS Code extension `local.claude-review` 0.2.0 (`src/`), Claude Code mod `session-review` (`claude-plugin/hooks/register.tsx`), pure shared `core/` copied into the mod by `scripts/sync-core.mjs`.
- Ledger at `~/.claude/claude-review/ledgers/<sha256(root)[:16]>/` (one JSON file per event, sha256 blobs, snapshot). The mod pings VS Code windows over Unix sockets.

**Why it is slow (found on this machine, 2026-11-10):**

1. User settings `claudeReview.openFilesAs: "file"` + `claudeReview.inlineRemovedLines: true` → one webview inset per removed block (≤100 per editor), created on open, recreated on scroll/relayout (`src/surfaces/insets.ts`). Main cause of slow editor render.
2. Each typing burst (120 ms) in a reviewed file → full re-diff (on the shared extension-host thread for files < 64K chars, `diffService.ts` `INLINE_LIMIT`) → one coarse `Delta` → full tree refresh, CodeLens re-request for every visible doc, decoration repaint, and `claude-base:` `onDidChange`, so VS Code re-fetches the whole baseline over IPC, replaces the model, re-tokenizes and re-diffs although the baseline did not change (`baseline.ts`).
3. The diff allocates an object per line of the whole file (`editItems`) and compares strings in Myers' inner loop.
4. `diffEditor.maxComputationTime: 0` (unbounded) in user settings.
5. Activation awaits every fold and every diff, and re-parses up to 52 legacy `review.json` files (425 MB folder) on every window load.
6. Mod: `refresh()` runs inside every Edit/Write/Bash tool call: per tracked file, sequentially, 2–3 RPCs to recompute paths, a blob read, a disk read and a full diff (40 files ≈ 160 sequential RPCs + 40 diffs per tool call).
7. Mod Bash: `git rev-parse` + two full `git add -A`/`write-tree` in a per-session shadow repo on every Bash call, read-only ones included (~0.2–0.6 s each; each new session re-hashes the whole tree; 300 MB+ of shadow repos on disk), then per-file `git cat-file` and disk reads sequentially.
8. Mod: paths recomputed per call (`$.env.get` + `$.session.cwd` + sha256); sockets dir listed on every write.
9. Storage and large inputs:
   - `~/.claude/claude-review` is 419 MB, of which ≈340 MB is per-session shadow repos.
   - The 0.1 store `~/.claude/session-review` is 425 MB in 37,829 files; one 17 MB object was hashed again in each session's shadow.
   - The 0.2 extension lists and parses that store on every activation.
   - Nothing caps what `git add -A` hashes: the 2 MiB check ran only after hashing, so any large non-ignored file in a work tree was hashed into every session's shadow.
   - Ledger roots that are not git repos are large: `~/Desktop/neoclan` is 17 GB, `~/Desktop/John/resume` 1.5 GB, `~/Desktop/arloui` 643 MB.

Environment: VS Code 1.142.0 (commit 6d62b1d5dace93a33b3a6d3eca1317bd5e15bcb1), git 2.33.0 (no built-in fsmonitor), macOS, `~/.vscode/argv.json` already has `"enable-proposed-api": ["local.claude-review"]`.

**Decisions (user, 2026-11-10):** native inline diff, insets deleted · one combined review per workspace, grouped by session · Bash tracking optimized and always on · clean-slate rewrite: new repo, ledger format v2, one-time migration.

### Glossary

- **baseline**: a file's text before the oldest change nobody has reviewed.
- **live**: the file's current text (open buffer, else disk).
- **entry**: one turn's change to one file (before/after refs).
- **turn**: one prompt's run. **session**: one Claude Code session.
- **keep**: move the baseline. **undo**: change the live text. **resolve**: mark a turn's entry as dealt with. **settle**: nothing left in the file, so its record is deleted.
- **batch**: one ledger file holding events. **ledger**: one workspace root's store. **shadow**: the private git repo used to snapshot the work tree around Bash.
- **layout signature**: a string of hunk positions; when it is unchanged, nothing needs repainting.

## 1. Goals, non-goals, budgets

### 1.1 Goals

- G1: Claude's tool calls are not slowed perceptibly.
- G2: Editors of reviewed files render, scroll and type at native speed, with no webviews.
- G3: A Cursor-like review on VS Code-native surfaces:
  - inline diff with removed lines
  - keep/undo per change, file, turn, session and all
  - file navigation and review-all
  - a sidebar grouped by files, folders, turns or sessions
  - a status bar entry
  - the terminal `/changes` command with a pane and a band above the prompt
- G4: Correct under concurrency: several Claude sessions, several VS Code windows, mod and extension writing at once, crashes mid-write.
- G5: Bounded storage through compaction and GC.

### 1.2 Non-goals

- Windows, and Remote/SSH/WSL/containers (the design relies on POSIX `sh`, `base64`, `cp` and `rm`).
- Binary files.
- Files over 4 MiB for Edit/Write (the `$.fs.read` cap), and Bash captures over 2 MiB.
- Changes a backgrounded Bash command makes after it returns.
- Attributing individual hunks to turns.
- Separate baselines per session.
- Any webview.

### 1.3 Budgets (acceptance criteria; how each is measured is in §10)

| id | budget |
| --- | --- |
| M1 | An Edit/Write/NotebookEdit hook awaits exactly 2 `$` calls on the tool's critical path: a pre-read and a post-read with `$.fs.read`. A third, `$.fs.stat`, is allowed only after a read rejects, to tell a missing file from one over 4 MiB. Scheduling the flush with `$.clock.after` returns a Timer synchronously and is never awaited. The hook does no hashing, diffing, blob or event writes, ledger reads or path computation before it returns. |
| M2 | A Bash command classified read-only (§5.2) makes 0 `$.process.run` and 0 `$.fs` calls. |
| M3 | A mutating Bash command makes exactly 1 spawn before the command runs. That spawn walks the tree once with lstat (`git ls-files`), reading no content, and hashes only changed files ≤ 2 MiB. A file over 2 MiB is never read or hashed. Over 2000 changed paths, the command runs unrecorded and a rebaseline follows in the background. After the command, in the background behind the barrier (§6.6): 1 spawn for stage+diff-tree, 1 for sizes, and ⌈bytes/2.9 MB⌉ for contents. A new session's first Bash call never re-hashes the tree, because its index is seeded. |
| M4 | The mod's summary is never recomputed inside `tool.call`. It is debounced 300 ms, diffs only files whose (base, lastAfter) refs changed, and reads nothing from disk. |
| M5 | One shadow repo per ledger, with one index file per session. Indexes older than 7 days are GC'd; a shadow over 512 MB is deleted and rebuilt lazily. The shadow never stores a file over 2 MiB, and large paths persist in `shadow-large.txt` across rebuilds. |
| E1 | `activate()` returns in ≤ 30 ms without awaiting any file I/O. Folds and diffs run afterwards, visible editors first. |
| E2 | Typing in a reviewed file causes 0 `claude-base:` content requests, 0 base change events, 0 full tree refreshes and 0 diffs on the extension-host thread. At most 1 diff per 150 ms pause (600 ms max-wait). Handler time per keystroke ≤ 0.5 ms. |
| E3 | After Claude edits, the tree and decorations update ≤ 150 ms after the batch file lands via the ping, and ≤ 600 ms via the watcher alone. |
| E4 | Opening a review diff takes ≤ 5 ms of extension work, because the base text is already cached. |
| E5 | The extension creates 0 webviews (a test greps `src/` for `createWebview`). |
| E6 | The blob cache stays ≤ 64 MB, the worker's base cache ≤ 32 files, and no live text is kept between diffs. |
| E7 | With 200 files under review, the tree shows immediately with pending counts, and every count is computed within 3 s in the background while E2 still holds. |

### 1.4 Large inputs (hard limits; each is a setting or userConfig with this default)

| input | limit | over the limit |
| --- | --- | --- |
| file edited by Edit/Write/NotebookEdit | 4 MiB (the `$.fs.read` cap) | Not recorded; logged once per path. |
| file changed by Bash | 2 MiB (`maxFileBytes`) | Never read or hashed: it is untracked in the shadow index and excluded before `git add` (§6.6). Not recorded. |
| changed paths in one snapshot | 2000 (`maxSnapshotCandidates`) | The command runs unrecorded, and a background rebaseline follows (§6.6). |
| files recorded per Bash command | 200 (`maxBashFiles`) | The rest are dropped and logged. |
| live text the extension diffs | 4 MiB (`maxDiffBytes`) | State `tooLarge`. Size is checked first (`fs.stat`, or `offsetAt` for open docs), so the text is never read and gets no counts or decorations. The native diff still opens, within VS Code's own `diffEditor.maxFileSize`. |
| diff work | (n+m)·D ≤ 5·10⁷ | `maxEdits` is lowered; past it, the middle becomes one replace hunk (§5.1). |
| diff drawn in the pane or `/changes` text | 20,000 chars per page | Paginated. |
| blob cache | 64 MB (extension), 16 MB (mod) | LRU eviction. |
| shadow repo | 512 MB | Deleted and rebuilt lazily; `shadow-large.txt` is kept. |
| ledger blobs | 1 GB per ledger | One-time warning suggesting Keep/Undo. GC already removes unreferenced blobs. |
| legacy stores (0.1 is 425 MB, 0.2 is 419 MB) | never read at startup | Migration reads only the referenced blobs (each ≤ 4 MiB) of pending records for open folders. Cleanup walks metadata only. |

**Invariant:** no component walks a directory tree except these two:

- the shadow snapshot, which is git's own lstat walk of a git work tree, honors `.gitignore` and reads no content
- `cleanUpStorage`, which reads metadata only, in the background, and can be cancelled

Non-git roots are never walked:

- Bash tracking requires a git session root.
- Routing calls `git rev-parse` per directory.
- Discovery reads only `meta.json`.
- Watchers are per tracked file.
- Migration walks only upward, from a file to its ancestors.

## 2. Architecture

```text
Claude Code process                         ~/.claude/claude-review/v2/ledgers/<id>/          VS Code window (extension host)
┌─ mod (isolated worker; $ = RPC) ─────┐    meta.json  events/  snapshots/                ┌─────────────────────────────────────────┐
│ tool.call: pre/post read → capture   │    blobs/xx/  shadow.git/                         │ Bridge (unix-socket HTTP) ─┐             │
│ Bash: classifier → shadow snapshot   │ ──batch files──────────────────────────────────►  │ LedgerStore×N ─fold─► ReviewModel ─signals─► Surfaces
│ flush (timer): sha256→blobs→batch    │ ──ping (fire & forget)──────────────────────────► │   compactor(lock)        │  ▲            │  tree, decorations, hover,
│ summary (debounced) → $.state → UI   │ ◄──poll 5 s (only while non-empty)────────────── │                          ▼  │            │  base/blob docs, quick diff,
│ /changes actions → disk + batch      │                                                   │ DiffScheduler ⇄ worker_threads diff        │  inline diff, multi-diff, status
└──────────────────────────────────────┘                                                   │ ActionQueue → WorkspaceEdit(+save) + batch │
                                                                                            └─────────────────────────────────────────┘
```

Principles (MUST):

- **P1:** The ledger is the only shared state. Both sides fold it with the same core code.
- **P2:** Hot paths only capture. Hashing, persistence, folding and diffing happen later, serialized and off the critical path.
- **P3:** Nothing is recomputed unless the version of one of its inputs changed (base ref, live version).
- **P4:** Signals are granular: membership, counts, layout, base and turns. Each surface subscribes only to what it draws.
- **P5:** Every extension diff runs in a worker. The extension-host thread only schedules work and applies results.
- **P6:** Only native surfaces are used: diff editors, decorations, hover, tree, SCM quick diff, menus and the status bar.
- **P7:** Every write is crash-safe for readers. Writers only create new files (the extension writes a tmp file and renames it), and readers tolerate partial or vanished files.
- **P8:** Each absolute path belongs to exactly one ledger (routing, §4.9).

Flows:

- **F1, Claude edits:**
  1. The hook pre-reads the file, calls `next(e)`, post-reads it, captures the change and returns.
  2. The timer flush routes the path to a ledger, hashes the texts, writes new blobs and one batch, and pings the extension.
  3. The extension's ping handler scans and folds the ledger.
  4. The model asks the scheduler for a diff; the worker computes it; the model applies it and emits signals; the surfaces repaint.
- **F2, the user types:** `onDidChangeTextDocument` checks that the file is tracked, the scheduler debounces with reason `typing`, the worker diffs, and the model applies the result. A layout signal fires only when hunk positions moved.
- **F3, keep or undo in VS Code:** the ActionQueue settles the file's diff, computes the result, applies a WorkspaceEdit and saves and/or appends a batch, then folds it in memory and fires signals. The mod sees the change at its next load or poll.
- **F4, keep or undo in the terminal:** the mod reads the disk text and blobs, computes the result, writes the file, appends a batch and pings.

## 3. Repository (new): `~/Desktop/claude-review`

```text
claude-review/
  package.json                  npm workspaces; scripts: build typecheck test bench verify package install-local sync-core
  tsconfig.base.json            strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes, noImplicitOverride
  .claude-plugin/marketplace.json  { "name": "claude-review", "owner": <copy from 0.2 .claude-plugin/marketplace.json>, "plugins": [{ "name": "session-review", "source": "./packages/mod" }] }
  docs/SPEC.md
  scripts/sync-core.mjs         packages/core/src/*.ts → packages/mod/hooks/core/ with a "generated" header; --check fails on drift (port 0.2 script)
  packages/core/                pure TS, zero deps, no Node/DOM APIs (runs in the mod worker and in Node)
    src/ ids events ledger lines diff patch model view bashReadOnly compact legacy02 counts   (.ts)
    test/*.test.ts   bench/*.bench.ts
  packages/mod/                 Claude Code plugin "session-review" 1.0.0
    .claude-plugin/plugin.json  { "name": "session-review", "version": "1.0.0", "description": "...", "types": "./types/index.d.ts", "userConfig": {...§6.9} }
    hooks/hooks.json            { "modules": ["./register.tsx"] }
    hooks/*.ts(x)  hooks/core/ (generated)  types/index.d.ts  hooks/*.test.tsx
  packages/vscode/              extension local.claude-review 1.0.0 (same id: keeps the argv.json proposed-API opt-in)
    package.json  esbuild.mjs  src/**  test/**  media/removed.svg  media/review.svg
```

- **Dependencies:** pin exact versions and add nothing else: typescript 5.6.3, esbuild 0.24.0, @types/node 20.16.10, @types/vscode 1.100.0, @vscode/test-electron 2.4.1, @vscode/vsce 3.2.1, and zod 3.25.76 (extension only).
- **Conventions:** follow `~/.claude/CLAUDE.md`:
  - no `any`, no unproven `as`, no `!`
  - discriminated unions checked exhaustively with `never`
  - `readonly` at module boundaries and explicit return types on exports
  - typed errors and no empty `catch`
  - comments only for why or invariants
- **Ledger JSON is a trust boundary.** Core parses it with hand-written guards that return `Parsed<T> = { ok: true; value: T } | { ok: false; reason: string }`, because the mod has no npm and so no zod. The extension reuses the same guards. Use zod everywhere else at extension boundaries: settings, command args, worker messages and bridge bodies.
- **Mod API reference:** load the `plugin-authoring` skill. Its types file, `claude-code.d.ts`, is the authority; grep it for `'tool.call'`, `ToolCallResult`, `Pane: {`, `AbovePrompt: {`, `clock: {`, `process: {` and `fs: {`.

## 4. Ledger format v2 (the contract between mod and extension)

### 4.1 Layout

```text
~/.claude/claude-review/v2/                  (extension: claudeReview.dataDir; mod: userConfig dataDir; both default here)
  ledgers/<sha256(root) hex [0:16]>/
    meta.json                     { "v": 2, "root": "<abs>", "createdAt": <ms> }
    events/<BatchId>.json         one batch per write, never modified
    snapshots/<gen, 8 digits>-<BatchId>.json
    blobs/<ref[0:2]>/<ref>        UTF-8 text; ref = sha256 hex of its UTF-8 bytes
    shadow.git/                   bare repo for Bash; index.<sessionId> files; info/exclude
    shadow-large.txt              anchored, glob-escaped exclude patterns of files over maxFileBytes (survives shadow rebuilds)
    compact.lock/                 directory lock with owner.json inside
    gc.json                       { "blobsAt": <ms>, "shadowAt": <ms> }
  sockets/<pid base36><4 hex>.sock     dir mode 0700; path ≤ 103 bytes
```

### 4.2 Ids and branded types

- **BatchId:** `${ms.toString(36).padStart(10,'0')}-${writer}-${counter.toString(36).padStart(6,'0')}-${nonce4}`.
  - The writer is `m` plus the first 6 alphanumerics of the session id (the mod), `x` plus the pid in base 36 (the extension), or `xmig` (migration). It is at most 12 characters of `[a-z0-9]`.
  - Lexicographic order equals time order.
  - File-name regex: `^[0-9a-z]{10}-[0-9a-z]{1,12}-[0-9a-z]{6}-[0-9a-z]{4}\.json$`.
  - Port from 0.2 `core/ids.ts` (`eventId`, `idOfFileName`).
- **Branded strings:** `Ref` (64 hex), `BatchId`, `SessionId`, `TurnKey` (`${session}:${turn}`). Brand them only through guard or constructor functions.

### 4.3 Batch file

```json
{ "v": 2, "id": "<BatchId>", "at": 1794334827391, "writer": "m2503fa", "events": [ /* LedgerEvent */ ] }
```

A file that fails to parse or fails the guard is "not yet whole": retry it. If it is still bad 5 s after it was first seen (extension) or 5 s after its `mtimeMs` (mod), skip it and log once. Fold only the contiguous whole prefix in id order, so that a later batch is never folded ahead of an earlier one.

### 4.4 Events and fold

```ts
type EntryTool = 'Edit' | 'Write' | 'NotebookEdit' | 'Bash' | 'Import'
type EntryData = { turn: TurnKey; before: Ref | null; after: Ref | null; isResolved: boolean; tool: EntryTool }
type TurnData = { key: TurnKey; session: SessionId; turn: string; prompt: string }
type SessionData = { id: SessionId; title: string; cwd: string }
type LedgerEvent =
  | { kind: 'session'; session: SessionId; title: string; cwd: string }
  | { kind: 'turn'; session: SessionId; turn: string; prompt: string }
  | { kind: 'edit'; session: SessionId; turn: string; path: string; before: Ref | null; after: Ref | null; tool: EntryTool }
  | { kind: 'keep'; path: string; base: Ref | null }
  | { kind: 'resolve'; path: string; turn: TurnKey | null }
  | { kind: 'settle'; path: string }
  | { kind: 'import'; path: string; base: Ref | null; entries: EntryData[]; turns: TurnData[]; sessions: SessionData[] }
```

`path` is an absolute, normalized path (no trailing slash, no `.` or `..` segments). A `null` ref means the file is absent. The fold ports `applyOne`/`foldEvents` from 0.2 `core/ledger.ts` and adds sessions; `at` is the batch's `at`.

| event | effect on the fold |
| --- | --- |
| session | Add the session if unseen (`n = sessions.size+1`, `at`). Fill an empty title. |
| turn | Add the turn if unseen (`n = turns.size+1`). Fill an empty prompt. |
| edit | Add the turn (prompt `''`) if unseen. No record yet: create `{ base: before, entries: [{ turn, before, after, isResolved: false, tool }] }`. An unresolved entry of the same turn exists: set its `after` and `tool`. Otherwise append a new entry. |
| keep | Set `record.base := base`. |
| resolve | Set `isResolved := true` on the entries of `turn`, or on all entries when `turn` is null. |
| settle | Delete the record. |
| import | Add the sessions and turns. Create the record only if the path has none. |

- **Ledger:** `{ files: ReadonlyMap<string, FileRecord>; turns: ReadonlyMap<TurnKey, Turn>; sessions: ReadonlyMap<SessionId, Session>; last: BatchId | undefined }`.
- **`foldBatches(ledger, batches)`:** batches must be sorted; skip those with id ≤ `last`. Never mutate the input ledger. The switch ends in a `never` check.

### 4.5 Snapshot

`{ "v": 2, "gen": 7, "last": "<BatchId>", "files": FileRecord[], "turns": Turn[], "sessions": Session[] }`. Only the compactor writes snapshots. Readers load the highest `gen` that parses, falling back to the next lower one.

### 4.6 Writer rules

- Write blobs before the batch that references them.
- Blobs are immutable. Write a blob unconditionally when its ref is not known to this writer; skip it when it is.
- Write paths:
  - **The mod** writes with `$.fs.write`, which is not atomic and creates directories, so readers must tolerate partial files.
  - **The extension** writes a tmp file `<name>.<pid>.<hex>.tmp` and renames it.
- Only the compactor deletes batches; only blob GC deletes blobs.

### 4.7 Compaction (extension only)

Trigger: more than 256 batch files, or an oldest batch older than 24 h. Run it in the background, never during an action.

1. `mkdir compact.lock`. On EEXIST: if the lock's mtime is more than 60 s old, `rm -r` it and retry once; otherwise skip. Write `owner.json` `{ pid, at }`.
2. Read the latest snapshot S and every batch with id > `S.last` from disk (disk truth, not memory). Keep the contiguous whole prefix.
3. `L = foldBatches(S, prefix)`. Write `snapshots/<gen+1>-<L.last>.json` (tmp, fsync, rename, fsync dir).
4. Delete batches with id ≤ `L.last`. Delete snapshots with gen < `S.gen` (keep S and the new one).
5. If `gc.json.blobsAt` is more than 24 h old, run blob GC:
   - `needed` = `refsOf(L)` ∪ the refs in remaining batches.
   - Delete blob files that are not needed and whose mtime is more than 10 minutes old.
   - Write `gc.json`.
6. In `finally`: remove `owner.json` and rmdir the lock.

Readers treat ENOENT on a listed batch as "already in a newer snapshot". When they see a higher snapshot gen, they reload from it plus the batches after its `last`.

### 4.8 Shadow repository (Bash)

- Create `shadow.git` with `git init --bare -q`.
- Set config with one script: `gc.auto=0` (MUST: auto-gc would stall snapshots), `core.autocrlf=false`, `core.untrackedCache=true`, `index.version=4`, `core.quotePath=false`, `advice.addEmbeddedRepo=false`.
- `info/exclude` = a copy of `<root>/.git/info/exclude` plus `sort -u <ledger>/shadow-large.txt`. Regenerate it at warm-up when either file's mtime changes.
- Staging is size-gated (§6.6). A file over `maxFileBytes` is removed from the session index and appended to `shadow-large.txt` and `info/exclude` before `git add` runs, so it is never hashed or stored.
- Each session has its own index, `shadow.git/index.<sessionId>`. When it is absent, seed it from the newest `index.*`, so concurrent sessions never contend for `index.lock`.
- Never run a git write against the user's repo. Always set `GIT_DIR` to the shadow and `GIT_INDEX_FILE` to the session's index.

### 4.9 Routing

- **A file's ledger root:** the git top-level of the file's directory (cached per directory); otherwise, the session root.
- **The session root:** the git top-level of the session's cwd; otherwise, the cwd.
- The mod decides routing in its flush, never in the hook.
- The extension writes to the ledger that owns the record.

This matters on this machine: sessions run in `~/Desktop/neoclan`, which is not a repo, while editing files inside its child repos.

## 5. packages/core (pure)

| module | exports (explicit return types) | notes |
| --- | --- | --- |
| ids.ts | `batchId`, `batchIdOfFileName`, `fileNameOf`, `turnKey`, brand guards | port 0.2 `core/ids.ts` |
| events.ts | types §4.4; `parseBatch(text): Parsed<Batch>`, `parseSnapshot(text): Parsed<SnapshotData>`, `parseMeta` | hand guards; ref regex `^[0-9a-f]{64}$` |
| ledger.ts | `emptyLedger`, `foldBatches`, `openTurns(ledger, isListed)`, `openSessions(ledger, isListed)`, `refsOf`, `toSnapshot`, `fromSnapshot` | port 0.2 `core/ledger.ts` |
| lines.ts | `splitLines(text): string[]` (an `indexOf('\n')` loop, each line keeps its `\n`), `class LineInterner { idsOf(lines): Int32Array }` | no regex |
| diff.ts | `Hunk`, `Line`, `diffHunks(before, after, opts?)`, `diffIds(a, b, maxEdits): Uint8Array \| null`, `countChanges`, `toUnified` | §5.1 |
| patch.ts | `patch`, `keepHunk`, `undoHunk`, `PatchResult` | port 0.2 `core/diff.ts` verbatim |
| model.ts | `standingOf`, `keepTurnText`, `undoTurnText`, `keepTurnsText(base, current, pairs)`, `undoTurnsText(base, current, pairs)` | port 0.2 `core/model.ts`. A session keeps its turns oldest→newest on an evolving base and undoes them newest→oldest on an evolving current; it fails on the first conflict. |
| view.ts | `HunkView`, `viewHunks`, `hunkAtLine`, `focusedHunk`, `layoutSignature(views)`, `hunkSig(h)` (FNV-1a of the hunk's lines) | port 0.2 `core/view.ts` |
| bashReadOnly.ts | `isReadOnlyCommand(command): boolean` | §5.2 |
| compact.ts | `planCompaction(snapshot, batches)`, `planBlobGc(needed, blobs, now)` | pure planning; I/O lives in the callers |
| legacy02.ts | a frozen copy of the 0.2 event parser and fold; `toImportEvents(ledger02, route)` | migration only |
| counts.ts | `countsOf(base, after): { added, removed }` | |
| shadowScripts.ts | the strings `STAGE`, `SNAPSHOT`, `SNAPSHOT_DIFF`, `REBASELINE`, `CONTENTS` (§6.6); `parseSnapshotDiff(stdout)`, `parseBatchCheck(stdout)`, `parseContents(bytes)`, all returning discriminated results | Kept in core so `node --test` can run the scripts against real temp repos. |

### 5.1 Diff v2 (deterministic; shared by mod and extension)

1. Split both texts with `splitLines`, intern every distinct line to an int (`LineInterner`), and build Int32Arrays `ai` and `bi`.
2. Trim the common prefix P and suffix S by comparing ints.
3. On the middle, run greedy Myers with trace (port 0.2 `myers`/`backtrack`), comparing ints. Ops go into a Uint8Array: 0 = keep, 1 = delete, 2 = insert.
   - Work bound: `maxEdits = min(opts.maxEdits ?? 2000, max(64, floor(5e7 / (n + m))))`, where n and m are the middle's lengths. This bounds time to ~5·10⁷ int steps and the trace to O(maxEdits²).
   - If D > `maxEdits`, the middle becomes all deletes followed by all inserts.
4. Build hunks from the middle ops only. Take up to `context` (3) lines from P and S by index arithmetic. Merge hunks whose gap is ≤ 2×context (the 0.2 rule). Allocate no per-line objects outside hunks.
5. The output `Hunk[]` keeps the 0.2 shape `{ oldIdx, oldLen, newIdx, newLen, lines }`, so patch, model and view port unchanged.

Tests:

- Property tests, 10,000 random cases: `patch(a, diffHunks(a,b), 'forward').text === b`, and the reverse.
- Parity with 0.2 on fixtures: same hunk count and the same added/removed counts.
- CRLF, a missing final newline, empty sides, and identical texts.

Bench: 10k lines with 10 hunks < 3 ms; 50k lines with 1k changed lines < 150 ms. Print 0.2 vs v2.

### 5.2 `isReadOnlyCommand` (conservative: true only when certainly read-only)

**Lexer:** handles whitespace, `'…'`, `"…"` (with backslash escapes), `\x`, the separators `|`, `||`, `&&`, `;` and newline, and redirects.

**It returns false** on any of:

- unbalanced quotes
- unquoted `` ` ``, `$(`, `<(`, `>(`, `<<` or `(`
- a trailing or background `&`
- any `>`, `>>` or `&>` except exactly `>/dev/null`, `2>/dev/null`, `&>/dev/null`, `2>&1`, `1>&2` or `>&2`
- the programs `xargs`, `sudo`, `exec`, `eval`, `source` and `.`

**Each simple command** (split on the separators):

1. Skip leading `NAME=value` words.
2. Take the program as the basename of the first word.
3. The program must be in ALLOW and pass its rule.

**ALLOW:** `cd pushd popd pwd true false test [ echo printf ls cat head tail wc grep egrep fgrep rg ag fd tree stat file du df which whereis type printenv date uname whoami id hostname ps lsof uptime basename dirname realpath readlink jq cut tr nl column diff cmp comm md5 shasum sha256sum sleep seq expr less more man`. Also `command`, only with `-v`, and `env`, only with no command argument.

**Rules:**

- `find`: deny `-delete -exec -execdir -ok -okdir -fprint -fprint0 -fprintf -fls`.
- `sort`: deny `-o` and `--output`.
- `uniq`: at most 1 positional argument.
- `yq`: deny `-i`.
- `git`:
  - Allowed subcommands: `status log diff show rev-parse ls-files ls-tree blame grep describe shortlog cat-file merge-base rev-list show-ref`.
  - `branch`, `tag` and `remote` are allowed with no arguments or only listing flags (`-a -r -v -l --list --show-current`).
  - `stash list`, `worktree list`, and `config` with `--get`, `--list` or `-l` are allowed.
  - Deny `--output` anywhere.

**Required test cases (T = true, F = false):**

- **Must return true:** `ls -la` · `grep -rn "a > b" src` · `cat x \| head -5` · `ls 2>/dev/null` · `git status && git diff` · `cd a && ls` · `FOO=1 rg x` · `jq . a.json`.
- **Must return false:** `npm test` · `sed -i s/a/b/ f` · `echo hi > f` · `find . -name x -delete` · `git commit -m x` · `echo $(rm x)` · `cat <<EOF` · `sort -o f a` · `awk '{print}' f` · `python -c 1` · `ls &` · `git branch -D x`.

## 6. packages/mod (session-review 1.0.0)

### 6.1 Files

| file | role |
| --- | --- |
| hooks/register.tsx | Wiring only (§6.2). |
| hooks/paths.ts | `SessionPaths`, computed once in `session.start`: home, dataDir, cwd, sessionRoot, isGit and writer. `rootOfDir(dir)` is cached per directory and spawns `git -C dir rev-parse --show-toplevel` only on a miss, only from flush. |
| hooks/recorder.ts | The capture queue, serialized flush, `knownBlobs`, batch writing, and turn/session events. |
| hooks/bash.ts | The Bash hook and the barrier. |
| hooks/shadow.ts | Runs core's `shadowScripts.ts` and holds the shadow state:<br>• `warmed`, init, seed, and `info/exclude` regeneration<br>• `snapshot()` → `{ kind: 'tree' } \| { kind: 'tooMany' } \| { kind: 'failed' }`<br>• `afterBash(before)`, `sizes(shas)` and `contents(shas)`<br>• `rebaseline()`, `isRebaselining` and `onUnusable(result)`<br>• GC |
| hooks/ledger.ts | Reads the snapshot and batches and folds them (cached by snapshot gen plus the set of seen batches); applies the mod's own batches to the cache immediately. |
| hooks/summary.ts | The incremental summary, `$.state` and the status line. |
| hooks/sockets.ts | The socket list, cached 10 s and dropped on failure; a fire-and-forget `ping`; `open(path, line)` and `focus()` over the bridge. |
| hooks/actions.ts | Terminal keep/undo for hunk, file, turn, session and all. |
| hooks/ui.tsx | The `/changes` text, Pane, AbovePrompt band and CommandOutput. |
| hooks/core/ | Generated; never edited by hand. |
| types/index.d.ts | The state contract (§6.8). |

### 6.2 Hook wiring

| event | matcher | behaviour |
| --- | --- | --- |
| session.start | — | Register `/changes`, build SessionPaths, schedule warm-up with `$.clock.after(0, …)` (shadow init+seed+snapshot when git, ledger load, summary), then `return next(e)` without awaiting the warm-up. |
| turn.start | main loop only: return `next(e)` when `e.agentId !== undefined` | `currentTurn := { id: e.turnId, prompt }` (whitespace collapsed, 60 chars), kept in a module variable and `$.state`. |
| tool.call | `{ tool: 'Edit' }`, `'Write'`, `'NotebookEdit'` (three registrations, for type narrowing) | §6.3, registered with `.catch(($, e, next) => next(e))`. |
| tool.call | `{ tool: 'Bash' }` | §6.6, registered with `.catch(($, e, next) => next(e))`. |
| turn.complete | main loop | `await barrier; await recorder.flush()`, then `next(e)`. |
| session.end | — | Flush within `next.budget`, then `next(e)`. |
| command.run | `{ command: 'changes' }` | `ui.runChanges` |
| ui.render | Pane `requestId: 'session-review'`; CommandOutput `props: { command: 'changes' }`; AbovePrompt | ui |

### 6.3 Recorder hot path (MUST match)

```ts
// Edit and Write (path = e.file_path); NotebookEdit identical with e.notebook_path
await barrier
const before = await readText($, path)             // string | null (missing) | undefined (> 4 MiB or unreadable)
const ran = await next(e)
if (ran.deny !== undefined || ran.isError === true || isStaged(ran)) return ran   // isStaged: Edit/Write results only (`result.staged`)
if (before === undefined) return ran               // too large: not reviewable, log once per path
const after = await readText($, path)
if (after !== undefined && after !== before) recorder.capture({ path, before, after, tool: e.tool, agentId: e.agentId })
return ran
```

- `readText` calls `$.fs.read`. On a rejection it calls `$.fs.stat`: if that rejects with ENOENT, return `null`; otherwise return `undefined` (the file is over 4 MiB or unreadable).
- Read from disk on both sides rather than trusting `result.originalFile`/`content`. The tool result may hold text whose line endings were normalized; the disk text is the truth.
- `capture` is synchronous. It pushes `{ path, before, after, tool, session, turn: currentTurn, at: Date.now() }` and, if no flush is pending, calls `$.clock.after(0, () => flush($))`. It never hashes or writes.

### 6.4 Flush (one at a time; never throws)

1. Take every queued capture.
2. Route each path to its ledger dir (§4.9). Ensure `meta.json` once per ledger per session, with the exists check cached.
3. Every ledger is folded on its own, so session and turn events are announced per ledger. Keep `announced: Set<ledgerDir|session>` and `Set<ledgerDir|turnKey>`. A ledger's first batch holding this session's edits starts with a `session` event (`title` = the current prompt, `cwd`). Its first batch holding a turn's edits starts with that `turn` event.
4. sha256 each distinct text with `crypto.subtle`. For refs not in `knownBlobs`, `$.fs.write` the blob in parallel and add it. Seed `knownBlobs` from `refsOf` of the cached fold.
5. Write one batch per ledger with `$.fs.write(<dir>/events/<id>.json)` and apply it to the cached fold.
6. `sockets.ping(ledgerDir)`, not awaited.
7. `summary.markDirty(paths)`.

A failure logs `$.ui.log("session-review: could not record <paths>: <reason>")` and the flush continues with the next ledger.

### 6.5 currentTurn

If no main-loop `turn.start` has been seen yet in this module instance (for example after a hot reload), read `$.state` once. Failing that, use `{ id: 'turn', prompt: '' }`. Subagent edits (`e.agentId`) are attributed to the current main turn.

### 6.6 Bash

```ts
let barrier: Promise<void> = Promise.resolve()
on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
  if (!options.bash || !paths.isGit || shadow.isRebaselining || isReadOnlyCommand(e.command)) return next(e)
  await barrier
  await shadow.warmed                                // in-flight warm-up from session.start; never rejects
  const before = await shadow.snapshot($)            // 1 spawn → { kind: 'tree', tree } | { kind: 'tooMany', count } | { kind: 'failed', reason }
  if (before.kind !== 'tree') {                      // unrecorded: log once; tooMany starts a background rebaseline
    shadow.onUnusable($, before)
    return next(e)
  }
  const ran = await next(e)
  if (ran.deny !== undefined || ran.isReadOnly === true) return ran
  barrier = shadow.afterBash($, before.tree)         // stage+diff-tree, sizes, contents → recorder.captureMany(…, 'Bash')
    .catch(err => logOnce($, err))
  return ran
})
```

**Rebaseline:** STAGE with no candidate cap, then `write-tree`, running in the background and not tied to the barrier. While it runs, Bash calls run untracked and log once (`shadow.isRebaselining`). It starts when a before- or after-snapshot reports `tooMany`, and at most one runs per session.
Run every script as `$.process.run(['/bin/sh', '-c', SCRIPT, 'sh', ...args], { cwd: root, timeoutMs: 120_000, stdin? })`. Remember the 4 MiB stdout cap per call.

**STAGE** is the size-gated prelude that SNAPSHOT, SNAPSHOT_DIFF and REBASELINE share. Its args: index, gitDir, root, seedIndex, maxBytes, maxCandidates (0 = no cap). It stages exactly what `git add -A` would, minus files over maxBytes, which it never reads.

```sh
set -e
export GIT_INDEX_FILE="$1" GIT_DIR="$2" GIT_WORK_TREE="$3"
MAX="$5" CAP="$6" L="$2/cand.$$"
trap 'rm -f "$L" "$L.big"' EXIT
if [ ! -f "$1" ] && [ -n "$4" ] && [ -f "$4" ]; then cp "$4" "$1"; fi
# The only walk: lstat + untracked cache, honors .gitignore/info/exclude, reads no file content.
git ls-files -z -o -m -d --exclude-standard > "$L"
N=$(tr -cd '\000' < "$L" | wc -c | tr -d ' ')
if [ "$CAP" -gt 0 ] && [ "$N" -gt "$CAP" ]; then printf '!toomany %s\n' "$N"; exit 0; fi
if [ "$N" -gt 0 ]; then
  # Candidates over MAX: "./" prefix so a name starting with "-" is not read as a find option.
  xargs -0 sh -c 'for f do shift; set -- "$@" "./$f"; done; find "$@" -prune -type f -size +"$0"c -print0 2>/dev/null || true' "$MAX" < "$L" > "$L.big"
  if [ -s "$L.big" ]; then
    xargs -0 git --literal-pathspecs rm -q --cached --ignore-unmatch -- < "$L.big" >/dev/null 2>&1 || true
    tr '\000' '\n' < "$L.big" | sed -e 's|^\./||' -e 's/[][*?\\]/\\&/g' -e 's/^[#!]/\\&/' -e 's|^|/|' \
      | tee -a "$2/info/exclude" >> "$2/../shadow-large.txt"
  fi
  # Ignored (large) pathspecs are reported and skipped; the rest are staged. A path that vanished
  # since the walk makes add die, so fall back to one plain add (large files are excluded by now).
  git --literal-pathspecs add -A --ignore-errors --pathspec-from-file="$L" --pathspec-file-nul >/dev/null 2>&1 \
    || git add -A --ignore-errors -- . >/dev/null 2>&1 || true
fi
```

- **SNAPSHOT** (critical path; args 1–6 with maxCandidates = `maxSnapshotCandidates`): STAGE, then `git write-tree`.
- **REBASELINE:** STAGE with maxCandidates = 0, then `git write-tree`.
- **SNAPSHOT_DIFF** (args 1–6 plus 7 = beforeTree): STAGE, then:

```sh
T=$(git write-tree); printf '%s\n' "$T"
[ "$T" = "$7" ] || git diff-tree -r -z --raw --no-abbrev --no-renames --no-ext-diff "$7" "$T"
```

Every script requires git ≥ 2.26 for `--pathspec-from-file`; this machine has 2.33. At warm-up, check `git --version`; if it is older, disable Bash tracking and log once.

Parse the output:

- A first line of `!toomany <n>` means the command goes unrecorded and a rebaseline starts.
- Otherwise, line 1 is the after-tree.
- The rest is NUL-separated records: `:<oldmode> <newmode> <oldsha> <newsha> <status>`, then the path.
- Skip modes `160000` and `120000`.
- `A` means `before: null`; `D` means `after: null`.
- Cap at `maxBashFiles` (200); log what was dropped.

**SIZES:** `git cat-file --batch-check='%(objectname) %(objecttype) %(objectsize)'` with `GIT_DIR` set and the shas on stdin. Drop any blob over `maxFileBytes` (2 MiB); that drops the whole file change. This is a second line of defense: STAGE already kept such files out. A before-side blob can still exceed the cap when a file staged earlier grew past it.

**CONTENTS:** `sh -c 'GIT_DIR="$1" git cat-file --batch | base64' sh <gitDir>` with the shas on stdin, in chunks whose raw sizes sum to ≤ 2,900,000 bytes, so the base64 output stays under 4 MiB.

1. Strip whitespace from stdout and decode it with `Uint8Array.fromBase64`.
2. Walk the bytes: an ASCII header `<sha> blob <size>\n`, then `size` bytes, then `\n`.
3. Decode each blob with `new TextDecoder('utf-8', { fatal: true })`.
4. If decoding throws or the text contains `\0`, the blob is binary: skip that file.

A file is captured only when both of its sides decode or are null.

**Warm-up** (in the background from `session.start`, with the promise held in `shadow.warmed`):

1. Check `git --version`.
2. Ensure the repo exists: init plus config, in one script.
3. Regenerate `info/exclude` (§4.8).
4. Run REBASELINE, which has no candidate cap and runs off the critical path. Seed it with the newest `index.*` (found with `$.fs.list(shadow.git)` and sorted by mtime).

The first warm-up of a workspace hashes its non-ignored files ≤ 2 MiB once. Every later session starts from the seeded index and re-hashes only what changed.

**GC** (at warm-up, at most once a day, tracked in `gc.json.shadowAt`):

1. Run `rm -f` on any `index.*` older than 7 days.
2. Run `git count-objects -v`. If `size-pack + size` exceeds 512 MB and no index was modified in the last 10 minutes, run `rm -rf shadow.git`; it is rebuilt lazily.

### 6.7 Summary (debounced 300 ms via `$.clock.after`, coalesced)

- **Scope:** the ledgers this session wrote to, plus its session-root ledger.
- **Per record:** `key = ${base}|${lastAfter}`, where `lastAfter` is the `after` of the newest entry.
  - On a memo hit, reuse the counts.
  - On a miss, read both blobs (module LRU, 16 MB) and run `countsOf`.
  - Drop the row when `base === lastAfter`.
- **Writes:** `$.state.set` only when the summary signature changed, and `$.ui.status` only when its text changed (`N files changed +a −r · /changes`).
- **Poll:** a `$.clock.every(5000)` timer reloads the ledger (`fs.list` of snapshots and events, 2 RPCs) only while `files.length > 0`, and recomputes when the fold changed. That is how keep and undo done in VS Code reach the terminal.
- **Disk:** read only when an action runs or the pane shows a file. Use `$.fs.stat` size and mtime as the cache key, and re-read only when they change.

### 6.8 State contract (`types/index.d.ts`)

```ts
export type FileRow = { path: string; rel: string; added: number; removed: number; status: 'new' | 'deleted' | 'modified'; ledger: string }
export type TurnRow = { key: string; n: number; prompt: string; session: string; paths: string[] }
export type SessionRow = { id: string; n: number; title: string; turnKeys: string[] }
export type Summary = { files: FileRow[]; turns: TurnRow[]; sessions: SessionRow[]; added: number; removed: number }
declare module 'claude-code' {
  interface PluginState {
    'session-review': { summary: Summary; selected: string | null; page: number; currentTurn: { id: string; prompt: string } | null }
  }
}
```

### 6.9 UI and options

- **`/changes`:** this is the text the model reads. Port 0.2 `runChanges`, `listText`, `diffText` and `HELP`.
  - Group the list as Sessions → Turns → files.
  - Add `keep|undo session N`.
  - `open N` posts `/open` to the bridge, trying sockets by newest mtime and stopping at the first 200; it falls back to the text diff.
  - `vscode` posts `/focus`, falling back to the `code --command claudeReview.focus` path (0.2 `runCode`).
- **Pane:** port `drawReview`.
  - The list view shows sessions, turns and files with Keep/Undo per row, plus Keep all and Undo all.
  - The file view shows hunks from disk against the base, cached by stat, in pages of 20,000 characters with a "Next changes" button that advances `page`.
  - Never write state while rendering.
- **AbovePrompt band:** only on the terminal and desktop surfaces, and only when the `band` option is on. Return `next(e)` when the summary is empty or `e.props.hasSurvey` is set. The band is one row, `◆ N files +a −r`, with buttons [Review] (opens the pane), [Keep all] and [Undo all]. It reads nothing but `summary`.
- **userConfig:** `bash` (boolean, true) · `band` (boolean, true) · `maxBashFiles` (number, 200) · `maxFileBytes` (number, 2097152) · `maxSnapshotCandidates` (number, 2000) · `dataDir` (string, '') · `debugTimings` (boolean, false). With `debugTimings` on, each capture logs a line such as `Edit recorded: 2 rpc, 3 ms`, and each Bash call logs its snapshot ms and spawn count.

### 6.10 Terminal actions

Port 0.2 `hunkEvents`, `fileEvents`, `turnAction` and `allAction` onto v2 events, and add the session action using `keepTurnsText`/`undoTurnsText`. Write the file with `$.fs.write`, or delete it with `$.process.run(['rm', '-f', path])`. Then append the batch, ping, and mark the summary dirty.

## 7. packages/vscode (local.claude-review 1.0.0)

### 7.1 Modules

```text
src/extension.ts          composition root (7.2)
src/config.ts             zod-parsed settings + onDidChange (port 0.2 src/config.ts)
src/log.ts                LogOutputChannel, timed(), Perf counters (7.9) (port 0.2 src/log.ts)
src/ledger/store.ts       LedgerStore (7.3.1)
src/ledger/blobs.ts       sharded io, sha256 via node:crypto, LRU by bytes (64 MB) with pin/unpin
src/ledger/compactor.ts   §4.7
src/ledger/discovery.ts   ledgers of this window: meta.root isSameTree a folder (port 0.2 findLedgers/isSameTree); watch ledgers/ for new dirs
src/ledger/bridge.ts      socket server (7.3.3) (port 0.2 src/data/bridge.ts)
src/ledger/migrate.ts     §8
src/review/model.ts       ReviewModel + signals (7.4)
src/review/live.ts        live text and LiveVersion
src/review/scheduler.ts   DiffScheduler (7.5)
src/review/diffPool.ts    worker client; src/review/diffWorker.ts worker entry
src/review/actions.ts     ActionQueue + actions (7.6)
src/review/edits.ts       port 0.2 src/engine/edits.ts (applyEdit, setTexts, replaceLines)
src/ui/{tree,baseDocs,quickDiff,decorations,hover,codeLens,contextKeys,statusBar,diffEditors,follow,prompts}.ts
src/commands.ts           registry; every arg parsed with zod (port 0.2 gutterArgSchema, nodeSchema, revealNext, stepHunk, stepFile)
```

### 7.2 Activation

**Synchronous in `activate()`** (≤ 30 ms, no awaited I/O):

1. Create log, config, model and scheduler (the worker starts lazily).
2. Register:
   - the `claude-base` and `claude-blob` content providers
   - the hover provider on scheme `file`
   - the tree view
   - commands
   - the status bar
   - quick diff, if enabled
   - document listeners
3. Return `ClaudeReviewApi { model, scheduler, perf, stores }` for tests.

**Deferred** (`setImmediate`, not awaited by `activate`):

1. `bridge.start`
2. discovery
3. migration, per folder, in the background
4. open the stores in parallel and add each to the model
5. scheduler requests: visible editors with reason `visible`, the rest with `startup`
6. `prompts.once()`

**Listeners:**

- `onDidChangeTextDocument`: if `uri.scheme === 'file'`, `model.has(path)` and there are content changes, request a diff with reason `action` when the path is in `actionPaths`, else `typing`.
- `onDidOpenTextDocument` / `onDidCloseTextDocument`: assign a new doc identity on open; on close, request `external`, because disk is the truth again.
- File watchers: one `createFileSystemWatcher(new RelativePattern(Uri.file(dirname), basename))` per tracked path, created when the path enters the model and disposed when it leaves. Its events request `external` only when no document is open for the path. Never watch `**/*`.

### 7.3 Data layer

#### 7.3.1 LedgerStore

- **start():**
  1. mkdir the directories.
  2. Load the highest snapshot gen.
  3. List `events/` and read batches with id > `last`, 16 in parallel.
  4. Fold the contiguous whole prefix.
  5. `fs.watch(events/)`, debounced 10 ms, triggers `scan()`.
- **scan():** coalesced, with one running and one queued.
- **Late batches:** a batch with id < `last` triggers a refold from the snapshot over every parsed batch kept since it. That set is bounded by compaction.
- **append(events):**
  1. Build a batch with writer `x<pid36>` and a monotonic counter.
  2. Write it (tmp + rename).
  3. Fold it immediately and add it to `seen`, so the watcher won't fold it twice.
  4. Emit.
- **Emits** `LedgerChange { dir, previous, current }`.

#### 7.3.2 Blobs

- `get(ref)` returns from the LRU or reads `blobs/xx/ref`.
- `put(text)` hashes; if the ref is neither cached nor on disk, it writes tmp + rename.
- `pin`/`unpin` keep base texts resident while a base document is open.
- Strip a leading U+FEFF from texts used for diffing. VS Code drops the BOM from documents; the blob keeps it.

#### 7.3.3 Bridge

- At start, remove stale sockets with a connect test (port 0.2).
- Every body is ≤ 4 KB, parsed with zod.

| request | body | response |
| --- | --- | --- |
| `POST /ping` | `{ ledger }` | 204. Scan that store, or run `discovery.connect()` when the ledger is unknown. |
| `POST /open` | `{ ledger, path, line? }` | 200 `{ opened: true }` after showing the review diff, when the path is under review here; otherwise 404. |
| `POST /focus` | none | 204, after revealing the view. |

### 7.4 ReviewModel

```ts
type LiveVersion = string        // open doc: `d${docIdentity}:${doc.version}`; disk: `f${mtimeMs}:${size}`; 'missing'
type DiffState =
  | { kind: 'pending' }
  | { kind: 'ready'; baseVersion: number; liveVersion: LiveVersion; hunks: readonly HunkView[]; added: number; removed: number; lineCount: number; layout: string }
  | { kind: 'clean'; baseVersion: number; liveVersion: LiveVersion }
  | { kind: 'tooLarge'; bytes: number }
  | { kind: 'error'; message: string }
type FileState = { path: string; uri: vscode.Uri; ledgerDir: string; record: FileRecord; baseVersion: number; diff: DiffState }
```

- **Under review:** the record exists and `diff.kind !== 'clean'`. Order follows record insertion; ledgers are ordered by root.
- **On a LedgerChange:** for each path whose record object changed:
  - If its `base` ref changed, increment `baseVersion`, emit `base(path)`, and request a `ledger` diff.
  - A removed record means a membership change.
  - New turns or sessions emit `turns`.
- **`applyDiff(path, result)`:**
  - Drop the result if `baseVersion` moved meanwhile.
  - Emit membership when the file switches between clean and not clean.
  - Emit counts when added or removed changed.
  - Emit layout when the `layout` string changed. A content-only change inside an added line repaints nothing.
- **Signals:** batched per tick and fired once via `queueMicrotask`: `onMembership()`, `onCounts(paths)`, `onLayout(paths)`, `onBase(paths)`, `onTurns()`.
- **Duplicates:** if a path appears in two ledgers (old data), the deepest root's record wins; warn once.
- **Projections:** `turns` and `sessions` (port 0.2 `openTurns` + `turnCache`) are memoized by ledger identity.
- **Undo Keep:** a stack holds the last 20 keeps as `{ path, previousBase }`. `claudeReview.revertLastKeep` appends `keep(previousBase)`.

### 7.5 Diff scheduling

#### 7.5.1 Lifecycle per path

```text
idle → debouncing → queued → running → applied
                                     ↘ superseded
```

- **Debouncing:** `typing` waits for 150 ms of quiet, with a 600 ms max-wait.
- **Queue priority** (lowest number first):

| priority | reasons |
| --- | --- |
| 0 | action, ledger, visible |
| 1 | typing |
| 2 | external |
| 3 | startup |

**A run:**

1. Size first, without copying or reading:
   - For an open doc, take its length from `doc.offsetAt(doc.lineAt(doc.lineCount - 1).range.end)`.
   - Otherwise, take it from `fs.stat`.
   - Over `maxDiffBytes`, the state becomes `tooLarge` and nothing is read.
   - Only then read the text: `doc.getText()` for an open doc, or `fs.readFile` as UTF-8.
   - Base blobs are capped by construction; still, `Blobs.get` stats each blob before its first read and rejects one over `maxDiffBytes`.
2. For the reasons typing, visible, external and startup, skip the run if the state is `ready` with the same `baseVersion` and `liveVersion` (`perf.diffsSkipped++`). Never skip for `ledger` or `action`.
3. Get the base text from `Blobs`.
4. Call `pool.diff`.
5. On the result: drop it if a newer request for the path is queued; otherwise call `model.applyDiff`. Release the texts.

`settle(paths)` flushes these paths' debounces and awaits their jobs. Actions call it.

#### 7.5.2 Worker (`node:worker_threads`, `dist/diffWorker.js`)

- Pool: 1 worker, growing to 2 when more than 8 jobs are queued.
- Messages, zod-validated on both sides:
  - → `{ t: 'diff', id, path, baseKey, base?: string, live: string }`
  - ← `{ t: 'ok', id, hunks: HunkView[], added, removed, lineCount, layout }`, or `{ t: 'needBase', id }`, or `{ t: 'err', id, message }`
- The worker keeps an LRU of 32 entries `baseKey (= path|baseRef) → { lines, interner, ids }`. On `needBase`, the client resends the request with `base`.
- Turn-history counts use the same worker with a low priority, cached by `before|after`.
- If the worker crashes: reject the in-flight jobs, log, and restart lazily.
- There is no main-thread diff, except while the worker cannot start, and then only for texts ≤ 16 KB.

### 7.6 Actions

**ActionQueue** (one action at a time):

1. `await scheduler.settle(paths)`.
2. Compute from the model.
3. Apply one WorkspaceEdit and save the touched docs (port 0.2 `applyEdit`/`setTexts`, so ⌘Z brings it back).
4. Add the paths to `actionPaths` until their next diff.
5. Append one batch per ledger.

**Hunk targets.** Commands carry `{ path, start, sig }`. The action re-finds the hunk by `sig` nearest `start` in the settled diff; if it is gone, the status bar says "That change moved, try again" and nothing happens.

| action | live edit | events |
| --- | --- | --- |
| keepHunk | — | `keep(keepHunk(base, h))`, plus `settle` if the new base equals live |
| undoHunk | Replace `newIdx..newIdx+newLen` with the removed lines. Delete the file if the base is null and the result is empty. | `settle` if live now equals base |
| keepMapping (diff gutter) | — | `keep(originalWithModifiedChanges)`, plus `settle` |
| undoMapping | Replace the modified range with the original range's lines | `settle` if clean |
| keepFile | — | `settle` |
| undoFile | `live := base` (minimal hunks, delete or create) | `resolve(null)`, `settle` |
| keepTurn T | — | For each file with an open entry of T: `keep(keepTurnText)`, `resolve(T)`, plus `settle`. Conflicts go to a warning. |
| undoTurn T | `live := undoTurnText` | `resolve(T)`, plus `settle`. Conflicts are listed. |
| keepSession S | — | `keepTurnsText` oldest→newest across S's open turns, one batch |
| undoSession S | `undoTurnsText` newest→oldest, one WorkspaceEdit | the resolves, plus `settle`. Confirm when `confirmUndoSession` is on. |
| keepAll | — | `settle` on every file |
| undoAll | `live := base` on every file (modal confirm) | `resolve(null)` and `settle` on every file |

After an action on the active file, reveal its next change, or else the next file's first change (port 0.2 `revealNext`).

### 7.7 Surfaces

#### Tree (`claudeReview.changes`)

- Subscribes to membership (full refresh), counts (item refresh), and turns (full refresh, in the turns and sessions modes only).
- Keeps a TreeItem cache by node id. Tooltips are built lazily in `resolveTreeItem`.
- Ids are stable: `f:<path>`, `d:<dir>`, `t:<key>`, `s:<id>`.
- Modes (`claudeReview.groupBy`): `files`, `folders` (compressed single-child chains, aggregated counts), `turns` (turn → files), and `sessions` (session → turn → files).
- A file's description is `+a −r`, with `new` or `deleted` appended. Under a turn, it shows that turn's own counts, from the entry's before and after.
- The badge is the file count.

#### Base documents (`claude-base:<fsPath>`)

- Subscribe to `base(paths)`.
- `provideTextDocumentContent` returns the base text, pinned while the doc is open, or the live text when the file is not under review.
- Fire `onDidChange` only for `base(paths)` that have an open base doc. Never fire on typing.

#### History documents (`claude-blob:/<ledgerId>/<ref>/<basename>`)

- Immutable blob text. `claude-blob:/empty/<basename>` serves an empty document.

#### Quick diff

- `provideOriginalResource` returns the `claude-base` uri for tracked paths. Setting: `claudeReview.quickDiff`.

#### Decorations

- Subscribe to `layout(paths)` and changes in the visible editors.
- Draw:
  - added lines with a whole-line `diffEditor.insertedLineBackground`
  - removed blocks with a 1px top border in `editorGutter.deletedBackground`
  - the gutter icon `media/removed.svg`, only when `quickDiff` is off (quick diff already marks the gutter)
  - overview ruler marks for both
- Skip an editor that is the modified side of a review diff (port 0.2 `isInReviewDiff`).
- Cache ranges per `(path, layout)`.

#### Hover

- Reads the model lazily and returns in O(1) for untracked docs.
- On a hunk's lines it shows the removed text in a `diff` block, plus `[Keep ⌥Y](command:…)`, `[Undo ⌥N](command:…)` and `[Open diff](command:…)`, with `isTrusted: { enabledCommands }`.
- It replaces 0.2's per-decoration `hoverMessage`.

#### CodeLens (opt-in)

- Shows Keep and Undo above each hunk.
- Fires `onDidChangeCodeLenses` only on a layout change of an open doc.

#### Context keys

- Subscribe to membership, the active editor and the selection.
- `claudeReview.hasChanges`.
- `claudeReview.reviewedPaths` as an object `{ [fsPath]: true }`. `in` on an object is O(1); on an array it is O(n).
- `claudeReview.hunkAtCursor` and `claudeReview.groupBy`.
- Set each key only when its value changes (port the 0.2 `ContextKeys.set` dedupe).

#### Status bar

- Subscribes to membership, counts and the cursor.
- `$(sparkle) 3 files +40 −12` focuses the view.
- A position item reads `Change 2/8 · File 1/3`.

#### Diff editors

- Port 0.2 `openDiff`, `showReview`, `reviewAll`, `closeFinishedReviews` and `ensureInlineSettings`. The settings prompt now asks only for `renderSideBySide: false`.
- Review All, Review Turn and Review Session use `vscode.changes`.
- `toggleDiff` (⌥D) swaps the plain editor and the inline diff in the same editor group, keeping the line, and closes the other tab if it is clean.
- A deleted file opens `vscode.diff(claude-base, claude-blob empty)`.

#### Follow (opt-in)

- `followEdits: 'openDiff'`: a ledger `edit` opens that file's review diff as a preview tab with `preserveFocus`.

#### Prompts (once each, tracked in globalState)

- `diffEditor.maxComputationTime` is 0: offer to set 5000.
- The old `inlineRemovedLines` is set: explain the inline diff and ⌥D, offer `openFilesAs: inlineDiff`, and remove the old setting.

### 7.8 package.json contributions

**Commands** (category "Claude Review"):

- **Changes view:** focus, reviewAll, refresh, and groupByFiles, groupByFolders, groupByTurns, groupBySessions.
- **Keep/undo:** keepHunk, undoHunk, keepFile, undoFile, keepMapping, undoMapping, keepTurn, undoTurn, keepSession, undoSession, keepAll, undoAll, revertLastKeep.
- **Navigation and diffs:** nextHunk, prevHunk, nextFile, prevFile, toggleDiff, openDiff, openFile (hidden), openTurnDiff, reviewTurn, reviewSession.
- **Maintenance:** importOldSessions, cleanUpStorage, showStats.

**Keybindings:**

| keys | command | when |
| --- | --- | --- |
| ⌥Y / ⌥N | keep / undo hunk | `editorTextFocus && claudeReview.hunkAtCursor` |
| ⌥⇧Y / ⌥⇧N | keep / undo file | `editorTextFocus && resourcePath in claudeReview.reviewedPaths` |
| ⌥] / ⌥[ | next / previous change | `claudeReview.hasChanges` |
| ⌥D | toggle inline diff | `editorTextFocus && resourcePath in claudeReview.reviewedPaths` |

**Menus:**

- **view/title:** Review All, Keep All, Undo All, a group-by submenu, and Refresh.
- **view/item/context** (inline):
  - `crFile`: open diff, keep, undo
  - `crTurn` and `crSession`: keep, undo, review
  - `crFileInTurn` adds "Show What This Turn Changed"
- **editor/title**, when the file is under review: previous/next file, toggle diff, undo/keep file.
- **`editor/content`** (proposed `contribEditorContentMenu`): keep/undo change, previous/next change, previous/next file, undo/keep file, and toggle diff.
- **`diffEditor/gutter/hunk`** (proposed `contribDiffEditorGutterToolBarMenus`): keepMapping and undoMapping, when `diffEditorOriginalUri =~ /^claude-base:/`.

**`enabledApiProposals`:** `["contribEditorContentMenu", "contribDiffEditorGutterToolBarMenus"]`. Verify both names in `src/vscode-dts/vscode.proposed.*.d.ts` at commit 6d62b1d5dace93a33b3a6d3eca1317bd5e15bcb1. Everything must keep working without them, through editor/title, the keys, the hover and the tree.

**Settings:**

| setting | values | default |
| --- | --- | --- |
| `openFilesAs` | `inlineDiff` or `file` | `inlineDiff` |
| `groupBy` | `files`, `folders`, `turns` or `sessions` | `files` |
| `quickDiff` | boolean | true |
| `codeLens` | boolean | false |
| `decorations.addedLines` | boolean | true |
| `decorations.removedMarkers` | boolean | true |
| `followEdits` | `off` or `openDiff` | `off` |
| `confirmUndoAll` | boolean | true |
| `confirmUndoSession` | boolean | true |
| `maxDiffBytes` | number | 4194304 |
| `dataDir` | string | `''` (means `~/.claude/claude-review/v2`) |

**Activation:** `onStartupFinished`.

### 7.9 Perf counters (`src/log.ts`, exposed as `api.perf` and printed by `showStats`)

`diffsRequested, diffsComputed, diffsSkipped, workerMsTotal, workerMsMax, baseDocsProvided, baseDocChangeEvents, treeFullRefreshes, treeItemRefreshes, decorationPaints, lensRefreshes, ledgerScans, batchesFolded, handlerMsMax`. `handlerMsMax` is measured by a `timed()` wrapper around every VS Code event handler and command.

## 8. Migration and rollout

1. **Automatic migration** (extension; per open folder, in the background, once per old ledger). For every 0.2 ledger (`~/.claude/claude-review/ledgers/*/meta.json` whose root isSameTree a folder) that has no `migrated-v2.json`:
   1. Fold it with `core/legacy02`.
   2. Route each record (§4.9; walk up for `.git` with `fs.stat`).
   3. Copy the referenced blobs from the flat 0.2 `blobs/<ref>` to v2 `blobs/xx/<ref>` (`copyFile`, skipping existing ones).
   4. Append one `import` batch per target ledger (writer `xmig`).
   5. Write `migrated-v2.json` `{ at, lastId, to }`.

   When two old ledgers hold the same path, keep the record whose newest turn `at` is latest. Migration is idempotent, because `import` ignores paths already present.

   Size rules:

   - Migration reads `meta.json`, the snapshot, events, and only the blobs that pending records reference.
   - It `stat`s each blob before copying it and skips one over 4 MiB, logging it.
   - It never opens `sessions/*/shadow.git`.
2. **`importOldSessions` command** (0.1 sessions in `~/.claude/session-review/*/review.json`, for this window's folders): port 0.2 `src/data/importLegacy.ts`, emitting v2 imports.
   - It reads only `review.json` and the referenced blobs (stat first, ≤ 4 MiB).
   - It never touches the sessions' `shadow.git`.
   - It never runs at startup.
3. **`cleanUpStorage` command:**
   1. Measure, in the background behind a progress notification, the migrated 0.2 ledgers (419 MB), `~/.claude/session-review` (425 MB, 37,829 files), and the 0.2 per-session `sessions/*/shadow.git` folders (≈340 MB).
      - The walk is metadata only (`readdir` + `lstat`), never reads contents, yields every 256 entries, and can be cancelled.
   2. Show a modal confirm that lists each path and size.
   3. Delete what the user chooses with `fs.rm(path, { recursive: true })` in the background.
4. **Rollout** (do these with the user's confirmation):
   1. `npm run install-local`, which builds and installs `packages/vscode/claude-review.vsix` with `code --install-extension … --force`. The id is the same, so it replaces 0.2.
   2. Set `extraKnownMarketplaces.claude-review.source.path` in `~/.claude/settings.json` to the absolute path of this repository. The key `session-review@claude-review` stays.
   3. Restart any running Claude sessions; until then their 0.2 mods keep writing 0.2 ledgers.
   4. Reload the VS Code windows; migration runs then.

## 9. Phases (each ends with `npm run verify` green and its DoD met)

- **P0 Scaffold:**
  - Set up the workspaces, tsconfig and esbuild (the extension plus its worker).
  - Set up the runners: `node --test` for core, `claude plugin test packages/mod`, and @vscode/test-electron.
  - `sync-core --check` runs in verify, plus `marketplace.json` and `claude plugin validate packages/mod`.
  - **DoD:** the empty packages build, typecheck and test.
- **P1 Core:** every module in §5, with tests and benches.
  - **DoD:**
    - §5.1 benches met.
    - Property tests green.
    - The classifier table green.
    - A read-only script folds every real 0.2 ledger in `~/.claude/claude-review/ledgers` through `legacy02` without errors.
- **P2 Mod recorder** (no Bash): paths, recorder, flush, ledger reader, summary, status and sockets.
  - Tests use a fake session (port 0.2 `review.test.tsx` `fakeSession`) and count RPCs:
    - Edit makes exactly 2 `fs.read` calls and 0 `fs.write` calls before the hook returns.
    - After the mocked clock advances, the flush writes the blobs and exactly 1 batch.
    - Nothing in the summary runs inside `tool.call`.
    - `ping` is not awaited.
  - **DoD:** M1, M4.
- **P3 Mod Bash:** shadow, scripts, parsing, barrier, warm-up and GC.
  - Tests stub `process.run`:
    - Spawn counts per scenario: read-only, mutating, unchanged, `!big`/oversize, binary, chunking, and failure → command still runs.
    - The arguments passed to each script.
    - Parsing of fixture outputs.
  - Script tests: `node --test` runs core's `shadowScripts.ts` with `/bin/sh` against real temp git repos.
    - A 50 MB untracked file is never hashed:
      - The shadow's `objects/` grows by less than 1 MB.
      - The path lands in `shadow-large.txt`.
      - The next snapshot doesn't list it.
    - A staged file that grows past the cap is untracked and excluded.
    - 2,500 new files make the capped STAGE print `!toomany 2500`, and REBASELINE then stages them.
    - A candidate deleted between the walk and the add still yields a tree, via the fallback.
    - File names with spaces, `*`, `[`, a leading `-` or `#`, and non-ASCII characters all work.
    - SNAPSHOT_DIFF finds A, M and D correctly.
    - `parseContents` handles chunk boundaries and binary blobs.
  - Manual: a temp git repo with 2,000 files, with `debugTimings` on.
  - **DoD:** M2, M3, M5, and §1.4's Bash rows.
- **P4 Extension data:** store, blobs, compactor, discovery, bridge and migrate.
  - Two stores plus the compactor on one temp dir while a third writer appends 1,000 batches: no event is lost, and the fold equals a single-threaded fold.
  - Partial-batch tolerance.
  - GC keeps every needed ref and young blobs.
  - Migration of a fixture copy of a real 0.2 ledger. It never opens `sessions/*/shadow.git`, and it skips a blob over 4 MiB with a log line.
  - Size checks: a 20 MB closed file and a 6 MB open doc both reach `tooLarge` without being read. Spy on `fs.readFile`, and confirm `getText` is never called.
- **P5 Extension engine:** model, scheduler, worker, actions and edits. Tests use fake timers:
  - typing debounce and max-wait
  - supersede and skip-unchanged
  - settle-before-action
  - re-targeting a hunk by `sig`
  - every row of the §7.6 table
  - signals do not fire when nothing changed
- **P6 Extension surfaces:** surfaces, commands, `package.json` and prompts. Integration tests on a fixture ledger, asserting §7.9 deltas:
  - Typing 40 chars in an open reviewed file: `baseDocsProvided` Δ0, `baseDocChangeEvents` Δ0, `treeFullRefreshes` Δ0, `diffsComputed` Δ ≤ 4, `handlerMsMax` < 5.
  - Keep/undo for hunk, file, turn, session and all.
  - ⌥D toggles.
  - Review All opens the multi-diff.
  - The E5 grep.
- **P7 Mod UI:** the `/changes` text with sessions, the pane, the band, and `/changes open` through the bridge. UI tests mount Pane and AbovePrompt on `['terminal', 'desktop']`, plus `'vscode'` for Pane.
- **P8 Rollout:** §8.4, the README (install, keys, settings, how it works), and manual QA (§10.4).

## 10. Verification

1. **`npm run verify`** runs:
   - `sync-core --check`
   - typecheck of every package
   - core tests
   - `claude plugin validate packages/mod` and `claude plugin test packages/mod`
   - extension unit tests and integration tests
2. **`npm run bench`** runs the core diff and fold benches and prints 0.2 vs v2. Fail if §5.1 regresses.
3. **Mod timings:** with `debugTimings` on, run Claude in `~/Desktop/japaflex/japaflex_mobile_fix` (1,474 tracked files) and `~/Desktop/jacko/Jacko-Core`, and check M1–M3 in the log lines:
   - An Edit adds about 2 RPCs.
   - `ls` and `grep` log nothing.
   - `npm test` logs 1 spawn before the command and the rest in the background.
4. **Manual QA** in VS Code 1.142 on this machine:
   1. Claude edits 3 files → the tree updates within about 150 ms and the status bar reads `3 files`.
   2. Click a file → the inline diff shows red removed lines, and the gutter Keep/Undo works.
   3. Open the same file plain from the Explorer → green lines, gutter bars, removed markers, a hover with Keep/Undo, and ⌥D flips to the diff.
   4. Type for 10 s → no flicker, and `Show Performance Stats` shows 0 base doc events.
   5. Group by Sessions, then Keep session; Undo turn with an overlapping later edit reports the conflict.
   6. Claude runs `npm test` → the changed files appear tagged Bash, and `ls`/`grep` add no latency.
   7. Two windows on one folder plus a forced compaction (300 batches) → both stay consistent.
   8. In the terminal: `/changes` lists, the band shows, `keep 1.2` works, and `open 1` jumps to the VS Code diff.
   9. Developer: Show Running Extensions → activation < 30 ms, and a CPU profile shows no diff work on the host thread.
   10. Large inputs, in a git repo:
       1. `mkfile -n 420m big.bin`, left out of `.gitignore`. Have Claude run a mutating Bash command.
       2. The before-snapshot stays within M3.
       3. `du -sh <ledger>/shadow.git` doesn't grow by 420 MB.
       4. `big.bin` appears in `shadow-large.txt`, and the review doesn't list it.
       5. In VS Code, open a 10 MB file Claude edited → the tree shows it as too large, and the editor doesn't freeze.
   11. Open the `~/Desktop/neoclan` window (17 GB, not a git repo) → activation and first paint stay within E1/E3. Activity Monitor shows no sustained disk reads from the extension host or the Claude process.

## 11. Port map (0.2 → 1.0) and pitfalls

**Port.** Paths are relative to `~/Desktop/claude-review-vscode/`:

- **Core, verbatim:** `core/model.ts`; `core/diff.ts` (`patch`, `keepHunk`, `undoHunk`, `toUnified`, `countChanges`).
- **Core, adapted:**
  - `core/diff.ts` `myers`/`backtrack`, moved onto Int32Array.
  - `core/view.ts`.
  - `core/ledger.ts` (`applyOne`, `foldEvents`, `openTurns`, `refsOf`).
  - `core/ids.ts`.
  - `core/events.ts` and `core/ledger.ts`, frozen into `legacy02.ts`.
- **Extension data:**
  - `src/engine/edits.ts`
  - `src/data/bridge.ts`
  - `src/data/paths.ts` (`writeAtomic`, `isSameTree`, `findLedgers`, `readMeta`)
  - `src/data/importLegacy.ts`, now behind a command
- **Extension UI:**
  - `src/surfaces/nativeDiff.ts`
  - `src/commands.ts` (`gutterArgSchema`, `revealNext`, `stepHunk`, `stepFile`)
  - `src/surfaces/tree.ts` (`nodeSchema`)
  - `src/surfaces/contextKeys.ts` (`set` dedupe)
  - `src/config.ts` and `src/log.ts`
- **Mod:** `claude-plugin/hooks/register.tsx` (`runChanges`, `listText`, `diffText`, `HELP`, `drawReview`, `hunkEvents`, `fileEvents`, `turnAction`, `allAction`, `runCode`).
- **Tests:** `claude-plugin/hooks/review.test.tsx` (`fakeSession`), `test/runIntegration.ts`, and `test/suite/index.ts` (`until`, fixture setup).
- **Build:** `scripts/sync-core.mjs` and `esbuild.mjs`.

**Delete, do not port:**

- `src/surfaces/insets.ts`, `core/insetPlan.ts`, `src/vscode.proposed.editorInsets.d.ts`.
- The coarse `Delta` in `src/engine/engine.ts`.
- The `INLINE_LIMIT` path in `diffService.ts`.
- `refresh()` inside hooks, the per-session shadow, and `workTree()` on every Bash call.

**MUST NOT:**

- **In the mod:**
  - await the flush or the summary inside `tool.call`
  - call `$.state.set` during `ui.render`
  - run a git write against the user's repo
  - omit `gc.auto=0` in the shadow
  - exceed 4 MiB of stdout per `$.process.run` or read files over 4 MiB with `$.fs.read`
  - omit `.catch(($, e, next) => next(e))` on a `tool.call` hook
  - record a subagent's `turn.start` as a turn
  - run `git add -A` without STAGE's size gate
  - snapshot a non-git root
- **Everywhere:**
  - read or hash a file before checking its size
  - walk a directory tree outside the two walks §1.4 allows
  - scan legacy stores at startup
- **In the extension:**
  - fire `claude-base:` changes on typing
  - call `onDidChangeTreeData(undefined)` for a count change
  - keep `getText()` results
  - diff on the extension-host thread
  - use an array for an `in` context key
  - watch `**/*`
  - create webviews
