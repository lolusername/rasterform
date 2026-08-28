import type { AppearanceSettings, ColorMode, MeshData } from '../types'
import type { DesktopRenderFailure, DesktopSavePreparation } from './contracts'
import {
  DESKTOP_MAX_MESH_BYTES,
  DESKTOP_MAX_MESH_INDICES,
  DESKTOP_MAX_MESH_VERTICES,
  isDesktopJobId,
  isDesktopSavePreparation,
} from './contracts'
import {
  isRasterformDesktopProBridge,
  type RasterformDesktopProBridge,
} from './pro-contracts'

export const DESKTOP_BLENDER_EXPORT_PROTOCOL_VERSION = 1 as const

export type DesktopBlenderTopology = 'exact' | 'balanced' | 'lightweight'
export type DesktopBlenderExportPhase = 'preparing' | 'retopologizing' | 'unwrapping' | 'saving'
export type DesktopBlenderColorMode = Exclude<ColorMode, 'wireframe'>

export interface DesktopBlenderExportSettings {
  topology: DesktopBlenderTopology
}

/** Blender needs geometry and display attributes, not the renderer-only height buffer. */
export type DesktopBlenderMeshData = Omit<MeshData, 'heights'>

export interface DesktopBlenderExportSnapshot {
  protocolVersion: typeof DESKTOP_BLENDER_EXPORT_PROTOCOL_VERSION
  mesh: DesktopBlenderMeshData
  colorMode: DesktopBlenderColorMode
  appearance: AppearanceSettings
  settings: DesktopBlenderExportSettings
}

export interface DesktopSavedBlenderExportResult {
  fileName: string
  topology: DesktopBlenderTopology
  sourceVertices: number
  sourceFaces: number
  outputVertices: number
  outputFaces: number
  /** Number of triangles Blender draws after triangulating every output polygon. */
  outputTriangleCount: number
  quads: number
  triangles: number
  ngons: number
  uvLayerName: string
  uvLoops: number
  colorAttributeName: string | null
  blenderVersion: string
  elapsedSeconds: number
}

export interface DesktopBlenderExportCaptureResult extends DesktopSavedBlenderExportResult {
  desktopSaved: true
}

export type DesktopBlenderExportSubmission =
  | { accepted: true }
  | { accepted: false; error: DesktopRenderFailure }

export type DesktopBlenderExportCancelResult =
  | { state: 'cancelling' }
  | { state: 'saving' }
  | { state: 'cancelled' }
  | { state: 'saved'; result: DesktopSavedBlenderExportResult }
  | { state: 'error'; error: DesktopRenderFailure }

export type DesktopBlenderExportEvent =
  | { type: 'progress'; jobId: string; phase: DesktopBlenderExportPhase }
  | { type: 'saved'; jobId: string; result: DesktopSavedBlenderExportResult }
  | { type: 'cancelled'; jobId: string }
  | { type: 'error'; jobId: string; code: DesktopRenderFailure['code']; message: string }

export interface RasterformDesktopBlenderExportBridge extends RasterformDesktopProBridge {
  readonly blenderExportProtocolVersion: typeof DESKTOP_BLENDER_EXPORT_PROTOCOL_VERSION
  prepareBlenderExport: (suggestedName: string) => Promise<DesktopSavePreparation>
  submitBlenderExport: (
    jobId: string,
    snapshot: DesktopBlenderExportSnapshot,
  ) => Promise<DesktopBlenderExportSubmission>
  cancelBlenderExport: (jobId: string) => Promise<DesktopBlenderExportCancelResult>
  onBlenderExportEvent: (listener: (event: DesktopBlenderExportEvent) => void) => () => void
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: UnknownRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
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

function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
}

function isBlenderMeshData(value: unknown): value is DesktopBlenderMeshData {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'positions',
    'indices',
    'colors',
    'uvs',
    'width',
    'height',
    'mode',
  ])) return false
  if (!isFloat32Array(value.positions)
    || !isUint32Array(value.indices)
    || !isFloat32Array(value.colors)
    || !isFloat32Array(value.uvs)
    || value.positions.length === 0
    || value.positions.length % 3 !== 0
    || value.indices.length === 0
    || value.indices.length % 3 !== 0) return false
  const vertices = value.positions.length / 3
  const totalBytes = value.positions.byteLength
    + value.indices.byteLength
    + value.colors.byteLength
    + value.uvs.byteLength
  if (vertices > DESKTOP_MAX_MESH_VERTICES
    || value.indices.length > DESKTOP_MAX_MESH_INDICES
    || !Number.isSafeInteger(totalBytes)
    || totalBytes > DESKTOP_MAX_MESH_BYTES
    || value.colors.length !== value.positions.length
    || value.uvs.length !== vertices * 2
    || !everyFinite(value.positions)
    || !everyInUnitInterval(value.colors)
    || !everyInUnitInterval(value.uvs)) return false
  for (const index of value.indices) {
    if (index >= vertices) return false
  }
  return isIntegerInRange(value.width, 1, 16_384)
    && isIntegerInRange(value.height, 1, 16_384)
    && (value.mode === 'plane' || value.mode === 'centered' || value.mode === 'solid')
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
    && isFiniteInRange(gradient.midpoint, 0, 1)
    && isRecord(clay)
    && hasOnlyKeys(clay, ['color', 'finish'])
    && isHexColor(clay.color)
    && (clay.finish === 'matte' || clay.finish === 'glossy' || clay.finish === 'metallic')
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
    && value.message.length <= 2_000
}

export function isDesktopBlendName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 7
    && value.length <= 255
    && value.trim() === value
    && value !== '.'
    && value !== '..'
    && !/[\u0000-\u001f\u007f:/\\]/.test(value)
    && value.toLowerCase().endsWith('.blend')
}

export function isDesktopBlenderTopology(value: unknown): value is DesktopBlenderTopology {
  return value === 'exact' || value === 'balanced' || value === 'lightweight'
}

export function isDesktopBlenderExportPhase(value: unknown): value is DesktopBlenderExportPhase {
  return value === 'preparing'
    || value === 'retopologizing'
    || value === 'unwrapping'
    || value === 'saving'
}

export function isDesktopBlenderExportSettings(
  value: unknown,
): value is DesktopBlenderExportSettings {
  return isRecord(value)
    && hasOnlyKeys(value, ['topology'])
    && isDesktopBlenderTopology(value.topology)
}

export function isDesktopBlenderExportSnapshot(
  value: unknown,
): value is DesktopBlenderExportSnapshot {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'protocolVersion',
    'mesh',
    'colorMode',
    'appearance',
    'settings',
  ])) return false
  if (value.protocolVersion !== DESKTOP_BLENDER_EXPORT_PROTOCOL_VERSION
    || (value.colorMode !== 'original' && value.colorMode !== 'height' && value.colorMode !== 'clay')
    || !isDesktopBlenderExportSettings(value.settings)) return false
  return isBlenderMeshData(value.mesh) && isAppearance(value.appearance)
}

export function isDesktopSavedBlenderExportResult(
  value: unknown,
): value is DesktopSavedBlenderExportResult {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'fileName',
    'topology',
    'sourceVertices',
    'sourceFaces',
    'outputVertices',
    'outputFaces',
    'outputTriangleCount',
    'quads',
    'triangles',
    'ngons',
    'uvLayerName',
    'uvLoops',
    'colorAttributeName',
    'blenderVersion',
    'elapsedSeconds',
  ])) return false
  if (!isDesktopBlendName(value.fileName)
    || !isDesktopBlenderTopology(value.topology)
    || !isIntegerInRange(value.sourceVertices, 3, 2_000_000)
    || !isIntegerInRange(value.sourceFaces, 1, 4_000_000)
    || !isIntegerInRange(value.outputVertices, 3, 2_000_000)
    || !isIntegerInRange(value.outputFaces, 1, 4_000_000)
    || !isIntegerInRange(value.outputTriangleCount, 1, 12_000_000)
    || !isIntegerInRange(value.quads, 0, Number(value.outputFaces))
    || !isIntegerInRange(value.triangles, 0, Number(value.outputFaces))
    || !isIntegerInRange(value.ngons, 0, Number(value.outputFaces))
    || Number(value.quads) + Number(value.triangles) + Number(value.ngons) !== value.outputFaces
    || Number(value.outputTriangleCount) < Number(value.triangles)
      + Number(value.quads) * 2
      + Number(value.ngons) * 3
    || !isIntegerInRange(value.uvLoops, 3, 12_000_000)
    || typeof value.uvLayerName !== 'string'
    || value.uvLayerName.length < 1
    || value.uvLayerName.length > 200
    || (value.colorAttributeName !== null
      && (typeof value.colorAttributeName !== 'string'
        || value.colorAttributeName.length < 1
        || value.colorAttributeName.length > 200))
    || typeof value.blenderVersion !== 'string'
    || value.blenderVersion.length < 1
    || value.blenderVersion.length > 200
    || !isFiniteInRange(value.elapsedSeconds, 0, 30 * 24 * 60 * 60)) return false
  if (value.topology === 'exact') {
    return value.outputVertices === value.sourceVertices
      && value.outputFaces === value.sourceFaces
      && value.outputTriangleCount === value.sourceFaces
      && value.triangles === value.sourceFaces
      && value.quads === 0
      && value.ngons === 0
  }
  return value.quads > 0
    && value.quads >= value.triangles + value.ngons
}

export function isDesktopBlenderExportSubmission(
  value: unknown,
): value is DesktopBlenderExportSubmission {
  if (!isRecord(value)) return false
  if (value.accepted === true) return hasOnlyKeys(value, ['accepted'])
  return value.accepted === false
    && hasOnlyKeys(value, ['accepted', 'error'])
    && isRenderFailure(value.error)
}

export function isDesktopBlenderExportCancelResult(
  value: unknown,
): value is DesktopBlenderExportCancelResult {
  if (!isRecord(value) || typeof value.state !== 'string') return false
  if (value.state === 'cancelling' || value.state === 'saving' || value.state === 'cancelled') {
    return hasOnlyKeys(value, ['state'])
  }
  if (value.state === 'saved') {
    return hasOnlyKeys(value, ['state', 'result'])
      && isDesktopSavedBlenderExportResult(value.result)
  }
  return value.state === 'error'
    && hasOnlyKeys(value, ['state', 'error'])
    && isRenderFailure(value.error)
}

export function isDesktopBlenderExportEvent(value: unknown): value is DesktopBlenderExportEvent {
  if (!isRecord(value) || !isDesktopJobId(value.jobId) || typeof value.type !== 'string') return false
  if (value.type === 'progress') {
    return hasOnlyKeys(value, ['type', 'jobId', 'phase'])
      && isDesktopBlenderExportPhase(value.phase)
  }
  if (value.type === 'saved') {
    return hasOnlyKeys(value, ['type', 'jobId', 'result'])
      && isDesktopSavedBlenderExportResult(value.result)
  }
  if (value.type === 'cancelled') return hasOnlyKeys(value, ['type', 'jobId'])
  return value.type === 'error'
    && hasOnlyKeys(value, ['type', 'jobId', 'code', 'message'])
    && isRenderFailure({ code: value.code, message: value.message })
}

export function isRasterformDesktopBlenderExportBridge(
  value: unknown,
): value is RasterformDesktopBlenderExportBridge {
  if (!isRasterformDesktopProBridge(value)) return false
  const candidate = value as unknown as UnknownRecord
  return candidate.blenderExportProtocolVersion === DESKTOP_BLENDER_EXPORT_PROTOCOL_VERSION
    && typeof candidate.prepareBlenderExport === 'function'
    && typeof candidate.submitBlenderExport === 'function'
    && typeof candidate.cancelBlenderExport === 'function'
    && typeof candidate.onBlenderExportEvent === 'function'
}

export function assertDesktopBlenderExportSnapshot(
  value: unknown,
): asserts value is DesktopBlenderExportSnapshot {
  if (!isDesktopBlenderExportSnapshot(value)) {
    throw new TypeError('Invalid desktop Blender project export snapshot.')
  }
}

export { isDesktopSavePreparation }
