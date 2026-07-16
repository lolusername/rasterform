import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js'
import { createThreeMesh } from './three'
import { scalarFieldPng } from './image'
import type { AppearanceSettings, ColorMode, MeshData, Recipe, ScalarField } from '../types'

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
) {
  downloadBlob(
    'rasterform.glb',
    new Blob([await encodeGlb(meshData, colorMode, appearance)], { type: 'model/gltf-binary' }),
  )
}

export async function encodeGlb(
  meshData: MeshData,
  colorMode: ColorMode,
  appearance?: AppearanceSettings,
): Promise<ArrayBuffer> {
  const mesh = createThreeMesh(meshData, colorMode, appearance)
  const result = await new GLTFExporter().parseAsync(mesh, { binary: true, onlyVisible: true })
  if (!(result instanceof ArrayBuffer)) throw new Error('The GLB exporter returned an unexpected payload.')
  mesh.geometry.dispose()
  const material = mesh.material
  if (!Array.isArray(material)) material.dispose()
  return result
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

export function exportRecipe(recipe: Recipe) {
  downloadBlob(
    'rasterform-recipe.json',
    new Blob([JSON.stringify(recipe, null, 2)], { type: 'application/json' }),
  )
}
