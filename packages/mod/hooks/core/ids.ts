// Generated from packages/core/src/ids.ts by scripts/sync-core.mjs: edit the original, then run `npm run sync-core`.

// Ids and branded strings shared by the mod and the extension. Pure.
//
// A BatchId is also its batch file's name: the time and counter are fixed-width
// base 36, so sorting the strings sorts the batches by when they were written.

declare const brand: unique symbol
type Brand<T, B extends string> = T & { readonly [brand]: B }

/** A blob's name: the sha256 of its UTF-8 bytes, in hex. */
export type Ref = Brand<string, 'Ref'>
export type BatchId = Brand<string, 'BatchId'>
export type SessionId = Brand<string, 'SessionId'>
/** `${session}:${turn}` */
export type TurnKey = Brand<string, 'TurnKey'>

const TIME_WIDTH = 10
const COUNTER_WIDTH = 6
const REF_PATTERN = /^[0-9a-f]{64}$/
const BATCH_ID_PATTERN = /^[0-9a-z]{10}-[0-9a-z]{1,12}-[0-9a-z]{6}-[0-9a-z]{4}$/
const BATCH_FILE_PATTERN = /^[0-9a-z]{10}-[0-9a-z]{1,12}-[0-9a-z]{6}-[0-9a-z]{4}\.json$/
const WRITER_PATTERN = /^[a-z0-9]{1,12}$/
const SNAPSHOT_FILE_PATTERN = /^(\d{8})-([0-9a-z]{10}-[0-9a-z]{1,12}-[0-9a-z]{6}-[0-9a-z]{4})\.json$/

export const isRef = (v: unknown): v is Ref => typeof v === 'string' && REF_PATTERN.test(v)
export const isBatchId = (v: unknown): v is BatchId => typeof v === 'string' && BATCH_ID_PATTERN.test(v)
export const isSessionId = (v: unknown): v is SessionId => typeof v === 'string' && v.length > 0
export const isTurnKey = (v: unknown): v is TurnKey => typeof v === 'string' && v.indexOf(':') > 0

export class IdError extends Error {
  override readonly name = 'IdError'
}

export const toRef = (hex: string): Ref => {
  if (!isRef(hex)) throw new IdError(`not a sha256 ref: ${hex.slice(0, 80)}`)
  return hex
}

export const toSessionId = (id: string): SessionId => {
  if (!isSessionId(id)) throw new IdError('a session id cannot be empty')
  return id
}

export const turnKey = (session: SessionId, turn: string): TurnKey => {
  const key = `${session}:${turn}`
  if (!isTurnKey(key)) throw new IdError(`not a turn key: ${key}`)
  return key
}

/** The mod's writer: `m` plus the first 6 alphanumerics of the session id. */
export const modWriter = (session: SessionId): string => `m${session.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6)}`

/** The extension's writer: `x` plus the pid in base 36. */
export const extensionWriter = (pid: number): string => `x${pid.toString(36)}`.slice(0, 12)

export const MIGRATION_WRITER = 'xmig'

/**
 * `<ms>-<writer>-<counter>-<nonce4>`. `counter` orders one writer's batches
 * within a millisecond; `nonce` keeps two writers with the same name apart.
 */
export const batchId = (now: number, writer: string, counter: number, nonce: string): BatchId => {
  if (!WRITER_PATTERN.test(writer)) throw new IdError(`writer must be 1-12 of [a-z0-9]: ${writer}`)
  const id = `${now.toString(36).padStart(TIME_WIDTH, '0')}-${writer}-${counter.toString(36).padStart(COUNTER_WIDTH, '0')}-${nonce}`
  if (!isBatchId(id)) throw new IdError(`not a batch id: ${id}`)
  return id
}

/** Four base-36 characters from any source of randomness in [0, 1). */
export const nonce4 = (random: () => number): string =>
  Math.floor(random() * 36 ** 4)
    .toString(36)
    .padStart(4, '0')
    .slice(-4)

export const fileNameOf = (id: BatchId): string => `${id}.json`

/** The id a batch file holds, or undefined for any other file (a tmp file mid-write, for one). */
export const batchIdOfFileName = (name: string): BatchId | undefined => {
  if (!BATCH_FILE_PATTERN.test(name)) return undefined
  const id = name.slice(0, -5)
  return isBatchId(id) ? id : undefined
}

/** When the batch was written, from the id alone. */
export const timeOfBatchId = (id: BatchId): number => parseInt(id.slice(0, TIME_WIDTH), 36)

export type SnapshotName = { readonly gen: number; readonly last: BatchId }

export const snapshotFileName = (gen: number, last: BatchId): string => `${gen.toString().padStart(8, '0')}-${last}.json`

export const parseSnapshotFileName = (name: string): SnapshotName | undefined => {
  const match = SNAPSHOT_FILE_PATTERN.exec(name)
  const gen = match?.[1]
  const last = match?.[2]
  return gen !== undefined && isBatchId(last) ? { gen: Number(gen), last } : undefined
}
