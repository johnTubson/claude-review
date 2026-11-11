// File helpers for the extension's writes: every file is written whole (tmp +
// rename), so a reader never sees half of it (§4.6).

import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'

export const isMissing = (err: unknown): boolean => err instanceof Error && 'code' in err && err.code === 'ENOENT'
export const isExisting = (err: unknown): boolean => err instanceof Error && 'code' in err && err.code === 'EEXIST'

const tmpName = (file: string): string => `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`

export const writeAtomic = async (file: string, text: string): Promise<void> => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = tmpName(file)
  await fs.writeFile(tmp, text)
  await fs.rename(tmp, file)
}

/** As writeAtomic, and survives a power cut: the file is synced before the rename, and its directory after. */
export const writeDurable = async (file: string, text: string): Promise<void> => {
  const dir = path.dirname(file)
  await fs.mkdir(dir, { recursive: true })
  const tmp = tmpName(file)
  const handle = await fs.open(tmp, 'w')
  try {
    await handle.writeFile(text)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(tmp, file)
  const dirHandle = await fs.open(dir, 'r')
  try {
    await dirHandle.sync()
  } finally {
    await dirHandle.close()
  }
}

export const readTextIfPresent = async (file: string): Promise<string | undefined> => {
  try {
    return await fs.readFile(file, 'utf8')
  } catch (err) {
    if (isMissing(err)) return undefined
    throw err
  }
}

export const listIfPresent = async (dir: string): Promise<string[]> => {
  try {
    return await fs.readdir(dir)
  } catch (err) {
    if (isMissing(err)) return []
    throw err
  }
}
