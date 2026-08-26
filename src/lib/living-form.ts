import type { LivingFormBehavior, LivingFormSettings, MeshData } from '../types'

export type { LivingFormBehavior, LivingFormSettings } from '../types'

const TAU = Math.PI * 2
const MIN_EXTENT = 1e-6

export const LIVING_FORM_BEHAVIORS = ['breathe', 'ripple', 'flow', 'melt'] as const

export interface LivingFormBounds {
  readonly min: readonly [number, number, number]
  readonly max: readonly [number, number, number]
  readonly center: readonly [number, number, number]
  readonly extent: number
}

export interface LivingFormEngine {
  readonly vertexCount: number
  readonly bounds: LivingFormBounds
  /** Returns a new positions array and never mutates the source mesh. */
  samplePositions(phase: number, settings?: Partial<LivingFormSettings>): Float32Array
  /**
   * Writes a frame into a caller-owned buffer. Reusing the same buffer is safe:
   * every sample is derived from the engine's private base snapshot, never the
   * previous frame.
   */
  writePositions(
    target: Float32Array,
    phase: number,
    settings?: Partial<LivingFormSettings>,
  ): Float32Array
  /** Returns a fully independent mesh snapshot suitable for frame export. */
  sampleMesh(phase: number, settings?: Partial<LivingFormSettings>): MeshData
}

export const DEFAULT_LIVING_FORM_SETTINGS: Readonly<LivingFormSettings> = Object.freeze({
  enabled: false,
  behavior: 'breathe',
  amount: 0.5,
  frequency: 1.5,
  seed: 0,
  duration: 4,
})

interface PreparedGeometry {
  readonly positions: Float32Array
  readonly indices: Uint32Array
  readonly colors: Float32Array
  readonly uvs: Float32Array
  readonly heights: Float32Array
  readonly normals: Float32Array
  readonly normalized: Float32Array
  readonly bounds: LivingFormBounds
  readonly width: number
  readonly height: number
  readonly mode: MeshData['mode']
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function finiteOr(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : value
}

function resolveSettings(settings: Partial<LivingFormSettings> = {}): LivingFormSettings {
  const behavior = LIVING_FORM_BEHAVIORS.includes(settings.behavior as LivingFormBehavior)
    ? settings.behavior as LivingFormBehavior
    : DEFAULT_LIVING_FORM_SETTINGS.behavior

  return {
    enabled: settings.enabled === true,
    behavior,
    amount: clamp(finiteOr(settings.amount, DEFAULT_LIVING_FORM_SETTINGS.amount), 0, 1),
    frequency: clamp(finiteOr(settings.frequency, DEFAULT_LIVING_FORM_SETTINGS.frequency), 0.25, 8),
    seed: finiteOr(settings.seed, DEFAULT_LIVING_FORM_SETTINGS.seed) % 4096,
    duration: clamp(finiteOr(settings.duration, DEFAULT_LIVING_FORM_SETTINGS.duration), 1, 12),
  }
}

/** Wraps any finite timeline value onto the canonical loop interval [0, 1). */
export function normalizeLivingFormPhase(phase: number): number {
  if (!Number.isFinite(phase)) throw new RangeError('Living Form phase must be finite.')
  const wrapped = phase % 1
  if (wrapped === 0) return 0
  return wrapped < 0 ? wrapped + 1 : wrapped
}

function assertFiniteArray(label: string, values: Float32Array): void {
  for (let index = 0; index < values.length; index += 1) {
    if (!Number.isFinite(values[index])) {
      throw new TypeError(`Living Form source ${label} contains a non-finite value at index ${index}.`)
    }
  }
}

function assertMesh(mesh: MeshData): number {
  if (mesh.positions.length === 0 || mesh.positions.length % 3 !== 0) {
    throw new TypeError('Living Form requires a non-empty mesh with XYZ positions.')
  }

  const vertexCount = mesh.positions.length / 3
  if (mesh.indices.length % 3 !== 0) {
    throw new TypeError('Living Form requires triangle indices.')
  }
  if (mesh.colors.length !== vertexCount * 3) {
    throw new TypeError('Living Form source colors do not match its vertex count.')
  }
  if (mesh.uvs.length !== vertexCount * 2) {
    throw new TypeError('Living Form source UVs do not match its vertex count.')
  }
  if (mesh.heights.length !== vertexCount) {
    throw new TypeError('Living Form source heights do not match its vertex count.')
  }

  assertFiniteArray('positions', mesh.positions)
  assertFiniteArray('colors', mesh.colors)
  assertFiniteArray('UVs', mesh.uvs)
  assertFiniteArray('heights', mesh.heights)

  for (let index = 0; index < mesh.indices.length; index += 1) {
    if (mesh.indices[index] >= vertexCount) {
      throw new RangeError(`Living Form source index ${index} is outside the vertex range.`)
    }
  }
  return vertexCount
}

function calculateBounds(positions: Float32Array): LivingFormBounds {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY

  for (let index = 0; index < positions.length; index += 3) {
    minX = Math.min(minX, positions[index])
    minY = Math.min(minY, positions[index + 1])
    minZ = Math.min(minZ, positions[index + 2])
    maxX = Math.max(maxX, positions[index])
    maxY = Math.max(maxY, positions[index + 1])
    maxZ = Math.max(maxZ, positions[index + 2])
  }

  const center = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2] as const
  const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ, MIN_EXTENT)
  return Object.freeze({
    min: Object.freeze([minX, minY, minZ] as const),
    max: Object.freeze([maxX, maxY, maxZ] as const),
    center: Object.freeze(center),
    extent,
  })
}

function calculateNormals(
  positions: Float32Array,
  indices: Uint32Array,
  center: readonly [number, number, number],
): Float32Array {
  const normals = new Float32Array(positions.length)

  for (let index = 0; index < indices.length; index += 3) {
    const ia = indices[index] * 3
    const ib = indices[index + 1] * 3
    const ic = indices[index + 2] * 3
    const abX = positions[ib] - positions[ia]
    const abY = positions[ib + 1] - positions[ia + 1]
    const abZ = positions[ib + 2] - positions[ia + 2]
    const acX = positions[ic] - positions[ia]
    const acY = positions[ic + 1] - positions[ia + 1]
    const acZ = positions[ic + 2] - positions[ia + 2]
    const normalX = abY * acZ - abZ * acY
    const normalY = abZ * acX - abX * acZ
    const normalZ = abX * acY - abY * acX

    normals[ia] += normalX
    normals[ia + 1] += normalY
    normals[ia + 2] += normalZ
    normals[ib] += normalX
    normals[ib + 1] += normalY
    normals[ib + 2] += normalZ
    normals[ic] += normalX
    normals[ic + 1] += normalY
    normals[ic + 2] += normalZ
  }

  for (let index = 0; index < normals.length; index += 3) {
    let normalX = normals[index]
    let normalY = normals[index + 1]
    let normalZ = normals[index + 2]
    let length = Math.hypot(normalX, normalY, normalZ)

    if (length < MIN_EXTENT) {
      normalX = positions[index] - center[0]
      normalY = positions[index + 1] - center[1]
      normalZ = positions[index + 2] - center[2]
      length = Math.hypot(normalX, normalY, normalZ)
      if (length < MIN_EXTENT) {
        normalX = 0
        normalY = 0
        normalZ = 1
        length = 1
      }
    }

    normals[index] = normalX / length
    normals[index + 1] = normalY / length
    normals[index + 2] = normalZ / length
  }
  return normals
}

function prepareGeometry(mesh: MeshData): PreparedGeometry {
  assertMesh(mesh)
  const positions = mesh.positions.slice()
  const indices = mesh.indices.slice()
  const bounds = calculateBounds(positions)
  const normals = calculateNormals(positions, indices, bounds.center)
  const normalized = new Float32Array(positions.length)

  for (let index = 0; index < positions.length; index += 3) {
    normalized[index] = (positions[index] - bounds.center[0]) / bounds.extent
    normalized[index + 1] = (positions[index + 1] - bounds.center[1]) / bounds.extent
    normalized[index + 2] = (positions[index + 2] - bounds.center[2]) / bounds.extent
  }

  return {
    positions,
    indices,
    colors: mesh.colors.slice(),
    uvs: mesh.uvs.slice(),
    heights: mesh.heights.slice(),
    normals,
    normalized,
    bounds,
    width: mesh.width,
    height: mesh.height,
    mode: mesh.mode,
  }
}

function breatheVertex(
  target: Float32Array,
  offset: number,
  source: PreparedGeometry,
  phase: number,
  settings: LivingFormSettings,
): void {
  const x = source.positions[offset]
  const y = source.positions[offset + 1]
  const z = source.positions[offset + 2]
  const nx = source.normalized[offset]
  const ny = source.normalized[offset + 1]
  const nz = source.normalized[offset + 2]
  const normalX = source.normals[offset]
  const normalY = source.normals[offset + 1]
  const normalZ = source.normals[offset + 2]
  const height = clamp(source.heights[offset / 3], 0, 1)
  const pulse = Math.sin(TAU * phase)

  if (pulse === 0 || settings.amount === 0) {
    target[offset] = x
    target[offset + 1] = y
    target[offset + 2] = z
    return
  }

  const seedPhase = settings.seed * 0.754877666
  const organic = 0.76 + 0.24 * Math.sin(TAU * (
    settings.frequency * (nx * 0.61 + ny * 0.37 + nz * 0.19) + seedPhase
  ))
  const normalOffset = source.bounds.extent * 0.095 * settings.amount * pulse
    * organic * (0.68 + height * 0.32)
  const radialScale = 1 + settings.amount * 0.035 * pulse

  target[offset] = source.bounds.center[0] + (x - source.bounds.center[0]) * radialScale + normalX * normalOffset
  target[offset + 1] = source.bounds.center[1] + (y - source.bounds.center[1]) * radialScale + normalY * normalOffset
  target[offset + 2] = source.bounds.center[2] + (z - source.bounds.center[2]) * radialScale + normalZ * normalOffset
}

function rippleVertex(
  target: Float32Array,
  offset: number,
  source: PreparedGeometry,
  phase: number,
  settings: LivingFormSettings,
): void {
  const nx = source.normalized[offset]
  const ny = source.normalized[offset + 1]
  const nz = source.normalized[offset + 2]
  const radius = Math.hypot(nx, ny)
  const seedPhase = settings.seed * 0.618033989
  const wave = Math.sin(TAU * (settings.frequency * radius - phase + seedPhase))
  const crossWave = Math.sin(TAU * (
    settings.frequency * (nx * 0.47 - ny * 0.73 + nz * 0.2) + phase * 2 + seedPhase * 0.37
  ))
  const envelope = clamp(1.15 - radius, 0.3, 1)
  const displacement = source.bounds.extent * 0.085 * settings.amount
    * (wave * 0.78 + crossWave * 0.22) * envelope

  target[offset] = source.positions[offset] + source.normals[offset] * displacement
  target[offset + 1] = source.positions[offset + 1] + source.normals[offset + 1] * displacement
  target[offset + 2] = source.positions[offset + 2] + source.normals[offset + 2] * displacement
}

function flowVertex(
  target: Float32Array,
  offset: number,
  source: PreparedGeometry,
  phase: number,
  settings: LivingFormSettings,
): void {
  const nx = source.normalized[offset]
  const ny = source.normalized[offset + 1]
  const nz = source.normalized[offset + 2]
  const time = TAU * phase
  const seedPhase = settings.seed * 1.324717957
  const fieldA = Math.sin(TAU * settings.frequency * (nx * 0.71 + ny * 0.29 + nz * 0.17) + time + seedPhase)
  const fieldB = Math.cos(TAU * settings.frequency * (-nx * 0.23 + ny * 0.79 + nz * 0.41) - time + seedPhase * 1.7)
  const fieldC = Math.sin(TAU * settings.frequency * (nx * 0.31 - ny * 0.43 + nz * 0.83) + time * 2 - seedPhase * 0.6)
  const displacement = source.bounds.extent * 0.055 * settings.amount
  const normalDisplacement = displacement * (fieldA * 0.52 + fieldB * 0.31 + fieldC * 0.17)

  target[offset] = source.positions[offset]
    + displacement * (fieldB * 0.72 - fieldC * 0.28)
    + source.normals[offset] * normalDisplacement
  target[offset + 1] = source.positions[offset + 1]
    + displacement * (fieldC * 0.64 + fieldA * 0.36)
    + source.normals[offset + 1] * normalDisplacement
  target[offset + 2] = source.positions[offset + 2]
    + displacement * (fieldA * 0.57 - fieldB * 0.23)
    + source.normals[offset + 2] * normalDisplacement
}

function meltVertex(
  target: Float32Array,
  offset: number,
  source: PreparedGeometry,
  phase: number,
  settings: LivingFormSettings,
): void {
  const x = source.positions[offset]
  const y = source.positions[offset + 1]
  const z = source.positions[offset + 2]
  const nx = source.normalized[offset]
  const ny = source.normalized[offset + 1]
  const nz = source.normalized[offset + 2]
  const envelope = 0.5 - 0.5 * Math.cos(TAU * phase)

  if (envelope === 0 || settings.amount === 0) {
    target[offset] = x
    target[offset + 1] = y
    target[offset + 2] = z
    return
  }

  const seedPhase = settings.seed * 0.569840291
  const organic = 0.68 + 0.32 * Math.sin(TAU * (
    settings.frequency * (nx * 0.53 + ny * 0.31 + nz * 0.16) + seedPhase + phase
  ))
  const topWeight = clamp(ny + 0.5, 0, 1)
  const droop = source.bounds.extent * 0.17 * settings.amount * envelope
    * (0.28 + topWeight * 0.72) * organic
  const spread = source.bounds.extent * 0.035 * settings.amount * envelope

  target[offset] = x + spread * Math.sin(TAU * (settings.frequency * ny + seedPhase))
  target[offset + 1] = y - droop
  target[offset + 2] = z
    + source.normals[offset + 2] * spread * (0.5 + organic * 0.5)
}

function writeFrame(
  target: Float32Array,
  source: PreparedGeometry,
  phase: number,
  settings: Partial<LivingFormSettings> = {},
): Float32Array {
  if (target.length !== source.positions.length) {
    throw new RangeError(`Living Form target requires ${source.positions.length} position values.`)
  }

  const loopPhase = normalizeLivingFormPhase(phase)
  const resolved = resolveSettings(settings)
  for (let offset = 0; offset < source.positions.length; offset += 3) {
    switch (resolved.behavior) {
      case 'breathe':
        breatheVertex(target, offset, source, loopPhase, resolved)
        break
      case 'ripple':
        rippleVertex(target, offset, source, loopPhase, resolved)
        break
      case 'flow':
        flowVertex(target, offset, source, loopPhase, resolved)
        break
      case 'melt':
        meltVertex(target, offset, source, loopPhase, resolved)
        break
    }
  }
  return target
}

/**
 * Compiles an immutable snapshot once, making subsequent samples inexpensive and
 * deterministic for both realtime preview and offline frame export.
 */
export function createLivingFormEngine(mesh: MeshData): LivingFormEngine {
  const protectedSourcePositions = mesh.positions
  const source = prepareGeometry(mesh)

  const writePositions = (
    target: Float32Array,
    phase: number,
    settings: Partial<LivingFormSettings> = {},
  ): Float32Array => {
    if (target === protectedSourcePositions) {
      throw new TypeError('Living Form will not overwrite its source mesh positions.')
    }
    return writeFrame(target, source, phase, settings)
  }

  return Object.freeze({
    vertexCount: source.positions.length / 3,
    bounds: source.bounds,
    samplePositions(phase: number, settings: Partial<LivingFormSettings> = {}) {
      return writeFrame(new Float32Array(source.positions.length), source, phase, settings)
    },
    writePositions,
    sampleMesh(phase: number, settings: Partial<LivingFormSettings> = {}) {
      return {
        positions: writeFrame(new Float32Array(source.positions.length), source, phase, settings),
        indices: source.indices.slice(),
        colors: source.colors.slice(),
        uvs: source.uvs.slice(),
        heights: source.heights.slice(),
        width: source.width,
        height: source.height,
        mode: source.mode,
      }
    },
  })
}

/** Convenience one-shot API. Reuse createLivingFormEngine for animation playback. */
export function animateLivingFormMesh(
  mesh: MeshData,
  phase: number,
  settings: Partial<LivingFormSettings> = {},
): MeshData {
  return createLivingFormEngine(mesh).sampleMesh(phase, settings)
}
