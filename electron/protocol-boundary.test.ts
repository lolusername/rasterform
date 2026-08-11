import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { resolveProtocolFile } from './main-helpers'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))

async function sourceFiles(root: string): Promise<string[]> {
  const found: string[] = []
  const visit = async (directory: string) => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (/\.(?:ts|tsx|js|mjs|vue)$/.test(entry.name)) found.push(path)
    }
  }
  await visit(root)
  return found.sort()
}

describe('desktop custom protocol and dependency boundary', () => {
  it('resolves decoded app assets inside exactly one assigned protocol root', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'rasterform-protocol-test-'))
    const appRoot = join(temporary, 'web')
    const renderRoot = join(temporary, 'render')

    try {
      await mkdir(join(appRoot, 'assets'), { recursive: true })
      await mkdir(join(renderRoot, 'hdri'), { recursive: true })
      await writeFile(join(appRoot, 'index.html'), 'editor')
      await writeFile(join(appRoot, 'assets/app.js'), 'app')
      await writeFile(join(renderRoot, 'index.html'), 'renderer')
      await writeFile(join(renderRoot, 'hdri/studio small.hdr'), 'hdr')

      const editorIndex = resolveProtocolFile(appRoot, '/')
      const editorAsset = resolveProtocolFile(appRoot, '/assets/app.js')
      const rendererHdr = resolveProtocolFile(renderRoot, '/hdri/studio%20small.hdr')
      expect(editorIndex).toBe(join(appRoot, 'index.html'))
      expect(editorAsset).toBe(join(appRoot, 'assets/app.js'))
      expect(rendererHdr).toBe(join(renderRoot, 'hdri/studio small.hdr'))
      await expect(readFile(editorIndex!, 'utf8')).resolves.toBe('editor')
      await expect(readFile(rendererHdr!, 'utf8')).resolves.toBe('hdr')

      for (const attack of [
        '/..',
        '/../outside',
        '/%2e%2e/outside',
        '/assets/%2E%2E/outside',
        '/assets%2f..%2foutside',
        '/assets%5c..%5coutside',
        '/bad%00path',
        '/bad%zzpath',
        '/./index.html',
      ]) {
        expect(resolveProtocolFile(appRoot, attack), attack).toBeNull()
      }
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it('keeps Electron and Node built-ins outside every browser source module', async () => {
    const srcRoot = join(repositoryRoot, 'src')
    const violations: string[] = []

    for (const path of await sourceFiles(srcRoot)) {
      const source = await readFile(path, 'utf8')
      const imports = ts.preProcessFile(source, true, true).importedFiles.map((entry) => entry.fileName)
      for (const moduleName of imports) {
        if (moduleName === 'electron'
          || moduleName.startsWith('electron/')
          || moduleName.startsWith('node:')) {
          violations.push(`${relative(repositoryRoot, path)} -> ${moduleName}`)
        }
      }
    }

    expect(violations).toEqual([])
  })

  it('keeps Electron tooling out of the unchanged web dependency graph', async () => {
    const webPackage = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'))
    const desktopPackage = JSON.parse(await readFile(join(repositoryRoot, 'electron/package.json'), 'utf8'))
    const webDependencies = {
      ...webPackage.dependencies,
      ...webPackage.devDependencies,
    }

    expect(webDependencies).not.toHaveProperty('electron')
    expect(webDependencies).not.toHaveProperty('@electron/packager')
    expect(webPackage.scripts.build).toBe('vue-tsc --noEmit && vite build')
    expect(desktopPackage.devDependencies).toHaveProperty('electron')
    expect(desktopPackage.devDependencies).toHaveProperty('@electron/packager')
  })
})
