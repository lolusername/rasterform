import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { fitStrataCamera } from './strata-frame'

describe('Strata screen-sized framing', () => {
  it.each([0.4, 1, 2.5])('keeps every corner inside a fixed canvas at aspect %s', (aspect) => {
    const camera = new THREE.PerspectiveCamera(38, aspect, 0.01, 100)
    camera.position.set(2.45, -2.2, 2.15)
    const target = new THREE.Vector3(0, 0, 0.12)
    const originalDirection = camera.position.clone().sub(target).normalize()
    const bounds = new THREE.Box3(new THREE.Vector3(-1, -1, 0), new THREE.Vector3(1, 1, 7.02))
    fitStrataCamera(camera, target, bounds)
    expect(camera.position.clone().sub(target).normalize().distanceTo(originalDirection)).toBeLessThan(1e-8)
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [0, 7.02]) {
      const projected = new THREE.Vector3(x, y, z).project(camera)
      expect(Math.abs(projected.x)).toBeLessThan(1)
      expect(Math.abs(projected.y)).toBeLessThan(1)
      expect(Math.abs(projected.z)).toBeLessThan(1)
    }
    expect(camera.aspect).toBe(aspect)
  })
})
