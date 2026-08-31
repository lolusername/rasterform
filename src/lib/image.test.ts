import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDemoImage, fileToPixelImage } from './image'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('image source dimensions', () => {
  it('uses the demo raster as both working and source dimensions', () => {
    const image = createDemoImage(48, 32)

    expect(image).toMatchObject({
      width: 48,
      height: 32,
      sourceWidth: 48,
      sourceHeight: 32,
    })
  })

  it('retains original pixels while downsampling only the working raster', async () => {
    const close = vi.fn()
    const bitmap = { width: 6000, height: 4000, close } as unknown as ImageBitmap
    const context = {
      drawImage: vi.fn(),
      getImageData: (_x: number, _y: number, width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4),
      }),
    }
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap))
    vi.stubGlobal('document', {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => context,
      }),
    })

    const image = await fileToPixelImage({
      name: 'source.png',
      type: 'image/png',
    } as File)

    expect(image).toMatchObject({
      name: 'source.png',
      width: 1280,
      height: 853,
      sourceWidth: 6000,
      sourceHeight: 4000,
    })
    expect(context.drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 1280, 853)
    expect(close).toHaveBeenCalledOnce()
  })
})
