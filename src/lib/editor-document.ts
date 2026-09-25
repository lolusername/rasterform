import type {
  AppearanceSettings, ChannelLayer, ColorMode, FieldSettings, FontChoice, LivingFormSettings,
  MeshSettings, PixelImage, StrataSettings, TextShapeSettings, ViewportBackground, WorkspaceMode,
} from '../types'
import { isPreviewCameraSnapshot, type PreviewCameraSnapshot } from './preview-camera'

/** Authored state only: no mesh caches, renderer jobs, progress, or playback clocks. */
export interface EditorDocument {
  image: PixelImage
  workspace: WorkspaceMode
  channels: ChannelLayer[]
  selectedChannelId: string
  field: FieldSettings
  mesh: MeshSettings
  strata: StrataSettings
  text: TextShapeSettings
  font: FontChoice
  /** Optional licensed font bytes, when access to the selected font was granted. */
  fontBlob?: Blob
  imageAppearance: AppearanceSettings
  textAppearance: AppearanceSettings
  imageLivingForm: LivingFormSettings
  textLivingForm: LivingFormSettings
  imageLivingPhase: number
  textLivingPhase: number
  imageColorMode: ColorMode
  textColorMode: ColorMode
  viewportBackground: ViewportBackground
  camera?: PreviewCameraSnapshot
}

export const EDITOR_PROJECT_FORMAT = 'Rasterform project'
export const EDITOR_PROJECT_VERSION = 1
export const EDITOR_PROJECT_EXTENSION = '.rasterform'
const MAX_WORKING_PIXELS = 16_777_216
const MAX_ASSET_BYTES = 512 * 1024 * 1024
const MAX_PROJECT_CHARACTERS = 768 * 1024 * 1024

export class EditorProjectError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EditorProjectError'
  }
}

function cloneAppearance(value: AppearanceSettings): AppearanceSettings {
  return { heightGradient: { ...value.heightGradient }, clay: { ...value.clay } }
}

/**
 * Mutable settings are copied. Raster pixels and Blob assets are shared deliberately:
 * treat them as immutable and replace the PixelImage when importing a new source.
 * This prevents a hundred slider edits from making a hundred bitmap copies.
 */
export function cloneEditorDocument(value: EditorDocument): EditorDocument {
  return {
    image: { ...value.image }, workspace: value.workspace,
    channels: value.channels.map((channel) => ({ ...channel })),
    selectedChannelId: value.selectedChannelId,
    field: { ...value.field },
    mesh: { ...value.mesh, ...(value.mesh.strata ? { strata: { ...value.mesh.strata } } : {}) },
    strata: { ...value.strata }, text: { ...value.text }, font: { ...value.font },
    ...(value.fontBlob ? { fontBlob: value.fontBlob } : {}),
    imageAppearance: cloneAppearance(value.imageAppearance),
    textAppearance: cloneAppearance(value.textAppearance),
    imageLivingForm: { ...value.imageLivingForm }, textLivingForm: { ...value.textLivingForm },
    imageLivingPhase: value.imageLivingPhase, textLivingPhase: value.textLivingPhase,
    imageColorMode: value.imageColorMode, textColorMode: value.textColorMode,
    viewportBackground: value.viewportBackground,
    ...(value.camera ? { camera: {
      ...value.camera,
      position: [...value.camera.position], quaternion: [...value.camera.quaternion],
      up: [...value.camera.up], target: [...value.camera.target],
    } } : {}),
  }
}

/** Cheap equality for documents sharing immutable source assets. */
export function editorDocumentsEqual(left: EditorDocument, right: EditorDocument): boolean {
  if (left.image.data !== right.image.data || left.image.sourceBlob !== right.image.sourceBlob
    || left.fontBlob !== right.fontBlob) return false
  const metadata = (document: EditorDocument) => {
    const { image, fontBlob: _fontBlob, ...settings } = cloneEditorDocument(document)
    const { data: _data, sourceBlob: _sourceBlob, ...imageMetadata } = image
    return { ...settings, image: imageMetadata }
  }
  return JSON.stringify(metadata(left)) === JSON.stringify(metadata(right))
}

type RecordValue = Record<string, unknown>
function object(value: unknown, name: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(name)
  return value as RecordValue
}
function fail(name: string): never { throw new EditorProjectError(`Invalid Rasterform project: ${name}.`) }
function number(value: unknown, name: string, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max
    || (integer && !Number.isSafeInteger(value))) fail(name)
  return value
}
function string(value: unknown, name: string, max = 4096): string {
  if (typeof value !== 'string' || value.length > max) fail(name)
  return value
}
function boolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') fail(name)
  return value
}
function enumeration<T extends string>(value: unknown, options: readonly T[], name: string): T {
  if (typeof value !== 'string' || !options.includes(value as T)) fail(name)
  return value as T
}
function color(value: unknown, name: string): string {
  const result = string(value, name, 7)
  if (!/^#[\da-f]{6}$/i.test(result)) fail(name)
  return result
}
function appearance(value: unknown, name: string): AppearanceSettings {
  const settings = object(value, name)
  const gradient = object(settings.heightGradient, `${name}.heightGradient`)
  const clay = object(settings.clay, `${name}.clay`)
  return {
    heightGradient: {
      low: color(gradient.low, `${name}.low`), mid: color(gradient.mid, `${name}.mid`),
      high: color(gradient.high, `${name}.high`), midpoint: number(gradient.midpoint, `${name}.midpoint`, 0, 1),
    },
    clay: { color: color(clay.color, `${name}.clay.color`), finish: enumeration(clay.finish, ['matte', 'glossy', 'metallic'], `${name}.finish`) },
  }
}
function livingForm(value: unknown, name: string): LivingFormSettings {
  const settings = object(value, name)
  return {
    enabled: boolean(settings.enabled, `${name}.enabled`),
    behavior: enumeration(settings.behavior, ['breathe', 'ripple', 'flow', 'melt', 'expand'], `${name}.behavior`),
    amount: number(settings.amount, `${name}.amount`, 0, 1),
    frequency: number(settings.frequency, `${name}.frequency`, 0.01, 100),
    seed: number(settings.seed, `${name}.seed`, -1e9, 1e9),
    duration: number(settings.duration, `${name}.duration`, 0.01, 3600),
  }
}
function strata(value: unknown): StrataSettings {
  const settings = object(value, 'strata')
  return {
    layers: number(settings.layers, 'strata.layers', 2, 24, true),
    thickness: number(settings.thickness, 'strata.thickness', 0.005, 0.12),
    separation: number(settings.separation, 'strata.separation', 0, 0.18),
  }
}
function tuple(value: unknown, length: number, name: string): number[] {
  if (!Array.isArray(value) || value.length !== length) fail(name)
  return value.map((entry) => number(entry, name, -1e9, 1e9))
}
function camera(value: unknown): NonNullable<EditorDocument['camera']> {
  if (!isPreviewCameraSnapshot(value)) fail('camera')
  const settings = object(value, 'camera')
  const near = number(settings.near, 'camera.near', Number.EPSILON, 1e9)
  const far = number(settings.far, 'camera.far', near, 1e12)
  if (far <= near) fail('camera clipping planes')
  const quaternion = tuple(settings.quaternion, 4, 'camera.quaternion') as [number, number, number, number]
  const quaternionLength = Math.hypot(...quaternion)
  if (Math.abs(quaternionLength - 1) > 0.001) fail('camera quaternion must be normalized')
  const up = tuple(settings.up, 3, 'camera.up') as [number, number, number]
  if (Math.hypot(...up) < Number.EPSILON) fail('camera.up')
  return {
    fov: number(settings.fov, 'camera.fov', 0.001, 179.999), near, far,
    zoom: number(settings.zoom, 'camera.zoom', Number.EPSILON, 1e6),
    filmGauge: number(settings.filmGauge, 'camera.filmGauge', Number.EPSILON, 1e6),
    filmOffset: number(settings.filmOffset, 'camera.filmOffset', -1e6, 1e6),
    position: tuple(settings.position, 3, 'camera.position') as [number, number, number], quaternion, up,
    target: tuple(settings.target, 3, 'camera.target') as [number, number, number],
  }
}

/** Validate untrusted project/session state without silently clamping authored values. */
export function validateEditorDocument(value: unknown): EditorDocument {
  const document = object(value, 'document')
  const image = object(document.image, 'image')
  const width = number(image.width, 'image.width', 1, MAX_WORKING_PIXELS, true)
  const height = number(image.height, 'image.height', 1, MAX_WORKING_PIXELS, true)
  if (width * height > MAX_WORKING_PIXELS) fail('working image is too large')
  if (!(image.data instanceof Uint8ClampedArray) || image.data.length !== width * height * 4) fail('image pixels')
  if (image.sourceBlob !== undefined && (!(image.sourceBlob instanceof Blob) || image.sourceBlob.size > MAX_ASSET_BYTES)) fail('original image file')
  if (document.fontBlob !== undefined && (!(document.fontBlob instanceof Blob) || document.fontBlob.size > MAX_ASSET_BYTES)) fail('font file')
  if (!Array.isArray(document.channels) || document.channels.length > 256) fail('channels')
  const channelIds = new Set<string>()
  const channels = document.channels.map((entry): ChannelLayer => {
    const channel = object(entry, 'channel')
    const id = string(channel.id, 'channel.id', 512)
    if (!id || channelIds.has(id)) fail('duplicate or missing channel ID')
    channelIds.add(id)
    return {
      id,
      source: enumeration(channel.source, ['luminance', 'hue', 'saturation', 'value', 'red', 'green', 'blue', 'alpha', 'edges'], 'channel.source'),
      blend: enumeration(channel.blend, ['normal', 'add', 'subtract', 'multiply', 'screen', 'max', 'min'], 'channel.blend'),
      amount: number(channel.amount, 'channel.amount', 0, 1), invert: boolean(channel.invert, 'channel.invert'),
      hueOrigin: number(channel.hueOrigin, 'channel.hueOrigin', 0, 1), enabled: boolean(channel.enabled, 'channel.enabled'),
    }
  })
  const selectedChannelId = string(document.selectedChannelId, 'selectedChannelId', 512)
  if (selectedChannelId && !channelIds.has(selectedChannelId)) fail('selected channel is missing')
  const field = object(document.field, 'field')
  const mesh = object(document.mesh, 'mesh')
  const text = object(document.text, 'text')
  const font = object(document.font, 'font')
  const finish = (value: unknown) => enumeration(value, ['detail', 'blob'], 'surface finish')
  const colorMode = (value: unknown) => enumeration(value, ['original', 'height', 'clay', 'wireframe'], 'color mode')
  return {
    image: {
      width, height, data: image.data as Uint8ClampedArray,
      sourceWidth: number(image.sourceWidth, 'image.sourceWidth', 1, 1e6, true),
      sourceHeight: number(image.sourceHeight, 'image.sourceHeight', 1, 1e6, true),
      name: string(image.name, 'image.name'),
      ...(image.sourceBlob ? { sourceBlob: image.sourceBlob as Blob } : {}),
    },
    workspace: enumeration(document.workspace, ['image', 'text'], 'workspace'), channels, selectedChannelId,
    field: {
      invert: boolean(field.invert, 'field.invert'), blur: number(field.blur, 'field.blur', 0, 64),
      contrast: number(field.contrast, 'field.contrast', -100, 100), quantize: number(field.quantize, 'field.quantize', 0, 256, true),
      finish: finish(field.finish), blobDilation: number(field.blobDilation, 'field.blobDilation', 0, 64),
      blobSmoothing: number(field.blobSmoothing, 'field.blobSmoothing', 0, 64),
    },
    mesh: {
      mode: enumeration(mesh.mode, ['plane', 'centered', 'solid', 'strata'], 'mesh.mode'),
      resolution: number(mesh.resolution, 'mesh.resolution', 2, 1024, true), depth: number(mesh.depth, 'mesh.depth', 0, 100),
      midpoint: number(mesh.midpoint, 'mesh.midpoint', 0, 1), baseThickness: number(mesh.baseThickness, 'mesh.baseThickness', 0, 100),
      ...(mesh.strata ? { strata: strata(mesh.strata) } : {}),
    },
    strata: strata(document.strata),
    text: {
      text: string(text.text, 'text.text', 100_000),
      alignment: enumeration(text.alignment, ['left', 'center', 'right'], 'text.alignment'),
      tracking: number(text.tracking, 'text.tracking', -10, 10), lineHeight: number(text.lineHeight, 'text.lineHeight', 0.01, 100),
      depth: number(text.depth, 'text.depth', 0, 100), bevelSize: number(text.bevelSize, 'text.bevelSize', 0, 10),
      bevelThickness: number(text.bevelThickness, 'text.bevelThickness', 0, 10),
      bevelSegments: number(text.bevelSegments, 'text.bevelSegments', 1, 64, true),
      resolution: number(text.resolution, 'text.resolution', 2, 4096, true), finish: finish(text.finish),
      blobDilation: number(text.blobDilation, 'text.blobDilation', 0, 64),
      blobSmoothing: number(text.blobSmoothing, 'text.blobSmoothing', 0, 64),
    },
    font: {
      id: string(font.id, 'font.id'), label: string(font.label, 'font.label'), family: string(font.family, 'font.family'),
      style: string(font.style, 'font.style'), source: enumeration(font.source, ['default', 'detected', 'local'], 'font.source'),
      cssFamily: string(font.cssFamily, 'font.cssFamily'),
      ...(font.postscriptName !== undefined ? { postscriptName: string(font.postscriptName, 'font.postscriptName') } : {}),
    },
    ...(document.fontBlob ? { fontBlob: document.fontBlob as Blob } : {}),
    imageAppearance: appearance(document.imageAppearance, 'imageAppearance'), textAppearance: appearance(document.textAppearance, 'textAppearance'),
    imageLivingForm: livingForm(document.imageLivingForm, 'imageLivingForm'), textLivingForm: livingForm(document.textLivingForm, 'textLivingForm'),
    imageLivingPhase: number(document.imageLivingPhase, 'imageLivingPhase', 0, 1),
    textLivingPhase: number(document.textLivingPhase, 'textLivingPhase', 0, 1),
    imageColorMode: colorMode(document.imageColorMode), textColorMode: colorMode(document.textColorMode),
    viewportBackground: enumeration(document.viewportBackground, ['white', 'dark-gray', 'black'], 'viewportBackground'),
    ...(document.camera !== undefined ? { camera: camera(document.camera) } : {}),
  }
}

interface EncodedAsset { base64: string; type: string; name?: string; lastModified?: number }
function encodeBytes(bytes: Uint8Array | Uint8ClampedArray): string {
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32_768)))
  }
  return btoa(chunks.join(''))
}
function decodeBytes(value: unknown, name: string, maxBytes: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4
    || value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)
    || (value.includes('=') && !/^[^=]*={1,2}$/.test(value))) fail(name)
  try {
    const decoded = atob(value)
    if (decoded.length > maxBytes) fail(name)
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0))
  } catch { return fail(name) }
}
async function encodeAsset(blob: Blob): Promise<EncodedAsset> {
  return {
    base64: encodeBytes(new Uint8Array(await blob.arrayBuffer())), type: blob.type,
    ...(typeof File !== 'undefined' && blob instanceof File ? { name: blob.name, lastModified: blob.lastModified } : {}),
  }
}
function decodeAsset(value: unknown, name: string): Blob {
  const asset = object(value, name)
  const data = decodeBytes(asset.base64, `${name} bytes`, MAX_ASSET_BYTES)
  const type = string(asset.type, `${name} MIME type`, 256)
  if (asset.name !== undefined) {
    const filename = string(asset.name, `${name} filename`)
    const lastModified = number(asset.lastModified, `${name} last-modified time`, 0, Number.MAX_SAFE_INTEGER, true)
    if (typeof File !== 'undefined') return new File([data], filename, { type, lastModified })
  }
  return new Blob([data], { type })
}

/** Portable, versioned project. Source bytes are preserved, never re-encoded as a JPEG. */
export async function serializeEditorProject(document: EditorDocument): Promise<string> {
  const snapshot = validateEditorDocument(document)
  const { image, fontBlob, ...settings } = snapshot
  const { data, sourceBlob, ...imageMetadata } = image
  const source = sourceBlob ? await encodeAsset(sourceBlob) : undefined
  const fontAsset = fontBlob ? await encodeAsset(fontBlob) : undefined
  return JSON.stringify({
    format: EDITOR_PROJECT_FORMAT, version: EDITOR_PROJECT_VERSION,
    document: {
      ...settings, image: { ...imageMetadata, rgba: encodeBytes(data), ...(source ? { source } : {}) },
      ...(fontAsset ? { fontAsset } : {}),
    },
  })
}

export function parseEditorProject(json: string): EditorDocument {
  if (typeof json !== 'string' || json.length > MAX_PROJECT_CHARACTERS) fail('project file is too large')
  let parsed: unknown
  try { parsed = JSON.parse(json) } catch { throw new EditorProjectError('This is not a readable Rasterform project file.') }
  const envelope = object(parsed, 'file')
  if (envelope.format !== EDITOR_PROJECT_FORMAT) throw new EditorProjectError('Choose a .rasterform project, not an export recipe or rendered image.')
  if (envelope.version !== EDITOR_PROJECT_VERSION) throw new EditorProjectError('This Rasterform project version is not supported. The current project has not been changed.')
  const document = object(envelope.document, 'document')
  const image = object(document.image, 'image')
  const width = number(image.width, 'image.width', 1, MAX_WORKING_PIXELS, true)
  const height = number(image.height, 'image.height', 1, MAX_WORKING_PIXELS, true)
  if (width * height > MAX_WORKING_PIXELS) fail('working image is too large')
  const data = decodeBytes(image.rgba, 'image pixels', width * height * 4)
  if (data.length !== width * height * 4) fail('image pixel count')
  return validateEditorDocument({
    ...document,
    image: {
      ...image, data: new Uint8ClampedArray(data.buffer),
      // Serialized fields cannot smuggle an unvalidated Blob-like object.
      sourceBlob: image.source !== undefined ? decodeAsset(image.source, 'original image file') : undefined,
    },
    fontBlob: document.fontAsset !== undefined ? decodeAsset(document.fontAsset, 'font file') : undefined,
  })
}

/** Missing fonts must be acknowledged by the UI, never silently substituted. */
export function editorFontRequirement(document: EditorDocument, available: readonly FontChoice[]): 'available' | 'embedded' | 'missing' {
  if (document.fontBlob) return 'embedded'
  if (available.some((font) => font.id === document.font.id
    || (font.postscriptName && font.postscriptName === document.font.postscriptName)
    || (font.family === document.font.family && font.style === document.font.style))) return 'available'
  return 'missing'
}
