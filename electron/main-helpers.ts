import { randomUUID } from 'node:crypto'
import { open, rename, unlink } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { inflateSync } from 'node:zlib'

const PNG_EXTENSION = '.png'
const MAX_FILE_NAME_LENGTH = 180

export type DesktopJobState = 'prepared' | 'rendering' | 'cancelling' | 'writing'

export const DESKTOP_SMOKE_HEARTBEAT_MAX_ATTEMPTS = 3
export const DESKTOP_SMOKE_HEARTBEAT_REQUIRED_BEATS = 2

export function desktopSmokeHeartbeatBeatsDuringBlock(
  tickTimestamps: unknown,
  blockStartedAt: unknown,
  blockEndedAt: unknown,
): number {
  if (!Array.isArray(tickTimestamps)
    || typeof blockStartedAt !== 'number'
    || typeof blockEndedAt !== 'number'
    || !Number.isFinite(blockStartedAt)
    || !Number.isFinite(blockEndedAt)
    || blockEndedAt < blockStartedAt) return 0
  return tickTimestamps.filter((tick) => (
    typeof tick === 'number'
    && Number.isFinite(tick)
    && tick >= blockStartedAt
    && tick <= blockEndedAt
  )).length
}

export function isDesktopSmokeHeartbeatResponsive(
  tickTimestamps: unknown,
  blockStartedAt: unknown,
  blockEndedAt: unknown,
): boolean {
  return desktopSmokeHeartbeatBeatsDuringBlock(
    tickTimestamps,
    blockStartedAt,
    blockEndedAt,
  ) >= DESKTOP_SMOKE_HEARTBEAT_REQUIRED_BEATS
}

export function finalRenderCompletionAction(
  state: DesktopJobState,
): 'accept' | 'cancel' | 'ignore' {
  if (state === 'rendering') return 'accept'
  if (state === 'cancelling') return 'cancel'
  return 'ignore'
}

export function finalRenderCancellationAction(
  state: DesktopJobState,
): 'cancel-now' | 'request-render-cancel' | 'await-cancel' | 'finish-save' {
  if (state === 'prepared') return 'cancel-now'
  if (state === 'rendering') return 'request-render-cancel'
  if (state === 'cancelling') return 'await-cancel'
  return 'finish-save'
}

export function shouldCancelFinalJobOnEditorClose(state: DesktopJobState): boolean {
  return state !== 'writing'
}

export function sanitizePngFileName(value: unknown): string {
  const source = typeof value === 'string' ? value : 'rasterform-final.png'
  const withoutPath = basename(source.replaceAll('\\', '/'))
  const cleaned = withoutPath
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f/:]/g, '-')
    .replace(/^\.+/, '')
    .replace(/\s+/g, ' ')
    .trim()
  const fallback = cleaned || 'rasterform-final'
  const extension = extname(fallback).toLowerCase() === PNG_EXTENSION ? PNG_EXTENSION : ''
  const stem = extension ? fallback.slice(0, -extension.length) : fallback
  const available = MAX_FILE_NAME_LENGTH - PNG_EXTENSION.length
  return `${stem.slice(0, available).replace(/[. ]+$/g, '') || 'rasterform-final'}${PNG_EXTENSION}`
}

export function ensurePngPath(filePath: string): string {
  return extname(filePath).toLowerCase() === PNG_EXTENSION ? filePath : `${filePath}${PNG_EXTENSION}`
}

export function atomicPngTemporaryPath(destination: string, id = randomUUID()): string {
  return join(dirname(destination), `.rasterform-save-${id}.tmp`)
}

export function safeFileSystemErrorMessage(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : ''
  if (code === 'ENOSPC' || code === 'EDQUOT') {
    return 'There is not enough free space to save the Final PNG.'
  }
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return 'macOS did not allow Rasterform to write to the selected location.'
  }
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return 'The selected save folder is no longer available.'
  }
  return 'The Final PNG could not be saved to the selected location.'
}

export function resolveProtocolFile(root: string, encodedPathname: string): string | null {
  let pathname: string
  try {
    pathname = decodeURIComponent(encodedPathname)
  } catch {
    return null
  }
  if (pathname.includes('\u0000') || pathname.includes('\\')) return null
  const segments = pathname.split('/')
  if (segments.some((segment) => segment === '..' || segment === '.')) return null
  const requestPath = pathname === '/' || pathname === '' ? '/index.html' : pathname
  const resolvedRoot = resolve(root)
  const candidate = resolve(resolvedRoot, `.${requestPath}`)
  const rel = relative(resolvedRoot, candidate)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  return candidate
}

export async function writePngAtomically(destination: string, bytes: Uint8Array): Promise<void> {
  const temporary = atomicPngTemporaryPath(destination)
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(temporary, 'wx')
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = null
    await rename(temporary, destination)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

export interface ExpectedPng {
  width: number
  height: number
  transparent: boolean
  dpi?: number
}

function pngChunkType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset + 4] ?? 0, bytes[offset + 5] ?? 0, bytes[offset + 6] ?? 0, bytes[offset + 7] ?? 0)
}

const PNG_CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function pngCrc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff
  for (let index = start; index < end; index += 1) {
    crc = PNG_CRC_TABLE[(crc ^ (bytes[index] ?? 0)) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function paethPredictor(left: number, above: number, aboveLeft: number): number {
  const estimate = left + above - aboveLeft
  const leftDistance = Math.abs(estimate - left)
  const aboveDistance = Math.abs(estimate - above)
  const aboveLeftDistance = Math.abs(estimate - aboveLeft)
  if (leftDistance <= aboveDistance && leftDistance <= aboveLeftDistance) return left
  return aboveDistance <= aboveLeftDistance ? above : aboveLeft
}

function validateRgbaScanlines(
  inflated: Uint8Array,
  width: number,
  height: number,
  requireOpaque: boolean,
): boolean {
  const bytesPerPixel = 4
  const pixelBytes = width * bytesPerPixel
  const rowBytes = pixelBytes + 1
  for (let row = 0; row < height; row += 1) {
    const rowStart = row * rowBytes
    const filter = inflated[rowStart]
    if (filter === undefined || filter > 4) return false
    const dataStart = rowStart + 1
    const previousDataStart = dataStart - rowBytes
    for (let column = 0; column < pixelBytes; column += 1) {
      const index = dataStart + column
      const filtered = inflated[index] ?? 0
      const left = column >= bytesPerPixel ? inflated[index - bytesPerPixel] ?? 0 : 0
      const above = row > 0 ? inflated[previousDataStart + column] ?? 0 : 0
      const aboveLeft = row > 0 && column >= bytesPerPixel
        ? inflated[previousDataStart + column - bytesPerPixel] ?? 0
        : 0
      let reconstructed = filtered
      if (filter === 1) reconstructed += left
      else if (filter === 2) reconstructed += above
      else if (filter === 3) reconstructed += Math.floor((left + above) / 2)
      else if (filter === 4) reconstructed += paethPredictor(left, above, aboveLeft)
      inflated[index] = reconstructed & 0xff
    }
    if (requireOpaque) {
      for (let alpha = dataStart + 3; alpha < dataStart + pixelBytes; alpha += bytesPerPixel) {
        if (inflated[alpha] !== 255) return false
      }
    }
  }
  return true
}

export function isPngBytes(
  value: unknown,
  expected?: ExpectedPng,
  maximumBytes = 512 * 1024 * 1024,
): value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < 33 || value.byteLength > maximumBytes) return false
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  if (!signature.every((byte, index) => value[index] === byte)) return false
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength)
  if (view.getUint32(8, false) !== 13 || pngChunkType(value, 8) !== 'IHDR') return false
  const width = view.getUint32(16, false)
  const height = view.getUint32(20, false)
  if (width === 0 || height === 0) return false
  // Chromium canvas exports are 8-bit, non-interlaced RGBA. Requiring that
  // exact representation prevents a renderer from substituting an opaque or
  // exotic PNG that only happens to share the requested dimensions.
  if (value[24] !== 8
    || value[25] !== 6
    || value[26] !== 0
    || value[27] !== 0
    || value[28] !== 0) return false
  if (expected && (width !== expected.width || height !== expected.height)) return false
  const rowBytes = width * 4 + 1
  const inflatedBytes = rowBytes * height
  if (!Number.isSafeInteger(inflatedBytes) || inflatedBytes > maximumBytes) return false
  let hasImageData = false
  let complete = false
  let imageDataEnded = false
  let density: number | null = null
  const imageData: Uint8Array[] = []
  let offset = 8
  while (offset + 12 <= value.byteLength) {
    const length = view.getUint32(offset, false)
    const chunkSize = length + 12
    if (chunkSize < 12 || offset + chunkSize > value.byteLength) return false
    const type = pngChunkType(value, offset)
    const dataEnd = offset + 8 + length
    if (pngCrc32(value, offset + 4, dataEnd) !== view.getUint32(dataEnd, false)) return false
    if (type === 'IDAT') {
      if (imageDataEnded || length === 0) return false
      hasImageData = true
      imageData.push(value.subarray(offset + 8, dataEnd))
    } else if (hasImageData) {
      imageDataEnded = true
    }
    if (type === 'pHYs' && length === 9 && value[offset + 16] === 1) {
      const x = view.getUint32(offset + 8, false)
      const y = view.getUint32(offset + 12, false)
      if (x === y) density = Math.round(x * 0.0254)
    }
    offset += chunkSize
    if (type === 'IEND') {
      complete = length === 0 && offset === value.byteLength
      break
    }
  }
  if (!hasImageData || !complete) return false
  if (expected?.dpi !== undefined && density !== expected.dpi) return false
  try {
    const compressed = Buffer.concat(imageData.map((chunk) => (
      Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    )))
    const inflated = inflateSync(compressed, { maxOutputLength: inflatedBytes })
    if (inflated.byteLength !== inflatedBytes) return false
    // A transparent export may legitimately be fully covered by the model, so
    // RGBA representation is sufficient there. Studio output, however, must
    // be fully opaque across every decoded pixel.
    if (!validateRgbaScanlines(inflated, width, height, expected?.transparent === false)) return false
  } catch {
    return false
  }
  return true
}
