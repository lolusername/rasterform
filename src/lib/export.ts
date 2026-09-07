import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js'
import { BufferAttribute, Color, type Mesh, type MeshStandardMaterial } from 'three'
import { createThreeMesh } from './three'
import { scalarFieldPng } from './image'
import { assertSourceTexture } from './source-texture'
import type { AppearanceSettings, ColorMode, MeshData, Recipe, ScalarField, SourceTexture, TextRecipe } from '../types'

export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

export async function exportGlb(
  meshData: MeshData,
  colorMode: ColorMode,
  appearance?: AppearanceSettings,
  texture?: SourceTexture,
) {
  downloadBlob(
    'rasterform.glb',
    new Blob([await encodeGlb(meshData, colorMode, appearance, texture)], { type: 'model/gltf-binary' }),
  )
}

export async function encodeGlb(
  meshData: MeshData,
  colorMode: ColorMode,
  appearance?: AppearanceSettings,
  texture?: SourceTexture,
): Promise<ArrayBuffer> {
  const mesh = createThreeMesh(meshData, colorMode, appearance)
  try {
    if (texture) {
      assertSourceTexture(texture)
      prepareTexturedMesh(mesh, meshData)
    }
    const result = await new GLTFExporter().parseAsync(mesh, { binary: true, onlyVisible: true })
    if (!(result instanceof ArrayBuffer)) throw new Error('The GLB exporter returned an unexpected payload.')
    return texture ? embedSourceTexture(result, texture) : result
  } finally {
    mesh.geometry.dispose()
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    materials.forEach((material) => material.dispose())
  }
}

const SOURCE_MATERIAL_NAME = 'Rasterform_Source_Image'

/** Split surface groups by source grid identity, so animated/folded fronts stay textured. */
function prepareTexturedMesh(mesh: Mesh, meshData: MeshData): void {
  const gridVertices = (meshData.width + 1) * (meshData.height + 1)
  const vertexCount = meshData.positions.length / 3
  const layers = meshData.mode === 'solid' ? 2 : 1
  if (!Number.isInteger(meshData.width) || !Number.isInteger(meshData.height) ||
      meshData.width < 1 || meshData.height < 1 || gridVertices * layers !== vertexCount) {
    throw new Error('Source bitmap GLB export requires an image relief with its original image UVs.')
  }
  const front: number[] = []
  const sidesBack: number[] = []
  for (let offset = 0; offset < meshData.indices.length; offset += 3) {
    const a = meshData.indices[offset]!
    const b = meshData.indices[offset + 1]!
    const c = meshData.indices[offset + 2]!
    const target = a < gridVertices && b < gridVertices && c < gridVertices ? front : sidesBack
    target.push(a, b, c)
  }
  if (front.length !== meshData.width * meshData.height * 6) {
    throw new Error('The mesh no longer has its original source-image topology. Export Current appearance instead.')
  }
  const geometry = mesh.geometry
  // glTF multiplies COLOR_0 and baseColorTexture; remove coarse vertex colors entirely.
  geometry.deleteAttribute('color')
  const uv = geometry.getAttribute('uv')
  // Mesh UVs use bottom-left V. glTF addresses a PNG from its top-left corner.
  // Flip only the exported UVs so the embedded PNG remains byte-for-byte unchanged.
  for (let index = 0; index < uv.count; index += 1) uv.setY(index, 1 - uv.getY(index))
  geometry.setIndex(new BufferAttribute(new Uint32Array([...front, ...sidesBack]), 1))
  geometry.clearGroups()
  geometry.addGroup(0, front.length, 0)

  const material = mesh.material as MeshStandardMaterial
  material.name = SOURCE_MATERIAL_NAME
  material.vertexColors = false
  material.wireframe = false
  material.color.set(0xffffff)
  if (sidesBack.length) {
    const backing = material.clone()
    backing.name = 'Rasterform_Sides_Back'
    // A neutral backing with the same roughness/metalness as the chosen surface.
    backing.color = new Color('#b8b8b8')
    mesh.material = [material, backing]
    geometry.addGroup(front.length, sidesBack.length, 1)
  }
}

interface TexturedGlb {
  buffers: Array<{ byteLength: number }>
  bufferViews: Array<{ buffer: number; byteOffset?: number; byteLength: number }>
  materials: Array<{ name?: string; pbrMetallicRoughness: { baseColorTexture?: { index: number; texCoord: number } } }>
  images?: Array<{ name: string; mimeType: string; bufferView: number }>
  textures?: Array<{ name: string; source: number; sampler: number }>
  samplers?: Array<{ magFilter: number; minFilter: number; wrapS: number; wrapT: number }>
}

/** Embed the already normalized PNG without an additional canvas allocation or re-encoding. */
function embedSourceTexture(glb: ArrayBuffer, texture: SourceTexture): ArrayBuffer {
  const header = new DataView(glb)
  const jsonLength = header.getUint32(12, true)
  const binaryHeader = 20 + jsonLength
  if (header.getUint32(16, true) !== 0x4e4f534a || header.getUint32(binaryHeader + 4, true) !== 0x004e4942) {
    throw new Error('The GLB exporter did not provide the required JSON and geometry buffers.')
  }
  const document = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, jsonLength))) as TexturedGlb
  const front = document.materials.find((material) => material.name === SOURCE_MATERIAL_NAME)
  if (!front) throw new Error('The source-image material is missing from the exported GLB.')
  const binaryLength = header.getUint32(binaryHeader, true)
  const textureOffset = Math.ceil(binaryLength / 4) * 4
  const nextBinaryLength = Math.ceil((textureOffset + texture.data.byteLength) / 4) * 4
  const bufferView = document.bufferViews.push({
    buffer: 0,
    byteOffset: textureOffset,
    byteLength: texture.data.byteLength,
  }) - 1
  const source = (document.images ??= []).push({ name: texture.name, mimeType: texture.mimeType, bufferView }) - 1
  const sampler = (document.samplers ??= []).push({ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }) - 1
  const index = (document.textures ??= []).push({ name: texture.name, source, sampler }) - 1
  // glTF baseColorTexture is sRGB by specification; metallic/roughness stay unchanged.
  front.pbrMetallicRoughness.baseColorTexture = { index, texCoord: 0 }
  document.buffers[0]!.byteLength = nextBinaryLength
  const json = new TextEncoder().encode(JSON.stringify(document))
  const nextJsonLength = Math.ceil(json.byteLength / 4) * 4
  const output = new ArrayBuffer(12 + 8 + nextJsonLength + 8 + nextBinaryLength)
  const bytes = new Uint8Array(output)
  const view = new DataView(output)
  view.setUint32(0, 0x46546c67, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, output.byteLength, true)
  view.setUint32(12, nextJsonLength, true)
  view.setUint32(16, 0x4e4f534a, true)
  bytes.fill(0x20, 20, 20 + nextJsonLength)
  bytes.set(json, 20)
  const nextBinaryHeader = 20 + nextJsonLength
  view.setUint32(nextBinaryHeader, nextBinaryLength, true)
  view.setUint32(nextBinaryHeader + 4, 0x004e4942, true)
  bytes.set(new Uint8Array(glb, binaryHeader + 8, binaryLength), nextBinaryHeader + 8)
  bytes.set(texture.data, nextBinaryHeader + 8 + textureOffset)
  return output
}

export function exportStl(meshData: MeshData) {
  downloadBlob('rasterform.stl', new Blob([encodeStl(meshData)], { type: 'model/stl' }))
}

export function encodeStl(meshData: MeshData): string | ArrayBuffer {
  const mesh = createThreeMesh(meshData, 'clay')
  const result = new STLExporter().parse(mesh, { binary: true })
  const payload = typeof result === 'string'
    ? result
    : (() => {
        const bytes = new Uint8Array(result.byteLength)
        bytes.set(new Uint8Array(result.buffer, result.byteOffset, result.byteLength))
        return bytes.buffer
      })()
  mesh.geometry.dispose()
  const material = mesh.material
  if (!Array.isArray(material)) material.dispose()
  return payload
}

export async function exportHeightPng(field: ScalarField) {
  downloadBlob('rasterform-height.png', await scalarFieldPng(field))
}

export function exportRecipe(recipe: Recipe | TextRecipe) {
  downloadBlob(
    'rasterform-recipe.json',
    new Blob([JSON.stringify(recipe, null, 2)], { type: 'application/json' }),
  )
}
