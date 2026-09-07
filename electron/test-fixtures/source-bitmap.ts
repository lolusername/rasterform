import { deflateSync } from 'node:zlib'
import type { SourceTexture } from '../../src/types'

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), data])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** Top left red, top right green, bottom left blue, bottom right yellow. */
export function sourceBitmapFixture(width = 8, height = 8): SourceTexture {
  const pixels = Buffer.alloc(height * (1 + width * 4))
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const top = y < height / 2
      const left = x < width / 2
      const rgba = top ? (left ? [255, 0, 0, 255] : [0, 255, 0, 255])
        : (left ? [0, 0, 255, 255] : [255, 255, 0, 255])
      pixels.set(rgba, y * (width * 4 + 1) + 1 + x * 4)
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0)),
  ])
  return { data: new Uint8Array(png), width, height, mimeType: 'image/png', name: 'quadrants.png' }
}
