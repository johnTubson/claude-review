// The diff worker: keeps the last 32 bases split into lines, so typing in a
// file only sends the live text.

import { parentPort } from 'node:worker_threads'

import { splitLines } from '@core/lines'

import { computeDiff } from './diffCompute'
import { requestSchema, type WorkerResponse } from './protocol'

const MAX_BASES = 32
const bases = new Map<string, readonly string[]>()

const remember = (key: string, lines: readonly string[]): void => {
  bases.delete(key)
  bases.set(key, lines)
  for (const k of bases.keys()) {
    if (bases.size <= MAX_BASES) break
    bases.delete(k)
  }
}

const handle = (raw: unknown): WorkerResponse | undefined => {
  const parsed = requestSchema.safeParse(raw)
  if (!parsed.success) return undefined
  const { id, baseKey, base, live } = parsed.data
  try {
    let lines = baseKey === '' ? undefined : bases.get(baseKey)
    if (base !== undefined) {
      lines = splitLines(base)
      if (baseKey !== '') remember(baseKey, lines)
    } else if (lines !== undefined) {
      remember(baseKey, lines)
    }
    if (lines === undefined) return { t: 'needBase', id }
    return { t: 'ok', id, ...computeDiff(lines, live) }
  } catch (err) {
    return { t: 'err', id, message: err instanceof Error ? err.message : String(err) }
  }
}

parentPort?.on('message', (raw: unknown) => {
  const response = handle(raw)
  if (response) parentPort?.postMessage(response)
})
