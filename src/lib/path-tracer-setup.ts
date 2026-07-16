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
  try {
    tracer.setBVHWorker(worker)
    await tracer.setSceneAsync(scene, camera, { onProgress })
  } finally {
    worker.dispose()
  }
}
