import * as THREE from 'three'
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'
import type { WebGLPathTracer } from 'three-gpu-pathtracer'
import type {
  AppearanceSettings,
  ColorMode,
  ImageExportBackground,
  MeshData,
  ViewportBackground,
} from '../types'
import { buildPathTracingScene } from './path-tracer-setup'
import { viewportBackgroundPreset } from './background'
import {
  configureStudioRenderer,
  createFinalRenderScene,
  disposeFinalRenderScene,
} from './three'
import {
  PNG_DPI,
  assertPngContract,
  setPngDensity,
} from './viewport-export'

export const FINAL_TILE_EDGE = 1024
export const FINAL_DENOISE_PADDING = 8

export interface FinalRenderTile {
  x: number
  y: number
  width: number
  height: number
  renderX: number
  renderY: number
  renderWidth: number
  renderHeight: number
  sourceX: number
  sourceY: number
}

export type FinalExportPhase = 'preparing' | 'rendering' | 'finishing'

export interface FinalExportProgress {
  phase: FinalExportPhase
  progress: number
  tile: number
  tiles: number
  samples: number
  targetSamples: number
}

export interface FinalImagePngResult {
  blob: Blob
  width: number
  height: number
  dpi: number
  samples: number
  tiles: number
}

export interface FinalImageExportOptions {
  mesh: MeshData
  colorMode: ColorMode
  appearance: AppearanceSettings
  environment: THREE.Texture | null
  camera: THREE.PerspectiveCamera
  width: number
  height: number
  background: ImageExportBackground
  studioBackground: ViewportBackground
  signal?: AbortSignal
  onProgress?: (progress: FinalExportProgress) => void
}

export function finalSampleTarget(colorMode: ColorMode, appearance: AppearanceSettings): number {
  return colorMode === 'clay' && appearance.clay.finish !== 'matte' ? 2048 : 1536
}

/** Divide a final image into bounded render targets with overlap for seam-free denoising. */
export function calculateFinalRenderTiles(
  width: number,
  height: number,
  tileEdge = FINAL_TILE_EDGE,
  padding = FINAL_DENOISE_PADDING,
): FinalRenderTile[] {
  const safeWidth = Math.max(1, Math.round(width))
  const safeHeight = Math.max(1, Math.round(height))
  const edge = Math.max(1, Math.round(tileEdge))
  const overlap = Math.max(0, Math.round(padding))
  const tiles: FinalRenderTile[] = []

  for (let y = 0; y < safeHeight; y += edge) {
    for (let x = 0; x < safeWidth; x += edge) {
      const tileWidth = Math.min(edge, safeWidth - x)
      const tileHeight = Math.min(edge, safeHeight - y)
      const renderX = Math.max(0, x - overlap)
      const renderY = Math.max(0, y - overlap)
      const renderRight = Math.min(safeWidth, x + tileWidth + overlap)
      const renderBottom = Math.min(safeHeight, y + tileHeight + overlap)
      tiles.push({
        x,
        y,
        width: tileWidth,
        height: tileHeight,
        renderX,
        renderY,
        renderWidth: renderRight - renderX,
        renderHeight: renderBottom - renderY,
        sourceX: x - renderX,
        sourceY: y - renderY,
      })
    }
  }
  return tiles
}

export function applyFinalTileView(
  camera: THREE.PerspectiveCamera,
  fullWidth: number,
  fullHeight: number,
  tile: FinalRenderTile,
): void {
  camera.aspect = fullWidth / fullHeight
  camera.setViewOffset(
    fullWidth,
    fullHeight,
    tile.renderX,
    tile.renderY,
    tile.renderWidth,
    tile.renderHeight,
  )
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld(true)
}

function abortError(): DOMException {
  return new DOMException('Final image export cancelled.', 'AbortError')
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

async function canvasPng(canvas: HTMLCanvasElement): Promise<Blob> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('The browser could not encode the final PNG.')
  return blob
}

function assertTileSupport(renderer: THREE.WebGLRenderer, tiles: FinalRenderTile[]): void {
  const gl = renderer.getContext()
  const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array
  const maxWidth = Math.min(
    Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 0,
    Number(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE)) || 0,
    Number(viewport[0]) || 0,
  )
  const maxHeight = Math.min(
    Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 0,
    Number(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE)) || 0,
    Number(viewport[1]) || 0,
  )
  if (tiles.some((tile) => tile.renderWidth > maxWidth || tile.renderHeight > maxHeight)) {
    throw new Error('Final rendering is not supported at this size on this device. Try 2K or High quality.')
  }
}

/**
 * Render a clean 2K/4K final PNG without allocating one enormous floating-point target.
 * The BVH is built once, then a camera view offset traces each overlapped tile independently.
 */
export async function renderFinalImagePng(options: FinalImageExportOptions): Promise<FinalImagePngResult> {
  const width = Math.max(1, Math.round(options.width))
  const height = Math.max(1, Math.round(options.height))
  const samples = finalSampleTarget(options.colorMode, options.appearance)
  const tiles = calculateFinalRenderTiles(width, height)
  const outputCanvas = document.createElement('canvas')
  outputCanvas.width = width
  outputCanvas.height = height
  const output = outputCanvas.getContext('2d', { alpha: true })
  if (!output || outputCanvas.width !== width || outputCanvas.height !== height) {
    throw new Error('The final image canvas is too large for this device. Try 2K.')
  }
  output.clearRect(0, 0, width, height)
  if (options.background !== 'transparent') {
    output.fillStyle = viewportBackgroundPreset(options.studioBackground).color
    output.fillRect(0, 0, width, height)
  }

  const tileCanvas = document.createElement('canvas')
  let renderer: THREE.WebGLRenderer | null = null
  let tracer: WebGLPathTracer | null = null
  let denoiseMaterial: import('three-gpu-pathtracer').DenoiseMaterial | null = null
  let denoiseQuad: FullScreenQuad | null = null
  const renderScene = createFinalRenderScene(
    options.mesh,
    options.colorMode,
    options.appearance,
    options.environment,
    // Trace against transparency, then composite the requested neutral backdrop
    // in 2D so AgX shapes the model lighting without dimming the flat color.
    'transparent',
    options.studioBackground,
  )
  const exportCamera = options.camera.clone()
  exportCamera.aspect = width / height
  exportCamera.clearViewOffset()
  exportCamera.updateProjectionMatrix()
  exportCamera.updateMatrixWorld(true)

  try {
    checkCancelled(options.signal)
    renderer = new THREE.WebGLRenderer({
      canvas: tileCanvas,
      alpha: true,
      antialias: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    })
    renderer.setPixelRatio(1)
    configureStudioRenderer(renderer)
    renderer.setClearColor(0x000000, 0)
    assertTileSupport(renderer, tiles)

    const [{ WebGLPathTracer, DenoiseMaterial }, { GenerateMeshBVHWorker }] = await Promise.all([
      import('three-gpu-pathtracer'),
      import('three-mesh-bvh/worker'),
    ])
    checkCancelled(options.signal)

    tracer = new WebGLPathTracer(renderer)
    tracer.bounces = 4
    tracer.transmissiveBounces = 2
    tracer.multipleImportanceSampling = true
    tracer.filterGlossyFactor = 0.75
    tracer.tiles.set(1, 1)
    tracer.dynamicLowRes = false
    tracer.lowResScale = 0.01
    tracer.renderScale = 1
    tracer.renderDelay = 0
    tracer.minSamples = 1
    tracer.fadeDuration = 0
    tracer.rasterizeScene = false
    tracer.renderToCanvas = false

    options.onProgress?.({
      phase: 'preparing',
      progress: 0,
      tile: 0,
      tiles: tiles.length,
      samples: 0,
      targetSamples: samples,
    })
    await buildPathTracingScene(
      tracer,
      new GenerateMeshBVHWorker(),
      renderScene.scene,
      exportCamera,
      (progress) => options.onProgress?.({
        phase: 'preparing',
        progress,
        tile: 0,
        tiles: tiles.length,
        samples: 0,
        targetSamples: samples,
      }),
    )
    checkCancelled(options.signal)

    denoiseMaterial = new DenoiseMaterial({ sigma: 2.5, kSigma: 1.5, threshold: 0.055 })
    denoiseQuad = new FullScreenQuad(denoiseMaterial)

    for (let tileIndex = 0; tileIndex < tiles.length; tileIndex += 1) {
      const tile = tiles[tileIndex]!
      checkCancelled(options.signal)
      renderer.setSize(tile.renderWidth, tile.renderHeight, false)
      applyFinalTileView(exportCamera, width, height, tile)
      tracer.setCamera(exportCamera)

      let stalledFrames = 0
      while (Math.floor(tracer.samples) < samples) {
        checkCancelled(options.signal)
        await nextFrame()
        checkCancelled(options.signal)
        if (renderer.getContext().isContextLost()) {
          throw new Error('The graphics context was lost during Final rendering.')
        }
        const samplesBeforeBatch = tracer.samples
        const frameStart = performance.now()
        do {
          tracer.renderSample()
        } while (
          Math.floor(tracer.samples) < samples
          && performance.now() - frameStart < 10
        )
        stalledFrames = tracer.samples > samplesBeforeBatch ? 0 : stalledFrames + 1
        if (stalledFrames > 1800) {
          throw new Error('Final rendering stopped making progress on this device.')
        }
        const completedSamples = Math.min(samples, Math.floor(tracer.samples))
        options.onProgress?.({
          phase: 'rendering',
          progress: (tileIndex * samples + completedSamples) / (tiles.length * samples),
          tile: tileIndex + 1,
          tiles: tiles.length,
          samples: completedSamples,
          targetSamples: samples,
        })
      }

      checkCancelled(options.signal)
      denoiseMaterial.map = tracer.target.texture
      renderer.setRenderTarget(null)
      renderer.setClearColor(0x000000, 0)
      renderer.clear(true, true, true)
      denoiseQuad.render(renderer)
      output.drawImage(
        tileCanvas,
        tile.sourceX,
        tile.sourceY,
        tile.width,
        tile.height,
        tile.x,
        tile.y,
        tile.width,
        tile.height,
      )
    }

    exportCamera.clearViewOffset()
    options.onProgress?.({
      phase: 'finishing',
      progress: 1,
      tile: tiles.length,
      tiles: tiles.length,
      samples,
      targetSamples: samples,
    })
    const raw = await canvasPng(outputCanvas)
    const png = setPngDensity(new Uint8Array(await raw.arrayBuffer()), PNG_DPI)
    assertPngContract(png, width, height, options.background === 'transparent')
    const payload = new ArrayBuffer(png.byteLength)
    new Uint8Array(payload).set(png)
    return {
      blob: new Blob([payload], { type: 'image/png' }),
      width,
      height,
      dpi: PNG_DPI,
      samples,
      tiles: tiles.length,
    }
  } finally {
    denoiseQuad?.dispose()
    denoiseMaterial?.dispose()
    tracer?.dispose()
    renderer?.dispose()
    renderer?.forceContextLoss()
    disposeFinalRenderScene(renderScene)
    tileCanvas.width = 1
    tileCanvas.height = 1
    outputCanvas.width = 1
    outputCanvas.height = 1
  }
}
