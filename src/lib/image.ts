import type { PixelImage, ScalarField } from '../types'

function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const section = (((hue % 1) + 1) % 1) * 6
  const secondary = chroma * (1 - Math.abs((section % 2) - 1))
  let red = 0
  let green = 0
  let blue = 0
  if (section < 1) [red, green] = [chroma, secondary]
  else if (section < 2) [red, green] = [secondary, chroma]
  else if (section < 3) [green, blue] = [chroma, secondary]
  else if (section < 4) [green, blue] = [secondary, chroma]
  else if (section < 5) [red, blue] = [secondary, chroma]
  else [red, blue] = [chroma, secondary]
  const match = lightness - chroma / 2
  return [red + match, green + match, blue + match]
}

/** Original deterministic artwork that exercises value, hue, saturation and edges. */
export function createDemoImage(width = 360, height = 270): PixelImage {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const u = x / Math.max(1, width - 1)
      const v = y / Math.max(1, height - 1)
      const offset = (y * width + x) * 4
      const wave = 0.5 + 0.5 * Math.sin(u * Math.PI * 6 + v * Math.PI * 2)
      const radial = Math.hypot(u - 0.72, v - 0.38)
      const ring = Math.exp(-Math.pow((radial - 0.19) * 24, 2))
      const block = u > 0.11 && u < 0.31 && v > 0.14 && v < 0.78
      const notch = u > 0.18 && u < 0.42 && v > 0.45 && v < 0.58
      const diagonal = Math.exp(-Math.pow((v - (0.84 - u * 0.55)) * 25, 2))
      let hue = (0.96 + u * 0.62 + 0.08 * Math.sin(v * Math.PI * 4)) % 1
      let saturation = 0.56 + wave * 0.38
      let lightness = 0.24 + v * 0.4 + ring * 0.24
      if (block) [hue, saturation, lightness] = [0.13, 0.9, 0.58]
      if (notch) [hue, saturation, lightness] = [0.58, 0.78, 0.48]
      if (diagonal > 0.2) {
        hue = 0.01
        saturation = 0.95
        lightness += diagonal * 0.22
      }
      const [red, green, blue] = hslToRgb(hue, Math.min(1, saturation), Math.min(0.92, lightness))
      data[offset] = red * 255
      data[offset + 1] = green * 255
      data[offset + 2] = blue * 255
      data[offset + 3] = 255
    }
  }
  return { width, height, sourceWidth: width, sourceHeight: height, data, name: 'Demo image' }
}

export async function fileToPixelImage(file: File, maxLongSide = 1280): Promise<PixelImage> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    throw new Error('Choose a PNG, JPEG, or WebP image.')
  }
  const bitmap = await createImageBitmap(file)
  const sourceWidth = bitmap.width
  const sourceHeight = bitmap.height
  try {
    const scale = Math.min(1, maxLongSide / Math.max(sourceWidth, sourceHeight))
    const width = Math.max(2, Math.round(sourceWidth * scale))
    const height = Math.max(2, Math.round(sourceHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('Canvas image processing is unavailable.')
    context.drawImage(bitmap, 0, 0, width, height)
    const pixels = context.getImageData(0, 0, width, height)
    return {
      width,
      height,
      sourceWidth,
      sourceHeight,
      data: pixels.data,
      name: file.name,
    }
  } finally {
    bitmap.close()
  }
}

export function drawPixelImage(canvas: HTMLCanvasElement, image: PixelImage): void {
  canvas.width = image.width
  canvas.height = image.height
  const context = canvas.getContext('2d')
  if (!context) return
  context.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0)
}

export function drawScalarField(canvas: HTMLCanvasElement, field: ScalarField): void {
  canvas.width = field.width
  canvas.height = field.height
  const pixels = new Uint8ClampedArray(field.values.length * 4)
  for (let index = 0; index < field.values.length; index += 1) {
    const value = Math.round((field.values[index] ?? 0) * 255)
    const offset = index * 4
    pixels[offset] = value
    pixels[offset + 1] = value
    pixels[offset + 2] = value
    pixels[offset + 3] = 255
  }
  const context = canvas.getContext('2d')
  context?.putImageData(new ImageData(pixels, field.width, field.height), 0, 0)
}

export function scalarFieldPng(field: ScalarField): Promise<Blob> {
  const canvas = document.createElement('canvas')
  drawScalarField(canvas, field)
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode height map.'))), 'image/png')
  })
}
