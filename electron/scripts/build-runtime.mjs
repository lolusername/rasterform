import { access, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const scriptsDirectory = dirname(fileURLToPath(import.meta.url))
const electronRoot = join(scriptsDirectory, '..')
const outputDirectory = join(electronRoot, '.build', 'runtime')
const entryPoints = {
  main: join(electronRoot, 'main.ts'),
  preload: join(electronRoot, 'preload.ts'),
  'render-preload': join(electronRoot, 'render-preload.ts'),
}

await Promise.all(Object.values(entryPoints).map((entry) => access(entry)))
await rm(outputDirectory, { recursive: true, force: true })

await build({
  entryPoints,
  outdir: outputDirectory,
  entryNames: '[name]',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron'],
  sourcemap: true,
  sourcesContent: false,
  legalComments: 'none',
  logLevel: 'info',
})
