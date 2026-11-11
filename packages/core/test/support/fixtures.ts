import { createHash } from 'node:crypto'

import type { Batch, LedgerEvent } from '../../src/events'
import { batchId, toRef, toSessionId, type BatchId, type Ref, type SessionId } from '../../src/ids'

export const ref = (text: string): Ref => toRef(createHash('sha256').update(text, 'utf8').digest('hex'))
export const S1: SessionId = toSessionId('s1')
export const S2: SessionId = toSessionId('s2')

let counter = 0
export const nextId = (at = 1_794_334_827_391, writer = 'test'): BatchId => batchId(at, writer, counter++, '0000')

export const batch = (events: readonly LedgerEvent[], at = 1_794_334_827_391): Batch => ({ v: 2, id: nextId(at), at, writer: 'test', events })
