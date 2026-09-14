import * as THREE from 'three'

/** Fit a tall contour stack in the existing canvas, preserving the orbit direction. */
export function fitStrataCamera(camera: THREE.PerspectiveCamera, target: THREE.Vector3, bounds: THREE.Box3): number {
  const sphere = bounds.getBoundingSphere(new THREE.Sphere())
  const direction = camera.position.clone().sub(target).normalize()
  if (direction.lengthSq() === 0) direction.set(1, -1, 1).normalize()
  const vertical = THREE.MathUtils.degToRad(camera.getEffectiveFOV() / 2)
  const horizontal = Math.atan(Math.tan(vertical) * Math.max(0.01, camera.aspect))
  const distance = Math.max(1.3, sphere.radius * 1.08 / Math.sin(Math.min(vertical, horizontal)))
  target.copy(sphere.center)
  camera.position.copy(target).addScaledVector(direction, distance)
  camera.near = Math.max(0.001, Math.min(0.01, distance - sphere.radius))
  camera.far = Math.max(100, distance + sphere.radius * 3)
  camera.lookAt(target)
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld(true)
  return distance
}
