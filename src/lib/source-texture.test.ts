import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PixelImage } from '../types'
import { encodeSourceTexture } from './source-texture'

const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII='), (character) => character.charCodeAt(0))

function mockEncoder(width: number, height: number, result: Blob | null = null) {
  const encoded = png.slice()
  const header = new DataView(encoded.buffer)
  header.setUint32(16, width)
  header.setUint32(20, height)
  const context = { drawImage: vi.fn(), putImageData: vi.fn() }
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => context),
    toBlob: vi.fn((callback: BlobCallback, type: string) => {
      expect(canvas.width).toBe(width)
      expect(canvas.height).toBe(height)
      expect(type).toBe('image/png')
      callback(result ?? new Blob([encoded], { type: 'image/png' }))
    }),
  }
  vi.stubGlobal('document', { createElement: () => canvas })
  return { canvas, context }
}

function sourceImage(): PixelImage {
  return {
    width: 2, height: 2, sourceWidth: 6000, sourceHeight: 4000,
    name: 'source.jpg', data: new Uint8ClampedArray(16),
    sourceBlob: new Blob(['compressed original'], { type: 'image/jpeg' }),
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('full-resolution source bitmap', () => {
  it('decodes the retained upload at its full size and releases the large decode/canvas', async () => {
    const image = sourceImage()
    const bitmap = { width: 6000, height: 4000, close: vi.fn() }
    const decode = vi.fn(async () => bitmap)
    vi.stubGlobal('createImageBitmap', decode)
    const { canvas, context } = mockEncoder(6000, 4000)

    const texture = await encodeSourceTexture(image)

    expect(decode).toHaveBeenCalledWith(image.sourceBlob, { imageOrientation: 'from-image', colorSpaceConversion: 'default' })
    expect(context.drawImage).toHaveBeenCalledWith(bitmap, 0, 0)
    expect(canvas.getContext).toHaveBeenCalledWith('2d', { colorSpace: 'srgb' })
    expect(texture).toMatchObject({ width: 6000, height: 4000, mimeType: 'image/png', name: 'source.png' })
    expect(texture.data).toBeInstanceOf(Uint8Array)
    expect(bitmap.close).toHaveBeenCalledOnce()
    expect([canvas.width, canvas.height]).toEqual([0, 0])
  })

  it('rejects missing originals instead of enlarging the working raster', async () => {
    const image = sourceImage()
    delete image.sourceBlob
    await expect(encodeSourceTexture(image)).rejects.toThrow('full-resolution source image is unavailable')
  })

  it('normalizes image labels to names accepted by the native export boundary', async () => {
    const bitmap = { width: 6000, height: 4000, close: vi.fn() }
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap))
    mockEncoder(6000, 4000)
    const texture = await encodeSourceTexture({ ...sourceImage(), name: 'Photo: red/blue\\green.jpg' })
    expect(texture.name).toBe('Photo_ red_blue_green.png')
  })

  it('rejects oversized sources before decoding and never resizes them', async () => {
    const decode = vi.fn()
    vi.stubGlobal('createImageBitmap', decode)
    await expect(encodeSourceTexture({ ...sourceImage(), sourceWidth: 20000 })).rejects.toThrow('has not been resized')
    await expect(encodeSourceTexture({ ...sourceImage(), sourceWidth: 12000, sourceHeight: 12000 })).rejects.toThrow('100 megapixels')
    expect(decode).not.toHaveBeenCalled()
  })

  it('rejects a truncated/dimension-changed encoder result and still releases resources', async () => {
    const bitmap = { width: 6000, height: 4000, close: vi.fn() }
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap))
    const { canvas } = mockEncoder(6000, 4000, new Blob([png], { type: 'image/png' }))
    await expect(encodeSourceTexture(sourceImage())).rejects.toThrow('PNG dimension check failed')
    expect(bitmap.close).toHaveBeenCalledOnce()
    expect([canvas.width, canvas.height]).toEqual([0, 0])
  })

  it('cleans up an orientation decode mismatch before creating a canvas', async () => {
    const bitmap = { width: 4000, height: 6000, close: vi.fn() }
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap))
    await expect(encodeSourceTexture(sourceImage())).rejects.toThrow('dimensions changed while decoding')
    expect(bitmap.close).toHaveBeenCalledOnce()
  })

  it('encodes the generated demo from its native pixels without requiring an upload', async () => {
    const image = { ...sourceImage(), width: 1, height: 1, sourceWidth: 1, sourceHeight: 1, data: new Uint8ClampedArray([255, 0, 0, 255]), name: 'Demo image' }
    delete image.sourceBlob
    vi.stubGlobal('ImageData', class {
      constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
    })
    const decode = vi.fn()
    vi.stubGlobal('createImageBitmap', decode)
    const { context } = mockEncoder(1, 1)
    const texture = await encodeSourceTexture(image)
    expect(texture).toMatchObject({ width: 1, height: 1, name: 'Demo image.png' })
    expect(context.putImageData).toHaveBeenCalledWith(expect.objectContaining({ data: image.data, width: 1, height: 1 }), 0, 0)
    expect(decode).not.toHaveBeenCalled()
  })

  it('reports an unavailable full-size encoder and frees the original decode', async () => {
    const bitmap = { width: 6000, height: 4000, close: vi.fn() }
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap))
    const { canvas } = mockEncoder(6000, 4000)
    canvas.toBlob.mockImplementation((callback: BlobCallback) => callback(null))
    await expect(encodeSourceTexture(sourceImage())).rejects.toThrow('Could not encode the full-resolution source texture')
    expect(bitmap.close).toHaveBeenCalledOnce()
    expect([canvas.width, canvas.height]).toEqual([0, 0])
  })
})
