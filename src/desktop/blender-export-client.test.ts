import { describe, expect, it, vi } from 'vitest'
import { heightGradientColors } from '../lib/three'
import type { MeshData } from '../types'
import { DESKTOP_LONG_EXPORT_PROTOCOL_VERSION, DESKTOP_PROTOCOL_VERSION } from './contracts'
import { DESKTOP_PRO_RENDER_PROTOCOL_VERSION } from './pro-contracts'
import {
  DESKTOP_BLENDER_EXPORT_PROTOCOL_VERSION,
  type DesktopBlenderExportEvent,
  type DesktopSavedBlenderExportResult,
  type RasterformDesktopBlenderExportBridge,
} from './blender-export-contracts'
import {
  DesktopBlenderExportError,
  createDesktopBlenderExportSnapshot,
  exportBlenderProjectInDesktop,
} from './blender-export-client'

function mesh(): MeshData {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0.5, 1, 1, 0.25]),
    indices: new Uint32Array([0, 2, 1, 1, 2, 3]),
    colors: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0]),
    uvs: new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
    heights: new Float32Array([0, 0.5, 1, 0.25]),
    width: 2,
    height: 2,
    mode: 'solid',
  }
}

const appearance = {
  heightGradient: {
    low: '#21194f',
    mid: '#32bf8a',
    high: '#f2c66d',
    midpoint: 0.5,
  },
  clay: { color: '#d7d0bf', finish: 'matte' as const },
}

function savedResult(overrides: Partial<DesktopSavedBlenderExportResult> = {}) {
  return {
    fileName: 'rasterform-balanced.blend',
    topology: 'balanced' as const,
    sourceVertices: 4,
    sourceFaces: 2,
    outputVertices: 4,
    outputFaces: 1,
    outputTriangleCount: 2,
    quads: 1,
    triangles: 0,
    ngons: 0,
    uvLayerName: 'UVMap',
    uvLoops: 4,
    colorAttributeName: 'RasterformColor',
    blenderVersion: '5.2.0 LTS',
    elapsedSeconds: 2.5,
    ...overrides,
  }
}

function bridgeWith(overrides: Partial<RasterformDesktopBlenderExportBridge> = {}) {
  const bridge: RasterformDesktopBlenderExportBridge = {
    protocolVersion: DESKTOP_PROTOCOL_VERSION,
    longExportProtocolVersion: DESKTOP_LONG_EXPORT_PROTOCOL_VERSION,
    proRenderProtocolVersion: DESKTOP_PRO_RENDER_PROTOCOL_VERSION,
    blenderExportProtocolVersion: DESKTOP_BLENDER_EXPORT_PROTOCOL_VERSION,
    prepareFinalSave: async () => ({ cancelled: true }),
    submitFinalRender: async () => ({ accepted: true }),
    cancelFinalRender: async () => ({ state: 'cancelled' }),
    onFinalRenderEvent: () => () => undefined,
    beginLongExport: async () => ({ accepted: true, jobId: 'loop_job' }),
    endLongExport: async () => ({ ended: true }),
    probeProRenderer: async () => ({
      available: true,
      blenderVersion: '5.2.0 LTS',
      device: 'METAL',
      message: 'Ready.',
    }),
    prepareProSave: async () => ({ cancelled: true }),
    submitProRender: async () => ({ accepted: true }),
    cancelProRender: async () => ({ state: 'cancelled' }),
    onProRenderEvent: () => () => undefined,
    prepareBlenderExport: async () => ({ cancelled: false, jobId: 'blend_job' }),
    submitBlenderExport: async () => ({ accepted: true }),
    cancelBlenderExport: async () => ({ state: 'cancelled' }),
    onBlenderExportEvent: () => () => undefined,
    ...overrides,
  }
  return bridge
}

describe('desktop Blender project export client', () => {
  it('snapshots typed arrays and resolves Height colors without mutating the model', () => {
    const source = mesh()
    const originalColors = source.colors.slice()
    const snapshot = createDesktopBlenderExportSnapshot({
      mesh: source,
      colorMode: 'height',
      appearance,
      topology: 'balanced',
    })

    expect(snapshot.protocolVersion).toBe(1)
    expect(snapshot.mesh).not.toBe(source)
    expect(snapshot.mesh.positions).not.toBe(source.positions)
    expect(snapshot.mesh).not.toHaveProperty('heights')
    expect([...snapshot.mesh.colors]).toEqual([
      ...heightGradientColors(source.heights, appearance.heightGradient),
    ])
    expect([...source.colors]).toEqual([...originalColors])
    source.positions[0] = 99
    expect(snapshot.mesh.positions[0]).toBe(0)
  })

  it('registers before submit, reports phases, verifies source counts, and unsubscribes', async () => {
    let listener: ((event: DesktopBlenderExportEvent) => void) | null = null
    const unsubscribe = vi.fn()
    const phases: string[] = []
    const bridge = bridgeWith({
      onBlenderExportEvent: (next) => {
        listener = next
        return unsubscribe
      },
      submitBlenderExport: async () => {
        listener?.({ type: 'progress', jobId: 'blend_job', phase: 'preparing' })
        listener?.({ type: 'progress', jobId: 'blend_job', phase: 'retopologizing' })
        listener?.({ type: 'progress', jobId: 'blend_job', phase: 'unwrapping' })
        listener?.({ type: 'progress', jobId: 'blend_job', phase: 'saving' })
        listener?.({ type: 'saved', jobId: 'blend_job', result: savedResult() })
        return { accepted: true }
      },
    })

    await expect(exportBlenderProjectInDesktop({
      mesh: mesh(),
      colorMode: 'original',
      appearance,
      topology: 'balanced',
      suggestedName: 'rasterform-balanced.blend',
      bridge,
      onProgress: (phase) => phases.push(phase),
    })).resolves.toMatchObject({
      desktopSaved: true,
      fileName: 'rasterform-balanced.blend',
      outputFaces: 1,
      quads: 1,
    })
    expect(phases).toEqual(['preparing', 'retopologizing', 'unwrapping', 'saving'])
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('cancels only the prepared native job through AbortSignal', async () => {
    let listener: ((event: DesktopBlenderExportEvent) => void) | null = null
    const cancel = vi.fn(async () => {
      queueMicrotask(() => listener?.({ type: 'cancelled', jobId: 'blend_job' }))
      return { state: 'cancelling' as const }
    })
    const controller = new AbortController()
    const bridge = bridgeWith({
      onBlenderExportEvent: (next) => {
        listener = next
        return () => undefined
      },
      cancelBlenderExport: cancel,
    })
    const pending = exportBlenderProjectInDesktop({
      mesh: mesh(),
      colorMode: 'clay',
      appearance,
      topology: 'balanced',
      suggestedName: 'rasterform-balanced.blend',
      bridge,
      signal: controller.signal,
    })
    await Promise.resolve()
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancel).toHaveBeenCalledExactlyOnceWith('blend_job')
  })

  it('polls the exact native job when a cancellation event is missed', async () => {
    vi.useFakeTimers()
    try {
      let markSubmitted: (() => void) | null = null
      const submitted = new Promise<void>((resolve) => { markSubmitted = resolve })
      const cancel = vi.fn()
        .mockResolvedValueOnce({ state: 'cancelling' as const })
        .mockResolvedValueOnce({ state: 'cancelled' as const })
      const controller = new AbortController()
      const pending = exportBlenderProjectInDesktop({
        mesh: mesh(),
        colorMode: 'original',
        appearance,
        topology: 'balanced',
        suggestedName: 'rasterform-balanced.blend',
        bridge: bridgeWith({
          submitBlenderExport: async () => {
            markSubmitted?.()
            return { accepted: true }
          },
          cancelBlenderExport: cancel,
          onBlenderExportEvent: () => () => undefined,
        }),
        signal: controller.signal,
      })
      const outcome = pending.catch((error: unknown) => error)
      await submitted
      controller.abort()
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(1_500)
      await expect(outcome).resolves.toMatchObject({ name: 'AbortError' })
      expect(cancel).toHaveBeenCalledTimes(2)
      expect(cancel).toHaveBeenNthCalledWith(1, 'blend_job')
      expect(cancel).toHaveBeenNthCalledWith(2, 'blend_job')
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects cancelled saves, invalid names, and result contracts changed by native code', async () => {
    const prepareMesh = vi.fn(() => ({ mesh: mesh(), ownedMeshSnapshot: true }))
    await expect(exportBlenderProjectInDesktop({
      mesh: mesh(),
      colorMode: 'clay',
      appearance,
      topology: 'exact',
      suggestedName: '../bad.blend',
      bridge: bridgeWith(),
    })).rejects.toBeInstanceOf(DesktopBlenderExportError)

    await expect(exportBlenderProjectInDesktop({
      mesh: mesh(),
      colorMode: 'clay',
      appearance,
      topology: 'exact',
      suggestedName: 'rasterform-exact.blend',
      bridge: bridgeWith({ prepareBlenderExport: async () => ({ cancelled: true }) }),
      prepareMesh,
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(prepareMesh).not.toHaveBeenCalled()

    let listener: ((event: DesktopBlenderExportEvent) => void) | null = null
    const changed = savedResult({
      sourceVertices: 100,
      sourceFaces: 180,
      outputVertices: 48,
      outputFaces: 42,
      outputTriangleCount: 82,
      quads: 40,
      triangles: 2,
      uvLoops: 166,
    })
    const bridge = bridgeWith({
      onBlenderExportEvent: (next) => {
        listener = next
        return () => undefined
      },
      submitBlenderExport: async () => {
        listener?.({ type: 'saved', jobId: 'blend_job', result: changed })
        return { accepted: true }
      },
    })
    await expect(exportBlenderProjectInDesktop({
      mesh: mesh(),
      colorMode: 'original',
      appearance,
      topology: 'balanced',
      suggestedName: 'rasterform-balanced.blend',
      bridge,
    })).rejects.toMatchObject({
      name: 'DesktopBlenderExportError',
      message: expect.stringContaining('changed the requested'),
    })
  })
})
