// §5.1 budgets: 10k lines with 10 hunks < 3 ms; 50k lines with 1k changed lines < 150 ms.
import { diffHunks } from '../src/diff'
import { diffHunks02 } from '../test/support/diff02'
import { seeded } from '../test/support/random'

type Case = { readonly name: string; readonly before: string; readonly after: string; readonly budgetMs: number }

const source = (n: number, random: () => number): string[] =>
  Array.from({ length: n }, (_, i) => `  const value${i} = compute(${Math.floor(random() * 1e6)}) // line ${i}\n`)

const withChanges = (lines: readonly string[], changes: number, random: () => number): string => {
  const out = [...lines]
  const stride = Math.floor(out.length / changes)
  for (let c = 0; c < changes; c++) {
    const at = c * stride + Math.floor(random() * Math.max(1, stride - 1))
    out[at] = `  const changed${c} = 1\n`
  }
  return out.join('')
}

const random = seeded(2026)
const ten = source(10_000, random)
const fifty = source(50_000, random)
const cases: readonly Case[] = [
  { name: '10k lines, 10 hunks', before: ten.join(''), after: withChanges(ten, 10, random), budgetMs: 3 },
  { name: '50k lines, 1k changed lines', before: fifty.join(''), after: withChanges(fifty, 1000, random), budgetMs: 150 },
]

const median = (xs: number[]): number => {
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN
}

const time = (fn: () => unknown, runs: number): number => {
  for (let i = 0; i < 3; i++) fn()
  const samples: number[] = []
  for (let i = 0; i < runs; i++) {
    const start = performance.now()
    fn()
    samples.push(performance.now() - start)
  }
  return median(samples)
}

let failed = false
for (const c of cases) {
  const v2 = time(() => diffHunks(c.before, c.after), 21)
  const old = time(() => diffHunks02(c.before, c.after), 7)
  const ok = v2 < c.budgetMs
  if (!ok) failed = true
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.name.padEnd(30)} v2 ${v2.toFixed(2).padStart(8)} ms   0.2 ${old.toFixed(2).padStart(8)} ms   budget ${c.budgetMs} ms`)
}
process.exit(failed ? 1 : 0)
