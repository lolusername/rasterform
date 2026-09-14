import { clamp01 } from './channels'
import type { PixelImage, ScalarField } from '../types'

export function sampleColor(image: PixelImage, u: number, v: number): [number, number, number] {
  const x = clamp01(u) * Math.max(0, image.width - 1)
  const y = clamp01(v) * Math.max(0, image.height - 1)
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const x1 = Math.min(image.width - 1, x0 + 1)
  const y1 = Math.min(image.height - 1, y0 + 1)
  const tx = x - x0
  const ty = y - y0
  const channel = (pixelX: number, pixelY: number, offset: number) =>
    (image.data[(pixelY * image.width + pixelX) * 4 + offset] ?? 0) / 255
  return [0, 1, 2].map((offset) => {
    const top = channel(x0, y0, offset) * (1 - tx) + channel(x1, y0, offset) * tx
    const bottom = channel(x0, y1, offset) * (1 - tx) + channel(x1, y1, offset) * tx
    return top * (1 - ty) + bottom * ty
  }) as [number, number, number]
}

export function gridDimensions(field: ScalarField, resolution: number) {
  const longSide = Math.max(8, Math.min(256, Math.round(resolution)))
  if (field.width >= field.height) {
    return { columns: longSide, rows: Math.max(4, Math.round(longSide * field.height / field.width)) }
  }
  return { columns: Math.max(4, Math.round(longSide * field.width / field.height)), rows: longSide }
}
