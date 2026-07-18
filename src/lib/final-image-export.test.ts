import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { createDefaultAppearanceSettings } from './three'
import {
  calculateFinalRenderTiles,
  applyFinalTileView,
  FINAL_DENOISE_PADDING,
  finalSampleTarget,
} from './final-image-export'

describe('final image export contract', () => {
  it('covers every output pixel once while keeping denoise gutters inside the image', () => {
    const width = 2305
    const height = 1537
    const padding = FINAL_DENOISE_PADDING
    const tiles = calculateFinalRenderTiles(width, height, 1024, padding)
    const coverage = new Uint8Array(width * height)

    for (const tile of tiles) {
      expect(tile.renderX).toBeGreaterThanOrEqual(0)
      expect(tile.renderY).toBeGreaterThanOrEqual(0)
      expect(tile.renderX + tile.renderWidth).toBeLessThanOrEqual(width)
      expect(tile.renderY + tile.renderHeight).toBeLessThanOrEqual(height)
      expect(tile.sourceX + tile.width).toBeLessThanOrEqual(tile.renderWidth)
      expect(tile.sourceY + tile.height).toBeLessThanOrEqual(tile.renderHeight)
      for (let y = tile.y; y < tile.y + tile.height; y += 1) {
        for (let x = tile.x; x < tile.x + tile.width; x += 1) coverage[y * width + x] += 1
      }
    }

    expect(tiles).toHaveLength(6)
    expect(coverage.every((count) => count === 1)).toBe(true)
    const left = tiles[0]!
    const right = tiles[1]!
    expect(left.renderX + left.renderWidth - right.renderX).toBe(padding * 2)
  })

  it('uses high-quality sampling with extra samples for reflective clay', () => {
    const appearance = createDefaultAppearanceSettings()
    expect(finalSampleTarget('original', appearance)).toBe(1536)
    expect(finalSampleTarget('height', appearance)).toBe(1536)
    expect(finalSampleTarget('clay', appearance)).toBe(1536)

    appearance.clay.finish = 'glossy'
    expect(finalSampleTarget('clay', appearance)).toBe(2048)
    appearance.clay.finish = 'metallic'
    expect(finalSampleTarget('clay', appearance)).toBe(2048)
  })

  it('applies every padded tile coordinate to the camera exactly once', () => {
    const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 100)
    const tile = calculateFinalRenderTiles(4096, 2560, 1024, 4)[5]!
    applyFinalTileView(camera, 4096, 2560, tile)

    expect(camera.aspect).toBe(1.6)
    expect(camera.view).toMatchObject({
      fullWidth: 4096,
      fullHeight: 2560,
      offsetX: tile.renderX,
      offsetY: tile.renderY,
      width: tile.renderWidth,
      height: tile.renderHeight,
    })
  })
})
