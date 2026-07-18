import { describe, expect, it } from 'vitest'
import { inspectTopology } from './topology'
import { buildTextMeshFromField, rasterizeTextMask, scalarFieldToShapes } from './text-mesh'
import type { ScalarField, TextShapeSettings } from '../types'

const settings: TextShapeSettings = {
  text: 'Rasterform',
  alignment: 'center',
  tracking: 0,
  lineHeight: 1.1,
  depth: 0.34,
  bevelSize: 0.025,
  bevelThickness: 0.025,
  bevelSegments: 3,
  resolution: 320,
  finish: 'detail',
  blobDilation: 4,
  blobSmoothing: 5,
}

function blockField(withHole = false): ScalarField {
  const width = 36
  const height = 28
  const values = new Float32Array(width * height)
  for (let y = 5; y < 23; y += 1) {
    for (let x = 6; x < 30; x += 1) {
      const hole = withHole && x >= 14 && x < 22 && y >= 10 && y < 18
      values[y * width + x] = hole ? 0 : 1
    }
  }
  return { width, height, values }
}

function pinchField(): ScalarField {
  const width = 12
  const height = 12
  const values = new Float32Array(width * height)
  const rows = [
    [1, 0.63, 0, 1, 0.04, 1, 1, 0.21],
    [0.65, 0, 0.12, 1, 0.68, 1, 0.97, 1],
    [0, 0, 0, 0, 1, 1, 0, 1],
    [1, 0.96, 0, 1, 0.83, 0.82, 1, 0.19],
    [0.45, 0.28, 1, 0.75, 0, 0, 1, 0],
    [0.06, 1, 0.98, 0, 0, 0.65, 0.24, 1],
    [1, 0, 1, 0.05, 0.48000026, 0.72, 0, 1],
    [0.59, 1, 0.46, 0, 0, 0.88, 0, 0.31],
  ]
  rows.forEach((row, y) => row.forEach((value, x) => {
    values[(y + 2) * width + x + 2] = value
  }))
  return { width, height, values }
}

function annulusField(size = 720): ScalarField {
  const values = new Float32Array(size * size)
  const center = (size - 1) / 2
  const outerRadius = size * 0.36
  const innerRadius = size * 0.2
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x - center, y - center)
      if (distance <= outerRadius && distance >= innerRadius) values[y * size + x] = 1
    }
  }
  return { width: size, height: size, values }
}

function textCanvasFactory(fillCalls: string[]): () => HTMLCanvasElement {
  return () => {
    const canvas = { width: 1, height: 1 } as HTMLCanvasElement
    const context = {
      font: '',
      textBaseline: 'alphabetic',
      textAlign: 'left',
      fillStyle: '#fff',
      measureText: (value: string) => ({ width: Array.from(value).length * 10 }),
      fillText: (value: string) => fillCalls.push(value),
      clearRect: () => undefined,
      getImageData: () => {
        const data = new Uint8ClampedArray(canvas.width * canvas.height * 4)
        data[3] = 255
        return { data }
      },
    }
    canvas.getContext = (() => context) as unknown as typeof canvas.getContext
    return canvas
  }
}

describe('text mesh geometry', () => {
  it('preserves counters as contour holes', () => {
    const shapes = scalarFieldToShapes(blockField(true))
    expect(shapes).toHaveLength(1)
    expect(shapes[0]?.holes).toHaveLength(1)
  })

  it('builds finite, centered, indexed geometry', () => {
    const mesh = buildTextMeshFromField(blockField(), settings)
    expect(mesh).not.toBeNull()
    expect(mesh!.indices.length).toBeGreaterThan(0)
    expect(mesh!.indices.length % 3).toBe(0)
    expect([...mesh!.positions].every(Number.isFinite)).toBe(true)

    const xs = [...mesh!.positions].filter((_, index) => index % 3 === 0)
    const ys = [...mesh!.positions].filter((_, index) => index % 3 === 1)
    const zs = [...mesh!.positions].filter((_, index) => index % 3 === 2)
    expect(Math.min(...xs) + Math.max(...xs)).toBeCloseTo(0, 5)
    expect(Math.min(...ys) + Math.max(...ys)).toBeCloseTo(0, 5)
    expect(Math.min(...zs) + Math.max(...zs)).toBeCloseTo(0, 5)
  })

  it('produces a closed solid for STL export', () => {
    const mesh = buildTextMeshFromField(blockField(true), settings)
    expect(mesh).not.toBeNull()
    const topology = inspectTopology(mesh!)
    expect(topology.watertight).toBe(true)
    expect(topology.degenerateFaces).toBe(0)
  })

  it('avoids non-manifold pinches at sampled alpha thresholds', () => {
    const mesh = buildTextMeshFromField(pinchField(), settings)
    expect(mesh).not.toBeNull()
    expect(inspectTopology(mesh!)).toMatchObject({
      boundaryEdges: 0,
      nonManifoldEdges: 0,
      degenerateFaces: 0,
      watertight: true,
    })
  })

  it('preserves a high-resolution curved ring and its counter', () => {
    const field = annulusField()
    const shapes = scalarFieldToShapes(field)
    expect(shapes).toHaveLength(1)
    expect(shapes[0]?.holes).toHaveLength(1)
    const mesh = buildTextMeshFromField(field, settings)
    expect(mesh).not.toBeNull()
    expect(inspectTopology(mesh!)).toMatchObject({
      boundaryEdges: 0,
      nonManifoldEdges: 0,
      degenerateFaces: 0,
      watertight: true,
    })
  })

  it('expands and rounds the mask in Blob mode', () => {
    const detail = buildTextMeshFromField(blockField(), settings)!
    const blob = buildTextMeshFromField(blockField(), {
      ...settings,
      finish: 'blob',
      blobDilation: 3,
      blobSmoothing: 2,
    })!
    const extent = (positions: Float32Array) => {
      const xs = [...positions].filter((_, index) => index % 3 === 0)
      return Math.max(...xs) - Math.min(...xs)
    }
    expect(extent(blob.positions)).toBeGreaterThan(extent(detail.positions))
  })

  it('keeps browser kerning and ligatures when tracking is zero', () => {
    const fillCalls: string[] = []
    expect(rasterizeTextMask(
      'office',
      'sans-serif',
      settings,
      textCanvasFactory(fillCalls),
    )).not.toBeNull()
    expect(fillCalls).toEqual(['office'])
  })

  it('tracks extended grapheme clusters without splitting joined emoji', () => {
    const fillCalls: string[] = []
    expect(rasterizeTextMask(
      '👩‍👩‍👧‍👦A',
      'sans-serif',
      { ...settings, tracking: 0.1 },
      textCanvasFactory(fillCalls),
    )).not.toBeNull()
    expect(fillCalls).toEqual(['👩‍👩‍👧‍👦', 'A'])
  })
})
