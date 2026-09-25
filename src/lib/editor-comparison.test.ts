import { describe, expect, it } from 'vitest'
import { editorDocumentFixture } from '../../tests/fixtures/editor-document'
import { createFieldComparison } from './editor-comparison'

describe('form comparison candidates', () => {
  it('changes only the requested setting, preserving source, camera, geometry, appearance and motion', () => {
    const original = editorDocumentFixture()
    const before = structuredClone(original)
    const candidate = createFieldComparison(original, 'blur', 5)!
    expect(candidate.name).toBe('Base smoothing 5 px')
    expect(candidate.document).toEqual({ ...original, field: { ...original.field, blur: 5 } })
    expect(original).toEqual(before)
    expect(candidate.document.image.data).toBe(original.image.data)
    expect(candidate.document.field).not.toBe(original.field)
  })

  it('does not invent unsupported settings or enable Blob implicitly', () => {
    const original = editorDocumentFixture()
    original.field.finish = 'detail'
    expect(createFieldComparison(original, 'blobDilation', 10)).toBeNull()
    original.field.finish = 'blob'
    expect(createFieldComparison(original, 'blobDilation', 10)?.document.field.blobDilation).toBe(10)
    for (const value of [-1, 9, 1.5, NaN, Infinity]) expect(createFieldComparison(original, 'blur', value)).toBeNull()
    original.workspace = 'text'
    expect(createFieldComparison(original, 'contrast', 5)).toBeNull()
  })
})
