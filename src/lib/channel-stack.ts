import { clamp01, extractScalarField } from './channels'
import type { ChannelBlendMode, ChannelLayer, PixelImage, ScalarField } from '../types'

function blendValue(base: number, layer: number, mode: ChannelBlendMode, amount: number): number {
  const strength = clamp01(amount)
  let target: number

  switch (mode) {
    case 'normal':
      target = layer
      break
    case 'add':
      target = clamp01(base + layer)
      break
    case 'subtract':
      target = clamp01(base - layer)
      break
    case 'multiply':
      target = base * layer
      break
    case 'screen':
      target = 1 - (1 - base) * (1 - layer)
      break
    case 'max':
      target = Math.max(base, layer)
      break
    case 'min':
      target = Math.min(base, layer)
      break
  }

  return clamp01(base + (target - base) * strength)
}

interface CachedLayerField {
  image: PixelImage
  signature: string
  field: ScalarField
}

const extractedFieldCache = new WeakMap<ChannelLayer, CachedLayerField>()

function fieldForLayer(image: PixelImage, layer: ChannelLayer): ScalarField {
  const hue = layer.source === 'hue' ? clamp01(layer.hueOrigin) : 0
  const signature = `${layer.source}:${hue.toFixed(6)}`
  const cached = extractedFieldCache.get(layer)
  if (cached?.image === image && cached.signature === signature) return cached.field

  const field = extractScalarField(image, layer.source, hue)
  extractedFieldCache.set(layer, { image, signature, field })
  return field
}

/**
 * Combine image-derived scalar fields as an artist-facing layer stack.
 * The first enabled layer establishes the base; subsequent layers use their
 * selected blend mode. Every step is clamped so exported geometry remains
 * predictable and recipe order stays meaningful.
 */
export function composeChannelStack(image: PixelImage, layers: readonly ChannelLayer[]): ScalarField {
  const count = image.width * image.height
  const composed = new Float32Array(count)
  let hasBase = false

  for (const layer of layers) {
    if (!layer.enabled) continue
    const field = fieldForLayer(image, layer)
    const amount = clamp01(layer.amount)

    for (let index = 0; index < count; index += 1) {
      const extracted = field.values[index] ?? 0
      const value = layer.invert ? 1 - extracted : extracted

      if (!hasBase) composed[index] = clamp01(value * amount)
      else composed[index] = blendValue(composed[index] ?? 0, value, layer.blend, amount)
    }

    hasBase = true
  }

  return { width: image.width, height: image.height, values: composed }
}
