// What `cleanUpStorage` offers to delete, and how big each is. The walk reads
// metadata only (readdir + lstat), yields every 256 entries and can be
// cancelled: one of the two tree walks §1.4 allows.

import { promises as fs } from 'node:fs'
import * as path from 'node:path'

import { listIfPresent } from './fsx'
import { isMigrated02 } from './migrate'

const YIELD_EVERY = 256

export type Cancellation = { readonly isCancelled: () => boolean }
export type StorageCandidate = { readonly label: string; readonly path: string }
export type Measured = StorageCandidate & { readonly bytes: number; readonly files: number }

export class CancelledError extends Error {
  override readonly name = 'CancelledError'
}

const yieldToLoop = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

/** Bytes and files under `root`, by lstat; symlinks are counted, never followed. */
export const measureTree = async (root: string, cancel: Cancellation): Promise<{ bytes: number; files: number }> => {
  let bytes = 0
  let files = 0
  let seen = 0
  const stack = [root]
  for (let dir = stack.pop(); dir !== undefined; dir = stack.pop()) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (++seen % YIELD_EVERY === 0) {
        await yieldToLoop()
        if (cancel.isCancelled()) throw new CancelledError('cancelled')
      }
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      const stat = await fs.lstat(full).catch(() => undefined)
      if (stat) {
        bytes += stat.size
        files++
      }
    }
  }
  return { bytes, files }
}

/** The old stores: migrated 0.2 ledgers, the 0.1 sessions folder, and 0.2's per-session shadow repos. */
export const storageCandidates = async (legacyDir: string, sessionsDir: string): Promise<StorageCandidate[]> => {
  const out: StorageCandidate[] = []
  const ledgers = path.join(legacyDir, 'ledgers')
  for (const name of await listIfPresent(ledgers)) {
    const dir = path.join(ledgers, name)
    if (await isMigrated02(dir)) {
      out.push({ label: `0.2 ledger ${name} (migrated)`, path: dir })
      continue
    }
    for (const session of await listIfPresent(path.join(dir, 'sessions'))) {
      const shadow = path.join(dir, 'sessions', session, 'shadow.git')
      if (await fs.stat(shadow).then(s => s.isDirectory(), () => false)) out.push({ label: `0.2 shadow repo of session ${session}`, path: shadow })
    }
  }
  if ((await listIfPresent(sessionsDir)).length > 0) out.push({ label: '0.1 sessions', path: sessionsDir })
  return out
}

export const measureAll = async (candidates: readonly StorageCandidate[], cancel: Cancellation): Promise<Measured[]> => {
  const out: Measured[] = []
  for (const c of candidates) out.push({ ...c, ...(await measureTree(c.path, cancel)) })
  return out
}
