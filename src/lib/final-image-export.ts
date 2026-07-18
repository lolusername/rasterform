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
  cooperativeExportYield,
  encodeExportCanvasPng,
  setPngDensity,
  type ExportCanvas,
} from './viewport-export'

export const FINAL_TILE_EDGE = 1024
export const FINAL_DENOISE_PADDING = 8
export const FINAL_BATCH_BUDGET_MS = 6
export const FINAL_PATH_TRACER_TILES = 3
export const FINAL_PROGRESS_INTERVAL_MS = 100
export const FINAL_DENOISE_SETTINGS = Object.freeze({
  sigma: 2.5,
  kSigma: 1.5,
  threshold: 0.055,
})

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

export interface FinalImageExportRuntime {
  /** An OffscreenCanvas can be returned here when rendering inside a worker. */
  createCanvas: () => ExportCanvas
  createRenderer: (canvas: ExportCanvas) => THREE.WebGLRenderer
  encodeCanvas: (canvas: ExportCanvas) => Promise<Blob>
  yieldToHost: () => Promise<void>
  now: () => number
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
  runtime?: Partial<FinalImageExportRuntime>
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

/**
 * Await long preparation work without making cancellation wait for that work.
 * The underlying task remains observed so a late rejection never becomes an
 * unhandled promise while its renderer resources are cleaned up safely.
 */
export function awaitExportTask<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return task
  if (signal.aborted) return Promise.reject(abortError())

  return new Promise<T>((resolve, reject) => {
    const handleAbort = () => reject(abortError())
    signal.addEventListener('abort', handleAbort, { once: true })
    task.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', handleAbort)
    }).catch(() => {
      // `task.then` already routed the failure to the returned promise. This
      // catch only observes the cleanup chain after cancellation won the race.
    })
  })
}

function tracerIsCompiling(tracer: WebGLPathTracer): boolean {
  return Boolean((tracer as WebGLPathTracer & { readonly isCompiling?: boolean }).isCompiling)
}

function deferFinalCleanup(
  preparation: Promise<unknown> | null,
  tracer: WebGLPathTracer | null,
  cleanup: () => void,
): void {
  void (async () => {
    if (preparation) await preparation.catch(() => undefined)
    // Three's parallel shader compiler polls renderer-owned programs. Keep the
    // renderer alive until that polling finishes, but do not hold Cancel or the
    // rest of the UI hostage while it does.
    while (tracer && tracerIsCompiling(tracer)) {
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 50))
    }
    cleanup()
  })().catch(() => {
    // Cleanup is best-effort after the user-facing export promise has settled.
  })
}

export function createFinalProgressReporter(
  onProgress: ((progress: FinalExportProgress) => void) | undefined,
  now: () => number,
  interval = FINAL_PROGRESS_INTERVAL_MS,
): (progress: FinalExportProgress) => void {
  let lastReportedAt = Number.NEGATIVE_INFINITY
  let lastPhase: FinalExportPhase | null = null
  return (progress) => {
    const timestamp = now()
    const phaseChanged = progress.phase !== lastPhase
    const complete = progress.progress >= 1
    if (!phaseChanged && !complete && timestamp - lastReportedAt < interval) return
    lastPhase = progress.phase
    lastReportedAt = timestamp
    onProgress?.(progress)
  }
}

function defaultFinalRuntime(): FinalImageExportRuntime {
  return {
    createCanvas: () => document.createElement('canvas'),
    createRenderer: (canvas) => new THREE.WebGLRenderer({
      canvas: canvas as HTMLCanvasElement,
      alpha: true,
      antialias: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    }),
    encodeCanvas: encodeExportCanvasPng,
    yieldToHost: cooperativeExportYield,
    now: () => performance.now(),
  }
}

/**
 * Chrome can spend minutes polling compilation status and shader diagnostics
 * for the path tracer's large production shader. The dedicated Final renderer
 * does not need development diagnostics, and rendering the first sample will
 * synchronously finish the exact same shader program without changing any
 * path-tracing settings or output quality.
 */
export function configureFinalShaderCompilation(renderer: THREE.WebGLRenderer): void {
  renderer.debug.checkShaderErrors = false
  renderer.compileAsync = async (object: THREE.Object3D) => object
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
  const runtime: FinalImageExportRuntime = { ...defaultFinalRuntime(), ...options.runtime }
  const reportProgress = createFinalProgressReporter(options.onProgress, runtime.now)
  const yieldAndCheck = async () => {
    await runtime.yieldToHost()
    checkCancelled(options.signal)
  }
  checkCancelled(options.signal)
  const outputCanvas = runtime.createCanvas()
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

  const tileCanvas = runtime.createCanvas()
  let renderer: THREE.WebGLRenderer | null = null
  let tracer: WebGLPathTracer | null = null
  let denoiseMaterial: import('three-gpu-pathtracer').DenoiseMaterial | null = null
  let denoiseQuad: FullScreenQuad | null = null
  let preparation: Promise<void> | null = null
  let preparationSettled = true
  let cleanupDeferred = false
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

  const cleanup = () => {
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

  try {
    checkCancelled(options.signal)
    renderer = runtime.createRenderer(tileCanvas)
    renderer.setPixelRatio(1)
    configureStudioRenderer(renderer)
    configureFinalShaderCompilation(renderer)
    renderer.setClearColor(0x000000, 0)
    assertTileSupport(renderer, tiles)

    const [{ WebGLPathTracer, DenoiseMaterial }, { GenerateMeshBVHWorker }] = await awaitExportTask(
      Promise.all([
        import('three-gpu-pathtracer'),
        import('three-mesh-bvh/worker'),
      ]),
      options.signal,
    )
    checkCancelled(options.signal)

    tracer = new WebGLPathTracer(renderer)
    tracer.bounces = 4
    tracer.transmissiveBounces = 2
    tracer.multipleImportanceSampling = true
    tracer.filterGlossyFactor = 0.75
    tracer.tiles.set(FINAL_PATH_TRACER_TILES, FINAL_PATH_TRACER_TILES)
    tracer.dynamicLowRes = false
    tracer.lowResScale = 0.01
    tracer.renderScale = 1
    tracer.renderDelay = 0
    tracer.minSamples = 1
    tracer.fadeDuration = 0
    tracer.rasterizeScene = false
    tracer.renderToCanvas = false

    reportProgress({
      phase: 'preparing',
      progress: 0,
      tile: 0,
      tiles: tiles.length,
      samples: 0,
      targetSamples: samples,
    })
    preparationSettled = false
    preparation = buildPathTracingScene(
      tracer,
      new GenerateMeshBVHWorker(),
      renderScene.scene,
      exportCamera,
      (progress) => reportProgress({
        phase: 'preparing',
        progress,
        tile: 0,
        tiles: tiles.length,
        samples: 0,
        targetSamples: samples,
      }),
    )
    void preparation.then(
      () => { preparationSettled = true },
      () => { preparationSettled = true },
    )
    await awaitExportTask(preparation, options.signal)
    checkCancelled(options.signal)
    reportProgress({
      phase: 'preparing',
      progress: 1,
      tile: 0,
      tiles: tiles.length,
      samples: 0,
      targetSamples: samples,
    })

    denoiseMaterial = new DenoiseMaterial(FINAL_DENOISE_SETTINGS)
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
        await yieldAndCheck()
        if (renderer.getContext().isContextLost()) {
          throw new Error('The graphics context was lost during Final rendering.')
        }
        const samplesBeforeBatch = tracer.samples
        const frameStart = runtime.now()
        do {
          tracer.renderSample()
        } while (
          Math.floor(tracer.samples) < samples
          && runtime.now() - frameStart < FINAL_BATCH_BUDGET_MS
        )
        // The first sample starts asynchronous shader compilation. Scheduler
        // yields can run far faster than animation frames, so compilation time
        // must not be mistaken for a stalled renderer.
        stalledFrames = tracer.samples > samplesBeforeBatch || tracerIsCompiling(tracer)
          ? 0
          : stalledFrames + 1
        if (stalledFrames > 1800) {
          throw new Error('Final rendering stopped making progress on this device.')
        }
        const completedSamples = Math.min(samples, Math.floor(tracer.samples))
        reportProgress({
          phase: 'rendering',
          progress: (tileIndex * samples + completedSamples) / (tiles.length * samples),
          tile: tileIndex + 1,
          tiles: tiles.length,
          samples: completedSamples,
          targetSamples: samples,
        })
      }

      checkCancelled(options.signal)
      await yieldAndCheck()
      denoiseMaterial.map = tracer.target.texture
      renderer.setRenderTarget(null)
      renderer.setClearColor(0x000000, 0)
      renderer.clear(true, true, true)
      denoiseQuad.render(renderer)
      await yieldAndCheck()
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
      await yieldAndCheck()
    }

    exportCamera.clearViewOffset()
    reportProgress({
      phase: 'finishing',
      progress: 1,
      tile: tiles.length,
      tiles: tiles.length,
      samples,
      targetSamples: samples,
    })
    await yieldAndCheck()
    const raw = await runtime.encodeCanvas(outputCanvas)
    await yieldAndCheck()
    const rawBytes = new Uint8Array(await raw.arrayBuffer())
    await yieldAndCheck()
    const png = setPngDensity(rawBytes, PNG_DPI)
    await yieldAndCheck()
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
  } catch (error) {
    if (!preparationSettled || (tracer && tracerIsCompiling(tracer))) {
      cleanupDeferred = true
      deferFinalCleanup(preparation, tracer, cleanup)
    }
    throw error
  } finally {
    if (!cleanupDeferred) cleanup()
  }
}
