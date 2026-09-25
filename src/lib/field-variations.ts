import { processScalarField } from './filters'
import type { FieldSettings, ScalarField } from '../types'

export const FIELD_VARIATIONS = {
  blur: { label: 'Base smoothing', min: 0, max: 8, step: 2, unit: 'px' },
  contrast: { label: 'Contrast', min: -50, max: 50, step: 15, unit: '' },
  blobDilation: { label: 'Dilation', min: 0, max: 20, step: 4, unit: 'px' },
} as const
export type FieldVariationKey = keyof typeof FIELD_VARIATIONS

/** Sample one real field parameter; all other authored settings remain untouched. */
export function createFieldVariations(raw: ScalarField, settings: FieldSettings, key: FieldVariationKey) {
  const option = FIELD_VARIATIONS[key]
  const values = [...new Set([-1, 0, 1].map(offset => Math.max(option.min, Math.min(option.max, settings[key] + offset * option.step))))]
  return values.map(value => ({ value, field: processScalarField(raw, { ...settings, [key]: value }) }))
}
