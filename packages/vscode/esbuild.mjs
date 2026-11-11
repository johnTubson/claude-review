// Bundles the extension and its diff worker; `--unit` bundles only the unit
// tests, `--tests` the integration tests too.
import { readdirSync } from 'node:fs'
import * as esbuild from 'esbuild'

const isWatch = process.argv.includes('--watch')
const withTests = process.argv.includes('--tests')
const isUnitOnly = process.argv.includes('--unit')

const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node20', sourcemap: true, external: ['vscode'], logLevel: 'warning' }
const unit = {
  ...common,
  entryPoints: readdirSync('test/unit')
    .filter(n => n.endsWith('.test.ts'))
    .map(n => `test/unit/${n}`),
  outdir: 'dist-test/unit',
}

const worker = { ...common, entryPoints: ['src/review/diffWorker.ts'], outfile: 'dist/diffWorker.js' }
const builds = isUnitOnly
  ? [unit, worker]
  : [
      { ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js' },
      worker,
    ]
if (withTests) {
  builds.push(
    unit,
    { ...common, entryPoints: ['test/runIntegration.ts'], outfile: 'dist-test/runIntegration.js', external: ['vscode', '@vscode/test-electron'] },
    { ...common, entryPoints: ['test/suite/index.ts'], outfile: 'dist-test/suite/index.js' },
  )
}

if (isWatch) {
  for (const b of builds) await (await esbuild.context(b)).watch()
} else {
  await Promise.all(builds.map(b => esbuild.build(b)))
}
