// P1 DoD: folds every real 0.2 ledger on this machine through legacy02, read-only.
// Usage: npm run fold-legacy02 [-- <ledgers dir>]
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { emptyLedger02, foldEvents02, fromSnapshot02, idOfFileName02, parseEventText02, toImportEvents, type Event02 } from '../src/legacy02'

const dir = process.argv[2] ?? path.join(os.homedir(), '.claude', 'claude-review', 'ledgers')
let failures = 0

for (const name of readdirSync(dir).sort()) {
  const ledgerDir = path.join(dir, name)
  const eventsDir = path.join(ledgerDir, 'events')
  if (!existsSync(path.join(ledgerDir, 'meta.json'))) {
    console.log(`skip ${name}: no meta.json`)
    continue
  }
  try {
    const snapshotFile = path.join(ledgerDir, 'snapshot.json')
    const start = existsSync(snapshotFile) ? fromSnapshot02(JSON.parse(readFileSync(snapshotFile, 'utf8'))) : emptyLedger02
    if (start === undefined) throw new Error('snapshot.json does not parse')
    const names = existsSync(eventsDir) ? readdirSync(eventsDir).filter(n => idOfFileName02(n) !== undefined) : []
    const events: Event02[] = []
    let unparsed = 0
    for (const n of names) {
      const e = parseEventText02(readFileSync(path.join(eventsDir, n), 'utf8'))
      if (e) events.push(e)
      else unparsed++
    }
    const ledger = foldEvents02(start, events)
    const plan = toImportEvents(ledger, () => 'target')
    const imports = plan.events.get('target')?.length ?? 0
    console.log(
      `ok   ${name}: ${events.length} events (${unparsed} unparsed), ${ledger.files.size} pending files, ${ledger.turns.size} turns → ${imports} imports, ${plan.refs.size} blobs, ${plan.skipped.length} skipped`,
    )
  } catch (err) {
    failures++
    console.log(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`)
  }
}
process.exit(failures > 0 ? 1 : 0)
