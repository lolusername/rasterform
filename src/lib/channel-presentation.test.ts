import { describe, expect, it } from 'vitest'
import { CHANNEL_BLEND_MODES, HEIGHT_SOURCES, blendLabel, describeChannel, sourceLabel } from './channel-presentation'
import { inspectChannel } from './channel-inspection'
import { createDemoImage } from './image'
import type { ChannelLayer } from '../types'

const base: ChannelLayer = { id: 'base', source: 'luminance', blend: 'add', amount: 0.8, invert: false, hueOrigin: 0, enabled: true }
const edges: ChannelLayer = { id: 'edges', source: 'edges', blend: 'multiply', amount: 0.35, invert: true, hueOrigin: 0, enabled: true }

describe('channel presentation describes the real stack', () => {
  it('uses the same artist-facing vocabulary as the controls', () => {
    expect(HEIGHT_SOURCES).toHaveLength(9)
    expect(CHANNEL_BLEND_MODES).toHaveLength(7)
    expect(sourceLabel('hue')).toBe('Hue target')
    expect(blendLabel('normal')).toBe('Mix')
    expect(blendLabel('subtract')).toBe('Carve')
    expect(blendLabel('max')).toBe('Peak')
    expect(blendLabel('min')).toBe('Valley')
  })

  it('identifies the base and explicitly says its saved combine operation is bypassed', () => {
    const result = describeChannel([base, edges], 'base')!
    expect(result).toMatchObject({ source: 'Luminance', status: 'Base channel', isBase: true, influence: 80, position: 1, count: 2 })
    expect(result.rule).toContain('multiplied by 80%')
    expect(result.rule).toContain('Raise operation is not used')
  })

  it('keeps zero-influence enabled channels as the base, matching composition', () => {
    const layers = [{ ...base, amount: 0 }, edges]
    expect(describeChannel(layers, 'base')!.isBase).toBe(true)
    expect(describeChannel(layers, 'edges')!.isBase).toBe(false)
  })

  it('distinguishes muted state from an active operation and finds the next enabled base', () => {
    const layers = [{ ...base, enabled: false }, edges]
    const original = JSON.stringify(layers)
    const muted = describeChannel(layers, 'base')!
    expect(muted.status).toBe('Muted')
    expect(muted.isBase).toBe(false)
    expect(muted.rule).toContain('before and after are identical')
    const next = describeChannel(layers, 'edges')!
    expect(next.isBase).toBe(inspectChannel(createDemoImage(4, 4), layers, 'edges')!.isBase)
    expect(JSON.stringify(layers)).toBe(original)
  })

  it('shows actual influence, inversion and hue instead of inferring an additive contribution', () => {
    expect(describeChannel([base, edges], 'edges')).toMatchObject({
      source: 'Edges', operation: 'Multiply', status: 'Enabled', influence: 35,
      inversion: 'On · signal is inverted before combining', hue: null,
    })
    expect(describeChannel([{ ...base, source: 'hue', hueOrigin: 0.25, amount: 2 }], 'base')).toMatchObject({ hue: 90, influence: 100 })
  })

  it.each(CHANNEL_BLEND_MODES)('explains $label using its actual blend rule', ({ value, label }) => {
    const result = describeChannel([base, { ...edges, blend: value }], 'edges')!
    expect(result.rule).toContain(label)
    expect(result.rule).toContain('0% leaves the previous composite unchanged')
    expect(result.rule).toContain('100% uses the full result')
  })

  it('explains clipping before influence for Raise and Carve', () => {
    expect(describeChannel([base, { ...edges, blend: 'add' }], 'edges')!.rule).toContain('clips that sum to 0–1, then blends')
    expect(describeChannel([base, { ...edges, blend: 'subtract' }], 'edges')!.rule).toContain('clips that difference to 0–1, then blends')
  })

  it('does not invent a channel when selection is absent', () => {
    expect(describeChannel([base], 'missing')).toBeNull()
  })
})
