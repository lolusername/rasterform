import { bilinearSample } from './channels'
import { buildStrataMesh } from './strata'
import { gridDimensions, sampleColor } from './mesh-sampling'
import type { MeshData, MeshSettings, PixelImage, ScalarField } from '../types'

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
  if (settings.mode === 'strata') return buildStrataMesh(field, image, settings.resolution, settings.strata)
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
