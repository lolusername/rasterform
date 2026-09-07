import type { PixelImage, SourceTexture } from '../types'
import { assertPngContract } from './viewport-export'

export const MAX_SOURCE_TEXTURE_EDGE = 16_384
export const MAX_SOURCE_TEXTURE_PIXELS = 100_000_000
export const MAX_SOURCE_TEXTURE_BYTES = 512 * 1024 * 1024

function assertTextureDimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error('The source image has invalid dimensions. Load the original image again.')
  }
  if (width > MAX_SOURCE_TEXTURE_EDGE || height > MAX_SOURCE_TEXTURE_EDGE || width * height > MAX_SOURCE_TEXTURE_PIXELS) {
    throw new Error('The source image is too large for a bitmap texture (maximum 16,384 px per side and 100 megapixels). Choose Current appearance, or load a smaller source image. The original image has not been resized.')
  }
}

/** Validate the actual encoded pixels, including dimensions, before either export path uses them. */
export function assertSourceTexture(texture: SourceTexture): void {
  assertTextureDimensions(texture.width, texture.height)
  if (texture.mimeType !== 'image/png') throw new Error('Source textures must be lossless PNG images.')
  if (texture.data.byteLength > MAX_SOURCE_TEXTURE_BYTES) {
    throw new Error('The source texture exceeds the 512 MiB export limit. Choose Current appearance, or load a smaller source image.')
  }
  assertPngContract(texture.data, texture.width, texture.height, false)
}

function textureName(name: string): string {
  const stem = name.replace(/[\u0000-\u001f\u007f:/\\]/g, '_').replace(/\.[^.]+$/, '').trim()
  return `${(stem || 'rasterform-source').slice(0, 251)}.png`
}

/** Keep the compressed upload while editing; decode at its full size only when exporting. */
export async function encodeSourceTexture(image: PixelImage): Promise<SourceTexture> {
  const width = image.sourceWidth
  const height = image.sourceHeight
  assertTextureDimensions(width, height)

  let bitmap: ImageBitmap | undefined
  let canvas: HTMLCanvasElement | undefined
  try {
    if (image.sourceBlob) {
      bitmap = await createImageBitmap(image.sourceBlob, {
        imageOrientation: 'from-image',
        colorSpaceConversion: 'default',
      })
      if (bitmap.width !== width || bitmap.height !== height) {
        throw new Error('The original image dimensions changed while decoding. Load the source image again.')
      }
    } else if (image.width !== width || image.height !== height) {
      throw new Error('The full-resolution source image is unavailable. Load the original image again to export its bitmap texture.')
    }

    canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { colorSpace: 'srgb' })
    if (!context) throw new Error('Full-resolution texture processing is unavailable on this device.')
    if (bitmap) context.drawImage(bitmap, 0, 0)
    else context.putImageData(new ImageData(new Uint8ClampedArray(image.data), width, height), 0, 0)

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas!.toBlob(
        (value) => value ? resolve(value) : reject(new Error('Could not encode the full-resolution source texture. Choose Current appearance, or load a smaller source image.')),
        'image/png',
      )
    })
    if (blob.size > MAX_SOURCE_TEXTURE_BYTES) {
      throw new Error('The source texture exceeds the 512 MiB export limit. Choose Current appearance, or load a smaller source image.')
    }
    const texture: SourceTexture = {
      data: new Uint8Array(await blob.arrayBuffer()),
      mimeType: 'image/png',
      width,
      height,
      name: textureName(image.name),
    }
    assertSourceTexture(texture)
    return texture
  } finally {
    bitmap?.close()
    // Explicitly release the potentially large canvas backing store after encoding.
    if (canvas) {
      canvas.width = 0
      canvas.height = 0
    }
  }
}
