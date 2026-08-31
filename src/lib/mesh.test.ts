import { describe, expect, it } from 'vitest'
import { buildMesh } from './mesh'
import { inspectTopology } from './topology'
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
  it('builds a deterministic open relief plane', () => {
    const mesh = buildMesh(field, image, base)
    const report = inspectTopology(mesh)
    expect(report.vertices).toBe(81)
    expect(report.faces).toBe(128)
    expect(report.boundaryLoops).toBe(1)
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

  it('never emits invalid indices or coordinates', () => {
    const mesh = buildMesh(field, image, { ...base, mode: 'solid' })
    const vertices = mesh.positions.length / 3
    expect([...mesh.positions].every(Number.isFinite)).toBe(true)
    expect([...mesh.indices].every((index) => index >= 0 && index < vertices)).toBe(true)
  })
})
