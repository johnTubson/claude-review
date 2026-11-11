import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { decodeBase64, decodeUtf8With } from '../src/bytes'

const decoder = new TextDecoder()
const decodeUtf8 = (bytes: Uint8Array): string | undefined => decodeUtf8With(b => decoder.decode(b), bytes)
import { seeded } from './support/random'

const nodeStrict = (bytes: Uint8Array): string | undefined => {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return undefined
  }
}

describe('bytes', () => {
  test('decodeBase64 matches Buffer, wrapped or not', () => {
    const random = seeded(3)
    for (let i = 0; i < 500; i++) {
      const bytes = Uint8Array.from({ length: Math.floor(random() * 300) }, () => Math.floor(random() * 256))
      const b64 = Buffer.from(bytes).toString('base64')
      assert.deepEqual(decodeBase64(b64), bytes)
      assert.deepEqual(decodeBase64(b64.replace(/(.{76})/g, '$1\n')), bytes)
    }
    assert.equal(decodeBase64('ab$c'), undefined)
  })

  test('decodeUtf8 agrees with a fatal TextDecoder that keeps the BOM', () => {
    const random = seeded(4)
    const samples = ['', 'plain', 'héllo wörld', '﻿bom first', 'emoji 😀 and 𝄞', '中文', '\u0000nul']
    for (const s of samples) assert.equal(decodeUtf8(new TextEncoder().encode(s)), s)
    for (let i = 0; i < 3000; i++) {
      const bytes = Uint8Array.from({ length: Math.floor(random() * 12) }, () => (random() < 0.5 ? Math.floor(random() * 128) : 0x80 + Math.floor(random() * 128)))
      assert.equal(decodeUtf8(bytes), nodeStrict(bytes), `case ${i}: ${[...bytes].join(',')}`)
    }
    const long = 'ab😀'.repeat(10_000)
    assert.equal(decodeUtf8(new TextEncoder().encode(long)), long)
  })
})
