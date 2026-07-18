import { contours } from 'd3-contour'
import * as THREE from 'three'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { processScalarField } from './filters'
import type { MeshData, ScalarField, TextShapeSettings } from '../types'

export interface TextMeshResult {
  field: ScalarField
  mesh: MeshData
}

function graphemes(value: string): string[] {
  if (typeof Intl.Segmenter === 'function') {
    return Array.from(
      new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value),
      ({ segment }) => segment,
    )
  }
  return Array.from(value)
}

function trackedWidth(
  context: CanvasRenderingContext2D,
  line: string,
  tracking: number,
): number {
  if (tracking === 0) return context.measureText(line).width
  const characters = graphemes(line)
  if (characters.length === 0) return 0
  return characters.reduce((total, character) => total + context.measureText(character).width, 0)
    + Math.max(0, characters.length - 1) * tracking
}

function drawTrackedLine(
  context: CanvasRenderingContext2D,
  line: string,
  startX: number,
  baseline: number,
  tracking: number,
): void {
  if (tracking === 0) {
    context.fillText(line, startX, baseline)
    return
  }
  let x = startX
  for (const character of graphemes(line)) {
    context.fillText(character, x, baseline)
    x += context.measureText(character).width + tracking
  }
}

function pointSegmentDistance(point: number[], start: number[], end: number[]): number {
  const x = point[0] ?? 0
  const y = point[1] ?? 0
  const startX = start[0] ?? 0
  const startY = start[1] ?? 0
  const dx = (end[0] ?? 0) - startX
  const dy = (end[1] ?? 0) - startY
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return Math.hypot(x - startX, y - startY)
  const amount = Math.max(0, Math.min(1, ((x - startX) * dx + (y - startY) * dy) / lengthSquared))
  return Math.hypot(x - (startX + amount * dx), y - (startY + amount * dy))
}

function simplifyOpenPath(points: number[][], tolerance: number): number[][] {
  if (points.length <= 2) return points
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const ranges: Array<[number, number]> = [[0, points.length - 1]]
  while (ranges.length > 0) {
    const [start, end] = ranges.pop()!
    let furthest = -1
    let maximumDistance = tolerance
    for (let index = start + 1; index < end; index += 1) {
      const distance = pointSegmentDistance(points[index]!, points[start]!, points[end]!)
      if (distance > maximumDistance) {
        furthest = index
        maximumDistance = distance
      }
    }
    if (furthest >= 0) {
      keep[furthest] = 1
      ranges.push([start, furthest], [furthest, end])
    }
  }
  return points.filter((_, index) => keep[index] === 1)
}

function simplifyClosedPath(points: number[][], tolerance: number): number[][] {
  if (points.length <= 3) return points
  let split = 1
  let furthestDistance = 0
  for (let index = 1; index < points.length; index += 1) {
    const distance = Math.hypot(
      (points[index]?.[0] ?? 0) - (points[0]?.[0] ?? 0),
      (points[index]?.[1] ?? 0) - (points[0]?.[1] ?? 0),
    )
    if (distance > furthestDistance) {
      split = index
      furthestDistance = distance
    }
  }
  const firstHalf = simplifyOpenPath(points.slice(0, split + 1), tolerance)
  const secondHalf = simplifyOpenPath([...points.slice(split), points[0]!], tolerance)
  const simplified = [...firstHalf, ...secondHalf.slice(1, -1)]
  return simplified.length >= 3 ? simplified : points
}

/** Rasterize a CSS font face into a compact antialiased mask for contouring. */
export function rasterizeTextMask(
  text: string,
  cssFamily: string,
  settings: TextShapeSettings,
  canvasFactory: () => HTMLCanvasElement = () => document.createElement('canvas'),
): ScalarField | null {
  const normalized = text.replaceAll('\r', '')
  if (!normalized.trim()) return null

  const measureCanvas = canvasFactory()
  const measure = measureCanvas.getContext('2d', { willReadFrequently: true })
  if (!measure) throw new Error('This browser cannot prepare a text canvas.')

  const logicalFontSize = 180
  const logicalTracking = settings.tracking * logicalFontSize
  measure.font = `${logicalFontSize}px ${cssFamily}`
  measure.textBaseline = 'alphabetic'
  const lines = normalized.split('\n')
  const lineWidths = lines.map((line) => trackedWidth(measure, line, logicalTracking))
  const widest = Math.max(1, ...lineWidths)
  const lineStep = logicalFontSize * settings.lineHeight
  const padding = logicalFontSize * 0.3
  const logicalWidth = widest + padding * 2
  const logicalHeight = Math.max(logicalFontSize, (lines.length - 1) * lineStep + logicalFontSize) + padding * 2
  const targetLongSide = Math.min(720, Math.max(160, Math.round(settings.resolution)))
  const scale = targetLongSide / Math.max(logicalWidth, logicalHeight)
  const width = Math.max(24, Math.ceil(logicalWidth * scale))
  const height = Math.max(24, Math.ceil(logicalHeight * scale))

  const canvas = canvasFactory()
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('This browser cannot prepare a text canvas.')
  const fontSize = logicalFontSize * scale
  const tracking = logicalTracking * scale
  const scaledPadding = padding * scale
  context.clearRect(0, 0, width, height)
  context.fillStyle = '#ffffff'
  context.font = `${fontSize}px ${cssFamily}`
  context.textBaseline = 'alphabetic'
  context.textAlign = 'left'

  lines.forEach((line, index) => {
    const lineWidth = trackedWidth(context, line, tracking)
    const x = settings.alignment === 'left'
      ? scaledPadding
      : settings.alignment === 'right'
        ? width - scaledPadding - lineWidth
        : (width - lineWidth) / 2
    const baseline = scaledPadding + fontSize * 0.82 + index * lineStep * scale
    drawTrackedLine(context, line, x, baseline, tracking)
  })

  const pixels = context.getImageData(0, 0, width, height).data
  const values = new Float32Array(width * height)
  let hasInk = false
  for (let index = 0; index < values.length; index += 1) {
    const value = (pixels[index * 4 + 3] ?? 0) / 255
    values[index] = value
    if (value > 0.05) hasInk = true
  }
  return hasInk ? { width, height, values } : null
}

function simplifyRing(ring: number[][], tolerance = 0): number[][] {
  const openRing = ring.length > 1
    && ring[0]?.[0] === ring[ring.length - 1]?.[0]
    && ring[0]?.[1] === ring[ring.length - 1]?.[1]
    ? ring.slice(0, -1)
    : ring.slice()
  let points = openRing.filter((point, index) => {
    const previous = openRing[(index + openRing.length - 1) % openRing.length]
    return !previous
      || Math.hypot(
        (point[0] ?? 0) - (previous[0] ?? 0),
        (point[1] ?? 0) - (previous[1] ?? 0),
      ) > 1e-10
  })

  // Marching-squares contours contain long runs of collinear samples. Passing
  // every sample to Earcut creates zero-area cap triangles, so remove only
  // mathematically straight intermediate points before extrusion.
  let changed = true
  while (changed && points.length > 3) {
    changed = false
    const simplified: number[][] = []
    for (let index = 0; index < points.length; index += 1) {
      const previous = points[(index + points.length - 1) % points.length]!
      const current = points[index]!
      const next = points[(index + 1) % points.length]!
      const abX = (current[0] ?? 0) - (previous[0] ?? 0)
      const abY = (current[1] ?? 0) - (previous[1] ?? 0)
      const bcX = (next[0] ?? 0) - (current[0] ?? 0)
      const bcY = (next[1] ?? 0) - (current[1] ?? 0)
      if (Math.abs(abX * bcY - abY * bcX) <= 1e-10) changed = true
      else simplified.push(current)
    }
    if (simplified.length < 3) break
    points = simplified
  }
  return tolerance > 0 ? simplifyClosedPath(points, tolerance) : points
}

function ringPath(
  ring: number[][],
  width: number,
  height: number,
  scale: number,
  simplification: number,
): THREE.Path {
  const path = new THREE.Path()
  const points = simplifyRing(ring, simplification)
  points.forEach((point, index) => {
    const x = ((point[0] ?? 0) - width / 2) * scale
    const y = (height / 2 - (point[1] ?? 0)) * scale
    if (index === 0) path.moveTo(x, y)
    else path.lineTo(x, y)
  })
  path.closePath()
  return path
}

export function scalarFieldToShapes(
  field: ScalarField,
  threshold = 0.48,
  simplification = 0,
): THREE.Shape[] {
  const geometry = contours()
    .size([field.width, field.height])
    .smooth(true)
    .contour(Array.from(field.values), threshold)
  const scale = 2 / Math.max(field.width, field.height)
  const shapes: THREE.Shape[] = []

  for (const polygon of geometry.coordinates) {
    const outer = polygon[0]
    if (!outer || outer.length < 4) continue
    const outerPath = ringPath(outer, field.width, field.height, scale, simplification)
    const shape = new THREE.Shape()
    shape.curves = outerPath.curves
    shape.currentPoint.copy(outerPath.currentPoint)
    for (const hole of polygon.slice(1)) {
      if (hole.length >= 4) {
        shape.holes.push(ringPath(hole, field.width, field.height, scale, simplification))
      }
    }
    shapes.push(shape)
  }
  return shapes
}

interface GeometryDefects {
  boundaryEdges: number
  nonManifoldEdges: number
  degenerateFaces: number
}

interface TextGeometryCandidate {
  geometry: THREE.BufferGeometry
  defects: GeometryDefects
  threshold: number
}

interface TextGeometryChoice {
  best: TextGeometryCandidate
  perfect: boolean
}

function inspectGeometryDefects(geometry: THREE.BufferGeometry): GeometryDefects {
  const position = geometry.getAttribute('position')
  const index = geometry.getIndex()
  if (!index) return { boundaryEdges: 0, nonManifoldEdges: 0, degenerateFaces: 0 }
  const edgeIncidence = new Map<string, number>()
  let degenerateFaces = 0
  for (let offset = 0; offset < index.count; offset += 3) {
    const a = index.getX(offset)
    const b = index.getX(offset + 1)
    const c = index.getX(offset + 2)
    if (a === b || b === c || a === c) {
      degenerateFaces += 1
      continue
    }
    const ax = position.getX(a)
    const ay = position.getY(a)
    const az = position.getZ(a)
    const abX = position.getX(b) - ax
    const abY = position.getY(b) - ay
    const abZ = position.getZ(b) - az
    const acX = position.getX(c) - ax
    const acY = position.getY(c) - ay
    const acZ = position.getZ(c) - az
    const crossX = abY * acZ - abZ * acY
    const crossY = abZ * acX - abX * acZ
    const crossZ = abX * acY - abY * acX
    // These positions have already been serialized to Float32. A tiny but
    // positive triangle is a valid (if slender) manifold facet; only an
    // actually collapsed triangle should block STL export.
    if (crossX * crossX + crossY * crossY + crossZ * crossZ === 0) degenerateFaces += 1
    for (const [left, right] of [[a, b], [b, c], [c, a]] as const) {
      const key = left < right ? `${left}:${right}` : `${right}:${left}`
      edgeIncidence.set(key, (edgeIncidence.get(key) ?? 0) + 1)
    }
  }
  return {
    boundaryEdges: [...edgeIncidence.values()].filter((count) => count === 1).length,
    nonManifoldEdges: [...edgeIncidence.values()].filter((count) => count > 2).length,
    degenerateFaces,
  }
}

function extrudeTextGeometry(
  field: ScalarField,
  settings: TextShapeSettings,
  threshold: number,
  simplification = 0,
): THREE.BufferGeometry | null {
  const shapes = scalarFieldToShapes(field, threshold, simplification)
  if (shapes.length === 0) return null
  const raw = new THREE.ExtrudeGeometry(shapes, {
    depth: Math.max(0.02, settings.depth),
    steps: 1,
    bevelEnabled: settings.bevelSize > 0 && settings.bevelThickness > 0,
    bevelSize: Math.max(0, settings.bevelSize),
    bevelThickness: Math.max(0, settings.bevelThickness),
    bevelSegments: Math.max(1, Math.round(settings.bevelSegments)),
    curveSegments: 2,
  })
  raw.deleteAttribute('normal')
  raw.deleteAttribute('uv')
  // Keep welding extremely precise: glyph counters and tight joins can sit
  // very close together, and a broader tolerance can create non-manifold
  // edges even though the repeated contour seam itself is exact.
  const welded = mergeVertices(raw, 1e-6)
  raw.dispose()
  return welded
}

function chooseTextGeometry(
  current: TextGeometryCandidate | null,
  geometry: THREE.BufferGeometry,
  threshold: number,
): TextGeometryChoice {
  const defects = inspectGeometryDefects(geometry)
  const perfect = defects.boundaryEdges === 0
    && defects.nonManifoldEdges === 0
    && defects.degenerateFaces === 0
  const currentTopologyDefects = current
    ? current.defects.boundaryEdges + current.defects.nonManifoldEdges
    : Number.POSITIVE_INFINITY
  const topologyDefects = defects.boundaryEdges + defects.nonManifoldEdges
  const isBetter = !current
    || topologyDefects < currentTopologyDefects
    || (topologyDefects === currentTopologyDefects
      && defects.degenerateFaces < current.defects.degenerateFaces)

  if (isBetter) {
    current?.geometry.dispose()
    return { best: { geometry, defects, threshold }, perfect }
  }
  geometry.dispose()
  return { best: current, perfect }
}

function saferTextGeometry(
  field: ScalarField,
  settings: TextShapeSettings,
): THREE.BufferGeometry | null {
  // Alpha masks are sampled, so nearby iso-levels differ by far less than one
  // pixel. Only retry when a contour pinches into invalid STL topology.
  const hasAntialiasing = field.values.some((value) => value > 0 && value < 1)
  // Moving an iso-level cannot change a hard 0/1 mask, so avoid rebuilding the
  // same expensive geometry four times in that fallback case.
  const thresholds = hasAntialiasing ? [0.48, 0.49, 0.5, 0.46] : [0.48]
  let best: TextGeometryCandidate | null = null

  for (const threshold of thresholds) {
    const geometry = extrudeTextGeometry(field, settings, threshold)
    if (!geometry) continue
    const choice = chooseTextGeometry(best, geometry, threshold)
    best = choice.best
    if (choice.perfect) break
  }

  if (best && (best.defects.boundaryEdges > 0
    || best.defects.nonManifoldEdges > 0
    || best.defects.degenerateFaces > 0)) {
    // Perfectly hard raster contours can force Earcut to emit a collapsed cap
    // facet. Keep normal text untouched; only then retry the best iso-level
    // with progressively bounded, subpixel contour cleanup.
    const repairThreshold = best.threshold
    const topologyIsClosed = best.defects.boundaryEdges === 0
      && best.defects.nonManifoldEdges === 0
    const simplifications = topologyIsClosed ? [0.2, 1] : [0.1, 0.35, 1]
    for (const simplification of simplifications) {
      const geometry = extrudeTextGeometry(field, settings, repairThreshold, simplification)
      if (!geometry) continue
      const choice = chooseTextGeometry(best, geometry, repairThreshold)
      best = choice.best
      if (choice.perfect) break
    }
  }
  return best?.geometry ?? null
}

function sanitizedIndex(geometry: THREE.BufferGeometry): Uint32Array {
  const source = geometry.getIndex()
  if (!source) throw new Error('Text geometry could not be indexed.')
  const indices: number[] = []
  for (let offset = 0; offset < source.count; offset += 3) {
    const a = source.getX(offset)
    const b = source.getX(offset + 1)
    const c = source.getX(offset + 2)
    if (a === b || b === c || a === c) continue
    indices.push(a, b, c)
  }
  return new Uint32Array(indices)
}

/** Convert a text mask to the same indexed MeshData contract used by image reliefs. */
export function buildTextMeshFromField(
  sourceField: ScalarField,
  settings: TextShapeSettings,
): MeshData | null {
  const field = processScalarField(sourceField, {
    invert: false,
    blur: 0,
    contrast: 0,
    quantize: 0,
    finish: settings.finish,
    blobDilation: settings.blobDilation,
    blobSmoothing: settings.blobSmoothing,
  })
  const welded = saferTextGeometry(field, settings)
  if (!welded) return null
  welded.computeBoundingBox()
  const bounds = welded.boundingBox
  if (!bounds) {
    welded.dispose()
    return null
  }
  const position = welded.getAttribute('position')
  const centerX = (bounds.min.x + bounds.max.x) / 2
  const centerY = (bounds.min.y + bounds.max.y) / 2
  const centerZ = (bounds.min.z + bounds.max.z) / 2
  const zRange = Math.max(1e-6, bounds.max.z - bounds.min.z)
  const positions = new Float32Array(position.count * 3)
  const colors = new Float32Array(position.count * 3)
  const uvs = new Float32Array(position.count * 2)
  const heights = new Float32Array(position.count)
  const xRange = Math.max(1e-6, bounds.max.x - bounds.min.x)
  const yRange = Math.max(1e-6, bounds.max.y - bounds.min.y)

  for (let index = 0; index < position.count; index += 1) {
    const x = position.getX(index)
    const y = position.getY(index)
    const z = position.getZ(index)
    positions[index * 3] = x - centerX
    positions[index * 3 + 1] = y - centerY
    positions[index * 3 + 2] = z - centerZ
    colors[index * 3] = 0.88
    colors[index * 3 + 1] = 0.88
    colors[index * 3 + 2] = 0.88
    uvs[index * 2] = (x - bounds.min.x) / xRange
    uvs[index * 2 + 1] = (y - bounds.min.y) / yRange
    heights[index] = (z - bounds.min.z) / zRange
  }
  const indices = sanitizedIndex(welded)
  welded.dispose()
  if (indices.length === 0) return null

  return {
    positions,
    indices,
    colors,
    uvs,
    heights,
    width: sourceField.width,
    height: sourceField.height,
    mode: 'solid',
  }
}

export function createTextMesh(
  text: string,
  cssFamily: string,
  settings: TextShapeSettings,
  canvasFactory?: () => HTMLCanvasElement,
): TextMeshResult | null {
  const sourceField = rasterizeTextMask(text, cssFamily, settings, canvasFactory)
  if (!sourceField) return null
  const processedField = processScalarField(sourceField, {
    invert: false,
    blur: 0,
    contrast: 0,
    quantize: 0,
    finish: settings.finish,
    blobDilation: settings.blobDilation,
    blobSmoothing: settings.blobSmoothing,
  })
  const mesh = buildTextMeshFromField(sourceField, settings)
  return mesh ? { field: processedField, mesh } : null
}
