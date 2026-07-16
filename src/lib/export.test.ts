import { beforeAll, describe, expect, it } from 'vitest'
import { encodeGlb, encodeStl } from './export'
import { buildMesh } from './mesh'
import { createDefaultAppearanceSettings } from './three'
import type { PixelImage, ScalarField } from '../types'

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
const image: PixelImage = { width: 2, height: 2, name: 'test', data: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255]) }
const mesh = buildMesh(field, image, { mode: 'solid', resolution: 8, depth: .4, midpoint: .5, baseThickness: .4 })

describe('portable mesh exports', () => {
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
})
