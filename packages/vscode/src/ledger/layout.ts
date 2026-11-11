// Where a ledger keeps what (§4.1), shared with the mod.
//   <dataDir>/ledgers/<sha256(root) hex [0:16]>/{meta.json, events/, snapshots/, blobs/xx/, shadow.git/, compact.lock/, gc.json}
//   <dataDir>/sockets/*.sock

import { createHash } from 'node:crypto'
import * as path from 'node:path'

import type { Ref } from '@core/ids'

export const ledgersDir = (dataDir: string): string => path.join(dataDir, 'ledgers')
export const socketsDir = (dataDir: string): string => path.join(dataDir, 'sockets')
export const ledgerDirFor = (dataDir: string, root: string): string =>
  path.join(ledgersDir(dataDir), createHash('sha256').update(root, 'utf8').digest('hex').slice(0, 16))

export const eventsDir = (ledgerDir: string): string => path.join(ledgerDir, 'events')
export const snapshotsDir = (ledgerDir: string): string => path.join(ledgerDir, 'snapshots')
export const blobsDir = (ledgerDir: string): string => path.join(ledgerDir, 'blobs')
export const blobPath = (ledgerDir: string, ref: Ref): string => path.join(ledgerDir, 'blobs', ref.slice(0, 2), ref)
export const metaFile = (ledgerDir: string): string => path.join(ledgerDir, 'meta.json')
export const gcFile = (ledgerDir: string): string => path.join(ledgerDir, 'gc.json')
export const compactLockDir = (ledgerDir: string): string => path.join(ledgerDir, 'compact.lock')

/** True when one path is the other or holds it. */
export const isSameTree = (a: string, b: string): boolean => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep)
