import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { flipFuses } from '@electron/fuses'
import {
  fuseConfigurationForArchitecture,
  MAC_APP_CATEGORY,
  MAC_APP_TRANSPORT_SECURITY,
  MAC_MINIMUM_SYSTEM_VERSION,
  UNUSED_USAGE_DESCRIPTION_KEYS,
} from './package-contract.mjs'
import { resolvePackageArchitectures } from './architecture.mjs'
import { verifyPackagedApplication } from './verify-package.mjs'

const require = createRequire(import.meta.url)
const { packager } = require('@electron/packager')
const execFileAsync = promisify(execFile)
const scriptsDirectory = dirname(fileURLToPath(import.meta.url))
const electronRoot = join(scriptsDirectory, '..')
const repositoryRoot = join(electronRoot, '..')
const stageDirectory = join(electronRoot, '.stage')
const outputDirectory = join(electronRoot, 'out')
const iconPath = join(electronRoot, 'assets', 'Rasterform.icns')
const architectures = resolvePackageArchitectures(process.argv.slice(2))

if (process.platform !== 'darwin') {
  throw new Error('Rasterform macOS packages must be built on macOS.')
}

await access(join(stageDirectory, 'package.json'))
await access(join(stageDirectory, 'main.cjs'))
await access(iconPath)

const repositoryPackage = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'))

async function removeUnusedUsageDescriptions(applicationPath) {
  const infoPath = join(applicationPath, 'Contents', 'Info.plist')
  const { stdout } = await execFileAsync('plutil', ['-convert', 'json', '-o', '-', '--', infoPath])
  const info = JSON.parse(stdout)
  for (const key of UNUSED_USAGE_DESCRIPTION_KEYS) {
    if (key in info) await execFileAsync('plutil', ['-remove', key, '--', infoPath])
  }
}

function applicationBundlePath(packagerOutputPath) {
  return basename(packagerOutputPath).endsWith('.app')
    ? packagerOutputPath
    : join(packagerOutputPath, 'Rasterform.app')
}

for (const architecture of architectures) {
  const applicationPaths = await packager({
    dir: stageDirectory,
    name: 'Rasterform',
    executableName: 'Rasterform',
    platform: 'darwin',
    arch: architecture,
    electronVersion: '43.3.0',
    out: outputDirectory,
    overwrite: true,
    asar: true,
    prune: false,
    icon: iconPath,
    appBundleId: 'io.atil.rasterform',
    helperBundleId: 'io.atil.rasterform.helper',
    appCategoryType: MAC_APP_CATEGORY,
    appVersion: repositoryPackage.version,
    buildVersion: repositoryPackage.version,
    extendInfo: {
      CFBundleIconFile: 'Rasterform.icns',
      LSMinimumSystemVersion: MAC_MINIMUM_SYSTEM_VERSION,
      NSAppTransportSecurity: MAC_APP_TRANSPORT_SECURITY,
      NSHighResolutionCapable: true,
    },
    extendHelperInfo: {
      LSMinimumSystemVersion: MAC_MINIMUM_SYSTEM_VERSION,
    },
  })

  const applicationBundles = applicationPaths.map(applicationBundlePath)
  for (const applicationPath of applicationBundles) {
    await removeUnusedUsageDescriptions(applicationPath)
    const flippedFuseWires = await flipFuses(
      join(applicationPath, 'Contents', 'MacOS', 'Rasterform'),
      fuseConfigurationForArchitecture(architecture),
    )
    const expectedFuseWires = architecture === 'universal' ? 2 : 1
    if (flippedFuseWires !== expectedFuseWires) {
      throw new Error(
        `Expected to harden ${expectedFuseWires} ${architecture} fuse wire(s), found ${flippedFuseWires}.`,
      )
    }
    const verification = await verifyPackagedApplication(applicationPath, architecture)
    console.log(`Hardened ${architecture} package: ${JSON.stringify(verification)}`)
  }

  console.log(`Created ad-hoc-signed development ${architecture} package:\n${applicationBundles.join('\n')}`)
}
