// Fails when marketplace.json no longer points at the mod it lists.
import { existsSync, readFileSync } from 'node:fs'
import * as path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const market = JSON.parse(readFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8'))
const problems = []

if (market.name !== 'claude-review') problems.push(`marketplace name is ${JSON.stringify(market.name)}, expected "claude-review"`)
if (typeof market.owner?.name !== 'string') problems.push('marketplace owner.name is missing')
for (const plugin of market.plugins ?? []) {
  const manifest = path.join(root, plugin.source, '.claude-plugin', 'plugin.json')
  if (!existsSync(manifest)) {
    problems.push(`${plugin.name}: no plugin.json at ${manifest}`)
    continue
  }
  const { name } = JSON.parse(readFileSync(manifest, 'utf8'))
  if (name !== plugin.name) problems.push(`${plugin.name}: plugin.json names it ${JSON.stringify(name)}`)
}
if ((market.plugins ?? []).length === 0) problems.push('marketplace lists no plugins')

if (problems.length > 0) {
  console.error(problems.join('\n'))
  process.exit(1)
}
console.log('marketplace.json ok')
