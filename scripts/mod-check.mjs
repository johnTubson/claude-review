// Runs `claude plugin validate|test packages/mod`. The CLI is found as
// CLAUDE_BIN, else `claude` on PATH, else the binary the Claude Code VS Code
// extension ships; without any the step is skipped loudly rather than passing
// silently, and REQUIRE_CLAUDE=1 turns the skip into a failure.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const action = process.argv[2]
if (action !== 'validate' && action !== 'test') {
  console.error('usage: mod-check.mjs validate|test')
  process.exit(2)
}
const extensionBinary = () => {
  const dir = path.join(os.homedir(), '.vscode', 'extensions')
  if (!existsSync(dir)) return undefined
  const newest = readdirSync(dir)
    .filter(n => n.startsWith('anthropic.claude-code-'))
    .map(n => path.join(dir, n, 'resources', 'native-binary', 'claude'))
    .filter(p => existsSync(p))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .at(-1)
  return newest
}
const onPath = spawnSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).stdout.trim()
const bin = process.env.CLAUDE_BIN ?? (onPath || extensionBinary() || 'claude')
const mod = path.resolve(import.meta.dirname, '..', 'packages', 'mod')
const ran = spawnSync(bin, ['plugin', action, mod], { stdio: 'inherit' })

if (ran.error && 'code' in ran.error && ran.error.code === 'ENOENT') {
  const message = `SKIPPED: claude plugin ${action} (no \`${bin}\` on PATH; set CLAUDE_BIN)`
  if (process.env.REQUIRE_CLAUDE === '1') {
    console.error(message)
    process.exit(1)
  }
  console.warn(`\u001b[33m${message}\u001b[0m`)
  process.exit(0)
}
process.exit(ran.status ?? 1)
