import * as THREE from 'three'
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js'
import type {
  AppearanceSettings,
  ClayFinish,
  ColorMode,
  HeightGradientSettings,
  ImageExportBackground,
  MeshData,
  ViewportBackground,
} from '../types'
import { viewportBackgroundPreset } from './background'

export interface StudioLighting {
  hemisphere: THREE.HemisphereLight
  key: THREE.DirectionalLight
  fill: THREE.RectAreaLight
  rim: THREE.RectAreaLight
  keyTarget: THREE.Object3D
}

export interface FinalRenderScene {
  scene: THREE.Scene
  object: THREE.Mesh
  lights: StudioLighting
}

/** Apply the same color-management and shadow settings to live and export renderers. */
export function configureStudioRenderer(renderer: THREE.WebGLRenderer): void {
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.AgXToneMapping
  renderer.toneMappingExposure = 1.15
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
}

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
  object.castShadow = true
  object.receiveShadow = true
  return object
}

/** Add named, inspectable studio lights. The directional key provides soft shadows. */
export function addStudioLighting(scene: THREE.Scene): StudioLighting {
  RectAreaLightUniformsLib.init()

  const hemisphere = new THREE.HemisphereLight(0xfff3df, 0x172033, 0.65)
  hemisphere.name = 'Rasterform_Hemisphere'

  const key = new THREE.DirectionalLight(0xfff7ed, 3.4)
  key.name = 'Rasterform_Key'
  key.position.set(-3.2, 3.8, 5.8)
  key.castShadow = true
  key.shadow.mapSize.set(2048, 2048)
  key.shadow.bias = -0.0002
  key.shadow.normalBias = 0.025
  key.shadow.camera.near = 0.1
  key.shadow.camera.far = 20
  key.shadow.camera.left = -3.5
  key.shadow.camera.right = 3.5
  key.shadow.camera.top = 3.5
  key.shadow.camera.bottom = -3.5

  const keyTarget = new THREE.Object3D()
  keyTarget.name = 'Rasterform_KeyTarget'
  keyTarget.position.set(0, 0, 0.12)
  key.target = keyTarget

  const fill = new THREE.RectAreaLight(0xc9ddff, 7.5, 4.5, 4.5)
  fill.name = 'Rasterform_Fill'
  fill.position.set(3.6, 0.8, 3.8)
  fill.lookAt(0, 0, 0.1)

  const rim = new THREE.RectAreaLight(0xffc8a8, 9, 3, 4)
  rim.name = 'Rasterform_Rim'
  rim.position.set(-1.4, 2.6, -3.2)
  rim.lookAt(0, 0, 0.15)

  scene.add(hemisphere, key, keyTarget, fill, rim)
  return { hemisphere, key, fill, rim, keyTarget }
}

/** Build an isolated scene so final rendering never mutates the interactive viewport. */
export function createFinalRenderScene(
  mesh: MeshData,
  colorMode: ColorMode,
  appearance: AppearanceSettings = createDefaultAppearanceSettings(),
  environment: THREE.Texture | null = null,
  background: ImageExportBackground = 'studio',
  studioBackground: ViewportBackground = 'dark-gray',
): FinalRenderScene {
  const scene = new THREE.Scene()
  scene.name = 'Rasterform_FinalRender'
  scene.background = background === 'transparent'
    ? null
    : new THREE.Color(viewportBackgroundPreset(studioBackground).hex)
  scene.environment = environment
  scene.environmentIntensity = environment ? 0.85 : 1

  const object = createThreeMesh(mesh, colorMode, appearance)
  scene.add(object)
  const lights = addStudioLighting(scene)
  // HemisphereLight is not represented by the path tracer; the shared HDR environment
  // provides ambient fill so High and Final exports start from the same light rig.
  lights.hemisphere.intensity = 0
  return { scene, object, lights }
}

/** Dispose resources owned by an isolated image-render scene, never its shared HDR environment. */
export function disposeFinalRenderScene(renderScene: FinalRenderScene): void {
  renderScene.object.geometry.dispose()
  const objectMaterial = renderScene.object.material
  if (Array.isArray(objectMaterial)) objectMaterial.forEach((material) => material.dispose())
  else objectMaterial.dispose()
}
