// Blob texts by ref: immutable, so a read is cached until the byte budget
// evicts it. Base texts of open base documents are pinned and never evicted.

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'

import { toRef, type Ref } from '@core/ids'

import { isMissing, writeAtomic } from './fsx'
import { blobPath } from './layout'

export class BlobTooLargeError extends Error {
  override readonly name = 'BlobTooLargeError'

  constructor(
    readonly ref: Ref,
    readonly bytes: number,
  ) {
    super(`blob ${ref} is ${bytes} bytes, over the diff limit`)
  }
}

export const refOfText = (text: string): Ref => toRef(createHash('sha256').update(text, 'utf8').digest('hex'))

/** VS Code drops a leading BOM from documents; the blob keeps it. Diff against what the editor holds. */
export const forDiff = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)

type Entry = { readonly text: string; readonly bytes: number }

export class Blobs {
  private readonly cache = new Map<Ref, Entry>()
  private readonly reading = new Map<Ref, Promise<string>>()
  private readonly pins = new Map<Ref, number>()
  private bytes = 0

  constructor(
    private readonly maxBytes: number,
    private readonly maxBlobBytes: () => number,
  ) {}

  get cachedBytes(): number {
    return this.bytes
  }

  /** The blob's text; rejects with BlobTooLargeError past the diff limit, before reading it. */
  get(ledgerDir: string, ref: Ref): Promise<string> {
    const hit = this.cache.get(ref)
    if (hit) {
      this.cache.delete(ref)
      this.cache.set(ref, hit)
      return Promise.resolve(hit.text)
    }
    const running = this.reading.get(ref)
    if (running) return running
    const read = this.read(ledgerDir, ref).finally(() => this.reading.delete(ref))
    this.reading.set(ref, read)
    return read
  }

  /** Writes the text's blob unless it is cached or already on disk; answers its ref. */
  async put(ledgerDir: string, text: string): Promise<Ref> {
    const ref = refOfText(text)
    if (this.cache.has(ref)) return ref
    const file = blobPath(ledgerDir, ref)
    const exists = await fs.stat(file).then(
      () => true,
      (err: unknown) => {
        if (isMissing(err)) return false
        throw err
      },
    )
    if (!exists) await writeAtomic(file, text)
    this.remember(ref, text)
    return ref
  }

  pin(ref: Ref): void {
    this.pins.set(ref, (this.pins.get(ref) ?? 0) + 1)
  }

  unpin(ref: Ref): void {
    const n = (this.pins.get(ref) ?? 0) - 1
    if (n > 0) this.pins.set(ref, n)
    else this.pins.delete(ref)
    this.evict()
  }

  private async read(ledgerDir: string, ref: Ref): Promise<string> {
    const file = blobPath(ledgerDir, ref)
    const { size } = await fs.stat(file)
    if (size > this.maxBlobBytes()) throw new BlobTooLargeError(ref, size)
    const text = await fs.readFile(file, 'utf8')
    this.remember(ref, text)
    return text
  }

  private remember(ref: Ref, text: string): void {
    if (this.cache.has(ref)) return
    const bytes = text.length * 2
    this.cache.set(ref, { text, bytes })
    this.bytes += bytes
    this.evict()
  }

  private evict(): void {
    for (const [ref, entry] of this.cache) {
      if (this.bytes <= this.maxBytes) return
      if (this.pins.has(ref)) continue
      this.cache.delete(ref)
      this.bytes -= entry.bytes
    }
  }
}
