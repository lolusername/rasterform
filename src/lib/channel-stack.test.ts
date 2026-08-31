import { describe, expect, it } from 'vitest'
import { composeChannelStack } from './channel-stack'
import type { ChannelLayer, PixelImage } from '../types'

const image: PixelImage = {
  width: 2,
  height: 1,
  sourceWidth: 2,
  sourceHeight: 1,
  name: 'two-pixels',
  data: new Uint8ClampedArray([
    255, 0, 0, 255,
    0, 128, 255, 255,
  ]),
}

function layer(overrides: Partial<ChannelLayer> = {}): ChannelLayer {
  return {
    id: 'layer',
    source: 'red',
    blend: 'add',
    amount: 1,
    invert: false,
    hueOrigin: 0,
    enabled: true,
    ...overrides,
  }
}

describe('channel stack', () => {
  it('uses the first enabled channel as a weighted base', () => {
    const field = composeChannelStack(image, [
      layer({ enabled: false, source: 'blue' }),
      layer({ source: 'red', amount: 0.5 }),
    ])

    expect(Array.from(field.values)).toEqual([0.5, 0])
  })

  it('adds and subtracts layers in order while clamping the field', () => {
    const added = composeChannelStack(image, [
      layer({ source: 'red' }),
      layer({ id: 'blue', source: 'blue', blend: 'add', amount: 0.5 }),
    ])
    const subtracted = composeChannelStack(image, [
      layer({ source: 'blue' }),
      layer({ id: 'red', source: 'red', blend: 'subtract', amount: 0.75 }),
    ])

    expect(Array.from(added.values)).toEqual([1, 0.5])
    expect(Array.from(subtracted.values)).toEqual([0, 1])
  })

  it('supports photographic multiply and screen blends', () => {
    const multiplied = composeChannelStack(image, [
      layer({ source: 'red', amount: 0.8 }),
      layer({ id: 'alpha', source: 'alpha', blend: 'multiply', amount: 0.5 }),
    ])
    const screened = composeChannelStack(image, [
      layer({ source: 'red', amount: 0.5 }),
      layer({ id: 'blue', source: 'blue', blend: 'screen', amount: 1 }),
    ])

    expect(multiplied.values[0]).toBeCloseTo(0.8)
    expect(screened.values[0]).toBeCloseTo(0.5)
    expect(screened.values[1]).toBeCloseTo(1)
  })

  it('makes zero strength an identity for every non-base blend', () => {
    const modes = ['normal', 'add', 'subtract', 'multiply', 'screen', 'max', 'min'] as const
    for (const blend of modes) {
      const field = composeChannelStack(image, [
        layer({ source: 'red', amount: 0.5 }),
        layer({ id: blend, source: 'blue', blend, amount: 0 }),
      ])
      expect(Array.from(field.values)).toEqual([0.5, 0])
    }
  })

  it('interpolates toward a saturated add instead of jumping past it', () => {
    const field = composeChannelStack(image, [
      layer({ source: 'alpha', amount: 0.8 }),
      layer({ id: 'red', source: 'red', blend: 'add', amount: 0.5 }),
    ])
    expect(field.values[0]).toBeCloseTo(0.9)
  })

  it('mixes toward a replacement channel at partial influence', () => {
    const field = composeChannelStack(image, [
      layer({ source: 'alpha', amount: 0.8 }),
      layer({ id: 'blue', source: 'blue', blend: 'normal', amount: 0.25 }),
    ])
    expect(field.values[0]).toBeCloseTo(0.6)
    expect(field.values[1]).toBeCloseTo(0.85)
  })

  it('treats channel order as part of the recipe', () => {
    const raisedThenMultiplied = composeChannelStack(image, [
      layer({ source: 'red', amount: 0.4 }),
      layer({ id: 'blue', source: 'blue', blend: 'add', amount: 0.5 }),
      layer({ id: 'green', source: 'green', blend: 'multiply', amount: 1 }),
    ])
    const multipliedThenRaised = composeChannelStack(image, [
      layer({ source: 'red', amount: 0.4 }),
      layer({ id: 'green', source: 'green', blend: 'multiply', amount: 1 }),
      layer({ id: 'blue', source: 'blue', blend: 'add', amount: 0.5 }),
    ])

    expect(raisedThenMultiplied.values[1]).toBeCloseTo(0.5 * (128 / 255))
    expect(multipliedThenRaised.values[1]).toBeCloseTo(0.5)
  })

  it('interpolates toward peak and valley envelopes', () => {
    const peak = composeChannelStack(image, [
      layer({ source: 'alpha', amount: 0.8 }),
      layer({ id: 'red', source: 'red', blend: 'max', amount: 0.5 }),
    ])
    const valley = composeChannelStack(image, [
      layer({ source: 'alpha', amount: 0.8 }),
      layer({ id: 'blue', source: 'blue', blend: 'min', amount: 0.5 }),
    ])

    expect(peak.values[0]).toBeCloseTo(0.9)
    expect(valley.values[0]).toBeCloseTo(0.4)
  })

  it('applies per-layer inversion without changing the source image', () => {
    const original = Array.from(image.data)
    const field = composeChannelStack(image, [layer({ source: 'red', invert: true })])

    expect(Array.from(field.values)).toEqual([0, 1])
    expect(Array.from(image.data)).toEqual(original)
  })

  it('returns a flat zero field when every layer is disabled', () => {
    const field = composeChannelStack(image, [layer({ enabled: false })])
    expect(Array.from(field.values)).toEqual([0, 0])
  })
})
