import * as THREE from 'three'
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js'
import {
  assertDesktopFinalRenderSnapshot,
  type DesktopFinalRenderSnapshot,
} from '../../src/desktop/contracts'
import {
  finalSampleTarget,
  renderFinalImagePng,
  type FinalExportProgress,
} from '../../src/lib/final-image-export'
import type { ImageExportCameraSnapshot } from '../../src/lib/image-export-worker'

interface RenderStartMessage {
  jobId: string
  snapshot: DesktopFinalRenderSnapshot
}

interface RasterformRenderHost {
  onStart(listener: (message: RenderStartMessage) => void): () => void
  onCancel(listener: (jobId: string) => void): () => void
  progress(jobId: string, progress: FinalExportProgress): void
  complete(
    jobId: string,
    result: { width: number; height: number; dpi: number; samples: number; tiles: number },
    png: Uint8Array,
  ): void
  cancelled(jobId: string): void
  failed(jobId: string, message: string): void
}

declare global {
  interface Window {
    rasterformRenderHost: RasterformRenderHost
  }
}

let active: { jobId: string; controller: AbortController } | null = null

function restoreCamera(snapshot: ImageExportCameraSnapshot, width: number, height: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(snapshot.fov, width / height, snapshot.near, snapshot.far)
  camera.zoom = snapshot.zoom
  camera.filmGauge = snapshot.filmGauge
  camera.filmOffset = snapshot.filmOffset
  camera.position.fromArray(snapshot.position)
  camera.quaternion.fromArray(snapshot.quaternion)
  camera.up.fromArray(snapshot.up)
  camera.clearViewOffset()
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld(true)
  return camera
}

async function loadEnvironment(): Promise<THREE.DataTexture | null> {
  try {
    const texture = await new HDRLoader().loadAsync('/hdri/studio_small_08_1k.hdr')
    texture.mapping = THREE.EquirectangularReflectionMapping
    return texture
  } catch {
    // This is the same deliberate direct-studio-light fallback as the web app.
    return null
  }
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof DOMException && error.name === 'AbortError')
}

async function runFinal(message: RenderStartMessage): Promise<void> {
  if (active) {
    window.rasterformRenderHost.failed(message.jobId, 'The Final renderer is already in use.')
    return
  }

  const controller = new AbortController()
  active = { jobId: message.jobId, controller }
  let environment: THREE.DataTexture | null = null
  try {
    assertDesktopFinalRenderSnapshot(message.snapshot)
    const targetSamples = finalSampleTarget(message.snapshot.colorMode, message.snapshot.appearance)
    window.rasterformRenderHost.progress(message.jobId, {
      phase: 'preparing',
      progress: 0,
      tile: 0,
      tiles: 0,
      samples: 0,
      targetSamples,
    })
    environment = await loadEnvironment()
    if (controller.signal.aborted) throw new DOMException('Final image export cancelled.', 'AbortError')
    const snapshot = message.snapshot
    const result = await renderFinalImagePng({
      mesh: snapshot.mesh,
      colorMode: snapshot.colorMode,
      appearance: snapshot.appearance,
      environment,
      camera: restoreCamera(snapshot.camera, snapshot.width, snapshot.height),
      width: snapshot.width,
      height: snapshot.height,
      background: snapshot.background,
      studioBackground: snapshot.studioBackground,
      signal: controller.signal,
      onProgress: (progress) => window.rasterformRenderHost.progress(message.jobId, progress),
    })
    if (controller.signal.aborted) throw new DOMException('Final image export cancelled.', 'AbortError')
    const png = new Uint8Array(await result.blob.arrayBuffer())
    window.rasterformRenderHost.complete(message.jobId, {
      width: result.width,
      height: result.height,
      dpi: result.dpi,
      samples: result.samples,
      tiles: result.tiles,
    }, png)
  } catch (error) {
    if (isAbort(error, controller.signal)) window.rasterformRenderHost.cancelled(message.jobId)
    else window.rasterformRenderHost.failed(
      message.jobId,
      error instanceof Error ? error.message : 'Final rendering failed.',
    )
  } finally {
    environment?.dispose()
    if (active?.jobId === message.jobId) active = null
  }
}

window.rasterformRenderHost.onStart((message) => void runFinal(message))
window.rasterformRenderHost.onCancel((jobId) => {
  if (active?.jobId === jobId) active.controller.abort()
})
