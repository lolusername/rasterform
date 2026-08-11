import { FuseV1Options, FuseVersion } from '@electron/fuses'

export const MAC_APP_CATEGORY = 'public.app-category.graphics-design'
export const MAC_MINIMUM_SYSTEM_VERSION = '12.0'
export const MAC_APP_TRANSPORT_SECURITY = Object.freeze({
  NSAllowsArbitraryLoads: false,
  NSAllowsArbitraryLoadsForMedia: false,
  NSAllowsArbitraryLoadsInWebContent: false,
  NSAllowsLocalNetworking: false,
})

export const UNUSED_USAGE_DESCRIPTION_KEYS = Object.freeze([
  'NSAudioCaptureUsageDescription',
  'NSBluetoothAlwaysUsageDescription',
  'NSBluetoothPeripheralUsageDescription',
  'NSCameraUsageDescription',
  'NSMicrophoneUsageDescription',
])

// Every V1 fuse is explicit so an Electron upgrade cannot silently add a fuse
// with a permissive inherited value. The app loads only its packaged ASAR via
// rasterform:// and does not use Node child-process forks or CLI inspection.
export const RASTERFORM_FUSE_SETTINGS = Object.freeze({
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableCookieEncryption]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  [FuseV1Options.WasmTrapHandlers]: true,
})

export function fuseConfigurationForArchitecture(architecture) {
  return {
    version: FuseVersion.V1,
    strictlyRequireAllFuses: true,
    // Fuse mutation changes the Electron Framework bytes. Reset the ad-hoc
    // development seal for every architecture so the package-level strict
    // codesign integrity check is meaningful. This is not Developer ID signing.
    resetAdHocDarwinSignature: ['arm64', 'x64', 'universal'].includes(architecture),
    ...RASTERFORM_FUSE_SETTINGS,
  }
}
