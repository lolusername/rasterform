import { afterEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import type { MeshData } from '../types'
import {
  createImageExportWorkerSession,
  decideImageExportWorkerFailure,
  snapshotCamera,
  snapshotEnvironment,
  snapshotMesh,
  type HighWorkerOptions,
  type ImageExportWorkerResponse,
} from './image-export-worker'

class FakeWorker {
  static instances: FakeWorker[] = []

  onerror: ((event: ErrorEvent) => void) | null = null
  onmessage: ((event: MessageEvent<ImageExportWorkerResponse>) => void) | null = null
  readonly messages: Array<{ message: unknown; transfers?: Transferable[] }> = []
  terminated = false

  constructor() {
    FakeWorker.instances.push(this)
  }

  postMessage(message: unknown, transfers?: Transferable[]) {
    this.messages.push({ message, transfers })
  }

  terminate() {
    this.terminated = true
  }

  respond(response: ImageExportWorkerResponse) {
    this.onmessage?.({ data: response } as MessageEvent<ImageExportWorkerResponse>)
  }
}

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

function workerOptions(overrides: Partial<HighWorkerOptions> = {}): HighWorkerOptions {
  return {
    quality: 'high',
    mesh: meshFixture(),
    colorMode: 'clay',
    appearance: {
      heightGradient: { low: '#000000', mid: '#777777', high: '#ffffff', midpoint: 0.5 },
      clay: { color: '#eeeeee', finish: 'matte' },
    },
    environment: null,
    camera: new THREE.PerspectiveCamera(38, 1, 0.01, 100),
    width: 1,
    height: 1,
    background: 'transparent',
    studioBackground: 'dark-gray',
    supersample: 2,
    ...overrides,
  }
}

function workerResult(requestId: number): ImageExportWorkerResponse {
  return {
    type: 'result',
    requestId,
    quality: 'high',
    result: {
      blob: new Blob([new Uint8Array([1])], { type: 'image/png' }),
      width: 1,
      height: 1,
      dpi: 300,
      supersample: 2,
    },
  }
}

afterEach(() => {
  FakeWorker.instances.length = 0
  vi.unstubAllGlobals()
})

describe('dedicated image export snapshots', () => {
  it('retries an uncommitted sequence frame after worker progress and disables that session', () => {
    const decision = decideImageExportWorkerFailure({
      error: new Error('WebGL context lost after tile 2'),
      sequence: true,
      workerMadeProgress: true,
    })

    expect(decision).toEqual({
      aborted: false,
      disableSequenceWorker: true,
      retryOnMainThread: true,
    })
  })

  it('preserves one-shot High failure behavior after the worker has begun drawing', () => {
    const decision = decideImageExportWorkerFailure({
      error: new Error('WebGL context lost after tile 2'),
      sequence: false,
      workerMadeProgress: true,
    })

    expect(decision).toEqual({
      aborted: false,
      disableSequenceWorker: false,
      retryOnMainThread: false,
    })
  })

  it('preserves the one-shot High fallback when the worker never starts drawing', () => {
    expect(decideImageExportWorkerFailure({
      error: new Error('Worker failed to start'),
      sequence: false,
      workerMadeProgress: false,
    })).toEqual({
      aborted: false,
      disableSequenceWorker: false,
      retryOnMainThread: true,
    })
  })

  it('never retries cancellation on the main thread', () => {
    const controller = new AbortController()
    controller.abort()

    expect(decideImageExportWorkerFailure({
      error: new Error('Worker stopped'),
      signal: controller.signal,
      sequence: true,
      workerMadeProgress: true,
    })).toEqual({
      aborted: true,
      disableSequenceWorker: true,
      retryOnMainThread: false,
    })
    expect(decideImageExportWorkerFailure({
      error: new DOMException('Image export cancelled.', 'AbortError'),
      sequence: true,
      workerMadeProgress: false,
    }).retryOnMainThread).toBe(false)
  })

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

  it('reuses one worker for serialized sequence frames and disposes it explicitly', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    vi.stubGlobal('OffscreenCanvas', class {})
    const session = createImageExportWorkerSession()
    const worker = FakeWorker.instances[0]!

    const first = session.render(workerOptions())
    const firstRequest = worker.messages[0]?.message as { type: string; requestId: number }
    expect(firstRequest).toMatchObject({ type: 'render', requestId: 1 })
    worker.respond(workerResult(firstRequest.requestId))
    await expect(first).resolves.toMatchObject({ width: 1, height: 1, supersample: 2 })

    const second = session.render(workerOptions())
    const secondRequest = worker.messages[1]?.message as { type: string; requestId: number }
    expect(secondRequest).toMatchObject({ type: 'render', requestId: 2 })
    worker.respond(workerResult(secondRequest.requestId))
    await expect(second).resolves.toMatchObject({ width: 1, height: 1, supersample: 2 })

    expect(FakeWorker.instances).toHaveLength(1)
    expect(worker.terminated).toBe(false)
    session.dispose()
    expect(session.disposed).toBe(true)
    expect(worker.terminated).toBe(true)
  })

  it('tags cancellation and terminates the sequence worker before another frame can start', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    vi.stubGlobal('OffscreenCanvas', class {})
    const controller = new AbortController()
    const session = createImageExportWorkerSession()
    const worker = FakeWorker.instances[0]!
    const first = session.render(workerOptions({ signal: controller.signal }))
    const firstRequest = worker.messages[0]?.message as { requestId: number }

    controller.abort()
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect(worker.messages[1]?.message).toEqual({ type: 'cancel', requestId: firstRequest.requestId })
    expect(session.disposed).toBe(true)
    expect(worker.terminated).toBe(true)
    await expect(session.render(workerOptions())).rejects.toThrow(/no longer available/)
  })
})
