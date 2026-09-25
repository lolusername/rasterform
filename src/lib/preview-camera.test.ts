import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import type { MeshData } from '../types'
import { createStillExportCamera } from './straight-on-camera'
import {
  capturePreviewCamera,
  createOutputPreviewCamera,
  isPreviewCameraSnapshot,
  restorePreviewCamera,
} from './preview-camera'

const mesh: MeshData = {
  positions: new Float32Array([-1, -2, 0, 1, -2, 0.2, 1, 2, 1.8, -1, 2, 0.7]),
  indices: new Uint32Array(),
  colors: new Float32Array(12),
  uvs: new Float32Array(8),
  heights: new Float32Array(4),
  width: 2,
  height: 4,
  mode: 'plane',
}

function editingCamera(): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(38, 1.7, 0.01, 100)
  camera.position.set(2.45, -2.2, 2.15)
  camera.lookAt(0, 0, 0.12)
  camera.updateMatrixWorld(true)
  return camera
}

describe('output composition preview camera', () => {
  it.each(['current', 'straight-on'] as const)('matches the %s capture camera without touching the edit view', (view) => {
    const camera = editingCamera()
    const target = new THREE.Vector3(0, 0, 0.12)
    const original = capturePreviewCamera(camera, target)
    const positions = mesh.positions.slice()
    const dimensions = { width: 3072, height: 4096 }
    const output = createOutputPreviewCamera(mesh, camera, { ...dimensions, view, background: 'transparent' })
    const capture = createStillExportCamera(mesh, dimensions, camera, view)
    capture.aspect = dimensions.width / dimensions.height
    capture.clearViewOffset()
    capture.updateProjectionMatrix()
    capture.updateMatrixWorld(true)

    expect(output).not.toBe(camera)
    expect(output.projectionMatrix.elements).toEqual(capture.projectionMatrix.elements)
    expect(output.matrixWorld.elements).toEqual(capture.matrixWorld.elements)
    expect(capturePreviewCamera(camera, target)).toEqual(original)
    expect(camera.aspect).toBe(1.7)
    expect(mesh.positions).toEqual(positions)
  })

  it('uses identical framing at 2K, 4K, and 8K for the same aspect ratio', () => {
    const camera = editingCamera()
    const frames = [2048, 4096, 8192].map((height) => createOutputPreviewCamera(mesh, camera, {
      width: height * 0.75, height, view: 'straight-on', background: 'studio',
    }))
    for (const frame of frames) {
      expect(frame.projectionMatrix.elements).toEqual(frames[0]!.projectionMatrix.elements)
      expect(frame.matrixWorld.elements).toEqual(frames[0]!.matrixWorld.elements)
    }
  })

  it('rejects invalid dimensions instead of generating a broken camera', () => {
    expect(() => createOutputPreviewCamera(mesh, editingCamera(), {
      width: 0, height: 2048, view: 'current', background: 'transparent',
    })).toThrow('dimensions must be positive')
  })
})

describe('authored view snapshots', () => {
  it('round-trips pose and lens while keeping the new display aspect', () => {
    const original = editingCamera()
    const target = new THREE.Vector3(0, 0, 0.12)
    const snapshot = capturePreviewCamera(original, target)
    const restored = new THREE.PerspectiveCamera(50, 0.75, 0.1, 500)
    const restoredTarget = new THREE.Vector3()
    expect(restorePreviewCamera(restored, restoredTarget, snapshot)).toBe(true)
    expect(capturePreviewCamera(restored, restoredTarget)).toEqual(snapshot)
    expect(restored.aspect).toBe(0.75)
    snapshot.position[0] = 900
    snapshot.target[0] = 900
    expect(restored.position.x).toBe(2.45)
    expect(restoredTarget.x).toBe(0)
  })

  it('rejects malformed project values without mutating the view', () => {
    const camera = editingCamera()
    const target = new THREE.Vector3(0, 0, 0.12)
    const snapshot = capturePreviewCamera(camera, target)
    for (const invalid of [
      null, {}, { ...snapshot, zoom: 0 }, { ...snapshot, fov: 180 },
      { ...snapshot, far: snapshot.near }, { ...snapshot, position: [NaN, 0, 1] },
      { ...snapshot, quaternion: [0, 0, 0, 0] }, { ...snapshot, up: [0, 0, 0] },
      { ...snapshot, position: snapshot.target },
    ]) {
      expect(isPreviewCameraSnapshot(invalid)).toBe(false)
      expect(restorePreviewCamera(camera, target, invalid as typeof snapshot)).toBe(false)
      expect(capturePreviewCamera(camera, target)).toEqual(snapshot)
    }
  })
})
