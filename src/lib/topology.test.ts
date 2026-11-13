import { describe, expect, it } from 'vitest'
import { inspectTopology } from './topology'
import type { MeshData } from '../types'

function tetrahedron(thirdVertexY: number): MeshData {
  return {
    positions: new Float32Array([
      0, 0, 0,
      1, 0, 0,
      0.5, thirdVertexY, 0,
      0, 0, 1,
    ]),
    indices: new Uint32Array([
      0, 2, 1,
      0, 1, 3,
      1, 2, 3,
      2, 0, 3,
    ]),
    colors: new Float32Array(12),
    uvs: new Float32Array(8),
    heights: new Float32Array(4),
    width: 1,
    height: 1,
    mode: 'solid',
  }
}

describe('topology degeneracy', () => {
  it('rejects a pinched vertex even when every edge has exactly two incident faces', () => {
    const pinched: MeshData = {
      ...tetrahedron(1),
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, -1, 0, 0, 0, -1, 0, 0, 0, -1]),
      indices: new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3, 0, 4, 5, 0, 6, 4, 0, 5, 6, 4, 6, 5]),
      colors: new Float32Array(21), uvs: new Float32Array(14), heights: new Float32Array(7),
    }
    const report = inspectTopology(pinched)
    expect(report.watertight).toBe(false)
    expect(report).toMatchObject({ boundaryEdges: 0, nonManifoldEdges: 0, nonManifoldVertices: 1, connectedComponents: 1 })
  })

  it('accepts two disjoint closed shells', () => {
    const first = tetrahedron(1)
    const second = tetrahedron(1)
    for (let offset = 0; offset < second.positions.length; offset += 3) second.positions[offset]! += 3
    const pair: MeshData = {
      ...first,
      positions: new Float32Array([...first.positions, ...second.positions]),
      indices: new Uint32Array([...first.indices, ...second.indices.map(index => index + 4)]),
      colors: new Float32Array(24), uvs: new Float32Array(16), heights: new Float32Array(8),
    }
    expect(inspectTopology(pair)).toMatchObject({ watertight: true, nonManifoldVertices: 0, connectedComponents: 2 })
  })

  it('reports branching face fans at both endpoints of a three-face edge', () => {
    const branched: MeshData = {
      ...tetrahedron(1),
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 1, 0, 3, 0, 1, 4]),
      colors: new Float32Array(15), uvs: new Float32Array(10), heights: new Float32Array(5),
    }
    expect(inspectTopology(branched)).toMatchObject({ watertight: false, nonManifoldEdges: 1, nonManifoldVertices: 2 })
  })

  it('keeps a positive-area Float32 sliver eligible for STL', () => {
    const report = inspectTopology(tetrahedron(1e-8))
    expect(report.boundaryEdges).toBe(0)
    expect(report.nonManifoldEdges).toBe(0)
    expect(report.nonManifoldVertices).toBe(0)
    expect(report.degenerateFaces).toBe(0)
    expect(report.watertight).toBe(true)
  })

  it('rejects an actually collapsed face', () => {
    const report = inspectTopology(tetrahedron(0))
    expect(report.boundaryEdges).toBe(0)
    expect(report.nonManifoldEdges).toBe(0)
    expect(report.degenerateFaces).toBe(1)
    expect(report.watertight).toBe(false)
  })
})
