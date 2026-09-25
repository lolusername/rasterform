import { clamp01 } from './channels'
import type { ChannelBlendMode, ChannelLayer, HeightSource } from '../types'

/** Shared vocabulary for the controls and their read-only inspection. */
export const HEIGHT_SOURCES: Array<{ value: HeightSource; label: string }> = [
  { value: 'luminance', label: 'Luminance' },
  { value: 'hue', label: 'Hue target' },
  { value: 'saturation', label: 'Saturation' },
  { value: 'value', label: 'Value' },
  { value: 'red', label: 'Red' },
  { value: 'green', label: 'Green' },
  { value: 'blue', label: 'Blue' },
  { value: 'alpha', label: 'Alpha' },
  { value: 'edges', label: 'Edges' },
]

export const CHANNEL_BLEND_MODES: Array<{ value: ChannelBlendMode; label: string }> = [
  { value: 'normal', label: 'Mix' },
  { value: 'add', label: 'Raise' },
  { value: 'subtract', label: 'Carve' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'screen', label: 'Screen' },
  { value: 'max', label: 'Peak' },
  { value: 'min', label: 'Valley' },
]

export function sourceLabel(source: HeightSource): string {
  return HEIGHT_SOURCES.find(item => item.value === source)?.label ?? source
}

export function blendLabel(blend: ChannelBlendMode): string {
  return CHANNEL_BLEND_MODES.find(item => item.value === blend)?.label ?? blend
}

const COMBINE_RULES: Record<ChannelBlendMode, string> = {
  normal: 'Mix moves the previous composite toward this channel’s signal.',
  add: 'Raise adds this channel’s signal to the previous composite, clips that sum to 0–1, then blends toward it.',
  subtract: 'Carve subtracts this channel’s signal from the previous composite, clips that difference to 0–1, then blends toward it.',
  multiply: 'Multiply multiplies the previous composite by this channel’s signal, then blends toward that result.',
  screen: 'Screen multiplies the inverse of the previous composite by the inverse of this channel’s signal, inverts that result, then blends toward it.',
  max: 'Peak takes the higher of the previous composite and this channel’s signal, then blends toward it.',
  min: 'Valley takes the lower of the previous composite and this channel’s signal, then blends toward it.',
}

/** Describe the existing channel-stack rules; never calculate a different field. */
export function describeChannel(layers: readonly ChannelLayer[], selectedId: string) {
  const index = layers.findIndex(layer => layer.id === selectedId)
  const selected = layers[index]
  if (!selected) return null
  const isBase = selected.enabled && !layers.slice(0, index).some(layer => layer.enabled)
  const influence = Math.round(clamp01(selected.amount) * 100)
  const operation = blendLabel(selected.blend)
  return {
    source: sourceLabel(selected.source),
    enabled: selected.enabled,
    isBase,
    position: index + 1,
    count: layers.length,
    influence,
    operation,
    status: !selected.enabled ? 'Muted' : isBase ? 'Base channel' : 'Enabled',
    inversion: selected.invert ? 'On · signal is inverted before combining' : 'Off',
    hue: selected.source === 'hue' ? Math.round(clamp01(selected.hueOrigin) * 360) : null,
    rule: !selected.enabled
      ? `This channel is skipped. Its saved ${operation} operation, influence and inversion do not affect the form; before and after are identical.`
      : isBase
        ? `As the first enabled channel, its signal is multiplied by ${influence}% to establish the base. The saved ${operation} operation is not used for the base.`
        : `${COMBINE_RULES[selected.blend]} Influence controls that blend: 0% leaves the previous composite unchanged; 100% uses the full result.`,
  }
}
