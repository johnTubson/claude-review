import { toRef, type Ref } from './core/ids'

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'))
const encoder = new TextEncoder()

export const sha256Hex = async (text: string): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))
  let out = ''
  for (const byte of digest) out += HEX[byte] ?? '00'
  return out
}

export const refOf = async (text: string): Promise<Ref> => toRef(await sha256Hex(text))
