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
  it('keeps a positive-area Float32 sliver eligible for STL', () => {
    const report = inspectTopology(tetrahedron(1e-8))
    expect(report.boundaryEdges).toBe(0)
    expect(report.nonManifoldEdges).toBe(0)
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
