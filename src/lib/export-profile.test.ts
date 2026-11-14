import { describe, expect, it } from 'vitest'
import { fitWebImageDimensions } from './export-profile'

describe('web export dimensions', () => {
  it.each([
    [6000, 4000, 2048, 1365],
    [1500, 3000, 1024, 2048],
    [2048, 2048, 2048, 2048],
    [360, 270, 360, 270],
    [1, 10000, 1, 2048],
  ])('fits %i × %i within the output limit', (width, height, expectedWidth, expectedHeight) => {
    expect(fitWebImageDimensions({ width, height })).toEqual({ width: expectedWidth, height: expectedHeight })
  })
})
