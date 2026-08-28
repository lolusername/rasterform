import type { FinalExportProgress } from '../lib/final-image-export'
import type { DesktopFinalRenderSnapshot, DesktopSavePreparation } from './contracts'
import {
  DESKTOP_PROTOCOL_VERSION,
  isDesktopFinalRenderSnapshot,
  isDesktopJobId,
  isDesktopSavePreparation,
  isFinalExportProgress,
  isRasterformDesktopLongExportBridge,
  type DesktopRenderFailure,
  type RasterformDesktopLongExportBridge,
} from './contracts'

export const DESKTOP_PRO_RENDER_PROTOCOL_VERSION = 1 as const

export interface DesktopProRenderSettings {
  maxSamples: number
  minSamples: number
  noiseThreshold: number
  maxBounces: number
  denoise: boolean
}

export const DEFAULT_DESKTOP_PRO_RENDER_SETTINGS: Readonly<DesktopProRenderSettings> = Object.freeze({
  maxSamples: 8192,
  minSamples: 512,
  noiseThreshold: 0.001,
  maxBounces: 12,
  denoise: true,
})

export interface DesktopProRenderSnapshot extends Omit<DesktopFinalRenderSnapshot, 'protocolVersion'> {
  protocolVersion: typeof DESKTOP_PRO_RENDER_PROTOCOL_VERSION
  settings: DesktopProRenderSettings
}

export interface DesktopProRendererAvailability {
  available: boolean
  blenderVersion: string | null
  device: 'METAL' | 'CPU' | null
  message: string
}

export interface DesktopSavedProResult {
  width: number
  height: number
  maxSamples: number
  noiseThreshold: number
  pngFileName: string
  exrFileName: string
  blenderVersion: string
  device: 'METAL' | 'CPU'
  elapsedSeconds: number
}

export interface DesktopProCaptureResult extends DesktopSavedProResult {
  desktopSaved: true
}

export type DesktopProRenderSubmission =
  | { accepted: true }
  | { accepted: false; error: DesktopRenderFailure }

export type DesktopProCancelResult =
  | { state: 'cancelling' }
  | { state: 'saving' }
  | { state: 'cancelled' }
  | { state: 'saved'; result: DesktopSavedProResult }
  | { state: 'error'; error: DesktopRenderFailure }

export type DesktopProRenderEvent =
  | { type: 'progress'; jobId: string; progress: FinalExportProgress }
  | { type: 'saved'; jobId: string; result: DesktopSavedProResult }
  | { type: 'cancelled'; jobId: string }
  | { type: 'error'; jobId: string; code: DesktopRenderFailure['code']; message: string }

export interface RasterformDesktopProBridge extends RasterformDesktopLongExportBridge {
  readonly proRenderProtocolVersion: typeof DESKTOP_PRO_RENDER_PROTOCOL_VERSION
  probeProRenderer: () => Promise<DesktopProRendererAvailability>
  prepareProSave: (suggestedName: string) => Promise<DesktopSavePreparation>
  submitProRender: (
    jobId: string,
    snapshot: DesktopProRenderSnapshot,
  ) => Promise<DesktopProRenderSubmission>
  cancelProRender: (jobId: string) => Promise<DesktopProCancelResult>
  onProRenderEvent: (listener: (event: DesktopProRenderEvent) => void) => () => void
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(record: UnknownRecord, expected: readonly string[]): boolean {
  const keys = Object.keys(record)
  return keys.length === expected.length && keys.every((key) => expected.includes(key))
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum
}

function isFiniteInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= minimum
    && value <= maximum
}

function isSafeFileName(value: unknown, extension: '.png' | '.exr'): value is string {
  return typeof value === 'string'
    && value.length > extension.length
    && value.length <= 255
    && value.trim() === value
    && !/[\u0000-\u001f\u007f:/\\]/.test(value)
    && value.toLowerCase().endsWith(extension)
}

function isRenderFailure(value: unknown): value is DesktopRenderFailure {
  return isRecord(value)
    && hasOnlyKeys(value, ['code', 'message'])
    && (value.code === 'render-failed'
      || value.code === 'save-failed'
      || value.code === 'process-gone'
      || value.code === 'request-expired')
    && typeof value.message === 'string'
    && value.message.length >= 1
    && value.message.length <= 2000
}

export function isDesktopProRenderSettings(value: unknown): value is DesktopProRenderSettings {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'maxSamples',
    'minSamples',
    'noiseThreshold',
    'maxBounces',
    'denoise',
  ])) return false
  return isIntegerInRange(value.maxSamples, 64, 8192)
    && isIntegerInRange(value.minSamples, 64, Number(value.maxSamples))
    && isFiniteInRange(value.noiseThreshold, 0.001, 0.05)
    && isIntegerInRange(value.maxBounces, 2, 16)
    && typeof value.denoise === 'boolean'
}

export function isDesktopProRenderSnapshot(value: unknown): value is DesktopProRenderSnapshot {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'protocolVersion',
    'mesh',
    'camera',
    'colorMode',
    'appearance',
    'width',
    'height',
    'background',
    'studioBackground',
    'settings',
  ])) return false
  if (value.protocolVersion !== DESKTOP_PRO_RENDER_PROTOCOL_VERSION
    || !isDesktopProRenderSettings(value.settings)) return false
  return isDesktopFinalRenderSnapshot({
    protocolVersion: DESKTOP_PROTOCOL_VERSION,
    mesh: value.mesh,
    camera: value.camera,
    colorMode: value.colorMode,
    appearance: value.appearance,
    width: value.width,
    height: value.height,
    background: value.background,
    studioBackground: value.studioBackground,
  })
}

export function isDesktopProRendererAvailability(
  value: unknown,
): value is DesktopProRendererAvailability {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'available',
    'blenderVersion',
    'device',
    'message',
  ])) return false
  return typeof value.available === 'boolean'
    && (value.blenderVersion === null
      || (typeof value.blenderVersion === 'string'
        && value.blenderVersion.length >= 1
        && value.blenderVersion.length <= 200))
    && (value.device === null || value.device === 'METAL' || value.device === 'CPU')
    && typeof value.message === 'string'
    && value.message.length <= 2000
}

export function isDesktopSavedProResult(value: unknown): value is DesktopSavedProResult {
  return isRecord(value)
    && hasOnlyKeys(value, [
      'width',
      'height',
      'maxSamples',
      'noiseThreshold',
      'pngFileName',
      'exrFileName',
      'blenderVersion',
      'device',
      'elapsedSeconds',
    ])
    && isIntegerInRange(value.width, 1, 4096)
    && isIntegerInRange(value.height, 1, 4096)
    && isIntegerInRange(value.maxSamples, 64, 8192)
    && isFiniteInRange(value.noiseThreshold, 0.001, 0.05)
    && isSafeFileName(value.pngFileName, '.png')
    && isSafeFileName(value.exrFileName, '.exr')
    && typeof value.blenderVersion === 'string'
    && value.blenderVersion.length >= 1
    && value.blenderVersion.length <= 200
    && (value.device === 'METAL' || value.device === 'CPU')
    && isFiniteInRange(value.elapsedSeconds, 0, 30 * 24 * 60 * 60)
}

export function isDesktopProRenderSubmission(value: unknown): value is DesktopProRenderSubmission {
  if (!isRecord(value)) return false
  if (value.accepted === true) return hasOnlyKeys(value, ['accepted'])
  return value.accepted === false
    && hasOnlyKeys(value, ['accepted', 'error'])
    && isRenderFailure(value.error)
}

export function isDesktopProCancelResult(value: unknown): value is DesktopProCancelResult {
  if (!isRecord(value) || typeof value.state !== 'string') return false
  if (value.state === 'cancelling' || value.state === 'saving' || value.state === 'cancelled') {
    return hasOnlyKeys(value, ['state'])
  }
  if (value.state === 'saved') {
    return hasOnlyKeys(value, ['state', 'result']) && isDesktopSavedProResult(value.result)
  }
  return value.state === 'error'
    && hasOnlyKeys(value, ['state', 'error'])
    && isRenderFailure(value.error)
}

export function isDesktopProRenderEvent(value: unknown): value is DesktopProRenderEvent {
  if (!isRecord(value) || !isDesktopJobId(value.jobId) || typeof value.type !== 'string') return false
  if (value.type === 'progress') {
    return hasOnlyKeys(value, ['type', 'jobId', 'progress'])
      && isFinalExportProgress(value.progress)
  }
  if (value.type === 'saved') {
    return hasOnlyKeys(value, ['type', 'jobId', 'result'])
      && isDesktopSavedProResult(value.result)
  }
  if (value.type === 'cancelled') return hasOnlyKeys(value, ['type', 'jobId'])
  return value.type === 'error'
    && hasOnlyKeys(value, ['type', 'jobId', 'code', 'message'])
    && isRenderFailure({ code: value.code, message: value.message })
}

export function isRasterformDesktopProBridge(value: unknown): value is RasterformDesktopProBridge {
  if (!isRasterformDesktopLongExportBridge(value)) return false
  const candidate = value as unknown as UnknownRecord
  return candidate.proRenderProtocolVersion === DESKTOP_PRO_RENDER_PROTOCOL_VERSION
    && typeof candidate.probeProRenderer === 'function'
    && typeof candidate.prepareProSave === 'function'
    && typeof candidate.submitProRender === 'function'
    && typeof candidate.cancelProRender === 'function'
    && typeof candidate.onProRenderEvent === 'function'
}

export function assertDesktopProRenderSnapshot(
  value: unknown,
): asserts value is DesktopProRenderSnapshot {
  if (!isDesktopProRenderSnapshot(value)) throw new TypeError('Invalid desktop Pro render snapshot.')
}

export { isDesktopSavePreparation }
