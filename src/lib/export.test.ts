import { beforeAll, describe, expect, it, vi } from 'vitest'
import { BufferGeometry, Material } from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { encodeGlb, encodeStl } from './export'
import { buildMesh } from './mesh'
import { buildStrataMesh } from './strata'
import { createDefaultAppearanceSettings } from './three'
import type { PixelImage, ScalarField, SourceTexture } from '../types'

class TestFileReader {
  result: ArrayBuffer | string | null = null
  onloadend: (() => void) | null = null
  readAsArrayBuffer(blob: Blob) {
    void blob.arrayBuffer().then((buffer) => {
      this.result = buffer
      this.onloadend?.()
    })
  }
  readAsDataURL() { throw new Error('Data URL not expected for binary GLB test') }
}

beforeAll(() => {
  Object.defineProperty(globalThis, 'FileReader', { value: TestFileReader, configurable: true })
})

const field: ScalarField = { width: 2, height: 2, values: new Float32Array([0, .4, .7, 1]) }
const image: PixelImage = { width: 2, height: 2, sourceWidth: 2, sourceHeight: 2, name: 'test', data: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255]) }
const mesh = buildMesh(field, image, { mode: 'solid', resolution: 8, depth: .4, midpoint: .5, baseThickness: .4 })
const sourceTexture: SourceTexture = {
  data: Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII='), (character) => character.charCodeAt(0)),
  width: 1, height: 1, mimeType: 'image/png', name: 'source.png',
}

interface GlbDocument {
  nodes: Array<{ name: string; mesh?: number; children?: number[] }>
  buffers: Array<{ byteLength: number }>
  bufferViews: Array<{ byteOffset: number; byteLength: number }>
  accessors: Array<{ bufferView: number; byteOffset?: number; count: number; componentType: number }>
  images: Array<{ mimeType: string; bufferView: number; uri?: string }>
  textures: Array<{ source: number; sampler: number }>
  samplers: Array<{ wrapS: number; wrapT: number }>
  materials: Array<{
    name: string
    pbrMetallicRoughness: { baseColorFactor?: number[]; metallicFactor: number; roughnessFactor: number; baseColorTexture?: { index: number; texCoord: number } }
  }>
  meshes: Array<{ primitives: Array<{ attributes: Record<string, number>; indices: number; material: number }> }>
}

function readGlb(glb: ArrayBuffer) {
  const view = new DataView(glb)
  const length = view.getUint32(12, true)
  const document = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, length))) as GlbDocument
  const binaryOffset = 20 + length + 8
  const values = (accessorIndex: number, size: number) => {
    const accessor = document.accessors[accessorIndex]!
    const bufferView = document.bufferViews[accessor.bufferView]!
    const offset = binaryOffset + (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0)
    if (accessor.componentType === 5126) return Array.from(new Float32Array(glb, offset, accessor.count * size))
    if (accessor.componentType === 5125) return Array.from(new Uint32Array(glb, offset, accessor.count * size))
    return Array.from(new Uint16Array(glb, offset, accessor.count * size))
  }
  return { document, binaryOffset, values }
}

describe('portable mesh exports', () => {
  it('exports each contour layer as a named object with shared embedded bitmap and correct UVs', async () => {
    const strata = buildStrataMesh(field, image, 8, { layers: 5 })
    const appearance = createDefaultAppearanceSettings()
    appearance.clay.finish = 'metallic'
    const glb = await encodeGlb(strata, 'clay', appearance, sourceTexture)
    const { document, values } = readGlb(glb)
    expect(document.nodes.filter((node) => node.mesh !== undefined).map((node) => node.name)).toEqual([
      'Rasterform_Strata_01', 'Rasterform_Strata_02', 'Rasterform_Strata_03', 'Rasterform_Strata_04', 'Rasterform_Strata_05',
    ])
    expect(document.images).toHaveLength(1)
    expect(document.meshes).toHaveLength(5)
    for (const exported of document.meshes) {
      expect(exported.primitives).toHaveLength(2)
      const front = exported.primitives.find((primitive) => document.materials[primitive.material]!.name === 'Rasterform_Source_Image')!
      const material = document.materials[front.material]!.pbrMetallicRoughness
      expect(material.baseColorTexture).toEqual({ index: 0, texCoord: 0 })
      expect(material.metallicFactor).toBe(1)
      expect(material.roughnessFactor).toBe(0.26)
      expect(front.attributes.COLOR_0).toBeUndefined()
      const coordinates = values(front.attributes.POSITION!, 3)
      const uv = values(front.attributes.TEXCOORD_0!, 2)
      for (let vertex = 0; vertex < uv.length / 2; vertex += 1) {
        expect(uv[vertex * 2]).toBeCloseTo(coordinates[vertex * 3]! / 2 + 0.5)
        expect(uv[vertex * 2 + 1]).toBeCloseTo(0.5 - coordinates[vertex * 3 + 1]! / 2)
      }
    }
  })

  it('encodes a nonempty GLB 2.0 container', async () => {
    const glb = await encodeGlb(mesh, 'original')
    const header = new DataView(glb, 0, 12)
    expect(header.getUint32(0, true)).toBe(0x46546c67)
    expect(header.getUint32(4, true)).toBe(2)
    expect(header.getUint32(8, true)).toBe(glb.byteLength)
    expect(glb.byteLength).toBeGreaterThan(1000)
  })

  it('carries custom clay color and finish into GLB material data', async () => {
    const appearance = createDefaultAppearanceSettings()
    appearance.clay = { color: '#a33bd1', finish: 'metallic' }
    const glb = await encodeGlb(mesh, 'clay', appearance)
    const view = new DataView(glb)
    const jsonLength = view.getUint32(12, true)
    expect(view.getUint32(16, true)).toBe(0x4e4f534a)
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, jsonLength)).trim()) as {
      materials: Array<{ pbrMetallicRoughness: { baseColorFactor: number[]; metallicFactor: number; roughnessFactor: number } }>
    }
    const material = json.materials[0]?.pbrMetallicRoughness
    expect(material?.baseColorFactor).toHaveLength(4)
    expect(material?.metallicFactor).toBe(1)
    expect(material?.roughnessFactor).toBeCloseTo(0.26)
  })

  it('encodes a binary STL with the mesh face count', () => {
    const stl = encodeStl(mesh)
    expect(stl).toBeInstanceOf(ArrayBuffer)
    const buffer = stl as ArrayBuffer
    expect(buffer.byteLength).toBe(84 + mesh.indices.length / 3 * 50)
    expect(new DataView(buffer).getUint32(80, true)).toBe(mesh.indices.length / 3)
  })

  it('embeds exact PNG bytes on the front with neutral backing and the selected metallic finish', async () => {
    const appearance = createDefaultAppearanceSettings()
    appearance.clay = { color: '#a33bd1', finish: 'metallic' }
    const result = await encodeGlb(mesh, 'clay', appearance, sourceTexture)
    const { document, binaryOffset, values } = readGlb(result)
    expect(new DataView(result).getUint32(8, true)).toBe(result.byteLength)
    expect(document.buffers[0]!.byteLength + binaryOffset).toBe(result.byteLength)
    expect(document.images).toHaveLength(1)
    expect(document.images[0]!.uri).toBeUndefined()
    expect(document.images[0]!.mimeType).toBe('image/png')
    const imageView = document.bufferViews[document.images[0]!.bufferView]!
    expect(new Uint8Array(result, binaryOffset + imageView.byteOffset, imageView.byteLength)).toEqual(sourceTexture.data)
    expect(document.samplers[0]).toMatchObject({ wrapS: 33071, wrapT: 33071 })

    const primitives = document.meshes[0]!.primitives
    expect(primitives).toHaveLength(2)
    const front = primitives.find((primitive) => document.materials[primitive.material]!.name === 'Rasterform_Source_Image')!
    const backing = primitives.find((primitive) => document.materials[primitive.material]!.name === 'Rasterform_Sides_Back')!
    const frontMaterial = document.materials[front.material]!.pbrMetallicRoughness
    expect(frontMaterial.baseColorTexture).toEqual({ index: 0, texCoord: 0 })
    expect(frontMaterial.baseColorFactor ?? [1, 1, 1, 1]).toEqual([1, 1, 1, 1])
    expect(document.materials[backing.material]!.pbrMetallicRoughness.baseColorTexture).toBeUndefined()
    for (const primitive of primitives) {
      expect(primitive.attributes.COLOR_0).toBeUndefined()
      const material = document.materials[primitive.material]!.pbrMetallicRoughness
      expect(material.metallicFactor).toBe(1)
      expect(material.roughnessFactor).toBe(0.26)
    }
    const gridVertices = (mesh.width + 1) * (mesh.height + 1)
    const frontIndices = values(front.indices, 1)
    const backingIndices = values(backing.indices, 1)
    expect(frontIndices).toHaveLength(mesh.width * mesh.height * 6)
    expect(frontIndices.every((index) => index < gridVertices)).toBe(true)
    for (let index = 0; index < backingIndices.length; index += 3) {
      expect(backingIndices.slice(index, index + 3).some((vertex) => vertex >= gridVertices)).toBe(true)
    }
    const triangles = (indices: number[]) => Array.from({ length: indices.length / 3 }, (_, index) => indices.slice(index * 3, index * 3 + 3).join(',')).sort()
    expect(triangles([...frontIndices, ...backingIndices])).toEqual(triangles(Array.from(mesh.indices)))
    expect(values(front.attributes.POSITION!, 3)).toEqual(Array.from(mesh.positions))
    const uv = values(front.attributes.TEXCOORD_0!, 2)
    expect(uv.slice(0, 2)).toEqual([0, 0])
    expect(uv.slice((gridVertices - 1) * 2, gridVertices * 2)).toEqual([1, 1])
    expect(mesh.uvs.slice(0, 2)).toEqual(new Float32Array([0, 1]))
  })

  it('keeps source mapping on animated positions and leaves untextured exports intact', async () => {
    const deformed = { ...mesh, positions: mesh.positions.map((value, index) => index % 3 === 2 ? -value : value) }
    const textured = readGlb(await encodeGlb(deformed, 'original', undefined, sourceTexture))
    expect(textured.document.meshes[0]!.primitives).toHaveLength(2)
    const plain = readGlb(await encodeGlb(mesh, 'original'))
    expect(plain.document.meshes[0]!.primitives).toHaveLength(1)
    expect(plain.document.meshes[0]!.primitives[0]!.attributes.COLOR_0).toBeTypeOf('number')
    expect(plain.document.images).toBeUndefined()
  })

  it('exports open image reliefs with a single textured surface', async () => {
    const plane = buildMesh(field, image, { mode: 'plane', resolution: 8, depth: .4, midpoint: .5, baseThickness: .4 })
    const { document } = readGlb(await encodeGlb(plane, 'original', undefined, sourceTexture))
    expect(document.meshes[0]!.primitives).toHaveLength(1)
    expect(document.materials).toHaveLength(1)
    expect(document.materials[0]!.pbrMetallicRoughness.baseColorTexture).toBeDefined()
    expect(document.materials[0]!.pbrMetallicRoughness.roughnessFactor).toBe(0.66)
  })

  it('releases owned geometry and both materials even when the exporter fails', async () => {
    const geometryDispose = vi.spyOn(BufferGeometry.prototype, 'dispose')
    const materialDispose = vi.spyOn(Material.prototype, 'dispose')
    const parse = vi.spyOn(GLTFExporter.prototype, 'parseAsync').mockRejectedValueOnce(new Error('test encoding failure'))
    try {
      await expect(encodeGlb(mesh, 'original', undefined, sourceTexture)).rejects.toThrow('test encoding failure')
      expect(geometryDispose).toHaveBeenCalledOnce()
      expect(materialDispose).toHaveBeenCalledTimes(2)
    } finally {
      geometryDispose.mockRestore()
      materialDispose.mockRestore()
      parse.mockRestore()
    }
  })
})
