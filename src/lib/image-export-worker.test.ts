import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import type { MeshData } from '../types'
import {
  snapshotCamera,
  snapshotEnvironment,
  snapshotMesh,
} from './image-export-worker'

function meshFixture(): MeshData {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 1]),
    indices: new Uint32Array([0, 1, 2]),
    colors: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
    uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
    heights: new Float32Array([0, 0.5, 1]),
    width: 1,
    height: 1,
    mode: 'plane',
  }
}

describe('dedicated image export snapshots', () => {
  it('copies every mesh buffer before transferring it away from the live preview', () => {
    const source = meshFixture()
    const snapshot = snapshotMesh(source)

    expect(snapshot).not.toBe(source)
    expect(snapshot.positions).not.toBe(source.positions)
    expect(snapshot.indices).not.toBe(source.indices)
    expect(snapshot.colors).not.toBe(source.colors)
    expect(snapshot.uvs).not.toBe(source.uvs)
    expect(snapshot.heights).not.toBe(source.heights)
    expect([...snapshot.positions]).toEqual([...source.positions])

    snapshot.positions[0] = 99
    expect(source.positions[0]).toBe(0)
  })

  it('captures the complete perspective-camera framing state', () => {
    const camera = new THREE.PerspectiveCamera(42, 1.5, 0.1, 250)
    camera.position.set(2, -3, 4)
    camera.up.set(0, 0, 1)
    camera.zoom = 1.25
    camera.filmGauge = 32
    camera.filmOffset = 1.5
    camera.lookAt(0.2, 0.3, 0.4)
    camera.updateMatrixWorld(true)

    const snapshot = snapshotCamera(camera)

    expect(snapshot).toMatchObject({
      fov: 42,
      near: 0.1,
      far: 250,
      zoom: 1.25,
      filmGauge: 32,
      filmOffset: 1.5,
      position: [2, -3, 4],
      up: [0, 0, 1],
    })
    expect(snapshot.quaternion).toHaveLength(4)
  })

  it('copies HDR texture pixels without detaching the live environment', () => {
    const pixels = new Uint16Array([1, 2, 3, 4, 5, 6, 7, 8])
    const texture = new THREE.DataTexture(pixels, 2, 1, THREE.RGBAFormat, THREE.HalfFloatType)
    texture.mapping = THREE.EquirectangularReflectionMapping
    texture.colorSpace = THREE.LinearSRGBColorSpace
    texture.flipY = true
    texture.minFilter = THREE.LinearMipmapLinearFilter
    texture.magFilter = THREE.LinearFilter
    texture.wrapS = THREE.RepeatWrapping
    texture.wrapT = THREE.MirroredRepeatWrapping
    texture.anisotropy = 4
    texture.generateMipmaps = true
    texture.premultiplyAlpha = true
    texture.unpackAlignment = 8

    const snapshot = snapshotEnvironment(texture)

    expect(snapshot).not.toBeNull()
    expect(snapshot).toMatchObject({
      width: 2,
      height: 1,
      flipY: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.MirroredRepeatWrapping,
      anisotropy: 4,
      generateMipmaps: true,
      premultiplyAlpha: true,
      unpackAlignment: 8,
    })
    expect(snapshot?.data).toBeInstanceOf(Uint16Array)
    expect(snapshot?.data).not.toBe(pixels)
    expect([...(snapshot?.data ?? [])]).toEqual([...pixels])

    if (snapshot) snapshot.data[0] = 99
    expect(pixels[0]).toBe(1)
  })
})
