import type { HeightSource, PixelImage, ScalarField } from '../types'

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

export function wrap01(value: number): number {
  return ((value % 1) + 1) % 1
}

export function srgbToLinear(value: number): number {
  const channel = clamp01(value)
  return channel <= 0.04045
    ? channel / 12.92
    : Math.pow((channel + 0.055) / 1.055, 2.4)
}

export function perceptualLuminance(red: number, green: number, blue: number): number {
  return (
    0.2126 * srgbToLinear(red) +
    0.7152 * srgbToLinear(green) +
    0.0722 * srgbToLinear(blue)
  )
}

export interface Hsv {
  h: number
  s: number
  v: number
}

export function rgbToHsv(red: number, green: number, blue: number): Hsv {
  const r = clamp01(red)
  const g = clamp01(green)
  const b = clamp01(blue)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min

  let hue = 0
  if (delta > Number.EPSILON) {
    if (max === r) hue = ((g - b) / delta) % 6
    else if (max === g) hue = (b - r) / delta + 2
    else hue = (r - g) / delta + 4
    hue /= 6
  }

  return {
    h: wrap01(hue),
    s: max === 0 ? 0 : delta / max,
    v: max,
  }
}

export function shiftHue(hue: number, origin: number): number {
  return wrap01(hue - origin)
}

/**
 * Hue is circular, so 359° and 1° must remain neighbors. This response
 * measures proximity to an artist-selected hue anchor and fades achromatic
 * pixels, whose hue is undefined.
 */
export function circularHueResponse(hue: number, origin: number, saturation = 1): number {
  const affinity = (Math.cos(Math.PI * 2 * (hue - origin)) + 1) / 2
  return clamp01(affinity * saturation)
}

function scalarAt(
  source: Exclude<HeightSource, 'edges'>,
  r8: number,
  g8: number,
  b8: number,
  a8: number,
  hueOrigin: number,
): number {
  const r = r8 / 255
  const g = g8 / 255
  const b = b8 / 255

  switch (source) {
    case 'luminance':
      return perceptualLuminance(r, g, b)
    case 'red':
      return r
    case 'green':
      return g
    case 'blue':
      return b
    case 'alpha':
      return a8 / 255
    case 'hue': {
      const hsv = rgbToHsv(r, g, b)
      return hsv.s < 0.0001 ? 0 : circularHueResponse(hsv.h, hueOrigin, hsv.s)
    }
    case 'saturation':
      return rgbToHsv(r, g, b).s
    case 'value':
      return Math.max(r, g, b)
  }
}

function sobel(luminance: Float32Array, width: number, height: number): Float32Array {
  const output = new Float32Array(width * height)
  let maximum = 0

  const sample = (x: number, y: number): number => {
    const safeX = Math.min(width - 1, Math.max(0, x))
    const safeY = Math.min(height - 1, Math.max(0, y))
    return luminance[safeY * width + safeX] ?? 0
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const gx =
        -sample(x - 1, y - 1) +
        sample(x + 1, y - 1) -
        2 * sample(x - 1, y) +
        2 * sample(x + 1, y) -
        sample(x - 1, y + 1) +
        sample(x + 1, y + 1)
      const gy =
        sample(x - 1, y - 1) +
        2 * sample(x, y - 1) +
        sample(x + 1, y - 1) -
        sample(x - 1, y + 1) -
        2 * sample(x, y + 1) -
        sample(x + 1, y + 1)
      const magnitude = Math.hypot(gx, gy)
      output[y * width + x] = magnitude
      maximum = Math.max(maximum, magnitude)
    }
  }

  if (maximum > 0) {
    for (let index = 0; index < output.length; index += 1) {
      output[index] = clamp01((output[index] ?? 0) / maximum)
    }
  }
  return output
}

export function extractScalarField(
  image: PixelImage,
  source: HeightSource,
  hueOrigin = 0,
): ScalarField {
  const count = image.width * image.height
  const values = new Float32Array(count)

  if (source === 'edges') {
    const luminance = new Float32Array(count)
    for (let pixel = 0; pixel < count; pixel += 1) {
      const offset = pixel * 4
      luminance[pixel] = scalarAt(
        'luminance',
        image.data[offset] ?? 0,
        image.data[offset + 1] ?? 0,
        image.data[offset + 2] ?? 0,
        image.data[offset + 3] ?? 255,
        hueOrigin,
      )
    }
    return { width: image.width, height: image.height, values: sobel(luminance, image.width, image.height) }
  }

  for (let pixel = 0; pixel < count; pixel += 1) {
    const offset = pixel * 4
    values[pixel] = scalarAt(
      source,
      image.data[offset] ?? 0,
      image.data[offset + 1] ?? 0,
      image.data[offset + 2] ?? 0,
      image.data[offset + 3] ?? 255,
      hueOrigin,
    )
  }

  return { width: image.width, height: image.height, values }
}

export function bilinearSample(field: ScalarField, u: number, v: number): number {
  const x = clamp01(u) * Math.max(0, field.width - 1)
  const y = clamp01(v) * Math.max(0, field.height - 1)
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const x1 = Math.min(field.width - 1, x0 + 1)
  const y1 = Math.min(field.height - 1, y0 + 1)
  const tx = x - x0
  const ty = y - y0
  const top = (field.values[y0 * field.width + x0] ?? 0) * (1 - tx) + (field.values[y0 * field.width + x1] ?? 0) * tx
  const bottom = (field.values[y1 * field.width + x0] ?? 0) * (1 - tx) + (field.values[y1 * field.width + x1] ?? 0) * tx
  return top * (1 - ty) + bottom * ty
}
