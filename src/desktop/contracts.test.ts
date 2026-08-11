import { describe, expect, it } from 'vitest'
import type { DesktopFinalRenderSnapshot, DesktopRenderEvent } from './contracts'
import {
  DESKTOP_PROTOCOL_VERSION,
  DESKTOP_MAX_IMAGE_EDGE,
  DESKTOP_MAX_MESH_BYTES,
  DESKTOP_MAX_PNG_BYTES,
  assertDesktopFinalRenderSnapshot,
  isDesktopFinalCancelResult,
  isDesktopFinalRenderSnapshot,
  isDesktopFinalRenderResultMetadata,
  isDesktopFinalRenderSubmission,
  isDesktopJobId,
  isDesktopPngName,
  isDesktopRenderEvent,
  isFinalExportProgress,
} from './contracts'

function validSnapshot(): DesktopFinalRenderSnapshot {
  return {
    protocolVersion: DESKTOP_PROTOCOL_VERSION,
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
      clay: { color: '#d7d0bf', finish: 'matte' },
    },
    width: 2048,
    height: 1536,
    background: 'transparent',
    studioBackground: 'dark-gray',
  }
}

function validProgress() {
  return {
    phase: 'rendering' as const,
    progress: 0.5,
    tile: 1,
    tiles: 2,
    samples: 768,
    targetSamples: 1536,
  }
}

describe('desktop Final IPC contracts', () => {
  it('accepts the exact protocol-v1 snapshot without a caller-controlled sample field', () => {
    const snapshot = validSnapshot()

    expect(isDesktopFinalRenderSnapshot(snapshot)).toBe(true)
    expect('samples' in snapshot).toBe(false)
    expect(() => assertDesktopFinalRenderSnapshot(snapshot)).not.toThrow()
    expect(isDesktopFinalRenderSnapshot({ ...snapshot, samples: 1 })).toBe(false)
    expect(isDesktopFinalRenderSnapshot({ ...snapshot, protocolVersion: 2 })).toBe(false)
    expect(isDesktopFinalRenderSnapshot({ ...snapshot, colorMode: 'wireframe' })).toBe(false)
  })

  it('rejects malformed geometry, camera, appearance and output dimensions', () => {
    const snapshot = validSnapshot()

    expect(isDesktopFinalRenderSnapshot({
      ...snapshot,
      mesh: { ...snapshot.mesh, positions: new Float32Array([0, Number.NaN, 0]) },
    })).toBe(false)
    expect(isDesktopFinalRenderSnapshot({
      ...snapshot,
      mesh: { ...snapshot.mesh, indices: new Uint32Array([0, 1, 99]) },
    })).toBe(false)
    expect(isDesktopFinalRenderSnapshot({
      ...snapshot,
      camera: { ...snapshot.camera, far: snapshot.camera.near },
    })).toBe(false)
    expect(isDesktopFinalRenderSnapshot({
      ...snapshot,
      appearance: {
        ...snapshot.appearance,
        clay: { ...snapshot.appearance.clay, color: 'red' },
      },
    })).toBe(false)
    expect(DESKTOP_MAX_IMAGE_EDGE).toBe(4096)
    expect(DESKTOP_MAX_MESH_BYTES).toBe(256 * 1024 * 1024)
    expect(DESKTOP_MAX_PNG_BYTES).toBe(128 * 1024 * 1024)
    expect(isDesktopFinalRenderSnapshot({ ...snapshot, width: 4097 })).toBe(false)
    const offsetPositions = new Float32Array(new ArrayBuffer(40), 4, 9)
    expect(isDesktopFinalRenderSnapshot({
      ...snapshot,
      mesh: { ...snapshot.mesh, positions: offsetPositions },
    })).toBe(false)
  })

  it('rejects an oversized Final edge before touching mesh buffers', () => {
    const snapshot = validSnapshot() as DesktopFinalRenderSnapshot & { mesh: unknown }
    const candidate = { ...snapshot, width: DESKTOP_MAX_IMAGE_EDGE + 1 }
    Object.defineProperty(candidate, 'mesh', {
      enumerable: true,
      get: () => { throw new Error('mesh scan should not run') },
    })

    expect(() => isDesktopFinalRenderSnapshot(candidate)).not.toThrow()
    expect(isDesktopFinalRenderSnapshot(candidate)).toBe(false)
  })

  it('validates opaque job IDs and PNG basenames without permitting paths', () => {
    expect(isDesktopJobId('5df5d766-e9d4-42fc-a4dd-76315fa5c938')).toBe(true)
    expect(isDesktopJobId('render_42')).toBe(true)
    expect(isDesktopJobId('../render')).toBe(false)
    expect(isDesktopJobId('render job')).toBe(false)

    expect(isDesktopPngName('Rasterform Final 2K.png')).toBe(true)
    expect(isDesktopPngName('形-final.png')).toBe(true)
    expect(isDesktopPngName('../final.png')).toBe(false)
    expect(isDesktopPngName('folder/final.png')).toBe(false)
    expect(isDesktopPngName('final.jpg')).toBe(false)
    expect(isDesktopPngName(' final.png')).toBe(false)
  })

  it('requires bounded, internally consistent progress records', () => {
    expect(isFinalExportProgress(validProgress())).toBe(true)
    expect(isFinalExportProgress({ ...validProgress(), progress: 1.01 })).toBe(false)
    expect(isFinalExportProgress({ ...validProgress(), tile: 3 })).toBe(false)
    expect(isFinalExportProgress({ ...validProgress(), samples: 1537 })).toBe(false)
    expect(isFinalExportProgress({ ...validProgress(), phase: 'finishing', progress: 0.9 })).toBe(false)
    expect(isFinalExportProgress({ ...validProgress(), debug: true })).toBe(false)
  })

  it('validates every render event variant and rejects extra or malformed fields', () => {
    const jobId = 'render_42'
    const savedResult = {
      width: 2048,
      height: 1536,
      dpi: 300,
      samples: 1536,
      tiles: 4,
      fileName: 'rasterform-final.png',
    }
    const events: DesktopRenderEvent[] = [
      { type: 'progress', jobId, progress: validProgress() },
      { type: 'saved', jobId, result: savedResult },
      { type: 'cancelled', jobId },
      { type: 'error', jobId, code: 'process-gone', message: 'Renderer exited.' },
    ]

    for (const event of events) expect(isDesktopRenderEvent(event)).toBe(true)
    expect(isDesktopRenderEvent({ ...events[2], unexpected: true })).toBe(false)
    expect(isDesktopRenderEvent({
      type: 'error',
      jobId,
      code: 'arbitrary-code',
      message: 'No.',
    })).toBe(false)
    expect(isDesktopRenderEvent({
      type: 'saved',
      jobId,
      result: { ...savedResult, fileName: '/tmp/final.png' },
    })).toBe(false)
  })

  it('validates acknowledged submission and cancellation terminal states', () => {
    const error = { code: 'request-expired' as const, message: 'Reservation expired.' }
    const saved = {
      width: 2048,
      height: 1536,
      dpi: 300,
      samples: 1536,
      tiles: 4,
      fileName: 'rasterform-final.png',
    }

    expect(isDesktopFinalRenderSubmission({ accepted: true })).toBe(true)
    expect(isDesktopFinalRenderSubmission({ accepted: false, error })).toBe(true)
    expect(isDesktopFinalRenderSubmission(undefined)).toBe(false)
    expect(isDesktopFinalCancelResult({ state: 'cancelling' })).toBe(true)
    expect(isDesktopFinalCancelResult({ state: 'saving' })).toBe(true)
    expect(isDesktopFinalCancelResult({ state: 'cancelled' })).toBe(true)
    expect(isDesktopFinalCancelResult({ state: 'saved', result: saved })).toBe(true)
    expect(isDesktopFinalCancelResult({ state: 'error', error })).toBe(true)
    expect(isDesktopFinalCancelResult({ state: 'saved', result: { ...saved, fileName: '/tmp/final.png' } })).toBe(false)
  })

  it('requires exact, bounded hidden-renderer result metadata', () => {
    const metadata = {
      width: 2048,
      height: 1536,
      dpi: 300,
      samples: 1536,
      tiles: 4,
    }

    expect(isDesktopFinalRenderResultMetadata(metadata)).toBe(true)
    expect(isDesktopFinalRenderResultMetadata({ ...metadata, debug: true })).toBe(false)
    expect(isDesktopFinalRenderResultMetadata({ ...metadata, width: 0 })).toBe(false)
    expect(isDesktopFinalRenderResultMetadata({ ...metadata, samples: -1 })).toBe(false)
    expect(isDesktopFinalRenderResultMetadata({ ...metadata, tiles: 1.5 })).toBe(false)
  })
})
