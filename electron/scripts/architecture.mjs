import { execFileSync } from 'node:child_process'

export const SUPPORTED_PACKAGE_ARCHITECTURES = Object.freeze(['arm64', 'x64', 'universal'])

function macHardwareIsAppleSilicon() {
  if (process.platform !== 'darwin') return false
  for (const key of ['hw.optional.arm64', 'sysctl.proc_translated']) {
    try {
      const value = execFileSync('/usr/sbin/sysctl', ['-in', key], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      if (value === '1') return true
    } catch {
      // Intel macOS does not expose sysctl.proc_translated. The hardware key
      // and Node architecture still provide the remaining determinations.
    }
  }
  return false
}

export function physicalMacArchitecture(
  nodeArchitecture = process.arch,
  appleSiliconHardware = macHardwareIsAppleSilicon(),
) {
  if (appleSiliconHardware) return 'arm64'
  if (nodeArchitecture === 'arm64' || nodeArchitecture === 'x64') return nodeArchitecture
  throw new Error(`Unsupported macOS host architecture: ${nodeArchitecture}`)
}

function assertNativeMacArchitecture(hostArchitecture) {
  if (hostArchitecture !== 'arm64' && hostArchitecture !== 'x64') {
    throw new Error(`Unsupported macOS host architecture: ${hostArchitecture}`)
  }
}

function assertPackageArchitecture(architecture) {
  if (!SUPPORTED_PACKAGE_ARCHITECTURES.includes(architecture)) {
    throw new Error(`Unsupported macOS package architecture: ${architecture}`)
  }
}

export function resolvePackageArchitectures(
  requestedArchitectures,
  hostArchitecture = physicalMacArchitecture(),
) {
  assertNativeMacArchitecture(hostArchitecture)
  const architectures = requestedArchitectures.length > 0
    ? [...requestedArchitectures]
    : [hostArchitecture]
  for (const architecture of architectures) assertPackageArchitecture(architecture)
  return architectures
}

export function resolvePackagedSmokeArchitecture(
  requestedArchitecture,
  hostArchitecture = physicalMacArchitecture(),
) {
  assertNativeMacArchitecture(hostArchitecture)
  const architecture = requestedArchitecture ?? hostArchitecture
  assertPackageArchitecture(architecture)
  if (architecture !== 'universal' && architecture !== hostArchitecture) {
    throw new Error(
      `Refusing to launch the ${architecture} Rasterform package on this ${hostArchitecture} Mac. `
        + 'Run architecture-specific smoke tests on matching physical hardware.',
    )
  }
  return architecture
}
