import { describe, expect, it } from 'vitest'
import { clamp01, circularHueResponse, extractScalarField, perceptualLuminance, rgbToHsv } from './channels'
import { createDemoImage } from './image'

describe('channel math', () => {
  it('keeps non-finite values out of geometry fields', () => {
    expect(clamp01(Number.NaN)).toBe(0)
    expect(clamp01(Number.POSITIVE_INFINITY)).toBe(0)
  })

  it('uses linear-light perceptual luminance', () => {
    expect(perceptualLuminance(0, 0, 0)).toBe(0)
    expect(perceptualLuminance(1, 1, 1)).toBeCloseTo(1, 8)
    expect(perceptualLuminance(0, 1, 0)).toBeGreaterThan(perceptualLuminance(1, 0, 0))
  })

  it('converts primary colors to stable HSV values', () => {
    expect(rgbToHsv(1, 0, 0)).toEqual({ h: 0, s: 1, v: 1 })
    expect(rgbToHsv(0, 1, 0).h).toBeCloseTo(1 / 3)
    expect(rgbToHsv(0, 0, 1).h).toBeCloseTo(2 / 3)
  })

  it('treats hue as circular around the chosen anchor', () => {
    const justBelowRed = circularHueResponse(359 / 360, 0, 1)
    const justAboveRed = circularHueResponse(1 / 360, 0, 1)
    expect(justBelowRed).toBeCloseTo(justAboveRed, 8)
    expect(justBelowRed).toBeGreaterThan(0.99)
    expect(circularHueResponse(0.5, 0, 1)).toBeCloseTo(0)
    expect(circularHueResponse(0, 0, 0)).toBe(0)
  })

  it('produces distinct fields for every advertised image property', () => {
    const image = createDemoImage(48, 36)
    const modes = ['luminance', 'hue', 'saturation', 'value', 'red', 'green', 'blue', 'alpha', 'edges'] as const
    const signatures = modes.map((mode) => {
      const field = extractScalarField(image, mode, 0.03)
      return Array.from(field.values).reduce((sum, value, index) => sum + value * ((index % 13) + 1), 0).toFixed(4)
    })
    expect(new Set(signatures).size).toBe(modes.length)
  })
})
