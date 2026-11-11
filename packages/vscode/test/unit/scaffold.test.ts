import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import * as path from 'node:path'
import { test } from 'node:test'

const srcDir = path.resolve(__dirname, '..', '..', 'src')

const filesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap(name => {
    const full = path.join(dir, name)
    return statSync(full).isDirectory() ? filesUnder(full) : [full]
  })

test('E5: the extension creates no webviews', () => {
  const offenders = filesUnder(srcDir).filter(f => /createWebview|registerWebview/.test(readFileSync(f, 'utf8')))
  assert.deepEqual(offenders, [])
})
