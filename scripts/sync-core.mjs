// Copies packages/core/src into the mod (packages/mod/hooks/core/): the mod runs
// with no npm and loads only files under its own folder. `--check` fails when
// the copy has drifted instead of writing it.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const from = path.join(root, 'packages', 'core', 'src')
const to = path.join(root, 'packages', 'mod', 'hooks', 'core')
const isCheck = process.argv.includes('--check')

const header = name =>
  `// Generated from packages/core/src/${name} by scripts/sync-core.mjs: edit the original, then run \`npm run sync-core\`.\n\n`
const wanted = new Map(
  readdirSync(from)
    .filter(n => n.endsWith('.ts'))
    .map(n => [n, header(n) + readFileSync(path.join(from, n), 'utf8')]),
)
const present = existsSync(to) ? readdirSync(to).filter(n => n.endsWith('.ts')) : []

const drifted = [...wanted]
  .filter(([n, text]) => !existsSync(path.join(to, n)) || readFileSync(path.join(to, n), 'utf8') !== text)
  .map(([n]) => n)
const extra = present.filter(n => !wanted.has(n))

if (isCheck) {
  if (drifted.length + extra.length > 0) {
    console.error(`packages/mod/hooks/core is out of date (${[...drifted, ...extra].join(', ')}): run npm run sync-core`)
    process.exit(1)
  }
} else {
  mkdirSync(to, { recursive: true })
  for (const n of extra) rmSync(path.join(to, n))
  for (const [n, text] of wanted) writeFileSync(path.join(to, n), text)
  console.log(`synced ${wanted.size} core file(s) into packages/mod/hooks/core`)
}
