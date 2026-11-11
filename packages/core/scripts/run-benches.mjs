// Runs every bundled bench in order; a bench exits non-zero when it misses its budget.
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import * as path from 'node:path'

const dir = path.join(import.meta.dirname, '..', 'dist-test', 'bench')
let failed = false
for (const name of readdirSync(dir).filter(n => n.endsWith('.bench.js')).sort()) {
  console.log(`\n# ${name}`)
  const ran = spawnSync(process.execPath, ['--expose-gc', path.join(dir, name)], { stdio: 'inherit' })
  if (ran.status !== 0) failed = true
}
process.exit(failed ? 1 : 0)
