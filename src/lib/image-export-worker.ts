import type * as THREE from 'three'
import type {
  AppearanceSettings,
  ColorMode,
  ImageExportBackground,
  MeshData,
  ViewportBackground,
  ViewportSupersample,
} from '../types'
import type { FinalExportProgress } from './final-image-export'
import type { ViewportPngResult } from './viewport-export'

type TexturePixels = Float32Array | Uint16Array | Uint8Array

export interface ImageExportCameraSnapshot {
  fov: number
  near: number
  far: number
  zoom: number
  filmGauge: number
  filmOffset: number
  position: [number, number, number]
  quaternion: [number, number, number, number]
  up: [number, number, number]
}

export interface ImageExportEnvironmentSnapshot {
  data: TexturePixels
  width: number
  height: number
  format: number
  type: number
  mapping: number
  colorSpace: string
  flipY: boolean
  minFilter: number
  magFilter: number
  wrapS: number
  wrapT: number
  anisotropy: number
  generateMipmaps: boolean
  premultiplyAlpha: boolean
  unpackAlignment: number
}

export interface ImageExportWorkerRequest {
  type: 'render'
  requestId: number
  quality: 'high'
  mesh: MeshData
  colorMode: ColorMode
  appearance: AppearanceSettings
  environment: ImageExportEnvironmentSnapshot | null
  camera: ImageExportCameraSnapshot
  width: number
  height: number
  background: ImageExportBackground
  studioBackground: ViewportBackground
  supersample: ViewportSupersample
}

export type ImageExportWorkerResponse =
  | { type: 'progress'; requestId: number; progress: FinalExportProgress }
  | { type: 'result'; requestId: number; quality: 'high'; result: ViewportPngResult }
  | { type: 'error'; requestId: number; name: string; message: string }

interface BaseWorkerOptions {
  mesh: MeshData
  colorMode: ColorMode
  appearance: AppearanceSettings
  environment: THREE.DataTexture | null
  camera: THREE.PerspectiveCamera
  width: number
  height: number
  background: ImageExportBackground
  studioBackground: ViewportBackground
  signal?: AbortSignal
  onProgress?: (progress: FinalExportProgress) => void
}

export interface HighWorkerOptions extends BaseWorkerOptions {
  quality: 'high'
  supersample: ViewportSupersample
}

export interface ImageExportWorkerSession {
  readonly disposed: boolean
  render(options: HighWorkerOptions): Promise<ViewportPngResult>
  dispose(): void
}

export interface ImageExportWorkerFailureDecision {
  aborted: boolean
  disableSequenceWorker: boolean
  retryOnMainThread: boolean
}

function abortError(): DOMException {
  return new DOMException('Image export cancelled.', 'AbortError')
}

/**
 * Keep one-shot High exports conservative after a worker has begun drawing, but
 * never strand a loop on a failed background WebGL context. No loop frame is
 * committed until this render resolves, so retrying the same snapshot on the
 * established main-thread renderer is safe even after worker progress events.
 */
export function decideImageExportWorkerFailure(options: {
  error: unknown
  signal?: AbortSignal
  sequence: boolean
  workerMadeProgress: boolean
}): ImageExportWorkerFailureDecision {
  const aborted = options.signal?.aborted === true
    || (options.error instanceof DOMException && options.error.name === 'AbortError')
  return {
    aborted,
    disableSequenceWorker: options.sequence,
    retryOnMainThread: !aborted && (options.sequence || !options.workerMadeProgress),
  }
}

function copyTexturePixels(data: unknown): TexturePixels | null {
  if (data instanceof Float32Array) return data.slice()
  if (data instanceof Uint16Array) return data.slice()
  if (data instanceof Uint8Array || data instanceof Uint8ClampedArray) return new Uint8Array(data)
  return null
}

export function snapshotEnvironment(texture: THREE.DataTexture | null): ImageExportEnvironmentSnapshot | null {
  if (!texture) return null
  const image = texture.image as { data?: unknown; width?: number; height?: number }
  const data = copyTexturePixels(image.data)
  const width = Math.max(1, Math.round(image.width ?? 0))
  const height = Math.max(1, Math.round(image.height ?? 0))
  if (!data || !image.width || !image.height) return null
  return {
    data,
    width,
    height,
    format: texture.format,
    type: texture.type,
    mapping: texture.mapping,
    colorSpace: texture.colorSpace,
    flipY: texture.flipY,
    minFilter: texture.minFilter,
    magFilter: texture.magFilter,
    wrapS: texture.wrapS,
    wrapT: texture.wrapT,
    anisotropy: texture.anisotropy,
    generateMipmaps: texture.generateMipmaps,
    premultiplyAlpha: texture.premultiplyAlpha,
    unpackAlignment: texture.unpackAlignment,
  }
}

export function snapshotCamera(camera: THREE.PerspectiveCamera): ImageExportCameraSnapshot {
  return {
    fov: camera.fov,
    near: camera.near,
    far: camera.far,
    zoom: camera.zoom,
    filmGauge: camera.filmGauge,
    filmOffset: camera.filmOffset,
    position: camera.position.toArray() as [number, number, number],
    quaternion: camera.quaternion.toArray() as [number, number, number, number],
    up: camera.up.toArray() as [number, number, number],
  }
}

export function snapshotMesh(mesh: MeshData): MeshData {
  return {
    ...mesh,
    positions: mesh.positions.slice(),
    indices: mesh.indices.slice(),
    colors: mesh.colors.slice(),
    uvs: mesh.uvs.slice(),
    heights: mesh.heights.slice(),
  }
}

export function canUseImageExportWorker(): boolean {
  return typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined'
}

function createWorkerRequest(options: HighWorkerOptions, requestId: number): {
  request: ImageExportWorkerRequest
  transfers: Transferable[]
} {
  const mesh = snapshotMesh(options.mesh)
  const environment = snapshotEnvironment(options.environment)
  const request: ImageExportWorkerRequest = {
    type: 'render',
    requestId,
    quality: options.quality,
    mesh,
    colorMode: options.colorMode,
    appearance: {
      heightGradient: { ...options.appearance.heightGradient },
      clay: { ...options.appearance.clay },
    },
    environment,
    camera: snapshotCamera(options.camera),
    width: options.width,
    height: options.height,
    background: options.background,
    studioBackground: options.studioBackground,
    supersample: options.supersample,
  }
  const transfers: Transferable[] = [
    mesh.positions.buffer,
    mesh.indices.buffer,
    mesh.colors.buffer,
    mesh.uvs.buffer,
    mesh.heights.buffer,
  ]
  if (environment) transfers.push(environment.data.buffer)

  return { request, transfers }
}

/**
 * Own one dedicated renderer worker across a sequence of High-quality frames.
 * Calls are intentionally serialized so a loop cannot accidentally overlap two
 * WebGL jobs in the same worker. Request ids make late cancellation/error events
 * harmless if a caller aborts between frames.
 */
export function createImageExportWorkerSession(): ImageExportWorkerSession {
  if (!canUseImageExportWorker()) throw new Error('Dedicated image rendering is unavailable.')

  const worker = new Worker(new URL('../workers/image-export.worker.ts', import.meta.url), {
    type: 'module',
    name: 'rasterform-image-export',
  })
  let nextRequestId = 1
  let isDisposed = false
  let pending: {
    requestId: number
    resolve: (result: ViewportPngResult) => void
    reject: (reason: unknown) => void
    onProgress?: (progress: FinalExportProgress) => void
    signal?: AbortSignal
    handleAbort: () => void
  } | null = null

  const finishPending = (
    requestId: number,
    callback: (active: NonNullable<typeof pending>) => void,
  ) => {
    const active = pending
    if (!active || active.requestId !== requestId) return
    pending = null
    active.signal?.removeEventListener('abort', active.handleAbort)
    callback(active)
  }

  const dispose = () => {
    if (isDisposed) return
    isDisposed = true
    worker.terminate()
    const active = pending
    if (!active) return
    pending = null
    active.signal?.removeEventListener('abort', active.handleAbort)
    active.reject(abortError())
  }

  worker.onerror = (event) => {
    const message = event.message || 'Image export worker failed to start.'
    const active = pending
    if (active) finishPending(active.requestId, (request) => request.reject(new Error(message)))
    isDisposed = true
    worker.terminate()
  }
  worker.onmessage = (event: MessageEvent<ImageExportWorkerResponse>) => {
    const response = event.data
    const active = pending
    if (!active || response.requestId !== active.requestId) return
    if (response.type === 'progress') {
      active.onProgress?.(response.progress)
      return
    }
    if (response.type === 'error') {
      const error = response.name === 'AbortError'
        ? abortError()
        : new Error(response.message)
      finishPending(response.requestId, (request) => request.reject(error))
      return
    }
    finishPending(response.requestId, (request) => request.resolve(response.result))
  }

  return {
    get disposed() {
      return isDisposed
    },
    render(options: HighWorkerOptions): Promise<ViewportPngResult> {
      if (isDisposed) return Promise.reject(new Error('Dedicated image renderer is no longer available.'))
      if (pending) return Promise.reject(new Error('Dedicated image renderer is already rendering a frame.'))
      if (options.signal?.aborted) return Promise.reject(abortError())

      const requestId = nextRequestId
      nextRequestId += 1
      const prepared = createWorkerRequest(options, requestId)

      return new Promise((resolve, reject) => {
        const handleAbort = () => {
          try {
            worker.postMessage({ type: 'cancel', requestId })
          } catch {
            // The promise still rejects even if the worker has already stopped.
          }
          finishPending(requestId, (active) => active.reject(abortError()))
          // Cancellation ends a sequence, so terminate immediately instead of
          // allowing an old WebGL job to overlap a later request while unwinding.
          if (!isDisposed) {
            isDisposed = true
            worker.terminate()
          }
        }
        pending = {
          requestId,
          resolve,
          reject,
          onProgress: options.onProgress,
          signal: options.signal,
          handleAbort,
        }
        options.signal?.addEventListener('abort', handleAbort, { once: true })
        try {
          worker.postMessage(prepared.request, prepared.transfers)
        } catch (error) {
          finishPending(requestId, (active) => active.reject(error))
        }
      })
    },
    dispose,
  }
}

export function renderImageExportInWorker(
  options: HighWorkerOptions,
): Promise<ViewportPngResult> {
  if (!canUseImageExportWorker()) return Promise.reject(new Error('Dedicated image rendering is unavailable.'))
  if (options.signal?.aborted) return Promise.reject(abortError())

  try {
    const session = createImageExportWorkerSession()
    return session.render(options).finally(() => session.dispose())
  } catch (error) {
    return Promise.reject(error)
  }
}
