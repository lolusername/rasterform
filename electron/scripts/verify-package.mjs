import { execFile } from 'node:child_process'
import { access, mkdtemp, open, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  FuseState,
  FuseV1Options,
  FuseVersion,
  getCurrentFuseWire,
} from '@electron/fuses'
import {
  MAC_APP_CATEGORY,
  MAC_APP_TRANSPORT_SECURITY,
  MAC_MINIMUM_SYSTEM_VERSION,
  RASTERFORM_FUSE_SETTINGS,
  UNUSED_USAGE_DESCRIPTION_KEYS,
} from './package-contract.mjs'

const execFileAsync = promisify(execFile)
const MACH_O_MAGICS = new Set([
  0xfeedface,
  0xfeedfacf,
  0xcefaedfe,
  0xcffaedfe,
  0xcafebabe,
  0xcafebabf,
  0xbebafeca,
  0xbfbafeca,
])

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

export function expectedArchitecturesForPackage(architecture) {
  if (architecture === 'arm64') return ['arm64']
  if (architecture === 'x64') return ['x86_64']
  if (architecture === 'universal') return ['arm64', 'x86_64']
  throw new Error(`Unsupported package architecture label: ${architecture}`)
}

function inferPackageArchitecture(applicationPath) {
  const artifactDirectory = basename(dirname(applicationPath))
  const match = artifactDirectory.match(/-darwin-(arm64|x64|universal)$/)
  invariant(match, `Cannot infer package architecture from ${artifactDirectory}. Pass it explicitly.`)
  return match[1]
}

async function readPlist(path) {
  const { stdout } = await execFileAsync('plutil', ['-convert', 'json', '-o', '-', '--', path])
  return JSON.parse(stdout)
}

async function readArchitectures(executablePath) {
  const { stdout } = await execFileAsync('lipo', ['-archs', executablePath])
  const architectures = stdout.trim().split(/\s+/).filter(Boolean)
  invariant(architectures.length > 0, 'The packaged executable has no Mach-O architecture.')
  return architectures
}

async function listRegularFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await listRegularFiles(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

async function isMachO(path) {
  const handle = await open(path, 'r')
  try {
    const header = Buffer.alloc(4)
    const { bytesRead } = await handle.read(header, 0, header.byteLength, 0)
    return bytesRead === header.byteLength && MACH_O_MAGICS.has(header.readUInt32BE(0))
  } finally {
    await handle.close()
  }
}

function sameStringSet(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
}

async function readDeploymentTargets(executablePath) {
  const { stdout } = await execFileAsync('vtool', ['-show-build', executablePath])
  return [...stdout.matchAll(/^\s+minos\s+([0-9]+(?:\.[0-9]+){1,2})\s*$/gm)]
    .map((match) => match[1])
}

async function inspectMachOBinaries(applicationPath, expectedArchitectures) {
  const allFiles = await listRegularFiles(join(applicationPath, 'Contents'))
  const machOBinaries = []
  for (const path of allFiles) {
    if (await isMachO(path)) machOBinaries.push(path)
  }
  invariant(machOBinaries.length > 0, 'The application contains no Mach-O binaries.')

  const inspected = []
  for (const path of machOBinaries) {
    const [architectures, deploymentTargets] = await Promise.all([
      readArchitectures(path),
      readDeploymentTargets(path),
    ])
    const displayPath = relative(applicationPath, path)
    invariant(
      sameStringSet(architectures, expectedArchitectures),
      `${displayPath} has architectures ${architectures.join(', ')}, expected ${expectedArchitectures.join(', ')}.`,
    )
    invariant(
      deploymentTargets.length === architectures.length,
      `${displayPath} does not declare one macOS deployment target per architecture.`,
    )
    invariant(
      deploymentTargets.every((target) => target === MAC_MINIMUM_SYSTEM_VERSION),
      `${displayPath} targets macOS ${deploymentTargets.join(', ')}, expected ${MAC_MINIMUM_SYSTEM_VERSION}.`,
    )
    inspected.push({ path: displayPath, architectures, deploymentTargets })
  }
  return inspected
}

async function readFuseWiresByArchitecture(fuseBinaryPath) {
  const architectures = await readArchitectures(fuseBinaryPath)
  if (architectures.length === 1) {
    return new Map([[architectures[0], await getCurrentFuseWire(fuseBinaryPath)]])
  }

  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'rasterform-fuses-'))
  try {
    const wires = new Map()
    for (const architecture of architectures) {
      const thinFuseBinary = join(temporaryDirectory, `Electron-Framework-${architecture}`)
      await execFileAsync('lipo', [fuseBinaryPath, '-thin', architecture, '-output', thinFuseBinary])
      wires.set(architecture, await getCurrentFuseWire(thinFuseBinary))
    }
    return wires
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

function assertIcns(bytes) {
  invariant(bytes.byteLength >= 16, 'The Rasterform icon is empty.')
  invariant(bytes.subarray(0, 4).toString('ascii') === 'icns', 'The app icon is not an ICNS container.')
  invariant(bytes.readUInt32BE(4) === bytes.byteLength, 'The app icon has an invalid ICNS length.')
  const chunkTypes = new Set()
  let offset = 8
  while (offset < bytes.byteLength) {
    invariant(offset + 8 <= bytes.byteLength, 'The app icon has a truncated ICNS chunk.')
    const type = bytes.subarray(offset, offset + 4).toString('ascii')
    const length = bytes.readUInt32BE(offset + 4)
    invariant(length >= 8 && offset + length <= bytes.byteLength, `Invalid ${type} icon chunk.`)
    chunkTypes.add(type)
    offset += length
  }
  invariant(offset === bytes.byteLength, 'The app icon contains trailing data.')
  for (const required of ['icp4', 'icp5', 'icp6', 'ic07', 'ic08', 'ic09', 'ic10']) {
    invariant(chunkTypes.has(required), `The app icon is missing its ${required} resolution.`)
  }
}

export async function verifyPackagedApplication(applicationPath, packageArchitecture, options = {}) {
  const resolvedApplication = resolve(applicationPath)
  const executableName = options.executableName ?? 'Rasterform'
  const expectedBundleId = options.bundleId ?? 'io.atil.rasterform'
  const resolvedPackageArchitecture = packageArchitecture
    ?? inferPackageArchitecture(resolvedApplication)
  const expectedArchitectures = expectedArchitecturesForPackage(resolvedPackageArchitecture)
  const infoPath = join(resolvedApplication, 'Contents', 'Info.plist')
  const executablePath = join(resolvedApplication, 'Contents', 'MacOS', executableName)
  const fuseBinaryPath = join(
    resolvedApplication,
    'Contents',
    'Frameworks',
    'Electron Framework.framework',
    'Electron Framework',
  )
  const resourcesPath = join(resolvedApplication, 'Contents', 'Resources')
  const [info, executableArchitectures, fuseWires] = await Promise.all([
    readPlist(infoPath),
    readArchitectures(executablePath),
    readFuseWiresByArchitecture(fuseBinaryPath),
    access(join(resourcesPath, 'app.asar')),
  ])

  invariant(
    sameStringSet(executableArchitectures, expectedArchitectures),
    `The ${resolvedPackageArchitecture} artifact contains ${executableArchitectures.join(', ')}, expected ${expectedArchitectures.join(', ')}.`,
  )

  invariant(
    sameStringSet(executableArchitectures, fuseWires.keys()),
    'The application and Electron Framework architecture sets do not match.',
  )
  invariant(info.CFBundleExecutable === executableName, 'Unexpected application executable name.')

  const machOBinaries = await inspectMachOBinaries(
    resolvedApplication,
    expectedArchitectures,
  )

  invariant(info.CFBundleIdentifier === expectedBundleId, 'Unexpected application bundle ID.')
  invariant(info.LSApplicationCategoryType === MAC_APP_CATEGORY, 'Unexpected macOS app category.')
  invariant(info.LSMinimumSystemVersion === MAC_MINIMUM_SYSTEM_VERSION, 'Unexpected macOS minimum version.')
  invariant(info.CFBundleIconFile === 'Rasterform.icns', 'The package does not select the Rasterform icon.')
  invariant(
    Object.keys(info.NSAppTransportSecurity ?? {}).length
      === Object.keys(MAC_APP_TRANSPORT_SECURITY).length,
    'App Transport Security contains an unexpected exception.',
  )
  for (const [key, expected] of Object.entries(MAC_APP_TRANSPORT_SECURITY)) {
    invariant(info.NSAppTransportSecurity?.[key] === expected, `Unexpected ATS value: ${key}`)
  }
  for (const key of UNUSED_USAGE_DESCRIPTION_KEYS) {
    invariant(!(key in info), `Unused sensitive-device declaration remains: ${key}`)
  }

  const integrity = info.ElectronAsarIntegrity?.['Resources/app.asar']
  invariant(integrity?.algorithm === 'SHA256', 'The app.asar integrity algorithm is missing.')
  invariant(/^[a-f0-9]{64}$/i.test(integrity?.hash ?? ''), 'The app.asar integrity hash is invalid.')
  assertIcns(await readFile(join(resourcesPath, info.CFBundleIconFile)))

  for (const [architecture, fuseWire] of fuseWires) {
    invariant(fuseWire.version === FuseVersion.V1, `Unexpected ${architecture} fuse version.`)
    for (const [option, enabled] of Object.entries(RASTERFORM_FUSE_SETTINGS)) {
      const expected = enabled ? FuseState.ENABLE : FuseState.DISABLE
      invariant(
        fuseWire[Number(option)] === expected,
        `Unexpected ${architecture} ${FuseV1Options[Number(option)]} fuse value.`,
      )
    }
  }

  // This proves that the ad-hoc development seal (or a future distribution
  // seal) is internally consistent after packaging. It does not authenticate
  // a Developer ID identity and does not assess notarization or Gatekeeper.
  await execFileAsync('codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--verbose=2',
    resolvedApplication,
  ])

  return {
    app: basename(resolvedApplication),
    bundleId: info.CFBundleIdentifier,
    category: info.LSApplicationCategoryType,
    minimumSystemVersion: info.LSMinimumSystemVersion,
    arbitraryLoads: info.NSAppTransportSecurity.NSAllowsArbitraryLoads,
    icon: info.CFBundleIconFile,
    asarIntegrity: true,
    packageArchitecture: resolvedPackageArchitecture,
    architectures: executableArchitectures,
    machOBinaryCount: machOBinaries.length,
    deploymentTarget: MAC_MINIMUM_SYSTEM_VERSION,
    codeSignatureIntegrity: 'verified (identity and notarization not assessed)',
    fuses: Object.fromEntries(
      Object.entries(RASTERFORM_FUSE_SETTINGS).map(([option, enabled]) => [
        FuseV1Options[Number(option)],
        enabled,
      ]),
    ),
  }
}

const commandPath = process.argv[2]
const commandArchitecture = process.argv[3]
const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly && commandPath) {
  const rendererLab = process.env.RASTERFORM_RENDERER_LAB === '1'
  const result = await verifyPackagedApplication(commandPath, commandArchitecture, rendererLab
    ? { executableName: 'Rasterform Renderer Lab', bundleId: 'io.atil.rasterform.rendererlab' }
    : undefined)
  console.log(`RASTERFORM_PACKAGE_VERIFIED ${JSON.stringify(result)}`)
}
