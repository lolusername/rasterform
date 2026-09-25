import * as THREE from 'three'
import type { ImageExportCameraSnapshot } from './image-export-worker'
import { snapshotCamera } from './image-export-worker'
import { createStillExportCamera } from './straight-on-camera'
import type { ImageExportBackground, ImageExportView, MeshData } from '../types'

/** Serializable authored view. Aspect belongs to the display, not the project. */
export interface PreviewCameraSnapshot extends ImageExportCameraSnapshot {
  target: [number, number, number]
}

/** Composition only: output pixels never become CSS or live-renderer dimensions. */
export interface OutputCompositionPreview {
  width: number
  height: number
  view: ImageExportView
  background: ImageExportBackground
  checkerboard?: boolean
}

function finiteTuple(value: unknown, length: number): value is number[] {
  return Array.isArray(value) && value.length === length
    && value.every((item) => typeof item === 'number' && Number.isFinite(item))
}

export function isPreviewCameraSnapshot(value: unknown): value is PreviewCameraSnapshot {
  if (!value || typeof value !== 'object') return false
  const camera = value as Record<string, unknown>
  if (!finiteTuple(camera.position, 3) || !finiteTuple(camera.quaternion, 4)
    || !finiteTuple(camera.up, 3) || !finiteTuple(camera.target, 3)) return false
  if (!['fov', 'near', 'far', 'zoom', 'filmGauge', 'filmOffset']
    .every((key) => typeof camera[key] === 'number' && Number.isFinite(camera[key]))) return false
  return (camera.fov as number) > 0 && (camera.fov as number) < 180
    && (camera.near as number) > 0 && (camera.far as number) > (camera.near as number)
    && (camera.zoom as number) > 0 && (camera.filmGauge as number) > 0
    && camera.quaternion.some((value) => value !== 0)
    && camera.up.some((value) => value !== 0)
    && camera.position.some((value, axis) => value !== (camera.target as number[])[axis])
}

export function capturePreviewCamera(
  camera: THREE.PerspectiveCamera,
  target: THREE.Vector3,
): PreviewCameraSnapshot {
  return { ...snapshotCamera(camera), target: target.toArray() as [number, number, number] }
}

/** Restore without changing the current display aspect or retaining references. */
export function restorePreviewCamera(
  camera: THREE.PerspectiveCamera,
  target: THREE.Vector3,
  snapshot: PreviewCameraSnapshot,
): boolean {
  if (!isPreviewCameraSnapshot(snapshot)) return false
  camera.position.fromArray(snapshot.position)
  camera.quaternion.fromArray(snapshot.quaternion).normalize()
  camera.up.fromArray(snapshot.up)
  target.fromArray(snapshot.target)
  camera.fov = snapshot.fov
  camera.near = snapshot.near
  camera.far = snapshot.far
  camera.zoom = snapshot.zoom
  camera.filmGauge = snapshot.filmGauge
  camera.filmOffset = snapshot.filmOffset
  camera.clearViewOffset()
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld(true)
  return true
}

/** Use exactly the still-capture camera policy, including the output aspect. */
export function createOutputPreviewCamera(
  mesh: MeshData,
  editingCamera: THREE.PerspectiveCamera,
  preview: OutputCompositionPreview,
): THREE.PerspectiveCamera {
  if (!Number.isFinite(preview.width) || !Number.isFinite(preview.height)
    || preview.width <= 0 || preview.height <= 0) {
    throw new RangeError('Output preview dimensions must be positive.')
  }
  const result = createStillExportCamera(mesh, preview, editingCamera, preview.view)
  // The capture renderers apply output aspect and clear tile offsets in both
  // views. Mirror that here rather than deriving it from rounded screen pixels.
  result.aspect = preview.width / preview.height
  result.clearViewOffset()
  result.updateProjectionMatrix()
  result.updateMatrixWorld(true)
  return result
}
