import { describe, expect, it } from 'vitest'
import { normalizeNumberControlValue } from './number-control'

describe('normalizeNumberControlValue', () => {
  it.each([2, 4])('keeps fractional mesh detail on its integer step-%i grid', (step) => {
    expect(normalizeNumberControlValue(88.5, { min: 16, max: 180, step })).toBe(88)
  })

  it('rounds decimal half steps upward without binary floating-point drift', () => {
    const range = { min: 0.02, max: 1.4, step: 0.02 }
    expect(normalizeNumberControlValue(0.61, range)).toBe(0.62)
    expect(normalizeNumberControlValue(0.6, range)).toBe(0.6)
    expect(normalizeNumberControlValue(0.58, range)).toBe(0.58)
    expect(normalizeNumberControlValue(1.39, range)).toBe(1.4)
    expect(normalizeNumberControlValue(0.60999, range)).toBe(0.6)
  })

  it('anchors the step grid at min, including negative bounds', () => {
    expect(normalizeNumberControlValue(0.14, { min: 0.03, max: 0.43, step: 0.1 })).toBe(0.13)
    expect(normalizeNumberControlValue(-3.5, { min: -10, max: 10, step: 1 })).toBe(-3)
  })

  it('clamps entries to supported bounds and does not create off-grid endpoints', () => {
    expect(normalizeNumberControlValue(999, { min: 16, max: 180, step: 4 })).toBe(180)
    expect(normalizeNumberControlValue(-50, { min: 16, max: 180, step: 4 })).toBe(16)
    expect(normalizeNumberControlValue(8, { min: 0.02, max: 1.4, step: 0.02 })).toBe(1.4)
    expect(normalizeNumberControlValue(-2, { min: 0.02, max: 1.4, step: 0.02 })).toBe(0.02)
    expect(normalizeNumberControlValue(1, { min: 0, max: 1, step: 0.6 })).toBe(0.6)
    expect(normalizeNumberControlValue(0.3, { min: 0, max: 0.3, step: 0.1 })).toBe(0.3)
  })

  it('preserves small scientific-notation steps', () => {
    expect(normalizeNumberControlValue(2.5e-7, { min: 1e-7, max: 1e-6, step: 1e-7 })).toBe(3e-7)
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('rejects a non-finite entry %s so the control can restore its current value', (value) => {
    expect(normalizeNumberControlValue(value, { min: 0, max: 8, step: 1 })).toBeNull()
  })

  it('rejects invalid control definitions', () => {
    expect(() => normalizeNumberControlValue(1, { min: 0, max: 8, step: 0 })).toThrow(RangeError)
    expect(() => normalizeNumberControlValue(1, { min: 8, max: 0, step: 1 })).toThrow(RangeError)
  })
})
