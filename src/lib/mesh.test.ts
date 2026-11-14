import { describe, expect, it } from 'vitest'
import { buildMesh } from './mesh'
import { inspectTopology } from './topology'
import { sampleColor } from './mesh-sampling'
import type { MeshSettings, PixelImage, ScalarField } from '../types'

const field: ScalarField = {
  width: 3,
  height: 3,
  values: new Float32Array([0, 0.25, 0.5, 0.25, 0.5, 0.75, 0.5, 0.75, 1]),
}

const image: PixelImage = {
  width: 3,
  height: 3,
  sourceWidth: 3,
  sourceHeight: 3,
  name: 'test',
  data: new Uint8ClampedArray(Array.from({ length: 9 }, (_, index) => [index * 25, 80, 220 - index * 20, 255]).flat()),
}

const base: MeshSettings = { mode: 'plane', resolution: 8, depth: 0.6, midpoint: 0.5, baseThickness: 0.3 }

describe('mesh generation and topology', () => {
  it('decodes image colors before interpolating in linear light', () => {
    const source: PixelImage = {
      width: 2, height: 1, sourceWidth: 2, sourceHeight: 1, name: 'black-gray',
      data: new Uint8ClampedArray([0, 0, 0, 255, 128, 128, 128, 255]),
    }
    expect(sampleColor(source, 1, 0)[0]).toBeCloseTo(0.2158605, 7)
    expect(sampleColor(source, 0.5, 0)[0]).toBeCloseTo(0.10793025, 7)
    expect(source.data).toEqual(new Uint8ClampedArray([0, 0, 0, 255, 128, 128, 128, 255]))
  })

  it('builds a deterministic open relief plane', () => {
    const mesh = buildMesh(field, image, base)
    const report = inspectTopology(mesh)
    expect(report.vertices).toBe(81)
    expect(report.faces).toBe(128)
    expect(report.boundaryLoops).toBe(1)
    expect(report.nonManifoldVertices).toBe(0)
    expect(report.eulerCharacteristic).toBe(1)
    expect(report.watertight).toBe(false)
  })

  it('centers signed displacement around the chosen midpoint', () => {
    const mesh = buildMesh(field, image, { ...base, mode: 'centered' })
    const z = Array.from({ length: mesh.positions.length / 3 }, (_, index) => mesh.positions[index * 3 + 2])
    expect(Math.min(...z)).toBeLessThan(0)
    expect(Math.max(...z)).toBeGreaterThan(0)
  })

  it('builds a connected watertight solid tile', () => {
    const mesh = buildMesh(field, image, { ...base, mode: 'solid', baseThickness: 0.5 })
    const report = inspectTopology(mesh)
    expect(report.connectedComponents).toBe(1)
    expect(report.boundaryEdges).toBe(0)
    expect(report.nonManifoldEdges).toBe(0)
    expect(report.degenerateFaces).toBe(0)
    expect(report.eulerCharacteristic).toBe(2)
    expect(report.watertight).toBe(true)
  })

  it('clips a raised ring to transparency and keeps the inner and outer walls watertight', () => {
    const size = 25
    const data = new Uint8ClampedArray(size * size * 4)
    const values = new Float32Array(size * size)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const radius = Math.hypot(x - 12, y - 12)
        data[(y * size + x) * 4 + 3] = radius < 10 && radius > 3 ? 255 : 0
        values[y * size + x] = x / (size - 1)
      }
    }
    const source = { ...image, width: size, height: size, data }
    const settings = { ...base, mode: 'solid' as const, resolution: 24, alphaCutout: true }
    const mesh = buildMesh({ width: size, height: size, values }, source, settings)
    expect(mesh.alphaCutout).toBe(true)
    expect(inspectTopology(mesh)).toMatchObject({ watertight: true, connectedComponents: 1,
      eulerCharacteristic: 0, boundaryEdges: 0, nonManifoldVertices: 0, degenerateFaces: 0 })
    const frontCount = mesh.heights.length / 2
    for (let v = 0; v < frontCount; v++) {
      const x = mesh.positions[v * 3]!, y = mesh.positions[v * 3 + 1]!, z = mesh.positions[v * 3 + 2]!
      const u = mesh.uvs[v * 2]!
      expect(Math.hypot(x, y)).toBeGreaterThan(0.17)
      expect(Math.hypot(x, y)).toBeLessThan(0.90)
      expect(z).toBeCloseTo(Math.max(0.025, settings.baseThickness + (u - settings.midpoint) * settings.depth))
      expect(mesh.positions[(v + frontCount) * 3 + 2]).toBe(0)
    }
    // Check winding, in addition to counting shared edges. Both sides of every
    // mesh edge must use opposite direction, including the walls around holes.
    const balance = new Map<string, number>()
    for (let i = 0; i < mesh.indices.length; i += 3) {
      for (let j = 0; j < 3; j++) {
        const a = mesh.indices[i + j]!, b = mesh.indices[i + (j + 1) % 3]!
        const key = [Math.min(a, b), Math.max(a, b)].join(':')
        balance.set(key, (balance.get(key) ?? 0) + (a < b ? 1 : -1))
      }
    }
    expect([...balance.values()].every(n => n === 0)).toBe(true)
  })

  it('preserves opaque reliefs and returns no model for a fully transparent cutout', () => {
    const solid = { ...base, mode: 'solid' as const }
    expect(buildMesh(field, image, { ...solid, alphaCutout: true })).toEqual(buildMesh(field, image, solid))
    const transparent = { ...image, data: new Uint8ClampedArray(image.data.length) }
    expect(buildMesh(field, transparent, solid).indices.length).toBeGreaterThan(0)
    const clipped = buildMesh(field, transparent, { ...solid, alphaCutout: true })
    expect(clipped.positions.length).toBe(0)
    expect(clipped.indices.length).toBe(0)
  })

  it('never emits invalid indices or coordinates', () => {
    const mesh = buildMesh(field, image, { ...base, mode: 'solid' })
    const vertices = mesh.positions.length / 3
    expect([...mesh.positions].every(Number.isFinite)).toBe(true)
    expect([...mesh.indices].every((index) => index >= 0 && index < vertices)).toBe(true)
  })
})
