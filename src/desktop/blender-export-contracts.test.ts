import { describe, expect, it } from 'vitest'
import { DESKTOP_LONG_EXPORT_PROTOCOL_VERSION, DESKTOP_PROTOCOL_VERSION } from './contracts'
import { DESKTOP_PRO_RENDER_PROTOCOL_VERSION } from './pro-contracts'
import {
  DESKTOP_BLENDER_EXPORT_PROTOCOL_VERSION,
  assertDesktopBlenderExportSnapshot,
  isDesktopBlendName,
  isDesktopBlenderExportCancelResult,
  isDesktopBlenderExportEvent,
  isDesktopBlenderExportSettings,
  isDesktopBlenderExportSnapshot,
  isDesktopBlenderExportSubmission,
  isDesktopSavedBlenderExportResult,
  isRasterformDesktopBlenderExportBridge,
  type DesktopBlenderExportSnapshot,
  type DesktopSavedBlenderExportResult,
  type RasterformDesktopBlenderExportBridge,
} from './blender-export-contracts'

function validSnapshot(): DesktopBlenderExportSnapshot {
  return {
    protocolVersion: DESKTOP_BLENDER_EXPORT_PROTOCOL_VERSION,
    mesh: {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0.5]),
      indices: new Uint32Array([0, 1, 2]),
      colors: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
      uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
      width: 2,
      height: 2,
      mode: 'solid',
    },
    colorMode: 'height',
    appearance: {
      heightGradient: {
        low: '#21194f',
        mid: '#32bf8a',
        high: '#f2c66d',
        midpoint: 0.5,
      },
      clay: { color: '#d7d0bf', finish: 'matte' },
    },
    settings: { topology: 'balanced' },
  }
}

function validSavedResult(
  topology: 'exact' | 'balanced' | 'lightweight' = 'balanced',
): DesktopSavedBlenderExportResult {
  return topology === 'exact'
    ? {
        fileName: 'rasterform-exact.blend',
        topology,
        sourceVertices: 100,
        sourceFaces: 180,
        outputVertices: 100,
        outputFaces: 180,
        outputTriangleCount: 180,
        quads: 0,
        triangles: 180,
        ngons: 0,
        uvLayerName: 'UVMap',
        uvLoops: 540,
        colorAttributeName: 'RasterformColor',
        blenderVersion: '5.2.0 LTS',
        elapsedSeconds: 1.25,
      }
    : {
        fileName: `rasterform-${topology}.blend`,
        topology,
        sourceVertices: 100,
        sourceFaces: 180,
        outputVertices: 48,
        outputFaces: 42,
        outputTriangleCount: 82,
        quads: 40,
        triangles: 2,
        ngons: 0,
        uvLayerName: 'UVMap',
        uvLoops: 166,
        colorAttributeName: 'RasterformColor',
        blenderVersion: '5.2.0 LTS',
        elapsedSeconds: 3.5,
      }
}

function validBridge(): RasterformDesktopBlenderExportBridge {
  return {
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
    prepareBlenderExport: async () => ({ cancelled: true }),
    submitBlenderExport: async () => ({ accepted: true }),
    cancelBlenderExport: async () => ({ state: 'cancelled' }),
    onBlenderExportEvent: () => () => undefined,
  }
}

describe('desktop Blender project export contracts', () => {
  it('pins an independent protocol and three explicit topology choices', () => {
    expect(DESKTOP_BLENDER_EXPORT_PROTOCOL_VERSION).toBe(1)
    expect(isDesktopBlenderExportSettings({ topology: 'exact' })).toBe(true)
    expect(isDesktopBlenderExportSettings({ topology: 'balanced' })).toBe(true)
    expect(isDesktopBlenderExportSettings({ topology: 'lightweight' })).toBe(true)
    expect(isDesktopBlenderExportSettings({ topology: 'automatic' })).toBe(false)
    expect(isDesktopBlenderExportSettings({ topology: 'balanced', ratio: 0.5 })).toBe(false)
  })

  it('strictly validates geometry, appearance, topology, and excludes wireframe', () => {
    const snapshot = validSnapshot()
    expect(isDesktopBlenderExportSnapshot(snapshot)).toBe(true)
    expect(() => assertDesktopBlenderExportSnapshot(snapshot)).not.toThrow()
    expect(isDesktopBlenderExportSnapshot({ ...snapshot, debug: true })).toBe(false)
    expect(isDesktopBlenderExportSnapshot({ ...snapshot, protocolVersion: 2 })).toBe(false)
    expect(isDesktopBlenderExportSnapshot({ ...snapshot, colorMode: 'wireframe' })).toBe(false)
    expect(isDesktopBlenderExportSnapshot({
      ...snapshot,
      mesh: { ...snapshot.mesh, indices: new Uint32Array([0, 1, 99]) },
    })).toBe(false)
    expect(isDesktopBlenderExportSnapshot({
      ...snapshot,
      mesh: { ...snapshot.mesh, heights: new Float32Array([0, 0.5, 1]) },
    })).toBe(false)
    expect(isDesktopBlenderExportSnapshot({
      ...snapshot,
      appearance: { ...snapshot.appearance, clay: { color: 'red', finish: 'matte' } },
    })).toBe(false)
  })

  it('accepts only safe .blend basenames', () => {
    expect(isDesktopBlendName('Rasterform Balanced.blend')).toBe(true)
    expect(isDesktopBlendName('形.blend')).toBe(true)
    expect(isDesktopBlendName('../scene.blend')).toBe(false)
    expect(isDesktopBlendName('/tmp/scene.blend')).toBe(false)
    expect(isDesktopBlendName('scene.blend1')).toBe(false)
    expect(isDesktopBlendName(' scene.blend')).toBe(false)
  })

  it('enforces coherent exact and quad-dominant optimized results', () => {
    const exact = validSavedResult('exact')
    const balanced = validSavedResult('balanced')
    expect(isDesktopSavedBlenderExportResult(exact)).toBe(true)
    expect(isDesktopSavedBlenderExportResult(balanced)).toBe(true)
    expect(isDesktopSavedBlenderExportResult({ ...exact, outputFaces: 179 })).toBe(false)
    expect(isDesktopSavedBlenderExportResult({ ...balanced, outputFaces: 180 })).toBe(false)
    expect(isDesktopSavedBlenderExportResult({ ...balanced, quads: 20, triangles: 22 })).toBe(false)
    expect(isDesktopSavedBlenderExportResult({ ...balanced, uvLoops: Number.NaN })).toBe(false)
    expect(isDesktopSavedBlenderExportResult({ ...balanced, fileName: '../bad.blend' })).toBe(false)
  })

  it('strictly validates acknowledgement, cancellation, and events', () => {
    const saved = validSavedResult()
    const failure = { code: 'render-failed' as const, message: 'Blender stopped.' }
    expect(isDesktopBlenderExportSubmission({ accepted: true })).toBe(true)
    expect(isDesktopBlenderExportSubmission({ accepted: false, error: failure })).toBe(true)
    expect(isDesktopBlenderExportSubmission({ accepted: true, debug: true })).toBe(false)
    expect(isDesktopBlenderExportCancelResult({ state: 'cancelling' })).toBe(true)
    expect(isDesktopBlenderExportCancelResult({ state: 'saving' })).toBe(true)
    expect(isDesktopBlenderExportCancelResult({ state: 'saved', result: saved })).toBe(true)
    expect(isDesktopBlenderExportCancelResult({ state: 'error', error: failure })).toBe(true)
    expect(isDesktopBlenderExportEvent({
      type: 'progress', jobId: 'blend_job', phase: 'retopologizing',
    })).toBe(true)
    expect(isDesktopBlenderExportEvent({ type: 'saved', jobId: 'blend_job', result: saved })).toBe(true)
    expect(isDesktopBlenderExportEvent({ type: 'cancelled', jobId: 'blend_job' })).toBe(true)
    expect(isDesktopBlenderExportEvent({ type: 'error', jobId: 'blend_job', ...failure })).toBe(true)
    expect(isDesktopBlenderExportEvent({
      type: 'progress', jobId: 'blend_job', phase: 'halfway',
    })).toBe(false)
  })

  it('detects the exporter only as the complete Blender bridge extension', () => {
    const bridge = validBridge()
    expect(isRasterformDesktopBlenderExportBridge(bridge)).toBe(true)
    expect(isRasterformDesktopBlenderExportBridge({
      ...bridge,
      blenderExportProtocolVersion: 2,
    })).toBe(false)
    expect(isRasterformDesktopBlenderExportBridge({
      ...bridge,
      submitBlenderExport: undefined,
    })).toBe(false)
  })
})
