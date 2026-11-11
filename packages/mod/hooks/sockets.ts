// The VS Code windows' bridge sockets. Listing them is cached for 10 s and
// dropped when a ping fails, so a write costs no directory listing.

import type { EngineInterface } from 'claude-code'

type $ = EngineInterface

const LIST_TTL_MS = 10_000

export type Sockets = {
  readonly dir: string
  listed: { readonly at: number; readonly paths: readonly string[] } | undefined
  listing: Promise<readonly string[]> | undefined
}

export const newSockets = (dir: string): Sockets => ({ dir, listed: undefined, listing: undefined })

/** Socket paths, newest first. */
export function listSockets($: $, sockets: Sockets): Promise<readonly string[]> {
  const { listed } = sockets
  if (listed && Date.now() - listed.at < LIST_TTL_MS) return Promise.resolve(listed.paths)
  sockets.listing ??= $.fs
    .list(sockets.dir)
    .then(entries =>
      entries
        .filter(e => e.name.endsWith('.sock'))
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .map(e => `${sockets.dir}/${e.name}`),
    )
    .catch(() => [])
    .then(paths => {
      sockets.listed = { at: Date.now(), paths }
      sockets.listing = undefined
      return paths
    })
  return sockets.listing
}

const invalidate = (sockets: Sockets): void => {
  sockets.listed = undefined
}

/** Tells every window a ledger changed. Fire and forget: never awaited by a writer. */
export function ping($: $, sockets: Sockets, ledgerDir: string): void {
  void listSockets($, sockets).then(paths => {
    for (const socketPath of paths) {
      // A window that closed leaves its socket until the next window starts; that fetch fails.
      $.http
        .fetch('http://claude-review/ping', { method: 'POST', body: JSON.stringify({ ledger: ledgerDir }), socketPath })
        .then(r => {
          if (!r.ok) invalidate(sockets)
        })
        .catch(() => invalidate(sockets))
    }
  })
}

/** POSTs to each listed window, newest first, until one answers 2xx; true when one did. */
async function postToListed($: $, sockets: Sockets, url: string, body: string): Promise<boolean> {
  for (const socketPath of await listSockets($, sockets)) {
    const ok = await $.http
      .fetch(url, { method: 'POST', body, socketPath })
      .then(r => r.ok)
      .catch(() => false)
    if (ok) return true
  }
  return false
}

/** As postToListed, listing the sockets afresh when none of the cached ones answered: a window may have started since. */
async function postFirst($: $, sockets: Sockets, url: string, body: string): Promise<boolean> {
  if (await postToListed($, sockets, url, body)) return true
  invalidate(sockets)
  return postToListed($, sockets, url, body)
}

/** Asks VS Code to show a file's review diff; false when no window has it under review. */
export function openInVsCode($: $, sockets: Sockets, ledgerDir: string, path: string, line: number): Promise<boolean> {
  return postFirst($, sockets, 'http://claude-review/open', JSON.stringify({ ledger: ledgerDir, path, line }))
}

export function focusVsCode($: $, sockets: Sockets): Promise<boolean> {
  return postFirst($, sockets, 'http://claude-review/focus', '')
}
