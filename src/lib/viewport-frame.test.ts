import { describe, expect, it } from 'vitest'
import { fitViewportFrame } from './viewport-frame'

describe('bounded viewport framing', () => {
  it('fits landscape, portrait, and square ratios inside both axes', () => {
    expect(fitViewportFrame(16 / 9, 1200, 600)).toEqual({ width: 1067, height: 600 })
    expect(fitViewportFrame(9 / 16, 1200, 600)).toEqual({ width: 338, height: 600 })
    expect(fitViewportFrame(1, 1200, 600)).toEqual({ width: 600, height: 600 })
  })

  it('uses the width bound when it is the limiting axis', () => {
    expect(fitViewportFrame(16 / 9, 500, 900)).toEqual({ width: 500, height: 281 })
    expect(fitViewportFrame(1 / 2, 320, 1000)).toEqual({ width: 320, height: 640 })
  })

  it('rounds to whole pixels while preserving the requested ratio', () => {
    const frame = fitViewportFrame(4 / 3, 997.9, 613.8)

    expect(frame).toEqual({ width: 817, height: 613 })
    expect(Math.abs(frame.width - frame.height * (4 / 3))).toBeLessThanOrEqual(0.5)
    expect(Number.isInteger(frame.width)).toBe(true)
    expect(Number.isInteger(frame.height)).toBe(true)
  })

  it('never exceeds sanitized bounds for extreme ratios', () => {
    expect(fitViewportFrame(1e12, 640, 480)).toEqual({ width: 640, height: 1 })
    expect(fitViewportFrame(1e-12, 640, 480)).toEqual({ width: 1, height: 480 })
  })

  it('falls back safely for invalid ratios and bounds', () => {
    expect(fitViewportFrame(Number.NaN, 640, 480)).toEqual({ width: 480, height: 480 })
    expect(fitViewportFrame(0, Number.POSITIVE_INFINITY, -20)).toEqual({ width: 1, height: 1 })
    expect(fitViewportFrame(-2, Number.NaN, Number.NaN)).toEqual({ width: 1, height: 1 })
    expect(fitViewportFrame(2, 0.5, 0.25)).toEqual({ width: 1, height: 1 })
  })
})
