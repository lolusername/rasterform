import { describe, expect, it } from 'vitest'
import {
  VIEWPORT_BACKGROUNDS,
  isViewportBackground,
  viewportBackgroundFromShortcut,
  viewportBackgroundPreset,
} from './background'

describe('viewport backgrounds', () => {
  it('provides the three neutral Lightroom-style choices', () => {
    expect(VIEWPORT_BACKGROUNDS.map(({ value, color }) => [value, color])).toEqual([
      ['white', '#ffffff'],
      ['dark-gray', '#343434'],
      ['black', '#000000'],
    ])
  })

  it('maps direct keyboard shortcuts without caring about key case', () => {
    expect(viewportBackgroundFromShortcut('w')).toBe('white')
    expect(viewportBackgroundFromShortcut('G')).toBe('dark-gray')
    expect(viewportBackgroundFromShortcut('b')).toBe('black')
    expect(viewportBackgroundFromShortcut('x')).toBeNull()
  })

  it('validates persisted values and safely falls back to dark gray', () => {
    expect(isViewportBackground('black')).toBe(true)
    expect(isViewportBackground('studio')).toBe(false)
    expect(viewportBackgroundPreset('white').hex).toBe(0xffffff)
    expect(viewportBackgroundPreset('invalid' as never).value).toBe('dark-gray')
  })
})
