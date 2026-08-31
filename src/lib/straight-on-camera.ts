import * as THREE from 'three'
import type { ImageExportView, MeshData } from '../types'
import type { ViewportDimensions } from './viewport-export'

export const STRAIGHT_ON_FRAME_FILL = 0.92

interface MeshBounds {
  minX: number
  minY: number
  minZ: number
  maxX: number
  maxY: number
  maxZ: number
}

function meshBounds(positions: Float32Array): MeshBounds {
  if (positions.length === 0 || positions.length % 3 !== 0) {
    throw new TypeError('Straight-on export requires a non-empty XYZ position buffer.')
  }
  const bounds: MeshBounds = {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    minZ: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
    maxZ: Number.NEGATIVE_INFINITY,
  }
  for (let offset = 0; offset < positions.length; offset += 3) {
    const x = positions[offset]!
    const y = positions[offset + 1]!
    const z = positions[offset + 2]!
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new TypeError('Straight-on export requires finite mesh positions.')
    }
    bounds.minX = Math.min(bounds.minX, x)
    bounds.minY = Math.min(bounds.minY, y)
    bounds.minZ = Math.min(bounds.minZ, z)
    bounds.maxX = Math.max(bounds.maxX, x)
    bounds.maxY = Math.max(bounds.maxY, y)
    bounds.maxZ = Math.max(bounds.maxZ, z)
  }
  return bounds
}

function outputAspect(dimensions: ViewportDimensions): number {
  if (!Number.isFinite(dimensions.width) || !Number.isFinite(dimensions.height)
    || dimensions.width <= 0 || dimensions.height <= 0) {
    throw new RangeError('Straight-on export dimensions must be positive.')
  }
  return dimensions.width / dimensions.height
}

/**
 * Build a separate front camera without touching the live OrbitControls camera.
 * Every visible-phase vertex participates in the fit, so tall relief peaks and
 * Living Form motion cannot be clipped by a flat XY-bounds calculation.
 */
export function createStraightOnCamera(
  mesh: MeshData,
  dimensions: ViewportDimensions,
  template: THREE.PerspectiveCamera,
): THREE.PerspectiveCamera {
  const bounds = meshBounds(mesh.positions)
  const aspect = outputAspect(dimensions)
  const camera = template.clone()
  camera.aspect = aspect
  camera.filmOffset = 0
  camera.zoom = Number.isFinite(template.zoom) && template.zoom > 0 ? template.zoom : 1
  camera.clearViewOffset()

  const centerX = (bounds.minX + bounds.maxX) / 2
  const centerY = (bounds.minY + bounds.maxY) / 2
  const span = Math.max(
    bounds.maxX - bounds.minX,
    bounds.maxY - bounds.minY,
    bounds.maxZ - bounds.minZ,
    1e-6,
  )
  const fov = Number.isFinite(camera.fov) && camera.fov > 0 && camera.fov < 180 ? camera.fov : 38
  camera.fov = fov
  const verticalTangent = Math.tan(THREE.MathUtils.degToRad(fov / 2)) / camera.zoom
  const usableVerticalTangent = verticalTangent * STRAIGHT_ON_FRAME_FILL
  const usableHorizontalTangent = usableVerticalTangent * aspect

  let cameraZ = Number.NEGATIVE_INFINITY
  for (let offset = 0; offset < mesh.positions.length; offset += 3) {
    const x = mesh.positions[offset]!
    const y = mesh.positions[offset + 1]!
    const z = mesh.positions[offset + 2]!
    cameraZ = Math.max(
      cameraZ,
      z + Math.abs(x - centerX) / usableHorizontalTangent,
      z + Math.abs(y - centerY) / usableVerticalTangent,
    )
  }

  // Degenerate geometry still needs a positive eye-to-surface distance. For a
  // normal relief this only adds sub-pixel breathing room beyond the 92% fit.
  cameraZ += Math.max(0.01, span * 0.002)
  const closestSurface = Math.max(1e-4, cameraZ - bounds.maxZ)
  const farthestSurface = Math.max(closestSurface, cameraZ - bounds.minZ)
  camera.near = Math.max(0.001, Math.min(1, closestSurface * 0.1))
  camera.far = Math.max(camera.near + 1, farthestSurface + Math.max(1, span))
  camera.position.set(centerX, centerY, cameraZ)
  camera.up.set(0, 1, 0)
  // Three.js cameras face local -Z. Identity is the exact world-space front
  // orientation here: no yaw, pitch, roll, mirroring, or source-axis flip.
  camera.quaternion.identity()
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld(true)
  return camera
}

/** One camera policy shared by High, Final, and Cycles Pro still captures. */
export function createStillExportCamera(
  mesh: MeshData,
  dimensions: ViewportDimensions,
  template: THREE.PerspectiveCamera,
  view: ImageExportView,
): THREE.PerspectiveCamera {
  return view === 'straight-on'
    ? createStraightOnCamera(mesh, dimensions, template)
    : template.clone()
}
