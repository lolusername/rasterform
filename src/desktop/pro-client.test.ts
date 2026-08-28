import * as THREE from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppearanceSettings, MeshData } from '../types'
import {
  DESKTOP_LONG_EXPORT_PROTOCOL_VERSION,
  DESKTOP_PROTOCOL_VERSION,
} from './contracts'
import {
  DesktopProRenderError,
  createDesktopProRenderSnapshot,
  desktopProRendererAvailable,
  probeDesktopProRenderer,
  renderProImageInDesktop,
} from './pro-client'
import {
  DEFAULT_DESKTOP_PRO_RENDER_SETTINGS,
  DESKTOP_PRO_RENDER_PROTOCOL_VERSION,
  type DesktopProRenderEvent,
  type DesktopProRenderSnapshot,
  type DesktopSavedProResult,
  type RasterformDesktopProBridge,
} from './pro-contracts'

function meshFixture(): MeshData {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0.5]),
    indices: new Uint32Array([0, 1, 2]),
    colors: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
    uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
    heights: new Float32Array([0, 0.5, 1]),
    width: 2,
    height: 2,
    mode: 'solid',
  }
}

function appearanceFixture(): AppearanceSettings {
  return {
    heightGradient: {
      low: '#21194f',
      mid: '#32bf8a',
      high: '#f2c66d',
      midpoint: 0.5,
    },
    clay: { color: '#d7d0bf', finish: 'glossy' },
  }
}

function baseOptions() {
  const camera = new THREE.PerspectiveCamera(38, 4 / 3, 0.01, 100)
  camera.position.set(0, 0, 4)
  camera.updateMatrixWorld(true)
  return {
    suggestedName: 'rasterform-clay-pro-2048x1536-transparent.png',
    mesh: meshFixture(),
    camera,
    colorMode: 'clay' as const,
    appearance: appearanceFixture(),
    width: 2048,
    height: 1536,
    background: 'transparent' as const,
    studioBackground: 'dark-gray' as const,
    settings: { ...DEFAULT_DESKTOP_PRO_RENDER_SETTINGS },
  }
}

function savedResult(overrides: Partial<DesktopSavedProResult> = {}): DesktopSavedProResult {
  return {
    width: 2048,
    height: 1536,
    maxSamples: 8192,
    noiseThreshold: 0.001,
    pngFileName: 'rasterform-pro.png',
    exrFileName: 'rasterform-pro.exr',
    blenderVersion: '5.2.0 LTS',
    device: 'METAL',
    elapsedSeconds: 427.25,
    ...overrides,
  }
}

interface BridgeHarness {
  bridge: RasterformDesktopProBridge
  emit: (event: DesktopProRenderEvent) => void
  submitted: Array<{ jobId: string; snapshot: DesktopProRenderSnapshot }>
  cancelled: string[]
  preparedNames: string[]
  unsubscribe: ReturnType<typeof vi.fn>
}

function bridgeHarness(
  submit?: (
    jobId: string,
    snapshot: DesktopProRenderSnapshot,
    emit: (event: DesktopProRenderEvent) => void,
  ) => void,
): BridgeHarness {
  const listeners = new Set<(event: DesktopProRenderEvent) => void>()
  const submitted: Array<{ jobId: string; snapshot: DesktopProRenderSnapshot }> = []
  const cancelled: string[] = []
  const preparedNames: string[] = []
  const unsubscribe = vi.fn()
  const emit = (event: DesktopProRenderEvent) => listeners.forEach((listener) => listener(event))
  return {
    submitted,
    cancelled,
    preparedNames,
    unsubscribe,
    emit,
    bridge: {
      protocolVersion: DESKTOP_PROTOCOL_VERSION,
      longExportProtocolVersion: DESKTOP_LONG_EXPORT_PROTOCOL_VERSION,
      proRenderProtocolVersion: DESKTOP_PRO_RENDER_PROTOCOL_VERSION,
      prepareFinalSave: async () => ({ cancelled: true }),
      submitFinalRender: async () => ({ accepted: true }),
      cancelFinalRender: async () => ({ state: 'cancelled' }),
      onFinalRenderEvent: () => () => undefined,
      beginLongExport: async () => ({ accepted: true, jobId: 'living_job_1' }),
      endLongExport: async () => ({ ended: true }),
      probeProRenderer: async () => ({
        available: true,
        blenderVersion: '5.2.0 LTS',
        device: 'METAL',
        message: 'Cycles is ready.',
      }),
      prepareProSave: async (suggestedName) => {
        preparedNames.push(suggestedName)
        return { cancelled: false, jobId: 'pro_job_1' }
      },
      submitProRender: async (jobId, snapshot) => {
        submitted.push({ jobId, snapshot })
        submit?.(jobId, snapshot, emit)
        return { accepted: true }
      },
      cancelProRender: async (jobId) => {
        cancelled.push(jobId)
        return { state: 'cancelled' }
      },
      onProRenderEvent: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
          unsubscribe()
        }
      },
    },
  }
}

function savedEvent(jobId = 'pro_job_1', result = savedResult()): DesktopProRenderEvent {
  return { type: 'saved', jobId, result }
}

const desktopGlobal = globalThis as typeof globalThis & { window?: unknown }
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')

afterEach(() => {
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, 'window', originalWindowDescriptor)
  } else {
    Reflect.deleteProperty(desktopGlobal, 'window')
  }
})

describe('desktop Cycles Pro client', () => {
  it('detects only a complete independently versioned Pro bridge on window', () => {
    const harness = bridgeHarness()
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { rasterformDesktop: harness.bridge },
    })
    expect(desktopProRendererAvailable()).toBe(true)

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        rasterformDesktop: {
          ...harness.bridge,
          proRenderProtocolVersion: 2,
        },
      },
    })
    expect(desktopProRendererAvailable()).toBe(false)

    Reflect.deleteProperty(desktopGlobal, 'window')
    expect(desktopProRendererAvailable()).toBe(false)
  })

  it('probes the discovered bridge and strictly rejects malformed probe replies', async () => {
    const harness = bridgeHarness()
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { rasterformDesktop: harness.bridge },
    })

    await expect(probeDesktopProRenderer()).resolves.toEqual({
      available: true,
      blenderVersion: '5.2.0 LTS',
      device: 'METAL',
      message: 'Cycles is ready.',
    })
    harness.bridge.probeProRenderer = async () => ({
      available: true,
      blenderVersion: '',
      device: 'METAL',
      message: 'Malformed.',
    })
    await expect(probeDesktopProRenderer(harness.bridge)).rejects.toEqual(
      expect.objectContaining<Partial<DesktopProRenderError>>({
        name: 'DesktopProRenderError',
        code: 'render-failed',
      }),
    )
    await expect(probeDesktopProRenderer(null)).resolves.toBeNull()
  })

  it('takes an independent camera, geometry, appearance, and production-settings snapshot', () => {
    const options = baseOptions()
    options.camera.zoom = 1.4
    options.camera.filmGauge = 32
    options.camera.filmOffset = 1.25
    options.camera.updateProjectionMatrix()

    const snapshot = createDesktopProRenderSnapshot(options)

    expect(snapshot.protocolVersion).toBe(DESKTOP_PRO_RENDER_PROTOCOL_VERSION)
    expect(snapshot.camera).toMatchObject({ zoom: 1.4, filmGauge: 32, filmOffset: 1.25 })
    expect(snapshot.settings).toEqual({
      maxSamples: 8192,
      minSamples: 512,
      noiseThreshold: 0.001,
      maxBounces: 12,
      denoise: true,
    })
    expect(snapshot.mesh).not.toBe(options.mesh)
    expect(snapshot.mesh.positions).not.toBe(options.mesh.positions)
    expect(snapshot.appearance).not.toBe(options.appearance)
    expect(snapshot.settings).not.toBe(options.settings)

    snapshot.mesh.positions[0] = 99
    snapshot.appearance.clay.color = '#000000'
    snapshot.settings.maxSamples = 64
    expect(options.mesh.positions[0]).toBe(0)
    expect(options.appearance.clay.color).toBe('#d7d0bf')
    expect(options.settings.maxSamples).toBe(8192)
  })

  it('prepares, submits, reports progress, and resolves the exact saved PNG + EXR result', async () => {
    const progress = vi.fn()
    const harness = bridgeHarness((jobId, _snapshot, emit) => {
      queueMicrotask(() => {
        emit({
          type: 'progress',
          jobId,
          progress: {
            phase: 'rendering',
            progress: 0.5,
            tile: 0,
            tiles: 1,
            samples: 4096,
            targetSamples: 8192,
          },
        })
        emit(savedEvent(jobId))
      })
    })

    const result = await renderProImageInDesktop({
      ...baseOptions(),
      bridge: harness.bridge,
      onProgress: progress,
    })

    expect(result).toEqual({ desktopSaved: true, ...savedResult() })
    expect(harness.preparedNames).toEqual(['rasterform-clay-pro-2048x1536-transparent.png'])
    expect(harness.submitted).toHaveLength(1)
    expect(harness.submitted[0]?.jobId).toBe('pro_job_1')
    expect(progress).toHaveBeenCalledOnce()
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ samples: 4096 }))
    expect(harness.cancelled).toEqual([])
    expect(harness.unsubscribe).toHaveBeenCalledOnce()
  })

  it('ignores stale valid events from another job', async () => {
    const progress = vi.fn()
    const harness = bridgeHarness((jobId, _snapshot, emit) => {
      queueMicrotask(() => {
        emit(savedEvent('stale_job', savedResult({ pngFileName: 'stale.png', exrFileName: 'stale.exr' })))
        emit({
          type: 'progress',
          jobId: 'stale_job',
          progress: {
            phase: 'rendering',
            progress: 0.75,
            tile: 0,
            tiles: 1,
            samples: 6144,
            targetSamples: 8192,
          },
        })
        emit(savedEvent(jobId))
      })
    })

    await expect(renderProImageInDesktop({
      ...baseOptions(),
      bridge: harness.bridge,
      onProgress: progress,
    })).resolves.toMatchObject({ pngFileName: 'rasterform-pro.png' })
    expect(progress).not.toHaveBeenCalled()
    expect(harness.unsubscribe).toHaveBeenCalledOnce()
  })

  it('treats Save As cancellation as cancellation without submitting', async () => {
    const harness = bridgeHarness()
    harness.bridge.prepareProSave = async () => ({ cancelled: true })

    await expect(renderProImageInDesktop({
      ...baseOptions(),
      bridge: harness.bridge,
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(harness.submitted).toEqual([])
    expect(harness.unsubscribe).not.toHaveBeenCalled()
  })

  it('cancels a late save reservation after aborting during Save As', async () => {
    const controller = new AbortController()
    const harness = bridgeHarness()
    let resolveSave: (result: { cancelled: false; jobId: string }) => void = () => undefined
    harness.bridge.prepareProSave = () => new Promise((resolve) => {
      resolveSave = resolve
    })
    const render = renderProImageInDesktop({
      ...baseOptions(),
      bridge: harness.bridge,
      signal: controller.signal,
    })

    controller.abort()
    await expect(render).rejects.toMatchObject({ name: 'AbortError' })
    resolveSave({ cancelled: false, jobId: 'late_pro_job' })
    await Promise.resolve()
    await Promise.resolve()
    expect(harness.cancelled).toEqual(['late_pro_job'])
  })

  it('cancels an active render, rejects with AbortError, and cleans up the listener', async () => {
    const controller = new AbortController()
    const harness = bridgeHarness(() => queueMicrotask(() => controller.abort()))

    await expect(renderProImageInDesktop({
      ...baseOptions(),
      bridge: harness.bridge,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(harness.cancelled).toEqual(['pro_job_1'])
    expect(harness.unsubscribe).toHaveBeenCalledOnce()
  })

  it('waits for the real saved result when cancellation reaches atomic saving', async () => {
    const controller = new AbortController()
    const harness = bridgeHarness((jobId, _snapshot, emit) => {
      queueMicrotask(() => controller.abort())
      setTimeout(() => emit(savedEvent(jobId)), 0)
    })
    harness.bridge.cancelProRender = async (jobId) => {
      harness.cancelled.push(jobId)
      return { state: 'saving' }
    }

    await expect(renderProImageInDesktop({
      ...baseOptions(),
      bridge: harness.bridge,
      signal: controller.signal,
    })).resolves.toMatchObject({ desktopSaved: true, pngFileName: 'rasterform-pro.png' })
    expect(harness.cancelled).toEqual(['pro_job_1'])
    expect(harness.unsubscribe).toHaveBeenCalledOnce()
  })

  it('accepts a saved cancellation acknowledgement as the terminal success', async () => {
    const controller = new AbortController()
    const harness = bridgeHarness(() => queueMicrotask(() => controller.abort()))
    harness.bridge.cancelProRender = async (jobId) => {
      harness.cancelled.push(jobId)
      return { state: 'saved', result: savedResult() }
    }

    await expect(renderProImageInDesktop({
      ...baseOptions(),
      bridge: harness.bridge,
      signal: controller.signal,
    })).resolves.toMatchObject({ desktopSaved: true, maxSamples: 8192 })
    expect(harness.unsubscribe).toHaveBeenCalledOnce()
  })

  it('surfaces native errors and rejected submissions without leaking listeners', async () => {
    const nativeError = bridgeHarness((jobId, _snapshot, emit) => {
      queueMicrotask(() => emit({
        type: 'error',
        jobId,
        code: 'process-gone',
        message: 'The background Blender process exited.',
      }))
    })
    await expect(renderProImageInDesktop({
      ...baseOptions(),
      bridge: nativeError.bridge,
    })).rejects.toEqual(expect.objectContaining<Partial<DesktopProRenderError>>({
      name: 'DesktopProRenderError',
      code: 'process-gone',
      message: 'The background Blender process exited.',
    }))
    expect(nativeError.cancelled).toEqual([])
    expect(nativeError.unsubscribe).toHaveBeenCalledOnce()

    const rejected = bridgeHarness()
    rejected.bridge.submitProRender = async () => ({
      accepted: false,
      error: { code: 'request-expired', message: 'The save reservation expired.' },
    })
    await expect(renderProImageInDesktop({
      ...baseOptions(),
      bridge: rejected.bridge,
    })).rejects.toEqual(expect.objectContaining<Partial<DesktopProRenderError>>({
      code: 'request-expired',
    }))
    expect(rejected.cancelled).toEqual([])
    expect(rejected.unsubscribe).toHaveBeenCalledOnce()
  })

  it('rejects and cancels malformed or contract-changing renderer output', async () => {
    const changed = bridgeHarness((jobId, _snapshot, emit) => {
      queueMicrotask(() => emit(savedEvent(jobId, savedResult({ maxSamples: 512 }))))
    })
    await expect(renderProImageInDesktop({
      ...baseOptions(),
      bridge: changed.bridge,
    })).rejects.toThrow('changed the requested output contract')
    expect(changed.cancelled).toEqual(['pro_job_1'])

    const malformed = bridgeHarness()
    malformed.bridge.submitProRender = async () => ({ accepted: true, debug: true }) as never
    await expect(renderProImageInDesktop({
      ...baseOptions(),
      bridge: malformed.bridge,
    })).rejects.toThrow('invalid Pro acknowledgement')
    expect(malformed.cancelled).toEqual(['pro_job_1'])
    expect(malformed.unsubscribe).toHaveBeenCalledOnce()
  })

  it('turns progress callback failures into a settled error and cancels the native job', async () => {
    const harness = bridgeHarness((jobId, _snapshot, emit) => {
      queueMicrotask(() => emit({
        type: 'progress',
        jobId,
        progress: {
          phase: 'rendering',
          progress: 0.25,
          tile: 0,
          tiles: 1,
          samples: 2048,
          targetSamples: 8192,
        },
      }))
    })

    await expect(renderProImageInDesktop({
      ...baseOptions(),
      bridge: harness.bridge,
      onProgress: () => { throw new Error('UI callback failed') },
    })).rejects.toThrow('could not process Pro render progress')
    expect(harness.cancelled).toEqual(['pro_job_1'])
    expect(harness.unsubscribe).toHaveBeenCalledOnce()
  })

  it('settles cleanly when sending cancellation throws synchronously', async () => {
    const controller = new AbortController()
    const harness = bridgeHarness(() => queueMicrotask(() => controller.abort()))
    harness.bridge.cancelProRender = () => {
      throw new Error('IPC disappeared')
    }

    await expect(renderProImageInDesktop({
      ...baseOptions(),
      bridge: harness.bridge,
      signal: controller.signal,
    })).rejects.toThrow('could not send the Pro render cancellation request')
    expect(harness.unsubscribe).toHaveBeenCalledOnce()
  })

  it('cleans up and does not submit after a synchronous terminal subscription event', async () => {
    const harness = bridgeHarness()
    harness.bridge.onProRenderEvent = (listener) => {
      listener(savedEvent())
      return harness.unsubscribe
    }

    await expect(renderProImageInDesktop({
      ...baseOptions(),
      bridge: harness.bridge,
    })).resolves.toMatchObject({ desktopSaved: true, exrFileName: 'rasterform-pro.exr' })
    expect(harness.unsubscribe).toHaveBeenCalledOnce()
    expect(harness.submitted).toEqual([])
  })

  it('rejects invalid names and a missing desktop Pro capability before native work', async () => {
    const harness = bridgeHarness()
    await expect(renderProImageInDesktop({
      ...baseOptions(),
      suggestedName: '../render.png',
      bridge: harness.bridge,
    })).rejects.toEqual(expect.objectContaining<Partial<DesktopProRenderError>>({
      code: 'save-failed',
    }))
    expect(harness.preparedNames).toEqual([])

    await expect(renderProImageInDesktop({
      ...baseOptions(),
      bridge: null,
    })).rejects.toThrow('available only in the Rasterform desktop renderer lab')
  })
})
