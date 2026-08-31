import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import type { MeshData } from '../types'
import {
  createStillExportCamera,
  createStraightOnCamera,
  STRAIGHT_ON_FRAME_FILL,
} from './straight-on-camera'

function meshFromPositions(values: number[]): MeshData {
  const vertexCount = values.length / 3
  return {
    positions: new Float32Array(values),
    indices: new Uint32Array(),
    colors: new Float32Array(vertexCount * 3),
    uvs: new Float32Array(vertexCount * 2),
    heights: new Float32Array(vertexCount),
    width: 1,
    height: 1,
    mode: 'plane',
  }
}

function expectMeshInsideFrame(mesh: MeshData, camera: THREE.PerspectiveCamera): void {
  for (let offset = 0; offset < mesh.positions.length; offset += 3) {
    const projected = new THREE.Vector3(
      mesh.positions[offset],
      mesh.positions[offset + 1],
      mesh.positions[offset + 2],
    ).project(camera)
    expect(Math.abs(projected.x)).toBeLessThanOrEqual(STRAIGHT_ON_FRAME_FILL + 1e-6)
    expect(Math.abs(projected.y)).toBeLessThanOrEqual(STRAIGHT_ON_FRAME_FILL + 1e-6)
    expect(projected.z).toBeGreaterThan(-1)
    expect(projected.z).toBeLessThan(1)
  }
}

describe('straight-on export camera', () => {
  it.each([
    [{ width: 6000, height: 4000 }, [-1.5, -1, -0.2, 1.5, -1, 0.9, 1.5, 1, 0.1, -1.5, 1, 1.4]],
    [{ width: 2400, height: 5000 }, [-0.7, -1.8, 0.1, 0.7, -1.8, 1.5, 0.7, 1.8, -0.4, -0.7, 1.8, 0.8]],
  ])('fits every depth-varying vertex at the requested aspect', (dimensions, values) => {
    const mesh = meshFromPositions(values as number[])
    const template = new THREE.PerspectiveCamera(38, 1, 0.01, 100)
    template.position.set(2.5, -2.2, 2.1)
    template.lookAt(0, 0, 0)

    const camera = createStraightOnCamera(mesh, dimensions, template)

    expect(camera.aspect).toBe(dimensions.width / dimensions.height)
    expect(camera.position.x).toBeCloseTo(0)
    expect(camera.position.y).toBeCloseTo(0)
    const direction = camera.getWorldDirection(new THREE.Vector3())
    expect(direction.x).toBeCloseTo(0)
    expect(direction.y).toBeCloseTo(0)
    expect(direction.z).toBeCloseTo(-1)
    expect(camera.up.toArray()).toEqual([0, 1, 0])
    expectMeshInsideFrame(mesh, camera)
  })

  it('centers asymmetric geometry while leaving the live camera and mesh untouched', () => {
    const mesh = meshFromPositions([
      -2, -1, 0,
      4, -1, 0.4,
      4, 3, 1.2,
      -2, 3, -0.5,
    ])
    const originalPositions = mesh.positions.slice()
    const template = new THREE.PerspectiveCamera(42, 2, 0.05, 80)
    template.position.set(3, -4, 2)
    template.zoom = 1.25
    template.filmOffset = 0.4
    template.lookAt(0.5, 0.25, 0)
    const position = template.position.clone()
    const quaternion = template.quaternion.clone()

    const camera = createStraightOnCamera(mesh, { width: 3200, height: 1800 }, template)

    expect(camera.position.x).toBe(1)
    expect(camera.position.y).toBe(1)
    expect(camera.filmOffset).toBe(0)
    expect(template.position.equals(position)).toBe(true)
    expect(template.quaternion.equals(quaternion)).toBe(true)
    expect(template.filmOffset).toBe(0.4)
    expect(mesh.positions).toEqual(originalPositions)
    expectMeshInsideFrame(mesh, camera)
  })

  it('produces finite clipping planes for a single flat point', () => {
    const mesh = meshFromPositions([0.25, -0.5, 0.75])
    const camera = createStraightOnCamera(
      mesh,
      { width: 1, height: 1 },
      new THREE.PerspectiveCamera(38, 1, 0.01, 100),
    )

    expect(Number.isFinite(camera.position.z)).toBe(true)
    expect(camera.near).toBeGreaterThan(0)
    expect(camera.far).toBeGreaterThan(camera.near)
    expectMeshInsideFrame(mesh, camera)
  })

  it('preserves the established current-view camera policy as a non-mutating clone', () => {
    const mesh = meshFromPositions([-1, -1, 0, 1, 1, 1])
    const template = new THREE.PerspectiveCamera(38, 1.75, 0.01, 100)
    template.position.set(2.45, -2.2, 2.15)
    template.lookAt(0, 0, 0)

    const camera = createStillExportCamera(mesh, { width: 4096, height: 2730 }, template, 'current')

    expect(camera).not.toBe(template)
    expect(camera.position.equals(template.position)).toBe(true)
    expect(camera.quaternion.equals(template.quaternion)).toBe(true)
    expect(camera.aspect).toBe(template.aspect)
  })

  it('rejects empty, non-finite, or invalid export inputs', () => {
    const template = new THREE.PerspectiveCamera(38, 1, 0.01, 100)
    expect(() => createStraightOnCamera(meshFromPositions([]), { width: 10, height: 10 }, template))
      .toThrow('non-empty')
    expect(() => createStraightOnCamera(meshFromPositions([0, Number.NaN, 0]), { width: 10, height: 10 }, template))
      .toThrow('finite')
    expect(() => createStraightOnCamera(meshFromPositions([0, 0, 0]), { width: 0, height: 10 }, template))
      .toThrow('positive')
  })
})
