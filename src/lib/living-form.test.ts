import { describe, expect, it } from 'vitest'
import type { MeshData } from '../types'
import {
  LIVING_FORM_BEHAVIORS,
  animateLivingFormMesh,
  createLivingFormEngine,
  normalizeLivingFormPhase,
  type LivingFormBehavior,
} from './living-form'

function meshFixture(): MeshData {
  return {
    positions: new Float32Array([
      -1, 1, 0.05,
      0, 1, 0.2,
      1, 1, 0.1,
      -1, 0, 0.25,
      0, 0, 0.65,
      1, 0, 0.35,
      -1, -1, 0,
      0, -1, 0.3,
      1, -1, 0.15,
    ]),
    indices: new Uint32Array([
      0, 3, 1, 1, 3, 4,
      1, 4, 2, 2, 4, 5,
      3, 6, 4, 4, 6, 7,
      4, 7, 5, 5, 7, 8,
    ]),
    colors: new Float32Array([
      1, 0, 0, 0.5, 0.1, 0, 0, 1, 0,
      0.8, 0.2, 0.1, 1, 1, 1, 0.1, 0.2, 0.8,
      0, 0, 1, 0.2, 0.8, 0.4, 0.7, 0.4, 0.9,
    ]),
    uvs: new Float32Array([
      0, 1, 0.5, 1, 1, 1,
      0, 0.5, 0.5, 0.5, 1, 0.5,
      0, 0, 0.5, 0, 1, 0,
    ]),
    heights: new Float32Array([0.05, 0.2, 0.1, 0.25, 0.65, 0.35, 0, 0.3, 0.15]),
    width: 2,
    height: 2,
    mode: 'plane',
  }
}

function maximumDelta(left: Float32Array, right: Float32Array): number {
  let result = 0
  for (let index = 0; index < left.length; index += 1) {
    result = Math.max(result, Math.abs(left[index] - right[index]))
  }
  return result
}

describe('Living Form motion engine', () => {
  it('wraps timeline values onto one canonical phase', () => {
    expect(normalizeLivingFormPhase(0)).toBe(0)
    expect(normalizeLivingFormPhase(1)).toBe(0)
    expect(normalizeLivingFormPhase(3.25)).toBe(0.25)
    expect(normalizeLivingFormPhase(-0.25)).toBe(0.75)
    expect(() => normalizeLivingFormPhase(Number.NaN)).toThrow(/finite/)
  })

  it.each(LIVING_FORM_BEHAVIORS)('%s is exactly seamless at phases zero and one', (behavior) => {
    const engine = createLivingFormEngine(meshFixture())
    const settings = { behavior, amount: 0.83, frequency: 2.35, seed: 19 }
    expect(engine.samplePositions(1, settings)).toEqual(engine.samplePositions(0, settings))
    expect(engine.samplePositions(2.375, settings)).toEqual(engine.samplePositions(0.375, settings))
  })

  it('never mutates or aliases the source mesh', () => {
    const source = meshFixture()
    const original = {
      positions: source.positions.slice(),
      indices: source.indices.slice(),
      colors: source.colors.slice(),
      uvs: source.uvs.slice(),
      heights: source.heights.slice(),
    }
    const frame = animateLivingFormMesh(source, 0.31, {
      behavior: 'flow',
      amount: 0.9,
      frequency: 3,
      seed: 42,
    })

    expect(source.positions).toEqual(original.positions)
    expect(source.indices).toEqual(original.indices)
    expect(source.colors).toEqual(original.colors)
    expect(source.uvs).toEqual(original.uvs)
    expect(source.heights).toEqual(original.heights)
    expect(frame.positions).not.toBe(source.positions)
    expect(frame.indices).not.toBe(source.indices)
    expect(frame.colors).not.toBe(source.colors)
    expect(frame.uvs).not.toBe(source.uvs)
    expect(frame.heights).not.toBe(source.heights)
  })

  it('preserves topology, colors, UVs, heights, dimensions, and mode exactly', () => {
    const source = meshFixture()
    const frame = createLivingFormEngine(source).sampleMesh(0.47, {
      behavior: 'ripple',
      amount: 0.75,
    })

    expect(frame.indices).toEqual(source.indices)
    expect(frame.colors).toEqual(source.colors)
    expect(frame.uvs).toEqual(source.uvs)
    expect(frame.heights).toEqual(source.heights)
    expect(frame.width).toBe(source.width)
    expect(frame.height).toBe(source.height)
    expect(frame.mode).toBe(source.mode)
  })

  it.each([
    ['breathe', 0.25],
    ['ripple', 0.31],
    ['flow', 0.43],
    ['melt', 0.5],
  ] as const)('%s creates meaningful deformation', (behavior, phase) => {
    const source = meshFixture()
    const positions = createLivingFormEngine(source).samplePositions(phase, {
      behavior,
      amount: 0.8,
      frequency: 2,
      seed: 7,
    })
    expect(maximumDelta(positions, source.positions)).toBeGreaterThan(0.01)
  })

  it('samples every frame from the base snapshot, even when an output buffer is reused', () => {
    const source = meshFixture()
    const engine = createLivingFormEngine(source)
    const target = new Float32Array(source.positions.length)
    const settings = { behavior: 'flow' as const, amount: 0.7, frequency: 2.2, seed: 4 }

    engine.writePositions(target, 0.2, settings)
    const first = target.slice()
    engine.writePositions(target, 0.73, settings)
    engine.writePositions(target, 0.2, settings)

    expect(target).toEqual(first)
    expect(() => engine.writePositions(source.positions, 0.2, settings)).toThrow(/source mesh/)
    expect(source.positions).toEqual(meshFixture().positions)
  })

  it('is deterministic and emits finite values for every behavior and representative phase', () => {
    const engine = createLivingFormEngine(meshFixture())
    const phases = [-1.2, 0, 0.125, 0.5, 0.999, 4.4]

    for (const behavior of LIVING_FORM_BEHAVIORS) {
      for (const phase of phases) {
        const settings = {
          behavior,
          amount: Number.POSITIVE_INFINITY,
          frequency: Number.NaN,
          seed: Number.NEGATIVE_INFINITY,
        }
        const first = engine.samplePositions(phase, settings)
        const second = engine.samplePositions(phase, settings)
        expect(first).toEqual(second)
        expect([...first].every(Number.isFinite)).toBe(true)
      }
    }
  })

  it.each(LIVING_FORM_BEHAVIORS)('%s returns the exact base at zero amount', (behavior) => {
    const source = meshFixture()
    const positions = createLivingFormEngine(source).samplePositions(0.42, {
      behavior: behavior as LivingFormBehavior,
      amount: 0,
    })
    expect(positions).toEqual(source.positions)
  })

  it('snapshots its source so later outside edits cannot alter the animation', () => {
    const source = meshFixture()
    const engine = createLivingFormEngine(source)
    const before = engine.samplePositions(0.33, { behavior: 'ripple', amount: 0.8 })
    source.positions.fill(99)
    source.heights.fill(1)
    const after = engine.samplePositions(0.33, { behavior: 'ripple', amount: 0.8 })
    expect(after).toEqual(before)
  })
})
