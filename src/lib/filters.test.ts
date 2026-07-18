import { describe, expect, it } from 'vitest'
import { processScalarField } from './filters'
import type { FieldSettings, ScalarField } from '../types'

const detail: FieldSettings = {
  invert: false,
  blur: 0,
  contrast: 0,
  quantize: 0,
  finish: 'detail',
  blobDilation: 0,
  blobSmoothing: 0,
}

function scalarField(width: number, height: number, values: readonly number[]): ScalarField {
  return { width, height, values: new Float32Array(values) }
}

function impulse(width: number, height: number, x: number, y: number): ScalarField {
  const values = new Array<number>(width * height).fill(0)
  values[y * width + x] = 1
  return scalarField(width, height, values)
}

function referenceDilation(field: ScalarField, radius: number): number[] {
  const output = new Array<number>(field.values.length).fill(0)
  for (let y = 0; y < field.height; y += 1) {
    for (let x = 0; x < field.width; x += 1) {
      let maximum = 0
      for (let sampleY = Math.max(0, y - radius); sampleY <= Math.min(field.height - 1, y + radius); sampleY += 1) {
        for (let sampleX = Math.max(0, x - radius); sampleX <= Math.min(field.width - 1, x + radius); sampleX += 1) {
          maximum = Math.max(maximum, field.values[sampleY * field.width + sampleX] ?? 0)
        }
      }
      output[y * field.width + x] = maximum
    }
  }
  return output
}

function referenceBoxPass(values: readonly number[], width: number, height: number, radius: number): number[] {
  const horizontalRadius = Math.min(radius, Math.max(0, width - 1))
  const verticalRadius = Math.min(radius, Math.max(0, height - 1))
  const divisor = (horizontalRadius * 2 + 1) * (verticalRadius * 2 + 1)
  const output = new Array<number>(values.length).fill(0)

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0
      for (let offsetY = -verticalRadius; offsetY <= verticalRadius; offsetY += 1) {
        const sampleY = Math.min(height - 1, Math.max(0, y + offsetY))
        for (let offsetX = -horizontalRadius; offsetX <= horizontalRadius; offsetX += 1) {
          const sampleX = Math.min(width - 1, Math.max(0, x + offsetX))
          sum += values[sampleY * width + sampleX] ?? 0
        }
      }
      output[y * width + x] = sum / divisor
    }
  }
  return output
}

describe('scalar-field finishes', () => {
  it('preserves the existing detail path and ignores inactive blob radii', () => {
    const field = scalarField(3, 1, [0, 1, 0])
    const input = new Float32Array(field.values)
    const result = processScalarField(field, {
      ...detail,
      blur: 1,
      blobDilation: 20,
      blobSmoothing: 20,
    })

    expect(Array.from(result.values)).toEqual([
      0.22561010718345642,
      0.5487797856330872,
      0.22561010718345642,
    ])
    expect(field.values).toEqual(input)
    expect(result.values).not.toBe(field.values)
  })

  it('dilates an isolated height into its neighboring footprint', () => {
    const result = processScalarField(impulse(5, 5, 2, 2), {
      ...detail,
      finish: 'blob',
      blobDilation: 1,
    })

    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 5; x += 1) {
        expect(result.values[y * 5 + x]).toBe(x >= 1 && x <= 3 && y >= 1 && y <= 3 ? 1 : 0)
      }
    }
  })

  it('matches a direct two-dimensional max filter on non-square fields', () => {
    const field = scalarField(4, 3, [
      0.1, 0.8, 0.2, 0.3,
      0.4, 0.15, 0.95, 0.25,
      0.05, 0.6, 0.35, 0.7,
    ])
    const result = processScalarField(field, {
      ...detail,
      finish: 'blob',
      blobDilation: 1,
    })

    expect(Array.from(result.values)).toEqual(referenceDilation(field, 1))
  })

  it('rounds and suppresses a needle peak after dilation', () => {
    const size = 9
    const result = processScalarField(impulse(size, size, 4, 4), {
      ...detail,
      finish: 'blob',
      blobDilation: 1,
      blobSmoothing: 2,
    })
    const center = result.values[4 * size + 4] ?? 0
    const near = result.values[4 * size + 3] ?? 0
    const far = result.values[4 * size] ?? 0

    expect(center).toBeGreaterThan(near)
    expect(near).toBeGreaterThan(far)
    expect(center).toBeGreaterThan(0)
    expect(center).toBeLessThan(1)
    expect(result.values[4 * size + 3]).toBeCloseTo(result.values[3 * size + 4] ?? 0, 6)
  })

  it('matches three reference box passes for organic smoothing', () => {
    const field = scalarField(4, 3, [
      0, 0.2, 0.8, 1,
      0.1, 0.9, 0.3, 0.7,
      0.4, 0.6, 0.5, 0,
    ])
    const result = processScalarField(field, {
      ...detail,
      finish: 'blob',
      blobSmoothing: 1,
    })
    let reference = Array.from(field.values)
    for (let pass = 0; pass < 3; pass += 1) reference = referenceBoxPass(reference, field.width, field.height, 1)

    result.values.forEach((value, index) => expect(value).toBeCloseTo(reference[index] ?? 0, 5))
  })

  it('keeps a broad raised area while rounding its perimeter', () => {
    const values = new Array<number>(13 * 13).fill(0)
    for (let y = 3; y <= 9; y += 1) {
      for (let x = 3; x <= 9; x += 1) values[y * 13 + x] = 1
    }
    const result = processScalarField(scalarField(13, 13, values), {
      ...detail,
      finish: 'blob',
      blobDilation: 1,
      blobSmoothing: 1,
    })

    expect(result.values[6 * 13 + 6]).toBeCloseTo(1, 6)
    expect(result.values[6 * 13 + 2]).toBeGreaterThan(0)
    expect(result.values[6 * 13 + 2]).toBeLessThan(1)
    expect(result.values[0]).toBeLessThan(result.values[6 * 13 + 2] ?? 0)
  })

  it('applies inversion and quantization before organic processing', () => {
    const inverted = new Array<number>(25).fill(1)
    inverted[12] = 0
    const dilated = processScalarField(scalarField(5, 5, inverted), {
      ...detail,
      invert: true,
      finish: 'blob',
      blobDilation: 1,
    })
    expect(dilated.values[12]).toBe(1)
    expect(dilated.values[11]).toBe(1)
    expect(dilated.values[0]).toBe(0)

    const quantized = processScalarField(scalarField(7, 1, [0, 0, 0.49, 0.51, 0, 0, 0]), {
      ...detail,
      quantize: 2,
      finish: 'blob',
      blobSmoothing: 1,
    })
    expect(Array.from(quantized.values).some((value) => value > 0 && value < 1)).toBe(true)
  })

  it('clips morphology at field edges instead of wrapping', () => {
    const result = processScalarField(impulse(5, 4, 0, 0), {
      ...detail,
      finish: 'blob',
      blobDilation: 1,
    })

    expect(result.values[0]).toBe(1)
    expect(result.values[1]).toBe(1)
    expect(result.values[5]).toBe(1)
    expect(result.values[4]).toBe(0)
    expect(result.values[19]).toBe(0)
  })

  it('preserves uniform fields through large linear-time filters', () => {
    const field = scalarField(3, 2, new Array<number>(6).fill(0.375))
    const result = processScalarField(field, {
      ...detail,
      finish: 'blob',
      blobDilation: 10_000,
      blobSmoothing: 10_000,
    })

    for (const value of result.values) expect(value).toBeCloseTo(0.375, 6)
  })

  it('returns finite clamped values without mutating its input', () => {
    const field = scalarField(3, 2, [Number.NaN, Number.POSITIVE_INFINITY, -4, 0.4, 2, 0.7])
    const input = new Float32Array(field.values)
    const result = processScalarField(field, {
      ...detail,
      contrast: 50,
      finish: 'blob',
      blobDilation: 1,
      blobSmoothing: 1,
    })

    expect(field.values).toEqual(input)
    expect(result.width).toBe(field.width)
    expect(result.height).toBe(field.height)
    expect(Array.from(result.values).every((value) => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(true)
  })
})
