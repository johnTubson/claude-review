// Bundles test/*.test.ts or bench/*.bench.ts into dist-test/ for plain `node`.
import { readdirSync } from 'node:fs'
import * as path from 'node:path'
import * as esbuild from 'esbuild'

const kind = process.argv[2] === 'bench' ? 'bench' : 'test'
const dir = path.join(import.meta.dirname, kind)
const entryPoints = readdirSync(dir)
  .filter(n => n.endsWith(`.${kind}.ts`))
  .map(n => path.join(dir, n))

await esbuild.build({
  entryPoints,
  outdir: path.join(import.meta.dirname, 'dist-test', kind),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  logLevel: 'warning',
})
