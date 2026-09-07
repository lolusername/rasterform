import { describe, expect, it } from 'vitest'
import { exportProfile, imageDimensionsForEdition } from './export-profile'

describe('edition export policy', () => {
  it('restricts browser exports to images with a 2K maximum', () => {
    expect(exportProfile(false)).toEqual({
      modelFiles: false, defaultStillEdge: 2048, stillEdges: [2048], loopEdges: [2048],
    })
    expect(imageDimensionsForEdition({ width: 6000, height: 4000 }, false))
      .toEqual({ width: 2048, height: 1365 })
    expect(imageDimensionsForEdition({ width: 1500, height: 3000 }, false))
      .toEqual({ width: 1024, height: 2048 })
  })

  it('retains small source dimensions and all desktop export choices', () => {
    expect(imageDimensionsForEdition({ width: 360, height: 270 }, false))
      .toEqual({ width: 360, height: 270 })
    expect(exportProfile(true)).toEqual({
      modelFiles: true, defaultStillEdge: 4096, stillEdges: [2048, 4096, 8192], loopEdges: [2048, 4096],
    })
    expect(imageDimensionsForEdition({ width: 6000, height: 4000 }, true))
      .toEqual({ width: 6000, height: 4000 })
  })
})
