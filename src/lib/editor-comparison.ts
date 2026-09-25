import { cloneEditorDocument, type EditorDocument } from './editor-document'
import { FIELD_VARIATIONS, type FieldVariationKey } from './field-variations'

/** A temporary comparison changes exactly one existing whole-image setting. */
export function createFieldComparison(document: EditorDocument, key: FieldVariationKey, value: number) {
  const option = FIELD_VARIATIONS[key]
  if (document.workspace !== 'image' || !option || !Number.isInteger(value)
    || value < option.min || value > option.max
    || (key === 'blobDilation' && document.field.finish !== 'blob')) return null
  const candidate = cloneEditorDocument(document)
  candidate.field[key] = value
  return { document: candidate, name: `${option.label} ${value}${option.unit ? ` ${option.unit}` : ''}` }
}
