import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  atomicPngTemporaryPath,
  DESKTOP_SMOKE_HEARTBEAT_MAX_ATTEMPTS,
  DESKTOP_SMOKE_HEARTBEAT_REQUIRED_BEATS,
  desktopSmokeHeartbeatBeatsDuringBlock,
  ensurePngPath,
  finalRenderCancellationAction,
  finalRenderCompletionAction,
  isPngBytes,
  isDesktopSmokeHeartbeatResponsive,
  resolveProtocolFile,
  safeFileSystemErrorMessage,
  sanitizePngFileName,
  shouldCancelFinalJobOnEditorClose,
  writePngAtomically,
} from './main-helpers'

function testCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function findChunk(bytes: Uint8Array, expectedType: string): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 8
  while (offset + 12 <= bytes.byteLength) {
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    if (type === expectedType) return offset
    offset += view.getUint32(offset, false) + 12
  }
  return -1
}

function validPngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(data.byteLength + 12)
  const view = new DataView(chunk.buffer)
  view.setUint32(0, data.byteLength, false)
  for (let index = 0; index < 4; index += 1) chunk[index + 4] = type.charCodeAt(index)
  chunk.set(data, 8)
  view.setUint32(data.byteLength + 8, testCrc32(chunk.subarray(4, data.byteLength + 8)), false)
  return chunk
}

function testPaeth(left: number, above: number, aboveLeft: number): number {
  const estimate = left + above - aboveLeft
  const distances = [
    Math.abs(estimate - left),
    Math.abs(estimate - above),
    Math.abs(estimate - aboveLeft),
  ]
  if (distances[0]! <= distances[1]! && distances[0]! <= distances[2]!) return left
  return distances[1]! <= distances[2]! ? above : aboveLeft
}

function filteredRgbaRows(rows: Uint8Array[], filters: number[]): Uint8Array {
  const pixelBytes = rows[0]?.byteLength ?? 0
  const output = new Uint8Array(rows.length * (pixelBytes + 1))
  for (let row = 0; row < rows.length; row += 1) {
    const current = rows[row]!
    const previous = rows[row - 1]
    const filter = filters[row] ?? 0
    const rowStart = row * (pixelBytes + 1)
    output[rowStart] = filter
    for (let column = 0; column < pixelBytes; column += 1) {
      const value = current[column] ?? 0
      const left = column >= 4 ? current[column - 4] ?? 0 : 0
      const above = previous?.[column] ?? 0
      const aboveLeft = column >= 4 ? previous?.[column - 4] ?? 0 : 0
      let predictor = 0
      if (filter === 1) predictor = left
      else if (filter === 2) predictor = above
      else if (filter === 3) predictor = Math.floor((left + above) / 2)
      else if (filter === 4) predictor = testPaeth(left, above, aboveLeft)
      output[rowStart + column + 1] = (value - predictor) & 0xff
    }
  }
  return output
}

function validRgbaPng(width: number, rows: Uint8Array[], filters: number[]): Uint8Array {
  const header = new Uint8Array(13)
  const headerView = new DataView(header.buffer)
  headerView.setUint32(0, width, false)
  headerView.setUint32(4, rows.length, false)
  header[8] = 8
  header[9] = 6
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    validPngChunk('IHDR', header),
    validPngChunk('IDAT', new Uint8Array(deflateSync(filteredRgbaRows(rows, filters)))),
    validPngChunk('IEND', new Uint8Array()),
  ]
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.byteLength
  }
  return result
}

function validOnePixelRgbaPng(): Uint8Array {
  return validRgbaPng(1, [new Uint8Array([255, 0, 0, 0])], [0])
}

describe('desktop main helpers', () => {
  it('counts only visible-renderer heartbeats inside the hidden block window', () => {
    expect(DESKTOP_SMOKE_HEARTBEAT_MAX_ATTEMPTS).toBe(3)
    expect(DESKTOP_SMOKE_HEARTBEAT_REQUIRED_BEATS).toBe(2)
    expect(desktopSmokeHeartbeatBeatsDuringBlock(
      [900, 1_010, 1_050, 2_010],
      1_000,
      2_000,
    )).toBe(2)
    expect(isDesktopSmokeHeartbeatResponsive([1_010, 1_050], 1_000, 2_000)).toBe(true)
    expect(isDesktopSmokeHeartbeatResponsive([999, 2_001], 1_000, 2_000)).toBe(false)
    expect(desktopSmokeHeartbeatBeatsDuringBlock('not timestamps', 1_000, 2_000)).toBe(0)
    expect(desktopSmokeHeartbeatBeatsDuringBlock([1_010], 2_000, 1_000)).toBe(0)
  })

  it('sanitizes suggested PNG names without accepting paths', () => {
    expect(sanitizePngFileName('../../Bad: Name.jpg')).toBe('Bad- Name.jpg.png')
    expect(sanitizePngFileName('result.PNG')).toBe('result.png')
    expect(sanitizePngFileName('...')).toBe('rasterform-final.png')
    expect(ensurePngPath('/tmp/result.PNG')).toBe('/tmp/result.PNG')
    expect(ensurePngPath('/tmp/result')).toBe('/tmp/result.png')
  })

  it('keeps protocol paths inside their assigned root', () => {
    const root = '/Applications/Rasterform.app/Contents/Resources/app.asar/web'
    expect(resolveProtocolFile(root, '/')).toBe(join(root, 'index.html'))
    expect(resolveProtocolFile(root, '/assets/app.js')).toBe(join(root, 'assets/app.js'))
    expect(resolveProtocolFile(root, '/%2e%2e/secret')).toBeNull()
    expect(resolveProtocolFile(root, '/assets/%2e%2e/secret')).toBeNull()
    expect(resolveProtocolFile(root, '/bad%00path')).toBeNull()
  })

  it('writes the exact PNG bytes through an atomic sibling rename', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'rasterform-save-'))
    const destination = join(folder, 'final.png')
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...Array(24).fill(7)])
    await writePngAtomically(destination, bytes)
    expect(new Uint8Array(await readFile(destination))).toEqual(bytes)
    expect(isPngBytes(bytes)).toBe(false)
    expect(isPngBytes(new Uint8Array([1, 2, 3]))).toBe(false)
  })

  it('uses a short fixed temporary basename independent of the destination name', () => {
    const destination = join('/tmp', `${'very-long-export-name-'.repeat(10)}.png`)
    const temporary = atomicPngTemporaryPath(destination, '5df5d766-e9d4-42fc-a4dd-76315fa5c938')

    expect(temporary).toBe('/tmp/.rasterform-save-5df5d766-e9d4-42fc-a4dd-76315fa5c938.tmp')
    expect(temporary).not.toContain('very-long-export-name')
  })

  it('turns filesystem failures into path-free user messages', () => {
    const privatePath = '/Users/person/Secret Project/final.png'
    const denied = Object.assign(new Error(`EACCES: permission denied, open '${privatePath}'`), { code: 'EACCES' })
    const unknown = new Error(`Could not rename ${privatePath}`)

    expect(safeFileSystemErrorMessage(denied)).toContain('selected location')
    expect(safeFileSystemErrorMessage(unknown)).toContain('selected location')
    expect(safeFileSystemErrorMessage(denied)).not.toContain(privatePath)
    expect(safeFileSystemErrorMessage(unknown)).not.toContain(privatePath)
  })

  it('makes cancellation win before writing and preserves an in-flight atomic save', () => {
    expect(finalRenderCompletionAction('rendering')).toBe('accept')
    expect(finalRenderCompletionAction('cancelling')).toBe('cancel')
    expect(finalRenderCompletionAction('writing')).toBe('ignore')

    expect(finalRenderCancellationAction('prepared')).toBe('cancel-now')
    expect(finalRenderCancellationAction('rendering')).toBe('request-render-cancel')
    expect(finalRenderCancellationAction('cancelling')).toBe('await-cancel')
    expect(finalRenderCancellationAction('writing')).toBe('finish-save')

    expect(shouldCancelFinalJobOnEditorClose('rendering')).toBe(true)
    expect(shouldCancelFinalJobOnEditorClose('writing')).toBe(false)
  })

  it('validates a complete PNG instead of trusting only its signature', () => {
    const onePixel = validOnePixelRgbaPng()
    expect(isPngBytes(onePixel, { width: 1, height: 1, transparent: true })).toBe(true)
    expect(isPngBytes(onePixel, { width: 1, height: 1, transparent: false })).toBe(false)
    expect(isPngBytes(onePixel, { width: 2, height: 1, transparent: true })).toBe(false)
    const truncated = onePixel.slice(0, -12)
    expect(isPngBytes(truncated)).toBe(false)

    const trailing = new Uint8Array(onePixel.byteLength + 1)
    trailing.set(onePixel)
    expect(isPngBytes(trailing)).toBe(false)

    const badCrc = onePixel.slice()
    const idatOffset = findChunk(badCrc, 'IDAT')
    badCrc[idatOffset + 8] ^= 1
    expect(isPngBytes(badCrc)).toBe(false)

    const badDeflate = onePixel.slice()
    const deflateOffset = findChunk(badDeflate, 'IDAT')
    const deflateLength = new DataView(
      badDeflate.buffer,
      badDeflate.byteOffset,
      badDeflate.byteLength,
    ).getUint32(deflateOffset, false)
    badDeflate.fill(0, deflateOffset + 8, deflateOffset + 8 + deflateLength)
    const crc = testCrc32(badDeflate.subarray(
      deflateOffset + 4,
      deflateOffset + 8 + deflateLength,
    ))
    new DataView(badDeflate.buffer, badDeflate.byteOffset, badDeflate.byteLength)
      .setUint32(deflateOffset + 8 + deflateLength, crc, false)
    expect(isPngBytes(badDeflate)).toBe(false)

    const grayscaleAlpha = new Uint8Array(Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ))
    expect(isPngBytes(grayscaleAlpha)).toBe(false)
  })

  it('unfilters RGBA filters 0-4 and requires studio output to be fully opaque', () => {
    const opaqueRows = [0, 1, 2, 3, 4].map((row) => new Uint8Array([
      20 + row, 40 + row, 60 + row, 255,
      80 + row, 100 + row, 120 + row, 255,
    ]))
    const allFilters = validRgbaPng(2, opaqueRows, [0, 1, 2, 3, 4])

    expect(isPngBytes(allFilters, { width: 2, height: 5, transparent: false })).toBe(true)
    // A transparent-background render may legitimately have a model covering
    // every pixel, so an all-opaque RGBA payload remains valid for that mode.
    expect(isPngBytes(allFilters, { width: 2, height: 5, transparent: true })).toBe(true)

    const translucentRows = opaqueRows.map((row) => row.slice())
    translucentRows[4]![7] = 64
    const translucent = validRgbaPng(2, translucentRows, [0, 1, 2, 3, 4])
    expect(isPngBytes(translucent, { width: 2, height: 5, transparent: true })).toBe(true)
    expect(isPngBytes(translucent, { width: 2, height: 5, transparent: false })).toBe(false)

    const invalidFilter = validRgbaPng(1, [new Uint8Array([0, 0, 0, 255])], [5])
    expect(isPngBytes(invalidFilter, { width: 1, height: 1, transparent: false })).toBe(false)
  })
})
