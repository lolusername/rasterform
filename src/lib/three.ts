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

interface StrataRim {
  /** Each appended wall vertex follows an original cap vertex during motion. */
  sources: Uint32Array
  wallCorners: Uint32Array
}

const strataRims = new WeakMap<THREE.BufferGeometry, StrataRim>()

function splitStrataRims(mesh: MeshData, indices: Uint32Array): StrataRim {
  const first = mesh.positions.length / 3
  const mapped = new Map<number, number>()
  const sources: number[] = []
  const wallCorners: number[] = []
  for (const part of mesh.strata!.parts) {
    const start = part.indexStart + 2 * part.surfaceIndexCount
    for (let corner = start; corner < part.indexStart + part.indexCount; corner++) {
      const source = indices[corner]!
      let index = mapped.get(source)
      if (index === undefined) {
        index = first + sources.length
        mapped.set(source, index)
        sources.push(source)
      }
      indices[corner] = index
      wallCorners.push(index)
    }
  }
  return { sources: Uint32Array.from(sources), wallCorners: Uint32Array.from(wallCorners) }
}

function withRimVertices(values: Float32Array, size: number, rim: StrataRim | undefined): Float32Array {
  if (!rim) return values.slice()
  const result = new Float32Array(values.length + size * rim.sources.length)
  result.set(values)
  for (let i = 0; i < rim.sources.length; i++) {
    const from = rim.sources[i]! * size
    for (let j = 0; j < size; j++) result[values.length + i * size + j] = values[from + j]!
  }
  return result
}

export function createGeometry(
  mesh: MeshData,
  colorMode: ColorMode = 'original',
  appearance: AppearanceSettings = createDefaultAppearanceSettings(),
): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry()
  const indices = mesh.indices.slice()
  // Independent wall normals keep the horizontal sheets crisp all the way to
  // their edges. Source indices also distinguish coincident, disconnected shells.
  const rim = mesh.strata ? splitStrataRims(mesh, indices) : undefined
  if (rim) strataRims.set(geometry, rim)
  geometry.setAttribute('position', new THREE.BufferAttribute(withRimVertices(mesh.positions, 3, rim), 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(withRimVertices(mesh.uvs, 2, rim), 2))
  const colors = colorMode === 'height'
    ? heightGradientColors(mesh.heights, appearance.heightGradient)
    : mesh.colors
  geometry.setAttribute('color', new THREE.BufferAttribute(withRimVertices(colors, 3, rim), 3))
  geometry.setIndex(new THREE.BufferAttribute(indices, 1))
  updateSurfaceNormals(geometry, mesh.alphaCutout === true)
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

/** The motion engine writes the original indexed geometry in place. Refresh
 * the additional wall copies before computing shading for this frame. */
export function refreshGeometryFrame(geometry: THREE.BufferGeometry, cutout: boolean): void {
  const position = geometry.getAttribute('position')
  const rim = strataRims.get(geometry)
  if (rim) {
    const first = position.count - rim.sources.length
    for (let i = 0; i < rim.sources.length; i++) {
      const source = rim.sources[i]!
      position.setXYZ(first + i, position.getX(source), position.getY(source), position.getZ(source))
    }
  }
  position.needsUpdate = true
  updateSurfaceNormals(geometry, cutout)
}

/** Corner-angle weights make rim shading independent of a side quad’s diagonal. */
export function updateSurfaceNormals(geometry: THREE.BufferGeometry, cutout: boolean): void {
  geometry.computeVertexNormals()
  const strata = strataRims.get(geometry)
  if ((!strata && !cutout) || !geometry.index) return
  const position = geometry.getAttribute('position')
  const normal = geometry.getAttribute('normal')
  const indices = strata?.wallCorners ?? geometry.index.array
  const firstWallVertex = position.count - (strata?.sources.length ?? 0)
  const cutoutRim = new Set<number>()
  if (strata) {
    for (let i = firstWallVertex; i < position.count; i++) normal.setXYZ(i, 0, 0, 0)
  } else {
    const capCount = position.count / 2
    for (let i = indices.length - 3; i >= 0; i -= 3) {
      const a = indices[i]!, b = indices[i + 1]!, c = indices[i + 2]!
      if ((a < capCount) === (b < capCount) && (b < capCount) === (c < capCount)) break
      cutoutRim.add(a)
      cutoutRim.add(b)
      cutoutRim.add(c)
    }
    for (const index of cutoutRim) normal.setXYZ(index, 0, 0, 0)
  }
  const p = new THREE.Vector3(), u = new THREE.Vector3(), v = new THREE.Vector3(), face = new THREE.Vector3()
  for (let i = 0; i < indices.length; i += 3) {
    for (let j = 0; j < 3; j++) {
      const index = indices[i + j]!
      if (!strata && !cutoutRim.has(index)) continue
      p.fromBufferAttribute(position, index)
      u.fromBufferAttribute(position, indices[i + (j + 1) % 3]!).sub(p)
      v.fromBufferAttribute(position, indices[i + (j + 2) % 3]!).sub(p)
      face.crossVectors(u, v)
      const length = face.length()
      if (length === 0) continue
      face.multiplyScalar(Math.atan2(length, u.dot(v)) / length)
      normal.setXYZ(index, normal.getX(index) + face.x, normal.getY(index) + face.y, normal.getZ(index) + face.z)
    }
  }
  const normalize = (index: number) => {
    p.fromBufferAttribute(normal, index).normalize()
    normal.setXYZ(index, p.x, p.y, p.z)
  }
  if (strata) {
    for (let i = firstWallVertex; i < position.count; i++) normalize(i)
  } else {
    for (const index of cutoutRim) normalize(index)
  }
  normal.needsUpdate = true
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
  const material = createMaterial(colorMode, appearance)
  const object = new THREE.Mesh(
    createGeometry(mesh, colorMode, appearance),
    material,
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
