import { describe, expect, it } from 'vitest'
import {
  DESKTOP_LONG_EXPORT_PROTOCOL_VERSION,
  DESKTOP_PROTOCOL_VERSION,
  type RasterformDesktopLongExportBridge,
} from './contracts'
import {
  DEFAULT_DESKTOP_PRO_RENDER_SETTINGS,
  DESKTOP_PRO_RENDER_PROTOCOL_VERSION,
  assertDesktopProRenderSnapshot,
  isDesktopProCancelResult,
  isDesktopProRendererAvailability,
  isDesktopProRenderEvent,
  isDesktopProRenderSettings,
  isDesktopProRenderSnapshot,
  isDesktopProRenderSubmission,
  isDesktopSavedProResult,
  isRasterformDesktopProBridge,
  type DesktopProRenderSnapshot,
  type DesktopSavedProResult,
  type RasterformDesktopProBridge,
} from './pro-contracts'

function validSnapshot(): DesktopProRenderSnapshot {
  return {
    protocolVersion: DESKTOP_PRO_RENDER_PROTOCOL_VERSION,
    mesh: {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0.5]),
      indices: new Uint32Array([0, 1, 2]),
      colors: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
      uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
      heights: new Float32Array([0, 0.5, 1]),
      width: 2,
      height: 2,
      mode: 'solid',
    },
    camera: {
      fov: 38,
      near: 0.01,
      far: 100,
      zoom: 1,
      filmGauge: 35,
      filmOffset: 0,
      position: [0, 0, 4],
      quaternion: [0, 0, 0, 1],
      up: [0, 1, 0],
    },
    colorMode: 'clay',
    appearance: {
      heightGradient: {
        low: '#21194f',
        mid: '#32bf8a',
        high: '#f2c66d',
        midpoint: 0.5,
      },
      clay: { color: '#d7d0bf', finish: 'glossy' },
    },
    width: 2048,
    height: 1536,
    background: 'transparent',
    studioBackground: 'dark-gray',
    settings: { ...DEFAULT_DESKTOP_PRO_RENDER_SETTINGS },
  }
}

function validSavedResult(): DesktopSavedProResult {
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
  }
}

function validLongBridge(): RasterformDesktopLongExportBridge {
  return {
    protocolVersion: DESKTOP_PROTOCOL_VERSION,
    longExportProtocolVersion: DESKTOP_LONG_EXPORT_PROTOCOL_VERSION,
    prepareFinalSave: async () => ({ cancelled: true }),
    submitFinalRender: async () => ({ accepted: true }),
    cancelFinalRender: async () => ({ state: 'cancelled' }),
    onFinalRenderEvent: () => () => undefined,
    beginLongExport: async () => ({ accepted: true, jobId: 'living_job_1' }),
    endLongExport: async () => ({ ended: true }),
  }
}

function validProBridge(): RasterformDesktopProBridge {
  return {
    ...validLongBridge(),
    proRenderProtocolVersion: DESKTOP_PRO_RENDER_PROTOCOL_VERSION,
    probeProRenderer: async () => ({
      available: true,
      blenderVersion: '5.2.0 LTS',
      device: 'METAL',
      message: 'Cycles is ready.',
    }),
    prepareProSave: async () => ({ cancelled: true }),
    submitProRender: async () => ({ accepted: true }),
    cancelProRender: async () => ({ state: 'cancelled' }),
    onProRenderEvent: () => () => undefined,
  }
}

describe('desktop Cycles Pro IPC contracts', () => {
  it('pins the production preset to 8192/512/0.001/12 with OpenImageDenoise enabled', () => {
    expect(DESKTOP_PRO_RENDER_PROTOCOL_VERSION).toBe(1)
    expect(DEFAULT_DESKTOP_PRO_RENDER_SETTINGS).toEqual({
      maxSamples: 8192,
      minSamples: 512,
      noiseThreshold: 0.001,
      maxBounces: 12,
      denoise: true,
    })
    expect(Object.isFrozen(DEFAULT_DESKTOP_PRO_RENDER_SETTINGS)).toBe(true)
    expect(isDesktopProRenderSettings(DEFAULT_DESKTOP_PRO_RENDER_SETTINGS)).toBe(true)
  })

  it('strictly validates settings and their cross-field sample bounds', () => {
    const settings = { ...DEFAULT_DESKTOP_PRO_RENDER_SETTINGS }

    expect(isDesktopProRenderSettings({ ...settings, debug: true })).toBe(false)
    expect(isDesktopProRenderSettings({ ...settings, maxSamples: 8193 })).toBe(false)
    expect(isDesktopProRenderSettings({ ...settings, minSamples: 8193 })).toBe(false)
    expect(isDesktopProRenderSettings({ ...settings, minSamples: 511.5 })).toBe(false)
    expect(isDesktopProRenderSettings({ ...settings, noiseThreshold: 0.0009 })).toBe(false)
    expect(isDesktopProRenderSettings({ ...settings, maxBounces: 17 })).toBe(false)
    expect(isDesktopProRenderSettings({ ...settings, denoise: 'OIDN' })).toBe(false)
  })

  it('accepts only an exact Pro snapshot with valid Final geometry and appearance', () => {
    const snapshot = validSnapshot()

    expect(isDesktopProRenderSnapshot(snapshot)).toBe(true)
    expect(() => assertDesktopProRenderSnapshot(snapshot)).not.toThrow()
    expect(() => assertDesktopProRenderSnapshot({ ...snapshot, protocolVersion: 2 })).toThrow(TypeError)
    expect(isDesktopProRenderSnapshot({ ...snapshot, debug: true })).toBe(false)
    expect(isDesktopProRenderSnapshot({ ...snapshot, colorMode: 'wireframe' })).toBe(false)
    expect(isDesktopProRenderSnapshot({ ...snapshot, width: 4097 })).toBe(false)
    expect(isDesktopProRenderSnapshot({
      ...snapshot,
      mesh: { ...snapshot.mesh, positions: new Float32Array([0, Number.NaN, 0]) },
    })).toBe(false)
    expect(isDesktopProRenderSnapshot({
      ...snapshot,
      appearance: {
        ...snapshot.appearance,
        clay: { ...snapshot.appearance.clay, color: 'red' },
      },
    })).toBe(false)
  })

  it('strictly validates renderer probes and bounded renderer metadata', () => {
    const ready = {
      available: true,
      blenderVersion: '5.2.0 LTS',
      device: 'METAL',
      message: 'Cycles is ready.',
    }
    const unavailable = {
      available: false,
      blenderVersion: null,
      device: null,
      message: 'Install Blender 5.2 LTS.',
    }

    expect(isDesktopProRendererAvailability(ready)).toBe(true)
    expect(isDesktopProRendererAvailability(unavailable)).toBe(true)
    expect(isDesktopProRendererAvailability({ ...ready, debug: true })).toBe(false)
    expect(isDesktopProRendererAvailability({ ...ready, device: 'CUDA' })).toBe(false)
    expect(isDesktopProRendererAvailability({ ...ready, blenderVersion: '' })).toBe(false)
    expect(isDesktopProRendererAvailability({ ...ready, message: 'x'.repeat(2001) })).toBe(false)
  })

  it('accepts exact saved PNG + EXR metadata and rejects paths or unbounded values', () => {
    const saved = validSavedResult()

    expect(isDesktopSavedProResult(saved)).toBe(true)
    expect(isDesktopSavedProResult({ ...saved, debug: true })).toBe(false)
    expect(isDesktopSavedProResult({ ...saved, width: 4097 })).toBe(false)
    expect(isDesktopSavedProResult({ ...saved, maxSamples: 8193 })).toBe(false)
    expect(isDesktopSavedProResult({ ...saved, pngFileName: '../render.png' })).toBe(false)
    expect(isDesktopSavedProResult({ ...saved, exrFileName: '/tmp/render.exr' })).toBe(false)
    expect(isDesktopSavedProResult({ ...saved, blenderVersion: '' })).toBe(false)
    expect(isDesktopSavedProResult({ ...saved, device: 'CUDA' })).toBe(false)
    expect(isDesktopSavedProResult({ ...saved, elapsedSeconds: Number.NaN })).toBe(false)
  })

  it('strictly validates submission, cancellation, and every event variant', () => {
    const saved = validSavedResult()
    const failure = { code: 'process-gone' as const, message: 'Blender exited.' }
    const progress = {
      phase: 'rendering' as const,
      progress: 0.5,
      tile: 0,
      tiles: 1,
      samples: 4096,
      targetSamples: 8192,
    }

    expect(isDesktopProRenderSubmission({ accepted: true })).toBe(true)
    expect(isDesktopProRenderSubmission({ accepted: false, error: failure })).toBe(true)
    expect(isDesktopProRenderSubmission({ accepted: true, debug: true })).toBe(false)
    expect(isDesktopProRenderSubmission({ accepted: false, error: { code: 'busy', message: 'No.' } })).toBe(false)

    expect(isDesktopProCancelResult({ state: 'cancelling' })).toBe(true)
    expect(isDesktopProCancelResult({ state: 'saving' })).toBe(true)
    expect(isDesktopProCancelResult({ state: 'cancelled' })).toBe(true)
    expect(isDesktopProCancelResult({ state: 'saved', result: saved })).toBe(true)
    expect(isDesktopProCancelResult({ state: 'error', error: failure })).toBe(true)
    expect(isDesktopProCancelResult({ state: 'cancelled', debug: true })).toBe(false)

    expect(isDesktopProRenderEvent({ type: 'progress', jobId: 'pro_job_1', progress })).toBe(true)
    expect(isDesktopProRenderEvent({ type: 'saved', jobId: 'pro_job_1', result: saved })).toBe(true)
    expect(isDesktopProRenderEvent({ type: 'cancelled', jobId: 'pro_job_1' })).toBe(true)
    expect(isDesktopProRenderEvent({ type: 'error', jobId: 'pro_job_1', ...failure })).toBe(true)
    expect(isDesktopProRenderEvent({ type: 'cancelled', jobId: '../bad' })).toBe(false)
    expect(isDesktopProRenderEvent({ type: 'progress', jobId: 'pro_job_1', progress: { ...progress, samples: 8193 } })).toBe(false)
    expect(isDesktopProRenderEvent({ type: 'saved', jobId: 'pro_job_1', result: { ...saved, pngFileName: 'render.jpg' } })).toBe(false)
    expect(isDesktopProRenderEvent({ type: 'error', jobId: 'pro_job_1', code: 'busy', message: 'No.' })).toBe(false)
  })

  it('detects Pro only as an independently versioned extension of the long-export bridge', () => {
    const proBridge = validProBridge()

    expect(isRasterformDesktopProBridge(proBridge)).toBe(true)
    expect(isRasterformDesktopProBridge(validLongBridge())).toBe(false)
    expect(isRasterformDesktopProBridge({
      ...proBridge,
      proRenderProtocolVersion: 2,
    })).toBe(false)
    expect(isRasterformDesktopProBridge({
      ...proBridge,
      onProRenderEvent: undefined,
    })).toBe(false)
  })
})
