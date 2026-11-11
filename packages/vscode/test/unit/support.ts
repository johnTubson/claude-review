import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { toRef, toSessionId, type Ref, type SessionId } from '@core/ids'

import type { Log } from '../../src/log'
import { newPerf, type Perf } from '../../src/perf'

export type TestLog = Log & { readonly lines: string[] }

export const testLog = (): TestLog => {
  const lines: string[] = []
  return {
    lines,
    error: (what, err) => lines.push(`error ${what}: ${err instanceof Error ? err.message : String(err)}`),
    warn: m => lines.push(`warn ${m}`),
    info: m => lines.push(`info ${m}`),
    trace: () => undefined,
  }
}

export const perf = (): Perf => newPerf()

const temps: string[] = []
export const tempDir = (prefix = 'cr-x-'): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  temps.push(dir)
  return dir
}
export const cleanTemps = (): void => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
}

export const ref = (text: string): Ref => toRef(createHash('sha256').update(text, 'utf8').digest('hex'))
export const S1: SessionId = toSessionId('s1')

export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

export const until = async (what: string, check: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await check()) return
    await sleep(10)
  }
  throw new Error(`timed out waiting for: ${what}`)
}
