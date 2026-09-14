import { bilinearSample, clamp01 } from './channels'
import { gridDimensions, sampleColor } from './mesh-sampling'
import type { MeshData, PixelImage, ScalarField, StrataData, StrataPart, StrataSettings } from '../types'

export const DEFAULT_STRATA_SETTINGS: Readonly<StrataSettings> = Object.freeze({
  layers: 12,
  thickness: 0.025,
  separation: 0.055,
})

export function normalizeStrataSettings(settings: Partial<StrataSettings> = {}): StrataSettings {
  const finite = (value: number | undefined, fallback: number, low: number, high: number) =>
    Math.min(high, Math.max(low, Number.isFinite(value) ? value! : fallback))
  return {
    layers: Math.round(finite(settings.layers, DEFAULT_STRATA_SETTINGS.layers, 2, 24)),
    thickness: finite(settings.thickness, DEFAULT_STRATA_SETTINGS.thickness, 0.005, 0.12),
    separation: finite(settings.separation, DEFAULT_STRATA_SETTINGS.separation, 0, 0.18),
  }
}

export function cloneStrataData(data: StrataData): StrataData {
  return { ...data, parts: data.parts.map((part) => ({ ...part })) }
}

/** Validate object boundaries before accepting layer metadata over desktop IPC. */
export function isStrataData(value: unknown, vertexCount: number, indices: Uint32Array): value is StrataData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const data = value as StrataData
  if (Object.keys(data).sort().join(',') !== 'layers,parts,separation,thickness'
    || !Number.isInteger(data.layers) || data.layers < 2 || data.layers > 24
    || !Number.isFinite(data.thickness) || data.thickness < 0.005 || data.thickness > 0.12
    || !Number.isFinite(data.separation) || data.separation < 0 || data.separation > 0.18
    || !Array.isArray(data.parts) || data.parts.length < 1 || data.parts.length > data.layers) return false
  let vertexEnd = 0
  let indexEnd = 0
  let previousThreshold = -1
  for (let layer = 0; layer < data.parts.length; layer += 1) {
    const part = data.parts[layer]
    if (!part || typeof part !== 'object' || Array.isArray(part)
      || Object.keys(part).sort().join(',') !== 'indexCount,indexStart,layer,surfaceIndexCount,threshold,vertexCount,vertexStart'
      || part.layer !== layer || !Number.isFinite(part.threshold) || part.threshold < 0 || part.threshold > 1
      || part.threshold < previousThreshold || part.vertexStart !== vertexEnd || part.indexStart !== indexEnd
      || !Number.isSafeInteger(part.vertexCount) || part.vertexCount < 6 || part.vertexCount % 2 !== 0
      || !Number.isSafeInteger(part.indexCount) || part.indexCount < 12 || part.indexCount % 3 !== 0
      || !Number.isSafeInteger(part.surfaceIndexCount) || part.surfaceIndexCount < 3
      || part.surfaceIndexCount % 3 !== 0 || part.surfaceIndexCount * 2 >= part.indexCount) return false
    vertexEnd += part.vertexCount
    indexEnd += part.indexCount
    if (vertexEnd > vertexCount || indexEnd > indices.length) return false
    for (let index = part.indexStart; index < indexEnd; index += 1) {
      if (indices[index]! < part.vertexStart || indices[index]! >= vertexEnd
        || (index < part.indexStart + part.surfaceIndexCount
          && indices[index]! >= part.vertexStart + part.vertexCount / 2)) return false
    }
    previousThreshold = part.threshold
  }
  return vertexEnd === vertexCount && indexEnd === indices.length
}

/**
 * Clip the same sampled height triangles used by the relief, then cap and close
 * each superlevel set. Shared edge intersections are created once, so holes,
 * disconnected islands and the image boundary all get watertight walls. Keeping
 * interior grid vertices preserves Photo colors instead of interpolating an
 * entire image across a handful of contour corners.
 */
export function buildStrataMesh(
  field: ScalarField,
  image: PixelImage,
  resolution: number,
  options: Partial<StrataSettings> = {},
): MeshData {
  const settings = normalizeStrataSettings(options)
  const { columns, rows } = gridDimensions(field, resolution)
  const gridWidth = columns + 1
  const gridCount = gridWidth * (rows + 1)
  const values = new Float32Array(gridCount)
  let minimum = 1
  let maximum = 0
  for (let y = 0; y <= rows; y += 1) {
    for (let x = 0; x <= columns; x += 1) {
      const raw = bilinearSample(field, x / columns, y / rows)
      const value = clamp01(Number.isFinite(raw) ? raw : 0)
      values[y * gridWidth + x] = value
      minimum = Math.min(minimum, values[y * gridWidth + x]!)
      maximum = Math.max(maximum, values[y * gridWidth + x]!)
    }
  }
  const aspect = field.width / field.height
  const surfaceWidth = aspect >= 1 ? 2 : 2 * aspect
  const surfaceHeight = aspect >= 1 ? 2 / aspect : 2
  const positions: number[] = []
  const colors: number[] = []
  const uvs: number[] = []
  const heights: number[] = []
  const indices: number[] = []
  const parts: StrataPart[] = []
  // A flat field has one level, not a fabricated stack of identical cards.
  const count = maximum > minimum ? settings.layers : 1

  for (let layer = 0; layer < count; layer += 1) {
    const threshold = minimum + (maximum - minimum) * layer / settings.layers
    const vertexStart = positions.length / 3
    const indexStart = indices.length
    const bottom = layer * (settings.thickness + settings.separation)
    const top = bottom + settings.thickness
    const vertices = new Map<number, number>()
    const cap: number[] = []
    const boundary = new Map<number, [number, number]>()

    const vertex = (key: number, sourceU: number, sourceV: number): number => {
      const existing = vertices.get(key)
      if (existing !== undefined) return existing
      const u = clamp01(sourceU)
      const v = clamp01(sourceV)
      const index = positions.length / 3
      vertices.set(key, index)
      // Topology decisions must use the same Float32 coordinates we export.
      positions.push(Math.fround((u - 0.5) * surfaceWidth), Math.fround((0.5 - v) * surfaceHeight), Math.fround(top))
      colors.push(...sampleColor(image, u, v))
      uvs.push(u, 1 - v)
      // Color each level by its actual iso-height, not by its exploded Z offset.
      heights.push(threshold)
      return index
    }
    const original = (id: number) => vertex(id, (id % gridWidth) / columns, Math.floor(id / gridWidth) / rows)
    const crossing = (left: number, right: number): number => {
      const a = Math.min(left, right)
      const b = Math.max(left, right)
      const t = (threshold - values[a]!) / (values[b]! - values[a]!)
      if (t <= 0) return original(a)
      if (t >= 1) return original(b)
      const u = ((a % gridWidth) * (1 - t) + (b % gridWidth) * t) / columns
      const v = (Math.floor(a / gridWidth) * (1 - t) + Math.floor(b / gridWidth) * t) / rows
      const x = Math.fround((u - 0.5) * surfaceWidth)
      const y = Math.fround((0.5 - v) * surfaceHeight)
      for (const endpoint of [a, b]) {
        if (x === Math.fround(((endpoint % gridWidth) / columns - 0.5) * surfaceWidth)
          && y === Math.fround((0.5 - Math.floor(endpoint / gridWidth) / rows) * surfaceHeight)) return original(endpoint)
      }
      return vertex(gridCount + a * gridCount + b, u, v)
    }
    const triangle = (a: number, b: number, c: number) => {
      if (a === b || b === c || a === c) return
      const area = (positions[b * 3]! - positions[a * 3]!) * (positions[c * 3 + 1]! - positions[a * 3 + 1]!)
        - (positions[b * 3 + 1]! - positions[a * 3 + 1]!) * (positions[c * 3]! - positions[a * 3]!)
      if (area <= 0) return
      cap.push(a, b, c)
    }
    const clip = (a: number, b: number, c: number) => {
      const input = [a, b, c]
      const polygon: number[] = []
      for (let index = 0; index < 3; index += 1) {
        const current = input[index]!
        const next = input[(index + 1) % 3]!
        const inside = values[current]! >= threshold
        if (inside) polygon.push(original(current))
        if (inside !== (values[next]! >= threshold)) polygon.push(crossing(current, next))
      }
      for (let index = 1; index + 1 < polygon.length; index += 1) triangle(polygon[0]!, polygon[index]!, polygon[index + 1]!)
    }
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < columns; x += 1) {
        const a = y * gridWidth + x
        clip(a, a + gridWidth, a + 1)
        clip(a + 1, a + gridWidth, a + gridWidth + 1)
      }
    }
    const rawSurfaceVertices = positions.length / 3 - vertexStart
    const used = new Uint8Array(rawSurfaceVertices)
    for (const index of cap) used[index - vertexStart] = 1
    let surfaceVertices = 0
    const remap = new Uint32Array(rawSurfaceVertices)
    for (let local = 0; local < rawSurfaceVertices; local += 1) {
      if (!used[local]) continue
      const from = vertexStart + local
      const to = vertexStart + surfaceVertices++
      remap[local] = to
      for (let component = 0; component < 3; component += 1) {
        positions[to * 3 + component] = positions[from * 3 + component]!
        colors[to * 3 + component] = colors[from * 3 + component]!
      }
      uvs[to * 2] = uvs[from * 2]!
      uvs[to * 2 + 1] = uvs[from * 2 + 1]!
      heights[to] = heights[from]!
    }
    positions.length = colors.length = (vertexStart + surfaceVertices) * 3
    uvs.length = (vertexStart + surfaceVertices) * 2
    heights.length = vertexStart + surfaceVertices
    for (let index = 0; index < cap.length; index += 1) cap[index] = remap[cap[index]! - vertexStart]!
    const edgeBase = positions.length / 3
    for (let index = 0; index < cap.length; index += 3) {
      const a = cap[index]!, b = cap[index + 1]!, c = cap[index + 2]!
      indices.push(a, b, c)
      for (const [left, right] of [[a, b], [b, c], [c, a]]) {
        const key = Math.min(left!, right!) * edgeBase + Math.max(left!, right!)
        if (boundary.has(key)) boundary.delete(key)
        else boundary.set(key, [left!, right!])
      }
    }
    for (let index = vertexStart; index < vertexStart + surfaceVertices; index += 1) {
      positions.push(positions[index * 3]!, positions[index * 3 + 1]!, bottom)
      colors.push(colors[index * 3]!, colors[index * 3 + 1]!, colors[index * 3 + 2]!)
      uvs.push(uvs[index * 2]!, uvs[index * 2 + 1]!)
      heights.push(threshold)
    }
    for (let index = 0; index < cap.length; index += 3) {
      indices.push(cap[index]! + surfaceVertices, cap[index + 2]! + surfaceVertices, cap[index + 1]! + surfaceVertices)
    }
    for (const [a, b] of boundary.values()) {
      indices.push(a, a + surfaceVertices, b, b, a + surfaceVertices, b + surfaceVertices)
    }
    parts.push({ layer, threshold, vertexStart, vertexCount: surfaceVertices * 2, indexStart,
      indexCount: indices.length - indexStart, surfaceIndexCount: cap.length })
  }
  return {
    positions: new Float32Array(positions), indices: new Uint32Array(indices),
    colors: new Float32Array(colors), uvs: new Float32Array(uvs), heights: new Float32Array(heights),
    width: columns, height: rows, mode: 'strata', strata: { ...settings, parts },
  }
}

/** Thickness/separation edits do not need another contour extraction. */
export function spaceStrataMesh(mesh: MeshData, options: Pick<StrataSettings, 'thickness' | 'separation'>): MeshData {
  if (!mesh.strata) return mesh
  const settings = normalizeStrataSettings({ ...mesh.strata, ...options })
  const positions = mesh.positions.slice()
  for (const part of mesh.strata.parts) {
    const surfaceVertices = part.vertexCount / 2
    const bottom = part.layer * (settings.thickness + settings.separation)
    for (let index = 0; index < part.vertexCount; index += 1) {
      positions[(part.vertexStart + index) * 3 + 2] = bottom + (index < surfaceVertices ? settings.thickness : 0)
    }
  }
  return { ...mesh, positions, strata: { ...settings, parts: mesh.strata.parts } }
}

/** One named layer per Blender/glTF object, including its disconnected islands. */
export function splitStrataMesh(mesh: MeshData): MeshData[] {
  if (!mesh.strata) return [mesh]
  return mesh.strata.parts.map((part) => ({
    positions: mesh.positions.slice(part.vertexStart * 3, (part.vertexStart + part.vertexCount) * 3),
    colors: mesh.colors.slice(part.vertexStart * 3, (part.vertexStart + part.vertexCount) * 3),
    uvs: mesh.uvs.slice(part.vertexStart * 2, (part.vertexStart + part.vertexCount) * 2),
    heights: mesh.heights.slice(part.vertexStart, part.vertexStart + part.vertexCount),
    indices: mesh.indices.slice(part.indexStart, part.indexStart + part.indexCount).map((index) => index - part.vertexStart),
    width: mesh.width, height: mesh.height, mode: 'strata',
    strata: { ...mesh.strata!, parts: [{ ...part, vertexStart: 0, indexStart: 0 }] },
  }))
}
