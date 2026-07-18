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
  | { type: 'progress'; progress: FinalExportProgress }
  | { type: 'result'; quality: 'high'; result: ViewportPngResult }
  | { type: 'error'; name: string; message: string }

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

function abortError(): DOMException {
  return new DOMException('Image export cancelled.', 'AbortError')
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

export function renderImageExportInWorker(
  options: HighWorkerOptions,
): Promise<ViewportPngResult> {
  if (!canUseImageExportWorker()) return Promise.reject(new Error('Dedicated image rendering is unavailable.'))
  if (options.signal?.aborted) return Promise.reject(abortError())

  const mesh = snapshotMesh(options.mesh)
  const environment = snapshotEnvironment(options.environment)
  const request: ImageExportWorkerRequest = {
    type: 'render',
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

  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/image-export.worker.ts', import.meta.url), {
      type: 'module',
      name: 'rasterform-image-export',
    })
    let settled = false

    const cleanup = () => {
      options.signal?.removeEventListener('abort', handleAbort)
      worker.terminate()
    }
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      callback()
    }
    const handleAbort = () => finish(() => reject(abortError()))

    options.signal?.addEventListener('abort', handleAbort, { once: true })
    worker.onerror = (event) => finish(() => reject(new Error(event.message || 'Image export worker failed to start.')))
    worker.onmessage = (event: MessageEvent<ImageExportWorkerResponse>) => {
      const response = event.data
      if (response.type === 'progress') {
        options.onProgress?.(response.progress)
        return
      }
      if (response.type === 'error') {
        const error = response.name === 'AbortError'
          ? abortError()
          : new Error(response.message)
        finish(() => reject(error))
        return
      }
      finish(() => resolve(response.result))
    }

    try {
      worker.postMessage(request, transfers)
    } catch (error) {
      finish(() => reject(error))
    }
  })
}
