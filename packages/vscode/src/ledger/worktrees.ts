// The git worktrees of a folder's repository. The mod keeps one ledger per git
// top level, so a linked worktree has a ledger of its own that no workspace
// folder is in or around; this is how a window finds it.

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { promisify } from 'node:util'

const run = promisify(execFile)

const GIT_TIMEOUT_MS = 10_000
const NOT_A_REPOSITORY = 128

export type Worktree = { readonly root: string; readonly branch: string | undefined }

/** `git worktree list --porcelain`: blocks of `worktree <path>`, `HEAD <sha>`, then `branch refs/heads/<name>`, `detached` or `bare`. */
export function parseWorktrees(porcelain: string): Worktree[] {
  const out: Worktree[] = []
  for (const block of porcelain.split(/\r?\n\r?\n/)) {
    let root: string | undefined
    let branch: string | undefined
    let bare = false
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) root = line.slice('worktree '.length)
      else if (line.startsWith('branch ')) branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
      else if (line === 'bare') bare = true
    }
    if (root !== undefined && !bare) out.push({ root, branch })
  }
  return out
}

const realOrSame = (p: string): Promise<string> => fs.realpath(p).catch(() => p)

/** Every worktree of the repository `folder` is in, itself included; none when it is not in one. */
export async function worktreesOf(folder: string): Promise<Worktree[]> {
  let stdout: string
  try {
    stdout = (await run('git', ['-C', folder, 'worktree', 'list', '--porcelain'], { timeout: GIT_TIMEOUT_MS })).stdout
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === NOT_A_REPOSITORY) return []
    throw err
  }
  return Promise.all(parseWorktrees(stdout).map(async w => ({ root: await realOrSame(w.root), branch: w.branch })))
}
