import { describe, expect, it } from 'vitest'
import { initialEditorWindowBounds } from './window-bounds'

describe('native editor window fits the available display', () => {
  it('centers the preferred window inside a roomy display', () => {
    expect(initialEditorWindowBounds({ x: 0, y: 25, width: 1920, height: 1055 }))
      .toEqual({ x: 240, y: 82, width: 1440, height: 940, minWidth: 360, minHeight: 240 })
  })
  it.each([
    { x: 0, y: 25, width: 1280, height: 695 },
    { x: -1280, y: -700, width: 1280, height: 620 },
    { x: 0, y: 0, width: 320, height: 200 },
    { x: 1920, y: 0, width: 1080, height: 1920 },
  ])('never makes initial or minimum size exceed $width×$height work area', (area) => {
    const bounds = initialEditorWindowBounds(area)
    expect(bounds.width).toBeLessThanOrEqual(area.width)
    expect(bounds.height).toBeLessThanOrEqual(area.height)
    expect(bounds.minWidth).toBeLessThanOrEqual(bounds.width)
    expect(bounds.minHeight).toBeLessThanOrEqual(bounds.height)
    expect(bounds.x).toBeGreaterThanOrEqual(area.x)
    expect(bounds.y).toBeGreaterThanOrEqual(area.y)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(area.x + area.width)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(area.y + area.height)
  })
})
