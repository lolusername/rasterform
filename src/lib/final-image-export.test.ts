import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import * as PathTracerModule from 'three-gpu-pathtracer'
import { createDefaultAppearanceSettings } from './three'
import {
  calculateFinalRenderTiles,
  applyFinalTileView,
  awaitExportTask,
  configureFinalPathTracerIntegrity,
  configureFinalShaderCompilation,
  createFinalProgressReporter,
  FINAL_BATCH_BUDGET_MS,
  FINAL_DENOISE_SETTINGS,
  FINAL_DENOISE_PADDING,
  FINAL_PATH_TRACER_TILES,
  FINAL_PROGRESS_INTERVAL_MS,
  FINAL_RANDOM_TYPE_PCG,
  finalSampleTarget,
  type FinalExportProgress,
} from './final-image-export'

describe('final image export contract', () => {
  it('bypasses only Chrome shader polling without changing the Final render program', async () => {
    const originalCompile = vi.fn(async (object: THREE.Object3D) => object)
    const renderer = {
      debug: { checkShaderErrors: true },
      compileAsync: originalCompile,
    } as unknown as THREE.WebGLRenderer
    const object = new THREE.Object3D()

    configureFinalShaderCompilation(renderer)

    expect(renderer.debug.checkShaderErrors).toBe(false)
    await expect(renderer.compileAsync(object, new THREE.PerspectiveCamera())).resolves.toBe(object)
    expect(originalCompile).not.toHaveBeenCalled()
  })

  it('rejects non-finite samples and selects non-periodic PCG without clamping finite HDR', () => {
    const material = {
      fragmentShader: `
        void main() {
          gl_FragColor = vec4( 12.0, 3.0, 1.5, 1.0 );
          gl_FragColor.a *= opacity;
        }
      `,
      needsUpdate: false,
    }
    const tracer = {
      _pathTracer: { material },
    } as unknown as import('three-gpu-pathtracer').WebGLPathTracer

    configureFinalPathTracerIntegrity(tracer)
    configureFinalPathTracerIntegrity(tracer)

    expect(material.fragmentShader.match(/reject non-finite path samples/g)).toHaveLength(1)
    expect(material.fragmentShader).toContain('any( isnan( gl_FragColor.rgb ) )')
    expect(material.fragmentShader).toContain('any( isinf( gl_FragColor.rgb ) )')
    expect(material.fragmentShader).toContain('gl_FragColor = vec4( 0.0 );')
    expect(material.fragmentShader).toContain('gl_FragColor.a *= opacity;')
    expect(material.fragmentShader).not.toMatch(/clamp\s*\(\s*gl_FragColor/)
    const configured = material as typeof material & { defines: Record<string, number> }
    expect(configured.defines.RANDOM_TYPE).toBe(FINAL_RANDOM_TYPE_PCG)
    expect(material.needsUpdate).toBe(true)
  })

  it('patches the locked path-tracer dependency contract, not only a shader mock', () => {
    // The dependency still exports this legacy material at runtime, but omits it
    // from its 0.0.24 declaration file. Keep the contract probe honest without
    // widening Rasterform's production-facing dependency types.
    const PhysicalPathTracingMaterial = (
      PathTracerModule as unknown as {
        PhysicalPathTracingMaterial: new () => THREE.ShaderMaterial
      }
    ).PhysicalPathTracingMaterial
    const material = new PhysicalPathTracingMaterial()
    const originalOpacityStatements = material.fragmentShader.match(/gl_FragColor\.a \*= opacity;/g) ?? []
    const tracer = {
      _pathTracer: { material },
    } as unknown as import('three-gpu-pathtracer').WebGLPathTracer

    try {
      expect(material.defines.RANDOM_TYPE).toBe(2)
      expect(originalOpacityStatements).toHaveLength(1)

      configureFinalPathTracerIntegrity(tracer)

      expect(material.defines.RANDOM_TYPE).toBe(FINAL_RANDOM_TYPE_PCG)
      expect(material.fragmentShader.match(/reject non-finite path samples/g)).toHaveLength(1)
      expect(material.fragmentShader).toContain('any( isnan( gl_FragColor.rgb ) )')
      expect(material.fragmentShader).toContain('any( isinf( gl_FragColor.rgb ) )')
      expect(material.fragmentShader).toContain('gl_FragColor = vec4( 0.0 );')
      expect(material.fragmentShader).not.toMatch(/clamp\s*\(\s*gl_FragColor/)
    } finally {
      material.dispose()
    }
  })

  it('fails closed if the path-tracer shader contract changes upstream', () => {
    const tracer = {
      _pathTracer: {
        material: { fragmentShader: 'void main() {}', needsUpdate: false },
      },
    } as unknown as import('three-gpu-pathtracer').WebGLPathTracer

    expect(() => configureFinalPathTracerIntegrity(tracer)).toThrow(/shader contract is incompatible/i)
  })

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
    expect(finalSampleTarget('original', appearance)).toBe(6144)
    expect(finalSampleTarget('height', appearance)).toBe(6144)
    expect(finalSampleTarget('clay', appearance)).toBe(6144)

    appearance.clay.finish = 'glossy'
    expect(finalSampleTarget('clay', appearance)).toBe(8192)
    appearance.clay.finish = 'metallic'
    expect(finalSampleTarget('clay', appearance)).toBe(8192)
  })

  it('splits GPU work without reducing the sampling or denoise quality contract', () => {
    expect(FINAL_BATCH_BUDGET_MS).toBe(6)
    expect(FINAL_PATH_TRACER_TILES).toBe(3)
    expect(FINAL_DENOISE_PADDING).toBe(8)
    expect(FINAL_DENOISE_SETTINGS).toEqual({ sigma: 2.5, kSigma: 1.5, threshold: 0.055 })
  })

  it('throttles routine progress to 10 Hz while always reporting phase changes and completion', () => {
    let timestamp = 0
    const updates: FinalExportProgress[] = []
    const report = createFinalProgressReporter(
      (progress) => updates.push(progress),
      () => timestamp,
    )
    const progress = (
      phase: FinalExportProgress['phase'],
      value: number,
      samples = 0,
    ): FinalExportProgress => ({
      phase,
      progress: value,
      tile: phase === 'preparing' ? 0 : 1,
      tiles: 1,
      samples,
      targetSamples: 6144,
    })

    report(progress('preparing', 0))
    timestamp = FINAL_PROGRESS_INTERVAL_MS - 1
    report(progress('preparing', 0.5))
    timestamp = FINAL_PROGRESS_INTERVAL_MS
    report(progress('preparing', 0.6))
    timestamp += 1
    report(progress('rendering', 0, 0))
    timestamp += 1
    report(progress('rendering', 0.25, 384))
    timestamp += 1
    report(progress('rendering', 1, 6144))
    timestamp += 1
    report(progress('finishing', 1, 6144))

    expect(updates.map(({ phase, progress: value }) => [phase, value])).toEqual([
      ['preparing', 0],
      ['preparing', 0.6],
      ['rendering', 0],
      ['rendering', 1],
      ['finishing', 1],
    ])
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

  it('rejects cancellation immediately without leaving a late preparation failure unobserved', async () => {
    const controller = new AbortController()
    let rejectPreparation: (error: Error) => void = () => undefined
    const preparation = new Promise<void>((_resolve, reject) => {
      rejectPreparation = reject
    })
    const awaited = awaitExportTask(preparation, controller.signal)

    controller.abort()
    await expect(awaited).rejects.toMatchObject({ name: 'AbortError' })

    rejectPreparation(new Error('late BVH failure'))
    await Promise.resolve()
  })
})
