import { expect, it } from 'vitest'
import { createFieldVariations } from './field-variations'
import { processScalarField } from './filters'
import type { FieldSettings } from '../types'

it('compares actual parameter values without changing the source or other settings', () => {
  const raw = { width: 3, height: 3, values: new Float32Array([0, 0, 0, 0, 1, 0, 0, 0, 0]) }
  const settings: FieldSettings = { blur: 2, contrast: 8, quantize: 0, invert: false, finish: 'detail', blobDilation: 6, blobSmoothing: 8 }
  const before = JSON.stringify(settings)
  const choices = createFieldVariations(raw, settings, 'blur')
  expect(choices.map(item => item.value)).toEqual([0, 2, 4])
  expect(choices[1]!.field).toEqual(processScalarField(raw, settings))
  expect(JSON.stringify(settings)).toBe(before)
  expect(raw.values[4]).toBe(1)
})
it('does not duplicate clipped endpoints', () => {
  const raw = { width: 1, height: 1, values: new Float32Array([.5]) }
  const settings: FieldSettings = { blur: 0, contrast: 50, quantize: 0, invert: false, finish: 'detail', blobDilation: 6, blobSmoothing: 8 }
  expect(createFieldVariations(raw, settings, 'contrast').map(item => item.value)).toEqual([35, 50])
})
