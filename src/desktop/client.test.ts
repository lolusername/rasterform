import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import type { AppearanceSettings, MeshData } from '../types'
import {
  DESKTOP_LONG_EXPORT_PROTOCOL_VERSION,
  DESKTOP_PROTOCOL_VERSION,
  type DesktopFinalRenderSnapshot,
  type DesktopLongExportOutcome,
  type DesktopLongExportStartRequest,
  type DesktopRenderEvent,
  type RasterformDesktopLongExportBridge,
} from './contracts'
import {
  DesktopFinalRenderError,
  DesktopLongExportError,
  beginDesktopLongExport,
  createDesktopFinalRenderSnapshot,
  endDesktopLongExport,
  renderFinalImageInDesktop,
} from './client'

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

function appearanceFixture(finish: AppearanceSettings['clay']['finish'] = 'matte'): AppearanceSettings {
  return {
    heightGradient: {
      low: '#21194f',
      mid: '#32bf8a',
      high: '#f2c66d',
      midpoint: 0.5,
    },
    clay: { color: '#d7d0bf', finish },
  }
}

function baseOptions() {
  const camera = new THREE.PerspectiveCamera(38, 4 / 3, 0.01, 100)
  camera.position.set(0, 0, 4)
  camera.updateMatrixWorld(true)
  return {
    suggestedName: 'rasterform-clay-final-2048x1536-transparent.png',
    mesh: meshFixture(),
    camera,
    colorMode: 'clay' as const,
    appearance: appearanceFixture(),
    width: 2048,
    height: 1536,
    background: 'transparent' as const,
    studioBackground: 'dark-gray' as const,
  }
}

interface BridgeHarness {
  bridge: RasterformDesktopLongExportBridge
  emit: (event: DesktopRenderEvent) => void
  submitted: DesktopFinalRenderSnapshot[]
  cancelled: string[]
  longStarts: DesktopLongExportStartRequest[]
  longEnds: Array<{ jobId: string; outcome: DesktopLongExportOutcome }>
  unsubscribe: ReturnType<typeof vi.fn>
}

function bridgeHarness(
  submit?: (jobId: string, snapshot: DesktopFinalRenderSnapshot, emit: (event: DesktopRenderEvent) => void) => void,
): BridgeHarness {
  const listeners = new Set<(event: DesktopRenderEvent) => void>()
  const submitted: DesktopFinalRenderSnapshot[] = []
  const cancelled: string[] = []
  const longStarts: DesktopLongExportStartRequest[] = []
  const longEnds: Array<{ jobId: string; outcome: DesktopLongExportOutcome }> = []
  const unsubscribe = vi.fn()
  const emit = (event: DesktopRenderEvent) => listeners.forEach((listener) => listener(event))
  return {
    submitted,
    cancelled,
    longStarts,
    longEnds,
    unsubscribe,
    emit,
    bridge: {
      protocolVersion: DESKTOP_PROTOCOL_VERSION,
      longExportProtocolVersion: DESKTOP_LONG_EXPORT_PROTOCOL_VERSION,
      prepareFinalSave: async () => ({ cancelled: false, jobId: 'job_1' }),
      submitFinalRender: async (jobId, snapshot) => {
        submitted.push(snapshot)
        submit?.(jobId, snapshot, emit)
        return { accepted: true }
      },
      cancelFinalRender: async (jobId) => {
        cancelled.push(jobId)
        return { state: 'cancelled' }
      },
      onFinalRenderEvent: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
          unsubscribe()
        }
      },
      beginLongExport: async (request) => {
        longStarts.push(request)
        return { accepted: true, jobId: 'living_job_1' }
      },
      endLongExport: async (jobId, outcome) => {
        longEnds.push({ jobId, outcome })
        return { ended: true }
      },
    },
  }
}

function savedEvent(
  jobId = 'job_1',
  overrides: Partial<DesktopRenderEvent & { type: 'saved' }> = {},
): DesktopRenderEvent {
  return {
    type: 'saved',
    jobId,
    result: {
      width: 2048,
      height: 1536,
      dpi: 300,
      samples: 6144,
      tiles: 4,
      fileName: 'rasterform-final.png',
    },
    ...overrides,
  }
}

describe('desktop Final client', () => {
  it('returns null without a desktop bridge so the browser path remains unchanged', async () => {
    await expect(renderFinalImageInDesktop({ ...baseOptions(), bridge: null })).resolves.toBeNull()
  })

  it('copies the render snapshot and resolves a discriminated native-save result', async () => {
    const options = baseOptions()
    const progress = vi.fn()
    const harness = bridgeHarness((jobId, _snapshot, emit) => {
      queueMicrotask(() => {
        emit({
          type: 'progress',
          jobId,
          progress: {
            phase: 'rendering',
            progress: 0.5,
            tile: 1,
            tiles: 2,
            samples: 3072,
            targetSamples: 6144,
          },
        })
        emit(savedEvent(jobId))
      })
    })

    const result = await renderFinalImageInDesktop({
      ...options,
      bridge: harness.bridge,
      onProgress: progress,
    })

    expect(result).toEqual({
      desktopSaved: true,
      width: 2048,
      height: 1536,
      dpi: 300,
      samples: 6144,
      tiles: 4,
      fileName: 'rasterform-final.png',
    })
    expect(progress).toHaveBeenCalledOnce()
    expect(harness.unsubscribe).toHaveBeenCalledOnce()
    expect(harness.cancelled).toEqual([])
    expect(harness.submitted).toHaveLength(1)
    const snapshot = harness.submitted[0]!
    expect(snapshot.mesh).not.toBe(options.mesh)
    expect(snapshot.mesh.positions).not.toBe(options.mesh.positions)
    expect(snapshot.appearance).not.toBe(options.appearance)
    expect(snapshot.appearance.clay).not.toBe(options.appearance.clay)
    expect('samples' in snapshot).toBe(false)
  })

  it('takes a complete perspective-camera and mesh snapshot', () => {
    const options = baseOptions()
    options.camera.zoom = 1.4
    options.camera.filmGauge = 32
    options.camera.filmOffset = 1.25
    options.camera.updateProjectionMatrix()
    const snapshot = createDesktopFinalRenderSnapshot(options)

    expect(snapshot.camera).toMatchObject({ zoom: 1.4, filmGauge: 32, filmOffset: 1.25 })
    snapshot.mesh.positions[0] = 99
    snapshot.appearance.clay.color = '#000000'
    expect(options.mesh.positions[0]).toBe(0)
    expect(options.appearance.clay.color).toBe('#d7d0bf')
  })

  it('ignores stale job events and preserves the glossy 8192-sample contract', async () => {
    const harness = bridgeHarness((jobId, _snapshot, emit) => {
      queueMicrotask(() => {
        emit(savedEvent('stale_job'))
        emit(savedEvent(jobId, {
          result: {
            width: 2048,
            height: 1536,
            dpi: 300,
            samples: 8192,
            tiles: 4,
            fileName: 'glossy.png',
          },
        }))
      })
    })

    const result = await renderFinalImageInDesktop({
      ...baseOptions(),
      appearance: appearanceFixture('glossy'),
      bridge: harness.bridge,
    })

    expect(result?.samples).toBe(8192)
    expect(harness.unsubscribe).toHaveBeenCalledOnce()
  })

  it('cancels the native job, rejects with AbortError and unsubscribes', async () => {
    const controller = new AbortController()
    const harness = bridgeHarness(() => queueMicrotask(() => controller.abort()))

    await expect(renderFinalImageInDesktop({
      ...baseOptions(),
      bridge: harness.bridge,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' })

    expect(harness.cancelled).toEqual(['job_1'])
    expect(harness.unsubscribe).toHaveBeenCalledOnce()
  })

  it('does not report cancellation after the native job enters its atomic saving phase', async () => {
    const controller = new AbortController()
    const harness = bridgeHarness((jobId, _snapshot, emit) => {
      queueMicrotask(() => controller.abort())
      setTimeout(() => emit(savedEvent(jobId)), 0)
    })
    harness.bridge.cancelFinalRender = async (jobId) => {
      harness.cancelled.push(jobId)
      return { state: 'saving' }
    }

    await expect(renderFinalImageInDesktop({
      ...baseOptions(),
      bridge: harness.bridge,
      signal: controller.signal,
    })).resolves.toMatchObject({ desktopSaved: true, fileName: 'rasterform-final.png' })
    expect(harness.cancelled).toEqual(['job_1'])
    expect(harness.unsubscribe).toHaveBeenCalledOnce()
  })

  it('treats Save As cancellation as cancellation without submitting a render', async () => {
    const harness = bridgeHarness()
    harness.bridge.prepareFinalSave = async () => ({ cancelled: true })

    await expect(renderFinalImageInDesktop({
      ...baseOptions(),
      bridge: harness.bridge,
    })).rejects.toMatchObject({ name: 'AbortError' })

    expect(harness.submitted).toEqual([])
    expect(harness.unsubscribe).not.toHaveBeenCalled()
  })

  it('cancels a late save reservation when the signal aborts during Save As', async () => {
    const controller = new AbortController()
    const harness = bridgeHarness()
    let resolveSave: (value: { cancelled: false; jobId: string }) => void = () => undefined
    harness.bridge.prepareFinalSave = () => new Promise((resolve) => {
      resolveSave = resolve
    })
    const render = renderFinalImageInDesktop({
      ...baseOptions(),
      bridge: harness.bridge,
      signal: controller.signal,
    })

    controller.abort()
    await expect(render).rejects.toMatchObject({ name: 'AbortError' })
    resolveSave({ cancelled: false, jobId: 'late_job' })
    await Promise.resolve()
    await Promise.resolve()
    expect(harness.cancelled).toEqual(['late_job'])
  })

  it('rejects and cancels a saved result that changes the quality contract', async () => {
    const harness = bridgeHarness((jobId, _snapshot, emit) => {
      queueMicrotask(() => emit(savedEvent(jobId, {
        result: {
          width: 2048,
          height: 1536,
          dpi: 300,
          samples: 1,
          tiles: 4,
          fileName: 'downgraded.png',
        },
      })))
    })

    await expect(renderFinalImageInDesktop({
      ...baseOptions(),
      bridge: harness.bridge,
    })).rejects.toThrow('did not preserve the requested output contract')
    expect(harness.cancelled).toEqual(['job_1'])
    expect(harness.unsubscribe).toHaveBeenCalledOnce()
  })

  it('surfaces typed native errors without leaving a listener attached', async () => {
    const harness = bridgeHarness((jobId, _snapshot, emit) => {
      queueMicrotask(() => emit({
        type: 'error',
        jobId,
        code: 'process-gone',
        message: 'The dedicated renderer exited.',
      }))
    })

    const render = renderFinalImageInDesktop({ ...baseOptions(), bridge: harness.bridge })
    await expect(render).rejects.toEqual(expect.objectContaining<Partial<DesktopFinalRenderError>>({
      name: 'DesktopFinalRenderError',
      code: 'process-gone',
      message: 'The dedicated renderer exited.',
    }))
    expect(harness.unsubscribe).toHaveBeenCalledOnce()
    expect(harness.cancelled).toEqual([])
  })

  it('rejects an unacknowledged submission instead of waiting forever', async () => {
    const harness = bridgeHarness()
    harness.bridge.submitFinalRender = async () => ({
      accepted: false,
      error: {
        code: 'request-expired',
        message: 'The Final save reservation expired.',
      },
    })

    await expect(renderFinalImageInDesktop({
      ...baseOptions(),
      bridge: harness.bridge,
    })).rejects.toEqual(expect.objectContaining<Partial<DesktopFinalRenderError>>({
      code: 'request-expired',
    }))
    expect(harness.unsubscribe).toHaveBeenCalledOnce()
  })

  it('treats a saved cancellation acknowledgement as the successful terminal result', async () => {
    const controller = new AbortController()
    const harness = bridgeHarness(() => queueMicrotask(() => controller.abort()))
    harness.bridge.cancelFinalRender = async (jobId) => {
      harness.cancelled.push(jobId)
      return {
        state: 'saved',
        result: {
          width: 2048,
          height: 1536,
          dpi: 300,
          samples: 6144,
          tiles: 4,
          fileName: 'rasterform-final.png',
        },
      }
    }

    await expect(renderFinalImageInDesktop({
      ...baseOptions(),
      bridge: harness.bridge,
      signal: controller.signal,
    })).resolves.toMatchObject({ desktopSaved: true, samples: 6144 })
  })
})

describe('desktop long-export lifecycle client', () => {
  it('returns null without a desktop bridge so the shared web export stays unchanged', async () => {
    await expect(beginDesktopLongExport({ frames: 96, bridge: null })).resolves.toBeNull()
    await expect(endDesktopLongExport(null, 'completed')).resolves.toBe(false)
  })

  it('starts and ends metadata-only native protection with a versioned request', async () => {
    const harness = bridgeHarness()
    const session = await beginDesktopLongExport({ frames: 96, bridge: harness.bridge })

    expect(session).toEqual({ jobId: 'living_job_1' })
    expect(harness.longStarts).toEqual([{
      protocolVersion: DESKTOP_LONG_EXPORT_PROTOCOL_VERSION,
      kind: 'living-loop',
      frames: 96,
    }])
    await expect(endDesktopLongExport(session, 'completed')).resolves.toBe(true)
    expect(harness.longEnds).toEqual([{ jobId: 'living_job_1', outcome: 'completed' }])
  })

  it('rejects invalid frame counts before native IPC', async () => {
    const harness = bridgeHarness()
    await expect(beginDesktopLongExport({
      frames: 361,
      bridge: harness.bridge,
    })).rejects.toEqual(expect.objectContaining<Partial<DesktopLongExportError>>({
      name: 'DesktopLongExportError',
      code: 'invalid-request',
    }))
    expect(harness.longStarts).toEqual([])
  })

  it('surfaces strict busy/failure acknowledgements and rejects malformed replies', async () => {
    const busy = bridgeHarness()
    busy.bridge.beginLongExport = async () => ({
      accepted: false,
      error: { code: 'busy', message: 'Another export is active.' },
    })
    await expect(beginDesktopLongExport({ frames: 48, bridge: busy.bridge })).rejects.toEqual(
      expect.objectContaining<Partial<DesktopLongExportError>>({ code: 'busy' }),
    )

    const malformed = bridgeHarness()
    malformed.bridge.beginLongExport = async () => ({ accepted: true, jobId: '../bad' })
    await expect(beginDesktopLongExport({ frames: 48, bridge: malformed.bridge })).rejects.toEqual(
      expect.objectContaining<Partial<DesktopLongExportError>>({ code: 'invalid-request' }),
    )
  })

  it('validates native completion acknowledgements', async () => {
    const harness = bridgeHarness()
    const session = await beginDesktopLongExport({ frames: 24, bridge: harness.bridge })
    harness.bridge.endLongExport = async () => ({ ended: true, debug: true }) as never
    await expect(endDesktopLongExport(session, 'failed')).rejects.toEqual(
      expect.objectContaining<Partial<DesktopLongExportError>>({ code: 'invalid-request' }),
    )
  })
})
