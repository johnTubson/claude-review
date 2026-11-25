# Claude Review

Review what Claude Code changed, the way Cursor does, in VS Code's own diff editors and in the terminal. Every edit Claude makes (Edit, Write, NotebookEdit and mutating Bash commands) is recorded; you keep or undo each change, file, turn, session, or everything.

Two parts share one on-disk ledger:

- **`session-review`** (`packages/mod`): a Claude Code mod that records changes and adds `/changes`, a review pane and a band above the prompt.
- **Claude Review** (`packages/vscode`): a VS Code extension that shows the changes under review and keeps or undoes them.

## Install

```sh
npm install
npm run install-local        # builds and installs packages/vscode/claude-review.vsix
```

Then point Claude Code at this repo's marketplace in `~/.claude/settings.json`:

```json
{ "extraKnownMarketplaces": { "claude-review": { "source": { "source": "directory", "path": "/absolute/path/to/claude-review" } } } }
```

using the absolute path of your clone, and enable `session-review@claude-review`. Restart running Claude sessions and reload VS Code windows. If you used 0.2, the extension migrates its pending changes once on the first load.

## Use

In VS Code, the **Claude Review** view lists what is under review, grouped by files, folders, worktrees, turns or sessions. Click a file to open its inline diff: removed lines in red, Keep / Undo in the diff gutter.

| keys | does |
| --- | --- |
| ⌥Y / ⌥N | keep / undo the change at the cursor |
| ⌥⇧Y / ⌥⇧N | keep / undo the whole file |
| ⌥] / ⌥[ | next / previous change, across files |
| ⌥D | flip between the file and its inline diff |

Plain editors of changed files show added lines, removed-line markers, quick-diff bars, and a hover with the removed text and Keep / Undo. **Revert Last Keep** puts back the base a keep moved.

In the terminal, `/changes` lists the review (sessions → turns → files) and opens the pane:

```text
/changes                  list, and open the pane
/changes show 1 [page]    file 1's diff
/changes open 1           file 1 in VS Code's diff editor
/changes keep|undo 1      a whole file;  1.2  one change in it
/changes keep|undo turn 2 | session 1 | all
/changes vscode           show the view in VS Code
```

## Settings

| VS Code setting | default | |
| --- | --- | --- |
| `claudeReview.openFilesAs` | `inlineDiff` | or `file`: open the file itself |
| `claudeReview.groupBy` | `files` | `folders`, `worktree`, `turns`, `sessions` |
| `claudeReview.quickDiff` | `true` | gutter bars against the review baseline |
| `claudeReview.codeLens` | `false` | Keep / Undo above each change |
| `claudeReview.decorations.addedLines` / `removedMarkers` | `true` | |
| `claudeReview.followEdits` | `off` | `openDiff`: open each file Claude edits |
| `claudeReview.confirmUndoAll` / `confirmUndoSession` | `true` | |
| `claudeReview.maxDiffBytes` | 4 MiB | larger files are listed as too large, never read |
| `claudeReview.dataDir` | `~/.claude/claude-review/v2` | shared with the mod |

The mod's options (`/plugin` → session-review): `bash` (record Bash changes), `band`, `maxBashFiles` (200), `maxFileBytes` (2 MiB), `maxSnapshotCandidates` (2000), `dataDir`, `debugTimings`.

Maintenance commands: **Import Old Sessions** (0.1), **Clean Up Old Storage** (measures and deletes the 0.1 store, migrated 0.2 ledgers and 0.2 shadow repos, after you confirm), **Show Performance Stats**.

## How it works

Each workspace root has a ledger at `~/.claude/claude-review/v2/ledgers/<sha256(root)[:16]>/`: batches of events (`events/`), snapshots, and file versions by content hash (`blobs/`). Both sides fold the same batches with the same code (`packages/core`), so they always agree.

- **Edit/Write/NotebookEdit:** the hook reads the file before and after the tool and queues the change; hashing and writing happen later, off the tool's path.
- **Bash:** read-only commands (`ls`, `grep`, `git status`…) cost nothing. A mutating one costs one `git` snapshot of the work tree before it runs, into a private shadow repo that never touches your repository; what changed is read after it, in the background. Files over 2 MiB are never read or hashed.
- **VS Code:** diffs run in a worker thread. Typing in a reviewed file is debounced and never re-reads the baseline, so editors stay at native speed. Nothing uses webviews.

The extension compacts ledgers in the background and deletes file versions nothing needs.

## Develop

```sh
npm run verify    # sync-core check, typecheck, core tests, mod validate + tests, extension unit + integration tests
npm run bench     # diff and fold benchmarks against 0.2
```

`packages/core/src` is copied into the mod by `npm run sync-core`; edit the original. `docs/SPEC.md` is the design.
