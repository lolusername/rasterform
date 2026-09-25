import { describe, expect, it } from 'vitest'
import { editorDocumentFixture } from '../../tests/fixtures/editor-document'
import {
  cloneEditorDocument, editorDocumentsEqual, editorFontRequirement, EditorProjectError,
  parseEditorProject, serializeEditorProject, validateEditorDocument,
} from './editor-document'
import { composeChannelStack } from './channel-stack'
import { processScalarField } from './filters'
import { buildMesh } from './mesh'

describe('authored editor documents', () => {
  it('copies mutable state but retains immutable image/Blob assets', () => {
    const original = editorDocumentFixture()
    original.image.sourceBlob = new Blob(['original bytes'], { type: 'image/png' })
    original.mesh.strata = { ...original.strata }
    const snapshot = cloneEditorDocument(original)
    expect(editorDocumentsEqual(snapshot, original)).toBe(true)
    expect(snapshot.image.data).toBe(original.image.data)
    expect(snapshot.image.sourceBlob).toBe(original.image.sourceBlob)
    original.channels[0].amount = 0.1
    original.imageAppearance.clay.color = '#ffffff'
    original.camera!.position[0] = 19
    original.mesh.strata.layers = 15
    expect(snapshot.channels[0].amount).toBe(0.86)
    expect(snapshot.imageAppearance.clay.color).toBe('#d7d0bf')
    expect(snapshot.camera!.position[0]).toBe(2)
    expect(snapshot.mesh.strata!.layers).toBe(12)
    expect(editorDocumentsEqual(snapshot, original)).toBe(false)
  })

  it('round-trips all settings, full source bytes, source dimensions, camera, font, and working alpha', async () => {
    const original = editorDocumentFixture()
    original.workspace = 'text'
    original.image.name = 'A photograph – original.png'
    original.image.sourceWidth = 3072
    original.image.sourceHeight = 4096
    original.image.data[3] = 127
    original.image.sourceBlob = new File([new Uint8Array([137, 80, 78, 71, 0, 255, 19])], original.image.name, { type: 'image/png', lastModified: 123456789 })
    original.fontBlob = new Blob([new Uint8Array([0, 2, 5, 255])], { type: 'font/otf' })
    original.font = { ...original.font, id: 'local:test', source: 'local', postscriptName: 'Preserve-Me' }
    original.mesh.strata = { ...original.strata, layers: 24 }
    original.text.text = 'Exact\ntext 🎨'
    original.imageLivingPhase = 0.437
    original.textLivingPhase = 0.92
    original.textAppearance.clay.finish = 'metallic'
    const json = await serializeEditorProject(original)
    const restored = parseEditorProject(json)
    expect(restored).toEqual(original)
    expect(restored.image.data).not.toBe(original.image.data)
    expect(await restored.image.sourceBlob!.arrayBuffer()).toEqual(await original.image.sourceBlob.arrayBuffer())
    expect(await restored.fontBlob!.arrayBuffer()).toEqual(await original.fontBlob.arrayBuffer())
    expect((restored.image.sourceBlob as File).lastModified).toBe(123456789)
    expect((restored.image.sourceBlob as File).name).toBe(original.image.name)
    expect(json).not.toContain('progress')
    expect(json).not.toContain('positions')
  })

  it('does not require original file bytes for a generated demo image', async () => {
    const original = editorDocumentFixture()
    delete original.camera
    const restored = parseEditorProject(await serializeEditorProject(original))
    expect(restored).toEqual(original)
    expect(restored.image.sourceBlob).toBeUndefined()
  })

  it('produces byte-identical height fields, mesh geometry, UVs, and vertex colors after project restore', async () => {
    const original = editorDocumentFixture()
    original.field.finish = 'blob'
    original.channels[1].blend = 'multiply'
    original.channels[1].invert = true
    original.channels[1].amount = 0.37
    const restored = parseEditorProject(await serializeEditorProject(original))
    const originalField = processScalarField(composeChannelStack(original.image, original.channels), original.field)
    const restoredField = processScalarField(composeChannelStack(restored.image, restored.channels), restored.field)
    expect(restoredField).toEqual(originalField)
    const originalMesh = buildMesh(originalField, original.image, original.mesh)
    const restoredMesh = buildMesh(restoredField, restored.image, restored.mesh)
    for (const key of ['positions', 'indices', 'colors', 'uvs', 'heights'] as const) {
      expect(new Uint8Array(restoredMesh[key].buffer)).toEqual(new Uint8Array(originalMesh[key].buffer))
    }
  })

  it.each([
    ['non-finite settings', (doc: any) => { doc.mesh.depth = Infinity }],
    ['wrong pixel size', (doc: any) => { doc.image.data = new Uint8ClampedArray(1) }],
    ['duplicate channel IDs', (doc: any) => { doc.channels[1].id = doc.channels[0].id }],
    ['missing selected channel', (doc: any) => { doc.selectedChannelId = 'gone' }],
    ['unknown operators', (doc: any) => { doc.channels[0].blend = 'unknown' }],
    ['invalid camera', (doc: any) => { doc.camera.quaternion = [0, 0, 0, 0] }],
    ['invalid clipping', (doc: any) => { doc.camera.far = doc.camera.near }],
    ['hostile color values', (doc: any) => { doc.imageAppearance.clay.color = '<script>' }],
    ['missing font', (doc: any) => { delete doc.font }],
    ['unbounded resolution', (doc: any) => { doc.mesh.resolution = 1e9 }],
    ['malformed source asset', (doc: any) => { doc.image.sourceBlob = { size: 5 } }],
  ])('rejects %s without applying or normalizing it', (_name, change) => {
    const document = editorDocumentFixture()
    change(document)
    expect(() => validateEditorDocument(document)).toThrow(EditorProjectError)
  })

  it('accepts every current UI range endpoint without silently changing any settings', () => {
    const document = editorDocumentFixture()
    document.field = { invert: true, blur: 8, contrast: -50, quantize: 12, finish: 'blob', blobDilation: 20, blobSmoothing: 24 }
    document.mesh = { mode: 'strata', resolution: 180, depth: 1.4, midpoint: 1, baseThickness: 0.8 }
    document.strata = { layers: 24, thickness: 0.12, separation: 0.18 }
    document.text = { ...document.text, tracking: -0.08, lineHeight: 1.8, depth: 0.9, bevelSize: 0.12, bevelThickness: 0.12, bevelSegments: 8, resolution: 720 }
    document.imageLivingForm = { enabled: true, behavior: 'expand', amount: 1, frequency: 5, seed: 100, duration: 12 }
    expect(validateEditorDocument(document)).toEqual(document)
  })

  it('rejects malformed, future-version, recipe, truncated and oversized pixel imports', async () => {
    expect(() => parseEditorProject('not json')).toThrow(/readable/)
    const serialized = JSON.parse(await serializeEditorProject(editorDocumentFixture()))
    expect(() => parseEditorProject(JSON.stringify({ ...serialized, version: 99 }))).toThrow(/version/)
    expect(() => parseEditorProject(JSON.stringify({ app: 'Rasterform', version: 6 }))).toThrow(/recipe/)
    serialized.document.image.rgba = 'A===' // invalid base64
    expect(() => parseEditorProject(JSON.stringify(serialized))).toThrow(EditorProjectError)
    serialized.document.image.rgba = 'AAAA'
    expect(() => parseEditorProject(JSON.stringify(serialized))).toThrow(/pixel count/)
    serialized.document.image.width = 1e9
    expect(() => parseEditorProject(JSON.stringify(serialized))).toThrow(EditorProjectError)
  })

  it('reports a missing font explicitly and recognizes embedded or available matching faces', () => {
    const document = editorDocumentFixture()
    expect(editorFontRequirement(document, [])).toBe('missing')
    expect(editorFontRequirement(document, [document.font])).toBe('available')
    document.font = { ...document.font, id: 'local:other', postscriptName: 'AFont' }
    expect(editorFontRequirement(document, [{ ...document.font, id: 'detected:other' }])).toBe('available')
    document.fontBlob = new Blob(['font bytes'])
    expect(editorFontRequirement(document, [])).toBe('embedded')
  })

  it('strips extraneous untrusted fields when validating', () => {
    const document = Object.assign(editorDocumentFixture(), { exporting: true, progress: 0.5 })
    const validated = validateEditorDocument(document)
    expect(validated).not.toHaveProperty('exporting')
    expect(validated).not.toHaveProperty('progress')
  })
})
