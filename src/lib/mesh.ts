import { bilinearSample, clamp01 } from './channels'
import type { MeshData, MeshSettings, PixelImage, ScalarField } from '../types'

function sampleColor(image: PixelImage, u: number, v: number): [number, number, number] {
  const x = clamp01(u) * Math.max(0, image.width - 1)
  const y = clamp01(v) * Math.max(0, image.height - 1)
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const x1 = Math.min(image.width - 1, x0 + 1)
  const y1 = Math.min(image.height - 1, y0 + 1)
  const tx = x - x0
  const ty = y - y0
  const channel = (pixelX: number, pixelY: number, offset: number) =>
    (image.data[(pixelY * image.width + pixelX) * 4 + offset] ?? 0) / 255
  return [0, 1, 2].map((offset) => {
    const top = channel(x0, y0, offset) * (1 - tx) + channel(x1, y0, offset) * tx
    const bottom = channel(x0, y1, offset) * (1 - tx) + channel(x1, y1, offset) * tx
    return top * (1 - ty) + bottom * ty
  }) as [number, number, number]
}

function gridDimensions(field: ScalarField, resolution: number) {
  const longSide = Math.max(8, Math.min(256, Math.round(resolution)))
  if (field.width >= field.height) {
    return { columns: longSide, rows: Math.max(4, Math.round(longSide * field.height / field.width)) }
  }
  return { columns: Math.max(4, Math.round(longSide * field.width / field.height)), rows: longSide }
}

function perimeter(columns: number, rows: number): number[] {
  const width = columns + 1
  const result: number[] = []
  for (let x = 0; x <= columns; x += 1) result.push(x)
  for (let y = 1; y <= rows; y += 1) result.push(y * width + columns)
  for (let x = columns - 1; x >= 0; x -= 1) result.push(rows * width + x)
  for (let y = rows - 1; y >= 1; y -= 1) result.push(y * width)
  return result
}

export function buildMesh(field: ScalarField, image: PixelImage, settings: MeshSettings): MeshData {
  const { columns, rows } = gridDimensions(field, settings.resolution)
  const gridVertexCount = (columns + 1) * (rows + 1)
  const layerCount = settings.mode === 'solid' ? 2 : 1
  const positions = new Float32Array(gridVertexCount * layerCount * 3)
  const colors = new Float32Array(gridVertexCount * layerCount * 3)
  const uvs = new Float32Array(gridVertexCount * layerCount * 2)
  const heights = new Float32Array(gridVertexCount * layerCount)
  const aspect = field.width / field.height
  const surfaceWidth = aspect >= 1 ? 2 : 2 * aspect
  const surfaceHeight = aspect >= 1 ? 2 / aspect : 2

  const setVertex = (index: number, u: number, v: number, z: number, colorScale = 1) => {
    positions[index * 3] = (u - 0.5) * surfaceWidth
    positions[index * 3 + 1] = (0.5 - v) * surfaceHeight
    positions[index * 3 + 2] = z
    const color = sampleColor(image, u, v)
    colors[index * 3] = color[0] * colorScale
    colors[index * 3 + 1] = color[1] * colorScale
    colors[index * 3 + 2] = color[2] * colorScale
    uvs[index * 2] = u
    uvs[index * 2 + 1] = 1 - v
    heights[index] = bilinearSample(field, u, v)
  }

  for (let y = 0; y <= rows; y += 1) {
    for (let x = 0; x <= columns; x += 1) {
      const index = y * (columns + 1) + x
      const u = x / columns
      const v = y / rows
      const value = bilinearSample(field, u, v)
      const z = settings.mode === 'plane'
        ? value * settings.depth
        : settings.mode === 'centered'
          ? (value - settings.midpoint) * settings.depth
          : Math.max(0.025, settings.baseThickness + (value - settings.midpoint) * settings.depth)
      setVertex(index, u, v, z)
      if (settings.mode === 'solid') setVertex(index + gridVertexCount, u, v, 0, 0.62)
    }
  }

  const indices: number[] = []
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < columns; x += 1) {
      const a = y * (columns + 1) + x
      const b = a + 1
      const c = a + columns + 1
      const d = c + 1
      indices.push(a, c, b, b, c, d)
      if (settings.mode === 'solid') {
        const offset = gridVertexCount
        indices.push(a + offset, b + offset, c + offset, b + offset, d + offset, c + offset)
      }
    }
  }

  if (settings.mode === 'solid') {
    const cycle = perimeter(columns, rows)
    for (let index = 0; index < cycle.length; index += 1) {
      const current = cycle[index]
      const next = cycle[(index + 1) % cycle.length]
      const currentBottom = current + gridVertexCount
      const nextBottom = next + gridVertexCount
      indices.push(current, next, nextBottom, current, nextBottom, currentBottom)
    }
  }

  return {
    positions,
    indices: new Uint32Array(indices),
    colors,
    uvs,
    heights,
    width: columns,
    height: rows,
    mode: settings.mode,
  }
}
