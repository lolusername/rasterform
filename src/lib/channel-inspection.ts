import { extractScalarField } from './channels'
import { composeChannelStack } from './channel-stack'
import type { ChannelLayer, PixelImage } from '../types'

/** Real intermediate values, not an additive attribution of nonlinear blends. */
export function inspectChannel(image: PixelImage, layers: readonly ChannelLayer[], selectedId: string) {
  const index = layers.findIndex(layer => layer.id === selectedId)
  const selected = layers[index]
  if (!selected) return null
  return {
    signal: extractScalarField(image, selected.source, selected.hueOrigin),
    before: composeChannelStack(image, layers.slice(0, index)),
    after: composeChannelStack(image, layers.slice(0, index + 1)),
    enabled: selected.enabled,
    isBase: selected.enabled && !layers.slice(0, index).some(layer => layer.enabled),
  }
}
