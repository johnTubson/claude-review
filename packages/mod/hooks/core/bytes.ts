// Generated from packages/core/src/bytes.ts by scripts/sync-core.mjs: edit the original, then run `npm run sync-core`.

// Base64 and strict UTF-8 decoding with no host APIs, so the mod (whose
// TextDecoder has neither `fatal` nor `ignoreBOM`) and Node agree byte for byte.

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const SEXTETS = (() => {
  const table = new Int16Array(128).fill(-1)
  for (let i = 0; i < BASE64.length; i++) table[BASE64.charCodeAt(i)] = i
  return table
})()

/** Standard base64, whitespace anywhere ignored; undefined for anything else. */
export const decodeBase64 = (text: string): Uint8Array | undefined => {
  const out = new Uint8Array(Math.floor((text.length * 3) / 4) + 3)
  let len = 0
  let acc = 0
  let bits = 0
  let padding = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c === 32 || c === 10 || c === 13 || c === 9) continue
    if (c === 61) {
      padding++
      continue
    }
    if (padding > 0) return undefined
    const v = c < 128 ? (SEXTETS[c] ?? -1) : -1
    if (v < 0) return undefined
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[len++] = (acc >> bits) & 0xff
    }
  }
  return out.subarray(0, len)
}

/** Strict UTF-8: no overlongs, surrogates, truncated sequences or code points past U+10FFFF. */
export const isValidUtf8 = (bytes: Uint8Array): boolean => {
  const len = bytes.length
  let i = 0
  while (i < len) {
    const b0 = bytes[i] ?? 0
    if (b0 < 0x80) {
      i++
      continue
    }
    const b1 = bytes[i + 1] ?? 0
    if (b0 >= 0xc2 && b0 <= 0xdf) {
      if ((b1 & 0xc0) !== 0x80) return false
      i += 2
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      const b2 = bytes[i + 2] ?? 0
      if ((b1 & 0xc0) !== 0x80 || (b2 & 0xc0) !== 0x80) return false
      if (b0 === 0xe0 && b1 < 0xa0) return false
      if (b0 === 0xed && b1 >= 0xa0) return false
      i += 3
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      const b2 = bytes[i + 2] ?? 0
      const b3 = bytes[i + 3] ?? 0
      if ((b1 & 0xc0) !== 0x80 || (b2 & 0xc0) !== 0x80 || (b3 & 0xc0) !== 0x80) return false
      if (b0 === 0xf0 && b1 < 0x90) return false
      if (b0 === 0xf4 && b1 >= 0x90) return false
      i += 4
    } else {
      return false
    }
  }
  return true
}

/**
 * Strict UTF-8 through the host's decoder, keeping a leading BOM: a default
 * TextDecoder (all the mod's environment types) strips exactly one, so one is
 * put back. Undefined when the bytes are not valid UTF-8.
 */
export const decodeUtf8With = (decode: (bytes: Uint8Array) => string, bytes: Uint8Array): string | undefined => {
  if (!isValidUtf8(bytes)) return undefined
  const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  return hasBom ? `\uFEFF${decode(bytes)}` : decode(bytes)
}
