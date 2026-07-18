/// <reference lib="webworker" />

import * as THREE from 'three'
import {
  renderFinalImagePng,
  type FinalExportProgress,
  type FinalImageExportRuntime,
} from '../lib/final-image-export'
import type {
  ImageExportCameraSnapshot,
  ImageExportEnvironmentSnapshot,
  ImageExportWorkerRequest,
  ImageExportWorkerResponse,
} from '../lib/image-export-worker'
import {
  cooperativeExportYield,
  encodeExportCanvasPng,
  renderViewportPng,
  type ExportCanvas,
  type ViewportExportRuntime,
} from '../lib/viewport-export'
import {
  configureStudioRenderer,
  createFinalRenderScene,
  disposeFinalRenderScene,
} from '../lib/three'

type WorkerCommand = ImageExportWorkerRequest | { type: 'cancel' }

const workerScope = self as unknown as DedicatedWorkerGlobalScope
let activeController: AbortController | null = null

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

function restoreEnvironment(snapshot: ImageExportEnvironmentSnapshot | null): THREE.DataTexture | null {
  if (!snapshot) return null
  const texture = new THREE.DataTexture(
    snapshot.data,
    snapshot.width,
    snapshot.height,
    snapshot.format as THREE.PixelFormat,
    snapshot.type as THREE.TextureDataType,
  )
  texture.mapping = snapshot.mapping as THREE.AnyMapping
  texture.colorSpace = snapshot.colorSpace
  texture.flipY = snapshot.flipY
  texture.minFilter = snapshot.minFilter as THREE.MinificationTextureFilter
  texture.magFilter = snapshot.magFilter as THREE.MagnificationTextureFilter
  texture.wrapS = snapshot.wrapS as THREE.Wrapping
  texture.wrapT = snapshot.wrapT as THREE.Wrapping
  texture.anisotropy = snapshot.anisotropy
  texture.generateMipmaps = snapshot.generateMipmaps
  texture.premultiplyAlpha = snapshot.premultiplyAlpha
  texture.unpackAlignment = snapshot.unpackAlignment
  texture.needsUpdate = true
  return texture
}

function createOffscreenCanvas(): ExportCanvas {
  return new OffscreenCanvas(1, 1)
}

function createOffscreenRenderer(canvas: ExportCanvas, antialias: boolean): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    canvas: canvas as OffscreenCanvas,
    alpha: true,
    antialias,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  })
  configureStudioRenderer(renderer)
  return renderer
}

const viewportRuntime: ViewportExportRuntime = {
  createCanvas: createOffscreenCanvas,
  createRenderer: (canvas) => createOffscreenRenderer(canvas, true),
  encodeCanvas: encodeExportCanvasPng,
  yieldToHost: cooperativeExportYield,
}

const finalRuntime: FinalImageExportRuntime = {
  createCanvas: createOffscreenCanvas,
  createRenderer: (canvas) => createOffscreenRenderer(canvas, false),
  encodeCanvas: encodeExportCanvasPng,
  yieldToHost: cooperativeExportYield,
  now: () => performance.now(),
}

function postProgress(progress: FinalExportProgress) {
  const response: ImageExportWorkerResponse = { type: 'progress', progress }
  workerScope.postMessage(response)
}

async function renderHigh(
  request: ImageExportWorkerRequest,
  camera: THREE.PerspectiveCamera,
  environment: THREE.DataTexture | null,
  signal: AbortSignal,
) {
  const renderScene = createFinalRenderScene(
    request.mesh,
    request.colorMode,
    request.appearance,
    environment,
    request.background,
    request.studioBackground,
  )
  const referenceRenderer = {
    outputColorSpace: THREE.SRGBColorSpace,
    toneMapping: THREE.AgXToneMapping,
    toneMappingExposure: 1.15,
    shadowMap: {
      enabled: true,
      type: THREE.PCFSoftShadowMap,
    },
  } as unknown as THREE.WebGLRenderer

  try {
    return await renderViewportPng({
      scene: renderScene.scene,
      camera,
      liveRenderer: referenceRenderer,
      width: request.width,
      height: request.height,
      supersample: request.supersample,
      runtime: viewportRuntime,
      signal,
      onProgress: (progress) => postProgress({
        phase: progress.phase,
        progress: progress.progress,
        tile: progress.tile,
        tiles: progress.tiles,
        samples: progress.progress >= 1 ? 1 : 0,
        targetSamples: 1,
      }),
    })
  } finally {
    disposeFinalRenderScene(renderScene)
  }
}

async function renderRequest(request: ImageExportWorkerRequest) {
  activeController?.abort()
  const controller = new AbortController()
  activeController = controller
  const environment = restoreEnvironment(request.environment)
  const camera = restoreCamera(request.camera, request.width, request.height)

  try {
    if (request.quality === 'high') {
      const result = await renderHigh(request, camera, environment, controller.signal)
      const response: ImageExportWorkerResponse = { type: 'result', quality: 'high', result }
      workerScope.postMessage(response)
    } else {
      const result = await renderFinalImagePng({
        mesh: request.mesh,
        colorMode: request.colorMode,
        appearance: request.appearance,
        environment,
        camera,
        width: request.width,
        height: request.height,
        background: request.background,
        studioBackground: request.studioBackground,
        signal: controller.signal,
        onProgress: postProgress,
        runtime: finalRuntime,
      })
      const response: ImageExportWorkerResponse = { type: 'result', quality: 'final', result }
      workerScope.postMessage(response)
    }
  } catch (error) {
    const response: ImageExportWorkerResponse = {
      type: 'error',
      name: error instanceof DOMException ? error.name : 'Error',
      message: error instanceof Error ? error.message : 'Image export failed in the background renderer.',
    }
    workerScope.postMessage(response)
  } finally {
    if (activeController === controller) activeController = null
    environment?.dispose()
  }
}

workerScope.onmessage = (event: MessageEvent<WorkerCommand>) => {
  if (event.data.type === 'cancel') {
    activeController?.abort()
    return
  }
  void renderRequest(event.data)
}
