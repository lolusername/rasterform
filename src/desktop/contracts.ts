import type {
  AppearanceSettings,
  ColorMode,
  ImageExportBackground,
  MeshData,
  ViewportBackground,
} from '../types'
import type { FinalExportProgress } from '../lib/final-image-export'
import type { ImageExportCameraSnapshot } from '../lib/image-export-worker'

export const DESKTOP_PROTOCOL_VERSION = 1 as const
export const DESKTOP_MAX_IMAGE_EDGE = 4096
export const DESKTOP_MAX_MESH_VERTICES = 2_000_000
export const DESKTOP_MAX_MESH_INDICES = 12_000_000
export const DESKTOP_MAX_MESH_BYTES = 256 * 1024 * 1024
export const DESKTOP_MAX_PNG_BYTES = 128 * 1024 * 1024

export type DesktopFinalColorMode = Exclude<ColorMode, 'wireframe'>

/**
 * An immutable-at-the-boundary snapshot of everything the dedicated renderer
 * needs. Sampling is deliberately absent: Final derives it from the shared
 * quality contract instead of accepting a caller-controlled override.
 */
export interface DesktopFinalRenderSnapshot {
  protocolVersion: typeof DESKTOP_PROTOCOL_VERSION
  mesh: MeshData
  camera: ImageExportCameraSnapshot
  colorMode: DesktopFinalColorMode
  appearance: AppearanceSettings
  width: number
  height: number
  background: ImageExportBackground
  studioBackground: ViewportBackground
}

export type DesktopSavePreparation =
  | { cancelled: true }
  | { cancelled: false; jobId: string }

export interface DesktopFinalRenderResultMetadata {
  width: number
  height: number
  dpi: number
  samples: number
  tiles: number
}

export interface DesktopSavedFinalResult extends DesktopFinalRenderResultMetadata {
  fileName: string
}

export interface DesktopFinalCaptureResult extends DesktopSavedFinalResult {
  desktopSaved: true
}

export type DesktopRenderErrorCode =
  | 'render-failed'
  | 'save-failed'
  | 'process-gone'
  | 'request-expired'

export interface DesktopRenderFailure {
  code: DesktopRenderErrorCode
  message: string
}

export type DesktopFinalRenderSubmission =
  | { accepted: true }
  | { accepted: false; error: DesktopRenderFailure }

export type DesktopFinalCancelResult =
  | { state: 'cancelling' }
  | { state: 'saving' }
  | { state: 'cancelled' }
  | { state: 'saved'; result: DesktopSavedFinalResult }
  | { state: 'error'; error: DesktopRenderFailure }

export type DesktopRenderEvent =
  | { type: 'progress'; jobId: string; progress: FinalExportProgress }
  | { type: 'saved'; jobId: string; result: DesktopSavedFinalResult }
  | { type: 'cancelled'; jobId: string }
  | { type: 'error'; jobId: string; code: DesktopRenderErrorCode; message: string }

/** The only native capabilities exposed to the web renderer. */
export interface RasterformDesktopBridge {
  readonly protocolVersion: typeof DESKTOP_PROTOCOL_VERSION
  prepareFinalSave: (suggestedName: string) => Promise<DesktopSavePreparation>
  submitFinalRender: (
    jobId: string,
    snapshot: DesktopFinalRenderSnapshot,
  ) => Promise<DesktopFinalRenderSubmission>
  cancelFinalRender: (jobId: string) => Promise<DesktopFinalCancelResult>
  onFinalRenderEvent: (listener: (event: DesktopRenderEvent) => void) => () => void
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(record: UnknownRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(record)
  return actual.length === expected.length && actual.every((key) => expected.includes(key))
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum
}

function everyFinite(values: Float32Array): boolean {
  for (const value of values) {
    if (!Number.isFinite(value)) return false
  }
  return true
}

function everyInUnitInterval(values: Float32Array): boolean {
  for (const value of values) {
    if (!Number.isFinite(value) || value < 0 || value > 1) return false
  }
  return true
}

function isFiniteTuple(value: unknown, length: number): value is number[] {
  return Array.isArray(value)
    && value.length === length
    && value.every(isFiniteNumber)
}

function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
}

function isFloat32Array(value: unknown): value is Float32Array {
  return ArrayBuffer.isView(value)
    && Object.prototype.toString.call(value) === '[object Float32Array]'
    && value.byteOffset === 0
    && value.byteLength === value.buffer.byteLength
}

function isUint32Array(value: unknown): value is Uint32Array {
  return ArrayBuffer.isView(value)
    && Object.prototype.toString.call(value) === '[object Uint32Array]'
    && value.byteOffset === 0
    && value.byteLength === value.buffer.byteLength
}

function isMeshData(value: unknown): value is MeshData {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'positions',
    'indices',
    'colors',
    'uvs',
    'heights',
    'width',
    'height',
    'mode',
  ])) return false
  if (!isFloat32Array(value.positions)
    || !isUint32Array(value.indices)
    || !isFloat32Array(value.colors)
    || !isFloat32Array(value.uvs)
    || !isFloat32Array(value.heights)) return false
  if (value.positions.length === 0 || value.positions.length % 3 !== 0) return false
  if (value.indices.length === 0 || value.indices.length % 3 !== 0) return false
  const vertices = value.positions.length / 3
  if (vertices > DESKTOP_MAX_MESH_VERTICES
    || value.indices.length > DESKTOP_MAX_MESH_INDICES) return false
  const totalBytes = value.positions.byteLength
    + value.indices.byteLength
    + value.colors.byteLength
    + value.uvs.byteLength
    + value.heights.byteLength
  if (!Number.isSafeInteger(totalBytes) || totalBytes > DESKTOP_MAX_MESH_BYTES) return false
  if (value.colors.length !== value.positions.length
    || value.uvs.length !== vertices * 2
    || value.heights.length !== vertices) return false
  if (!everyFinite(value.positions)
    || !everyInUnitInterval(value.colors)
    || !everyInUnitInterval(value.uvs)
    || !everyInUnitInterval(value.heights)) return false
  for (const index of value.indices) {
    if (index >= vertices) return false
  }
  return isIntegerInRange(value.width, 1, 1_000_000)
    && isIntegerInRange(value.height, 1, 1_000_000)
    && (value.mode === 'plane' || value.mode === 'centered' || value.mode === 'solid')
}

function isCameraSnapshot(value: unknown): value is ImageExportCameraSnapshot {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'fov',
    'near',
    'far',
    'zoom',
    'filmGauge',
    'filmOffset',
    'position',
    'quaternion',
    'up',
  ])) return false
  if (!isFiniteNumber(value.fov) || value.fov <= 0 || value.fov >= 180) return false
  if (!isFiniteNumber(value.near) || value.near <= 0) return false
  if (!isFiniteNumber(value.far) || value.far <= value.near) return false
  if (!isFiniteNumber(value.zoom) || value.zoom <= 0) return false
  if (!isFiniteNumber(value.filmGauge) || value.filmGauge <= 0) return false
  if (!isFiniteNumber(value.filmOffset)) return false
  if (!isFiniteTuple(value.position, 3)
    || !isFiniteTuple(value.quaternion, 4)
    || !isFiniteTuple(value.up, 3)) return false
  const quaternionMagnitude = value.quaternion.reduce((sum, component) => sum + component * component, 0)
  const upMagnitude = value.up.reduce((sum, component) => sum + component * component, 0)
  return quaternionMagnitude > Number.EPSILON && upMagnitude > Number.EPSILON
}

function isAppearance(value: unknown): value is AppearanceSettings {
  if (!isRecord(value) || !hasOnlyKeys(value, ['heightGradient', 'clay'])) return false
  const gradient = value.heightGradient
  const clay = value.clay
  return isRecord(gradient)
    && hasOnlyKeys(gradient, ['low', 'mid', 'high', 'midpoint'])
    && isHexColor(gradient.low)
    && isHexColor(gradient.mid)
    && isHexColor(gradient.high)
    && isFiniteNumber(gradient.midpoint)
    && gradient.midpoint >= 0
    && gradient.midpoint <= 1
    && isRecord(clay)
    && hasOnlyKeys(clay, ['color', 'finish'])
    && isHexColor(clay.color)
    && (clay.finish === 'matte' || clay.finish === 'glossy' || clay.finish === 'metallic')
}

export function isDesktopJobId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 128
    && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)
}

/** Portable basename validation; the main process still owns the final path. */
export function isDesktopPngName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 5
    && value.length <= 255
    && value.trim() === value
    && value !== '.'
    && value !== '..'
    && !/[\u0000-\u001f\u007f:/\\]/.test(value)
    && value.toLowerCase().endsWith('.png')
}

export function isFinalExportProgress(value: unknown): value is FinalExportProgress {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'phase',
    'progress',
    'tile',
    'tiles',
    'samples',
    'targetSamples',
  ])) return false
  if (value.phase !== 'preparing' && value.phase !== 'rendering' && value.phase !== 'finishing') return false
  if (!isFiniteNumber(value.progress) || value.progress < 0 || value.progress > 1) return false
  if (!isIntegerInRange(value.tiles, 0, 1_000_000)
    || !isIntegerInRange(value.tile, 0, Number(value.tiles))) return false
  if (!isIntegerInRange(value.targetSamples, 1, 10_000_000)
    || !isIntegerInRange(value.samples, 0, Number(value.targetSamples))) return false
  if (value.phase === 'finishing' && value.progress !== 1) return false
  return true
}

export function isDesktopFinalRenderSnapshot(value: unknown): value is DesktopFinalRenderSnapshot {
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
  ])) return false
  // Reject cheap scalar limits before walking potentially large mesh buffers.
  if (value.protocolVersion !== DESKTOP_PROTOCOL_VERSION
    || !isIntegerInRange(value.width, 1, DESKTOP_MAX_IMAGE_EDGE)
    || !isIntegerInRange(value.height, 1, DESKTOP_MAX_IMAGE_EDGE)
    || (value.colorMode !== 'original' && value.colorMode !== 'height' && value.colorMode !== 'clay')
    || (value.background !== 'transparent' && value.background !== 'studio')
    || (value.studioBackground !== 'white'
      && value.studioBackground !== 'dark-gray'
      && value.studioBackground !== 'black')) return false
  return isMeshData(value.mesh)
    && isCameraSnapshot(value.camera)
    && isAppearance(value.appearance)
}

export function isDesktopSavePreparation(value: unknown): value is DesktopSavePreparation {
  if (!isRecord(value)) return false
  if (value.cancelled === true) return hasOnlyKeys(value, ['cancelled'])
  return value.cancelled === false
    && hasOnlyKeys(value, ['cancelled', 'jobId'])
    && isDesktopJobId(value.jobId)
}

function hasValidRenderResultScalars(value: UnknownRecord): boolean {
  return isIntegerInRange(value.width, 1, DESKTOP_MAX_IMAGE_EDGE)
    && isIntegerInRange(value.height, 1, DESKTOP_MAX_IMAGE_EDGE)
    && isIntegerInRange(value.dpi, 1, 2400)
    && isIntegerInRange(value.samples, 1, 10_000_000)
    && isIntegerInRange(value.tiles, 1, 1_000_000)
}

export function isDesktopFinalRenderResultMetadata(
  value: unknown,
): value is DesktopFinalRenderResultMetadata {
  return isRecord(value)
    && hasOnlyKeys(value, ['width', 'height', 'dpi', 'samples', 'tiles'])
    && hasValidRenderResultScalars(value)
}

function isSavedMetadata(value: unknown): value is DesktopSavedFinalResult {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'width',
    'height',
    'dpi',
    'samples',
    'tiles',
    'fileName',
  ])) return false
  return hasValidRenderResultScalars(value)
    && isDesktopPngName(value.fileName)
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

export function isDesktopFinalRenderSubmission(value: unknown): value is DesktopFinalRenderSubmission {
  if (!isRecord(value)) return false
  if (value.accepted === true) return hasOnlyKeys(value, ['accepted'])
  return value.accepted === false
    && hasOnlyKeys(value, ['accepted', 'error'])
    && isRenderFailure(value.error)
}

export function isDesktopFinalCancelResult(value: unknown): value is DesktopFinalCancelResult {
  if (!isRecord(value) || typeof value.state !== 'string') return false
  if (value.state === 'cancelling' || value.state === 'saving' || value.state === 'cancelled') {
    return hasOnlyKeys(value, ['state'])
  }
  if (value.state === 'saved') {
    return hasOnlyKeys(value, ['state', 'result']) && isSavedMetadata(value.result)
  }
  return value.state === 'error'
    && hasOnlyKeys(value, ['state', 'error'])
    && isRenderFailure(value.error)
}

export function isDesktopRenderEvent(value: unknown): value is DesktopRenderEvent {
  if (!isRecord(value) || !isDesktopJobId(value.jobId) || typeof value.type !== 'string') return false
  switch (value.type) {
    case 'progress':
      return hasOnlyKeys(value, ['type', 'jobId', 'progress'])
        && isFinalExportProgress(value.progress)
    case 'saved':
      return hasOnlyKeys(value, ['type', 'jobId', 'result'])
        && isSavedMetadata(value.result)
    case 'cancelled':
      return hasOnlyKeys(value, ['type', 'jobId'])
    case 'error':
      return hasOnlyKeys(value, ['type', 'jobId', 'code', 'message'])
        && (value.code === 'render-failed'
          || value.code === 'save-failed'
          || value.code === 'process-gone'
          || value.code === 'request-expired')
        && typeof value.message === 'string'
        && value.message.length >= 1
        && value.message.length <= 2000
    default:
      return false
  }
}

export function isRasterformDesktopBridge(value: unknown): value is RasterformDesktopBridge {
  if (!isRecord(value) || value.protocolVersion !== DESKTOP_PROTOCOL_VERSION) return false
  return typeof value.prepareFinalSave === 'function'
    && typeof value.submitFinalRender === 'function'
    && typeof value.cancelFinalRender === 'function'
    && typeof value.onFinalRenderEvent === 'function'
}

export function assertDesktopFinalRenderSnapshot(
  value: unknown,
): asserts value is DesktopFinalRenderSnapshot {
  if (!isDesktopFinalRenderSnapshot(value)) {
    throw new TypeError('Invalid desktop Final render snapshot.')
  }
}

export function assertDesktopRenderEvent(value: unknown): asserts value is DesktopRenderEvent {
  if (!isDesktopRenderEvent(value)) throw new TypeError('Invalid desktop Final render event.')
}
