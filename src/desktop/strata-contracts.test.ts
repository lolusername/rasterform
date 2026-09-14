import { describe, expect, it } from 'vitest'
import { PerspectiveCamera } from 'three'
import { buildStrataMesh, isStrataData } from '../lib/strata'
import { createDefaultAppearanceSettings } from '../lib/three'
import { finalSampleTarget } from '../lib/final-quality'
import { createDesktopFinalRenderSnapshot } from './client'
import { isDesktopFinalRenderSnapshot } from './contracts'
import { createDesktopProRenderSnapshot } from './pro-client'
import { DEFAULT_DESKTOP_PRO_RENDER_SETTINGS, isDesktopProRenderSnapshot } from './pro-contracts'
import { createDesktopBlenderExportSnapshot } from './blender-export-client'
import { isDesktopBlenderExportSnapshot } from './blender-export-contracts'

function fixture() {
  const field = { width: 2, height: 2, values: new Float32Array([0, 0.4, 0.7, 1]) }
  const image = { width: 2, height: 2, sourceWidth: 2, sourceHeight: 2, name: 'fixture', data: new Uint8ClampedArray(16).fill(180) }
  const mesh = buildStrataMesh(field, image, 16, { layers: 5 })
  return { mesh, camera: new PerspectiveCamera(38, 4 / 3, 0.01, 100), colorMode: 'clay' as const,
    appearance: createDefaultAppearanceSettings(), width: 4096, height: 3072,
    background: 'transparent' as const, studioBackground: 'dark-gray' as const }
}

describe('Strata desktop boundaries', () => {
  it('keeps full Final and Pro quality contracts while carrying immutable contour metadata', () => {
    const options = fixture()
    options.appearance.clay.finish = 'metallic'
    const final = createDesktopFinalRenderSnapshot(options)
    expect(isDesktopFinalRenderSnapshot(final)).toBe(true)
    expect(finalSampleTarget(final.colorMode, final.appearance)).toBe(8192)
    expect(final.mesh.strata).toEqual(options.mesh.strata)
    expect(final.mesh.strata!.parts).not.toBe(options.mesh.strata!.parts)
    const pro = createDesktopProRenderSnapshot({ ...options, settings: DEFAULT_DESKTOP_PRO_RENDER_SETTINGS })
    expect(isDesktopProRenderSnapshot(pro)).toBe(true)
    expect(pro.settings).toEqual({ maxSamples: 8192, minSamples: 512, noiseThreshold: 0.001, maxBounces: 12, denoise: true })
    expect(pro.width).toBe(4096)
  })

  it('passes layer metadata to Blender and rejects missing or cross-object boundaries on every route', () => {
    const options = fixture()
    const final = createDesktopFinalRenderSnapshot(options)
    const blend = createDesktopBlenderExportSnapshot({ ...options, topology: 'exact' })
    expect(isDesktopBlenderExportSnapshot(blend)).toBe(true)
    expect(blend.mesh.strata!.parts).not.toBe(options.mesh.strata!.parts)
    blend.mesh.strata!.parts[1]!.vertexStart = 0
    expect(isDesktopBlenderExportSnapshot(blend)).toBe(false)
    expect(isDesktopFinalRenderSnapshot({ ...final, mesh: { ...final.mesh, strata: undefined } })).toBe(false)
    expect(isDesktopFinalRenderSnapshot({ ...final, mesh: { ...final.mesh, mode: 'solid' } })).toBe(false)
  })

  it('admits the maximum UI detail and 24 layers without lowering geometry resolution', () => {
    const size = 181
    const field = { width: size, height: size, values: Float32Array.from({ length: size * size }, (_, index) =>
      ((index % size) + Math.floor(index / size)) % 2) }
    const image = { width: 2, height: 2, sourceWidth: 2, sourceHeight: 2, name: 'dense-fixture', data: new Uint8ClampedArray(16).fill(180) }
    const mesh = buildStrataMesh(field, image, 180, { layers: 24 })
    expect(mesh.positions.length / 3).toBeLessThanOrEqual(4_000_000)
    expect(mesh.indices.length).toBeLessThanOrEqual(24_000_000)
    expect(mesh.positions.byteLength + mesh.colors.byteLength + mesh.uvs.byteLength + mesh.heights.byteLength + mesh.indices.byteLength).toBeLessThanOrEqual(256 * 1024 * 1024)
    expect(isStrataData(mesh.strata, mesh.positions.length / 3, mesh.indices)).toBe(true)
    expect(mesh.uvs.find((value) => !Number.isFinite(value) || value < 0 || value > 1)).toBeUndefined()
    expect(mesh.colors.find((value) => !Number.isFinite(value) || value < 0 || value > 1)).toBeUndefined()
    const snapshot = createDesktopFinalRenderSnapshot({ ...fixture(), mesh })
    expect(mesh.width).toBe(180)
    expect(mesh.height).toBe(180)
    expect(mesh.strata!.parts).toHaveLength(24)
    expect(isDesktopFinalRenderSnapshot(snapshot)).toBe(true)
  }, 30_000)
})
