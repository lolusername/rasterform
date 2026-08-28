import { access, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsDirectory = dirname(fileURLToPath(import.meta.url))
const electronRoot = join(scriptsDirectory, '..')
const repositoryRoot = join(electronRoot, '..')
const runtimeDirectory = join(electronRoot, '.build', 'runtime')
const renderDirectory = join(electronRoot, '.build', 'render')
const webDirectory = join(repositoryRoot, 'dist')
const stageDirectory = join(electronRoot, '.stage')
const cyclesDirectory = join(electronRoot, 'cycles')
const rendererLab = process.env.RASTERFORM_RENDERER_LAB === '1'
const desktopBlockedFontUrls = [
  'https://use.typekit.net/mot7rkh.css',
  'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&display=swap',
]

const requiredInputs = [
  join(runtimeDirectory, 'main.cjs'),
  join(runtimeDirectory, 'preload.cjs'),
  join(runtimeDirectory, 'render-preload.cjs'),
  join(renderDirectory, 'index.html'),
  join(webDirectory, 'index.html'),
  join(cyclesDirectory, 'render.py'),
  join(cyclesDirectory, 'export_blend.py'),
]

await Promise.all(requiredInputs.map((input) => access(input)))

const repositoryPackage = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'))
const runtimePackage = {
  name: 'rasterform-desktop-runtime',
  productName: rendererLab ? 'Rasterform Renderer Lab' : 'Rasterform',
  version: repositoryPackage.version,
  private: true,
  type: 'commonjs',
  main: 'main.cjs',
  engines: {
    node: '>=22.12.0',
  },
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await listFiles(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

function escapedRegularExpression(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function makeDesktopWebBundleOffline(directory) {
  const files = await listFiles(directory)
  const cssFiles = files.filter((path) => path.endsWith('.css'))
  const removedImports = new Map(desktopBlockedFontUrls.map((url) => [url, 0]))

  for (const path of cssFiles) {
    let source = await readFile(path, 'utf8')
    const original = source
    for (const url of desktopBlockedFontUrls) {
      const pattern = new RegExp(
        `@import\\s*(?:url\\(\\s*)?(["'])${escapedRegularExpression(url)}\\1\\s*\\)?\\s*;`,
        'g',
      )
      source = source.replace(pattern, () => {
        removedImports.set(url, removedImports.get(url) + 1)
        return ''
      })
    }
    if (source !== original) await writeFile(path, source, 'utf8')
  }

  for (const url of desktopBlockedFontUrls) {
    if (removedImports.get(url) !== 1) {
      throw new Error(`Expected exactly one desktop font import for ${url}.`)
    }
  }
  for (const path of files.filter((file) => /\.(?:css|html|js|map)$/.test(file))) {
    const source = await readFile(path, 'utf8')
    for (const url of desktopBlockedFontUrls) {
      if (source.includes(url)) throw new Error(`Remote font URL remained in desktop stage: ${url}`)
    }
  }
}

await rm(stageDirectory, { recursive: true, force: true })
await mkdir(stageDirectory, { recursive: true })
await cp(runtimeDirectory, stageDirectory, { recursive: true })
await cp(webDirectory, join(stageDirectory, 'web'), { recursive: true })
await cp(renderDirectory, join(stageDirectory, 'render'), { recursive: true })
await cp(cyclesDirectory, join(stageDirectory, 'cycles'), { recursive: true })
await makeDesktopWebBundleOffline(join(stageDirectory, 'web'))
await writeFile(
  join(stageDirectory, 'package.json'),
  `${JSON.stringify(runtimePackage, null, 2)}\n`,
  'utf8',
)

console.log(`Staged Rasterform desktop runtime at ${stageDirectory}`)
