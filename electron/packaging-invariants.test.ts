import { execFile } from 'node:child_process'
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const electronRoot = fileURLToPath(new URL('.', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))

async function writeFixture(path: string, contents: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents)
}

describe('desktop packaging invariants', () => {
  it('pins the standalone desktop toolchain and lockfile exactly', async () => {
    const packageJson = JSON.parse(await readFile(join(electronRoot, 'package.json'), 'utf8'))
    const packageLock = JSON.parse(await readFile(join(electronRoot, 'package-lock.json'), 'utf8'))
    const dependencies = packageJson.devDependencies as Record<string, string>

    expect(packageJson.private).toBe(true)
    expect(packageJson.engines.node).toBe('>=22.12.0')
    expect(dependencies.electron).toBe('43.3.0')
    expect(dependencies['@electron/packager']).toBe('20.0.4')
    expect(dependencies['@electron/fuses']).toBe('2.1.3')
    expect(Object.values(dependencies).every((version) => /^\d+\.\d+\.\d+$/.test(version))).toBe(true)
    expect(packageLock.lockfileVersion).toBe(3)
    expect(packageLock.packages[''].devDependencies).toEqual(dependencies)
    expect(packageLock.packages['node_modules/electron'].version).toBe(dependencies.electron)
    expect(packageLock.packages['node_modules/@electron/packager'].version)
      .toBe(dependencies['@electron/packager'])
    expect(packageJson.scripts['package:arm64']).toContain('package.mjs arm64')
    expect(packageJson.scripts['package:x64']).toContain('package.mjs x64')
    expect(packageJson.scripts['package:universal']).toContain('package.mjs universal')
    expect(packageJson.scripts.package).toContain('package.mjs')
    expect(packageJson.scripts.package).not.toContain('universal')
    expect(packageJson.scripts['smoke:packaged']).toContain('npm run package')
    expect(packageJson.scripts['smoke:packaged']).toContain('smoke-packaged.mjs')
    expect(packageJson.scripts['smoke:packaged']).not.toContain('universal')
    expect(packageJson.scripts['smoke:packaged:arm64']).toContain('package:arm64')
    expect(packageJson.scripts['package:lab:arm64']).toContain('RASTERFORM_RENDERER_LAB=1')
    expect(packageJson.scripts['smoke:packaged:lab:arm64']).toContain('RASTERFORM_RENDERER_LAB=1')
    expect(packageJson.scripts['verify:packaged:lab:arm64']).toContain('RASTERFORM_RENDERER_LAB=1')
    expect(packageJson.scripts['smoke:packaged:existing:universal'])
      .toContain('smoke-packaged.mjs universal')
    expect(packageJson.scripts['verify:packaged:universal']).toContain('verify-package.mjs')
  })

  it('packages a real multi-resolution Rasterform ICNS derived from the web mark', async () => {
    const icon = await readFile(join(electronRoot, 'assets', 'Rasterform.icns'))
    expect(icon.subarray(0, 4).toString('ascii')).toBe('icns')
    expect(icon.readUInt32BE(4)).toBe(icon.byteLength)

    const chunkTypes = new Set<string>()
    let offset = 8
    while (offset < icon.byteLength) {
      const type = icon.subarray(offset, offset + 4).toString('ascii')
      const length = icon.readUInt32BE(offset + 4)
      expect(length).toBeGreaterThan(8)
      expect(offset + length).toBeLessThanOrEqual(icon.byteLength)
      chunkTypes.add(type)
      offset += length
    }
    expect(offset).toBe(icon.byteLength)
    expect([...chunkTypes]).toEqual(expect.arrayContaining([
      'icp4', 'icp5', 'icp6', 'ic07', 'ic08', 'ic09', 'ic10',
    ]))

    const generator = await readFile(join(electronRoot, 'scripts', 'generate-icon.mjs'), 'utf8')
    expect(generator).toContain("'public', 'favicon.svg'")
    expect(generator).toContain("join(electronRoot, 'assets', 'Rasterform.icns')")
  })

  it('maps each artifact label to its required Mach-O architecture set', async () => {
    const verifierUrl = pathToFileURL(join(electronRoot, 'scripts', 'verify-package.mjs')).href
    const source = `
      import { expectedArchitecturesForPackage } from ${JSON.stringify(verifierUrl)};
      console.log(JSON.stringify({
        arm64: expectedArchitecturesForPackage('arm64'),
        x64: expectedArchitecturesForPackage('x64'),
        universal: expectedArchitecturesForPackage('universal'),
      }));
    `
    const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', source])
    expect(JSON.parse(stdout)).toEqual({
      arm64: ['arm64'],
      x64: ['x86_64'],
      universal: ['arm64', 'x86_64'],
    })
  })

  it('defaults to the native package and refuses Rosetta smoke launches', async () => {
    const architectureUrl = pathToFileURL(join(electronRoot, 'scripts', 'architecture.mjs')).href
    const source = `
      import {
        physicalMacArchitecture,
        resolvePackageArchitectures,
        resolvePackagedSmokeArchitecture,
      } from ${JSON.stringify(architectureUrl)};
      const failure = (architecture, host) => {
        try {
          resolvePackagedSmokeArchitecture(architecture, host);
          return null;
        } catch (error) {
          return error.message;
        }
      };
      console.log(JSON.stringify({
        armDefault: resolvePackageArchitectures([], 'arm64'),
        intelDefault: resolvePackageArchitectures([], 'x64'),
        nativeArmNode: physicalMacArchitecture('arm64', true),
        translatedX64Node: physicalMacArchitecture('x64', true),
        nativeIntelNode: physicalMacArchitecture('x64', false),
        explicitUniversal: resolvePackageArchitectures(['universal'], 'arm64'),
        armSmoke: resolvePackagedSmokeArchitecture(undefined, 'arm64'),
        intelSmoke: resolvePackagedSmokeArchitecture(undefined, 'x64'),
        universalOnArm: resolvePackagedSmokeArchitecture('universal', 'arm64'),
        x64OnArm: failure('x64', 'arm64'),
        armOnX64: failure('arm64', 'x64'),
      }));
    `
    const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', source])
    expect(JSON.parse(stdout)).toEqual({
      armDefault: ['arm64'],
      intelDefault: ['x64'],
      nativeArmNode: 'arm64',
      translatedX64Node: 'arm64',
      nativeIntelNode: 'x64',
      explicitUniversal: ['universal'],
      armSmoke: 'arm64',
      intelSmoke: 'x64',
      universalOnArm: 'universal',
      x64OnArm: expect.stringContaining('Refusing to launch the x64 Rasterform package'),
      armOnX64: expect.stringContaining('Refusing to launch the arm64 Rasterform package'),
    })
  })

  it('hardens package metadata, every Electron fuse, and packaged smoke execution', async () => {
    const [contract, packageScript, smokeScript, packagedSmoke, mainSource, verifier] = await Promise.all([
      readFile(join(electronRoot, 'scripts', 'package-contract.mjs'), 'utf8'),
      readFile(join(electronRoot, 'scripts', 'package.mjs'), 'utf8'),
      readFile(join(electronRoot, 'scripts', 'smoke.mjs'), 'utf8'),
      readFile(join(electronRoot, 'scripts', 'smoke-packaged.mjs'), 'utf8'),
      readFile(join(electronRoot, 'main.ts'), 'utf8'),
      readFile(join(electronRoot, 'scripts', 'verify-package.mjs'), 'utf8'),
    ])

    expect(contract).toContain('public.app-category.graphics-design')
    expect(contract).toMatch(/NSAllowsArbitraryLoads:\s*false/)
    expect(contract).toMatch(/RunAsNode\]:\s*false/)
    expect(contract).toMatch(/EnableNodeOptionsEnvironmentVariable\]:\s*false/)
    expect(contract).toMatch(/EnableNodeCliInspectArguments\]:\s*false/)
    expect(contract).toMatch(/EnableEmbeddedAsarIntegrityValidation\]:\s*true/)
    expect(contract).toMatch(/OnlyLoadAppFromAsar\]:\s*true/)
    expect(contract).toMatch(/GrantFileProtocolExtraPrivileges\]:\s*false/)
    expect(contract).toContain('strictlyRequireAllFuses: true')
    expect(contract).toContain("['arm64', 'x64', 'universal'].includes(architecture)")
    expect(packageScript).toContain('flipFuses(')
    expect(packageScript).toContain('verifyPackagedApplication(applicationPath, architecture, {')
    expect(packageScript).toContain("bundleId = rendererLab ? 'io.atil.rasterform.rendererlab'")
    expect(packageScript).toContain("CFBundleIconFile: 'Rasterform.icns'")

    expect(smokeScript).toContain('delete childEnvironment.ELECTRON_RUN_AS_NODE')
    expect(smokeScript).toContain('delete childEnvironment.NODE_OPTIONS')
    expect(smokeScript).toContain('SMOKE_TIMEOUT_MS = 90_000')
    expect(smokeScript).toContain("child.kill('SIGKILL')")
    expect(smokeScript).not.toMatch(/--remote-debugging-port|--inspect(?:-brk)?/)
    expect(packagedSmoke).toContain('verifyPackagedApplication(applicationPath, architecture, {')
    expect(packagedSmoke).toContain("join(scriptsDirectory, 'smoke.mjs')")
    expect(packagedSmoke).toContain('resolvePackagedSmokeArchitecture(process.argv[2])')
    expect(packageScript).toContain('resolvePackageArchitectures(process.argv.slice(2))')

    expect(mainSource).toContain('DESKTOP_SMOKE_HEARTBEAT_MAX_ATTEMPTS')
    expect(mainSource).toContain('desktopSmokeHeartbeatBeatsDuringBlock(')
    expect(mainSource).toContain('data.serialized.roots')
    expect(mainSource).toContain('worker.postMessage({')
    expect(mainSource).not.toContain('setTimeout(() => finish(true), 400)')

    expect(verifier).toContain('async function listRegularFiles(')
    expect(verifier).toContain('sameStringSet(executableArchitectures, expectedArchitectures)')
    expect(verifier).toContain('-darwin-(arm64|x64|universal)')
    expect(verifier).toContain("execFileAsync('lipo', ['-archs'")
    expect(verifier).toContain("execFileAsync('vtool', ['-show-build'")
    expect(verifier).toContain("'--deep'")
    expect(verifier).toContain("'--strict'")
    expect(verifier).toContain('identity and notarization not assessed')
  })

  it('stages a clean, dependency-free runtime with both web and Final-render assets', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'rasterform-stage-test-'))
    const fixtureRoot = join(temporary, 'repository')
    const fixtureElectron = join(fixtureRoot, 'electron')
    const fixtureScript = join(fixtureElectron, 'scripts', 'stage.mjs')

    try {
      await mkdir(dirname(fixtureScript), { recursive: true })
      await copyFile(join(electronRoot, 'scripts', 'stage.mjs'), fixtureScript)
      await writeFixture(join(fixtureRoot, 'package.json'), JSON.stringify({ version: '9.8.7' }))
      await writeFixture(join(fixtureRoot, 'dist/index.html'), '<h1>web editor</h1>')
      await writeFixture(join(fixtureRoot, 'dist/assets/editor.js'), 'editor payload')
      await writeFixture(
        join(fixtureRoot, 'dist/assets/editor.css'),
        '@import"https://use.typekit.net/mot7rkh.css";'
          + '@import"https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&display=swap";'
          + ':root{font-family:Helvetica,Arial,sans-serif}',
      )
      await writeFixture(join(fixtureRoot, 'dist/hdri/studio_small_08_1k.hdr'), 'web hdr')
      await writeFixture(join(fixtureElectron, '.build/render/index.html'), '<h1>hidden renderer</h1>')
      await writeFixture(join(fixtureElectron, '.build/render/assets/final.js'), 'renderer payload')
      await writeFixture(
        join(fixtureElectron, '.build/render/assets/generateMeshBVH.worker.js'),
        'bvh worker payload',
      )
      await writeFixture(
        join(fixtureElectron, '.build/render/hdri/studio_small_08_1k.hdr'),
        'render hdr',
      )
      await writeFixture(join(fixtureElectron, '.build/runtime/main.cjs'), 'main runtime')
      await writeFixture(join(fixtureElectron, '.build/runtime/preload.cjs'), 'editor preload')
      await writeFixture(join(fixtureElectron, '.build/runtime/render-preload.cjs'), 'render preload')
      await writeFixture(join(fixtureElectron, 'cycles/render.py'), 'cycles renderer')
      await writeFixture(join(fixtureElectron, '.stage/stale.txt'), 'must be deleted')

      await execFileAsync(process.execPath, [fixtureScript], { cwd: fixtureElectron })

      const stage = join(fixtureElectron, '.stage')
      await expect(access(join(stage, 'stale.txt'))).rejects.toThrow()
      await expect(readFile(join(stage, 'main.cjs'), 'utf8')).resolves.toBe('main runtime')
      await expect(readFile(join(stage, 'preload.cjs'), 'utf8')).resolves.toBe('editor preload')
      await expect(readFile(join(stage, 'render-preload.cjs'), 'utf8')).resolves.toBe('render preload')
      await expect(readFile(join(stage, 'web/index.html'), 'utf8')).resolves.toBe('<h1>web editor</h1>')
      await expect(readFile(join(stage, 'web/assets/editor.js'), 'utf8')).resolves.toBe('editor payload')
      await expect(readFile(join(stage, 'web/assets/editor.css'), 'utf8')).resolves.toBe(
        ':root{font-family:Helvetica,Arial,sans-serif}',
      )
      await expect(readFile(join(fixtureRoot, 'dist/assets/editor.css'), 'utf8')).resolves.toContain(
        'https://use.typekit.net/mot7rkh.css',
      )
      await expect(readFile(join(stage, 'web/hdri/studio_small_08_1k.hdr'), 'utf8')).resolves.toBe('web hdr')
      await expect(readFile(join(stage, 'render/index.html'), 'utf8')).resolves.toBe('<h1>hidden renderer</h1>')
      await expect(readFile(join(stage, 'render/assets/final.js'), 'utf8')).resolves.toBe('renderer payload')
      await expect(
        readFile(join(stage, 'render/assets/generateMeshBVH.worker.js'), 'utf8'),
      ).resolves.toBe('bvh worker payload')
      await expect(
        readFile(join(stage, 'render/hdri/studio_small_08_1k.hdr'), 'utf8'),
      ).resolves.toBe('render hdr')
      await expect(readFile(join(stage, 'cycles/render.py'), 'utf8')).resolves.toBe('cycles renderer')

      const runtimePackage = JSON.parse(await readFile(join(stage, 'package.json'), 'utf8'))
      expect(runtimePackage).toMatchObject({
        name: 'rasterform-desktop-runtime',
        productName: 'Rasterform',
        version: '9.8.7',
        private: true,
        type: 'commonjs',
        main: 'main.cjs',
      })
      expect(runtimePackage).not.toHaveProperty('dependencies')
      expect(runtimePackage).not.toHaveProperty('devDependencies')
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it('keeps the source HDR available to both independent Vite builds', async () => {
    const hdr = await readFile(join(repositoryRoot, 'public/hdri/studio_small_08_1k.hdr'))
    const attribution = await readFile(join(repositoryRoot, 'public/hdri/ATTRIBUTION.md'), 'utf8')

    expect(hdr.byteLength).toBeGreaterThan(1_000)
    expect(attribution.trim().length).toBeGreaterThan(0)
  })
})
