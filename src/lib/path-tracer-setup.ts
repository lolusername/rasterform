import type { Camera, Scene } from 'three'
import type { BVHWorker, WebGLPathTracer } from 'three-gpu-pathtracer'

interface DisposableBVHWorker extends BVHWorker {
  dispose: () => void
}

export async function buildPathTracingScene(
  tracer: WebGLPathTracer,
  worker: DisposableBVHWorker,
  scene: Scene,
  camera: Camera,
  onProgress: (progress: number) => void,
): Promise<void> {
  tracer.setBVHWorker(worker)
  try {
    await tracer.setSceneAsync(scene, camera, { onProgress })
  } finally {
    worker.dispose()
  }
}
