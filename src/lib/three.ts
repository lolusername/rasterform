import * as THREE from 'three'
import type { AppearanceSettings, ClayFinish, ColorMode, HeightGradientSettings, MeshData } from '../types'

export function createDefaultAppearanceSettings(): AppearanceSettings {
  return {
    heightGradient: {
      low: '#21194f',
      mid: '#32bf8a',
      high: '#f2c66d',
      midpoint: 0.5,
    },
    clay: {
      color: '#d7d0bf',
      finish: 'matte',
    },
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

export function heightGradientColors(
  heights: Float32Array,
  gradient: HeightGradientSettings,
): Float32Array {
  const colors = new Float32Array(heights.length * 3)
  const low = new THREE.Color(gradient.low)
  const mid = new THREE.Color(gradient.mid)
  const high = new THREE.Color(gradient.high)
  const midpoint = Math.min(0.95, Math.max(0.05, gradient.midpoint))
  const color = new THREE.Color()

  for (let index = 0; index < heights.length; index += 1) {
    const value = clamp01(heights[index] ?? 0)
    if (value <= midpoint) color.copy(low).lerp(mid, value / midpoint)
    else color.copy(mid).lerp(high, (value - midpoint) / (1 - midpoint))
    colors[index * 3] = color.r
    colors[index * 3 + 1] = color.g
    colors[index * 3 + 2] = color.b
  }
  return colors
}

export function createGeometry(
  mesh: MeshData,
  colorMode: ColorMode = 'original',
  appearance: AppearanceSettings = createDefaultAppearanceSettings(),
): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions.slice(), 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(mesh.uvs.slice(), 2))
  const colors = colorMode === 'height'
    ? heightGradientColors(mesh.heights, appearance.heightGradient)
    : mesh.colors.slice()
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices.slice(), 1))
  geometry.computeVertexNormals()
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

export function claySurface(finish: ClayFinish): { roughness: number; metalness: number } {
  switch (finish) {
    case 'matte':
      return { roughness: 0.88, metalness: 0 }
    case 'glossy':
      return { roughness: 0.16, metalness: 0.02 }
    case 'metallic':
      return { roughness: 0.26, metalness: 1 }
  }
}

export function createMaterial(
  mode: ColorMode,
  appearance: AppearanceSettings = createDefaultAppearanceSettings(),
): THREE.MeshStandardMaterial {
  const clay = claySurface(appearance.clay.finish)
  const isClay = mode === 'clay'
  return new THREE.MeshStandardMaterial({
    color: isClay ? appearance.clay.color : mode === 'wireframe' ? 0xd7d0bf : 0xffffff,
    vertexColors: mode === 'original' || mode === 'height',
    roughness: isClay ? clay.roughness : mode === 'wireframe' ? 0.72 : 0.66,
    metalness: isClay ? clay.metalness : mode === 'wireframe' ? 0 : 0.04,
    side: THREE.DoubleSide,
    wireframe: mode === 'wireframe',
  })
}

export function createThreeMesh(
  mesh: MeshData,
  colorMode: ColorMode,
  appearance: AppearanceSettings = createDefaultAppearanceSettings(),
): THREE.Mesh {
  const object = new THREE.Mesh(
    createGeometry(mesh, colorMode, appearance),
    createMaterial(colorMode, appearance),
  )
  object.name = `Rasterform_${mesh.mode}`
  return object
}

export function addStudioLighting(scene: THREE.Scene): void {
  scene.add(new THREE.HemisphereLight(0xfff4df, 0x283141, 2.2))
  const key = new THREE.DirectionalLight(0xffffff, 3.1)
  key.position.set(-2.4, -1.4, 4)
  scene.add(key)
  const rim = new THREE.DirectionalLight(0xb9d7ff, 1.8)
  rim.position.set(3, 2, 1.5)
  scene.add(rim)
}
