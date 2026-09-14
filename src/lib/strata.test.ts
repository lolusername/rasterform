import { describe, expect, it } from 'vitest'
import { MeshStandardMaterial } from 'three'
import { buildMesh } from './mesh'
import { buildStrataMesh, DEFAULT_STRATA_SETTINGS, isStrataData, spaceStrataMesh, splitStrataMesh } from './strata'
import { inspectTopology } from './topology'
import { animateLivingFormMesh } from './living-form'
import { snapshotMesh } from './image-export-worker'
import { createThreeMesh } from './three'
import type { PixelImage, ScalarField } from '../types'

export function strataFixture(kind: 'hill' | 'ring' | 'islands' | 'flat' | 'noise' = 'hill', size = 17) {
  const values = new Float32Array(size * size)
  const data = new Uint8ClampedArray(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / (size - 1), v = y / (size - 1)
      const radius = Math.hypot(u - 0.5, v - 0.5)
      values[y * size + x] = kind === 'flat' ? 0.4
        : kind === 'ring' ? Math.max(0, 1 - Math.abs(radius - 0.3) * 8)
          : kind === 'islands' ? Math.max(0, 1 - Math.min(Math.hypot(u - 0.2, v - 0.2), Math.hypot(u - 0.8, v - 0.8)) * 5)
            : kind === 'noise' ? ((x * 137 + y * 773) % 997) / 997
              : Math.max(0, 1 - radius * 2)
      data.set([u * 255, v * 255, 128, 255], (y * size + x) * 4)
    }
  }
  const field: ScalarField = { width: size, height: size, values }
  const image: PixelImage = { width: size, height: size, sourceWidth: size, sourceHeight: size, data, name: 'strata-fixture' }
  return { field, image }
}

describe('Strata height-contour geometry', () => {
  it('keeps Float32 iso-level intersections from collapsing into zero-area facets', () => {
    const { image } = strataFixture()
    for (const layers of [5, 6, 12, 24]) {
      const field = { width: 2, height: 2, values: new Float32Array([0, 0.4, 0.7, 1]) }
      const mesh = buildStrataMesh(field, image, 16, { layers })
      expect(inspectTopology(mesh).degenerateFaces, `${layers} layers`).toBe(0)
      expect(inspectTopology(mesh).watertight).toBe(true)
    }
  })
  it.each(['hill', 'ring', 'islands', 'flat', 'noise'] as const)('closes every cap, contour and image boundary for %s', (kind) => {
    const { field, image } = strataFixture(kind)
    const mesh = buildStrataMesh(field, image, 16, { layers: 8 })
    const report = inspectTopology(mesh)
    expect(report.boundaryEdges).toBe(0)
    expect(report.nonManifoldEdges).toBe(0)
    expect(report.degenerateFaces).toBe(0)
    expect(report.watertight).toBe(true)
    expect(isStrataData(mesh.strata, mesh.positions.length / 3, mesh.indices)).toBe(true)
    for (const part of splitStrataMesh(mesh)) expect(inspectTopology(part).watertight).toBe(true)
    expect(mesh.strata!.parts).toHaveLength(kind === 'flat' ? 1 : 8)
  })

  it('makes nested footprints stacked along Z, not strips or identical cards', () => {
    const { field, image } = strataFixture()
    const mesh = buildStrataMesh(field, image, 16, { layers: 6, thickness: 0.03, separation: 0.08 })
    let previousArea = Infinity
    splitStrataMesh(mesh).forEach((piece, layer) => {
      const z = Array.from(piece.positions).filter((_, index) => index % 3 === 2)
      expect(Math.min(...z)).toBeCloseTo(layer * 0.11)
      expect(Math.max(...z)).toBeCloseTo(layer * 0.11 + 0.03)
      expect(new Set(z).size).toBe(2)
      let area = 0
      for (let index = 0; index < piece.strata!.parts[0]!.surfaceIndexCount; index += 3) {
        const a = piece.indices[index]! * 3, b = piece.indices[index + 1]! * 3, c = piece.indices[index + 2]! * 3
        const signed = ((piece.positions[b]! - piece.positions[a]!) * (piece.positions[c + 1]! - piece.positions[a + 1]!)
          - (piece.positions[c]! - piece.positions[a]!) * (piece.positions[b + 1]! - piece.positions[a + 1]!)) / 2
        expect(signed).toBeGreaterThan(0)
        area += signed
      }
      expect(area).toBeLessThan(previousArea)
      previousArea = area
    })
  })

  it('preserves a hole through ring layers and disconnected contour islands', () => {
    const ring = strataFixture('ring')
    const rings = splitStrataMesh(buildStrataMesh(ring.field, ring.image, 32, { layers: 6 }))
    expect(inspectTopology(rings[4]!).eulerCharacteristic).toBe(0)
    const islands = strataFixture('islands')
    const parts = splitStrataMesh(buildStrataMesh(islands.field, islands.image, 32, { layers: 6 }))
    expect(inspectTopology(parts[4]!).connectedComponents).toBe(2)
  })

  it('retains original XY UVs and interior image color samples on every sheet', () => {
    const { field, image } = strataFixture()
    const mesh = buildStrataMesh(field, image, 16)
    for (let index = 0; index < mesh.heights.length; index += 1) {
      expect(mesh.uvs[index * 2]).toBeCloseTo(mesh.positions[index * 3]! / 2 + 0.5)
      expect(mesh.uvs[index * 2 + 1]).toBeCloseTo(mesh.positions[index * 3 + 1]! / 2 + 0.5)
      expect(mesh.colors[index * 3]).toBeCloseTo(mesh.uvs[index * 2]!, 2)
      expect(mesh.colors[index * 3 + 1]).toBeCloseTo(1 - mesh.uvs[index * 2 + 1]!, 2)
    }
    const first = mesh.strata!.parts[0]!
    expect(first.vertexCount).toBeGreaterThan(8)
  })

  it('resizes gaps without re-clipping or mutating the source, and closes gaps at zero', () => {
    const { field, image } = strataFixture()
    const original = buildStrataMesh(field, image, 16)
    const before = original.positions.slice()
    const spaced = spaceStrataMesh(original, { thickness: 0.05, separation: 0 })
    expect(original.positions).toEqual(before)
    expect(spaced.indices).toBe(original.indices)
    expect(spaced.uvs).toBe(original.uvs)
    for (const part of spaced.strata!.parts) {
      expect(spaced.positions[part.vertexStart * 3 + 2]).toBeCloseTo((part.layer + 1) * 0.05)
    }
  })

  it('is optional and leaves every existing relief mode unchanged', () => {
    const { field, image } = strataFixture()
    for (const mode of ['plane', 'centered', 'solid'] as const) {
      const settings = { mode, resolution: 16, depth: 0.6, midpoint: 0.5, baseThickness: 0.3 }
      const mesh = buildMesh(field, image, settings)
      expect(buildMesh(field, image, { ...settings, strata: { layers: 24, thickness: 0.12, separation: 0.18 } })).toEqual(mesh)
      expect(mesh.strata).toBeUndefined()
    }
  })

  it('closes and reopens a seamless loop with rigid sheets and independent snapshots', () => {
    const { field, image } = strataFixture()
    const mesh = buildStrataMesh(field, image, 16)
    const options = { enabled: true, behavior: 'expand' as const, amount: 1 }
    expect(animateLivingFormMesh(mesh, 0, options).positions).toEqual(animateLivingFormMesh(mesh, 1, options).positions)
    const closed = animateLivingFormMesh(mesh, 0.5, options)
    for (const part of closed.strata!.parts) {
      expect(closed.positions[part.vertexStart * 3 + 2]).toBeCloseTo((part.layer + 1) * DEFAULT_STRATA_SETTINGS.thickness)
      for (let index = part.vertexStart; index < part.vertexStart + part.vertexCount; index += 1) {
        expect(closed.positions[index * 3]).toBe(mesh.positions[index * 3])
        expect(closed.positions[index * 3 + 1]).toBe(mesh.positions[index * 3 + 1])
      }
    }
    expect(closed.strata).toEqual(mesh.strata)
    expect(closed.strata).not.toBe(mesh.strata)
    expect(snapshotMesh(mesh).strata!.parts).not.toBe(mesh.strata!.parts)
    const rendered = createThreeMesh(mesh, 'clay')
    expect((rendered.material as MeshStandardMaterial).flatShading).toBe(true)
    rendered.geometry.dispose()
  })

  it('rejects overlapping, out-of-range and cross-layer export metadata', () => {
    const { field, image } = strataFixture()
    const mesh = buildStrataMesh(field, image, 16)
    const copy = () => structuredClone(mesh.strata!)
    const overlap = copy()
    overlap.parts[1]!.indexStart = 0
    expect(isStrataData(overlap, mesh.positions.length / 3, mesh.indices)).toBe(false)
    const invalid = copy()
    invalid.parts[0]!.vertexCount += 2
    expect(isStrataData(invalid, mesh.positions.length / 3, mesh.indices)).toBe(false)
    const crossLayer = mesh.indices.slice()
    crossLayer[0] = mesh.strata!.parts[1]!.vertexStart
    expect(isStrataData(mesh.strata, mesh.positions.length / 3, crossLayer)).toBe(false)
  })
})
