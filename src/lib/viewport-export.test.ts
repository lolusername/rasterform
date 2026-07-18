import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  GUIDE_LAYER,
  assertCanvasHasTransparentBackground,
  assertPngContract,
  calculateRenderTiles,
  calculateViewportDimensions,
  inspectPngHeader,
  padRenderTile,
  renderViewportPng,
  setPngDensity,
  type ViewportExportProgress,
} from './viewport-export'
import type { ViewportExportRuntime } from './viewport-export'

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(data.length + 12)
  const view = new DataView(chunk.buffer)
  view.setUint32(0, data.length, false)
  for (let index = 0; index < 4; index += 1) chunk[4 + index] = type.charCodeAt(index)
  chunk.set(data, 8)
  return chunk
}

function samplePngWithDensity(width = 1, height = 1, colorType = 6): Uint8Array {
  const header = new Uint8Array(13)
  const headerView = new DataView(header.buffer)
  headerView.setUint32(0, width, false)
  headerView.setUint32(4, height, false)
  header[8] = 8
  header[9] = colorType
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('pHYs', new Uint8Array(9)),
    pngChunk('IEND', new Uint8Array()),
  ]
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}

describe('transparent viewport export', () => {
  it('preserves landscape, portrait, and square viewport framing at 4K or 8K', () => {
    expect(calculateViewportDimensions(1600, 1000, 4096)).toEqual({ width: 4096, height: 2560 })
    expect(calculateViewportDimensions(1000, 1600, 4096)).toEqual({ width: 2560, height: 4096 })
    expect(calculateViewportDimensions(800, 800, 8192)).toEqual({ width: 8192, height: 8192 })
  })

  it('tiles non-divisible output dimensions without gaps or overlaps', () => {
    const width = 7
    const height = 5
    const tiles = calculateRenderTiles(width, height, 3)
    const coverage = new Uint8Array(width * height)
    for (const tile of tiles) {
      for (let y = tile.y; y < tile.y + tile.height; y += 1) {
        for (let x = tile.x; x < tile.x + tile.width; x += 1) coverage[y * width + x] += 1
      }
    }
    expect([...coverage].every((count) => count === 1)).toBe(true)
    expect(tiles.at(-1)).toEqual({ x: 6, y: 3, width: 1, height: 2 })
  })

  it('adds bounded gutters around internal High-quality tiles', () => {
    expect(padRenderTile({ x: 0, y: 0, width: 1020, height: 1020 }, 4096, 4096, 2))
      .toMatchObject({ renderX: 0, renderY: 0, renderWidth: 1022, renderHeight: 1022 })
    expect(padRenderTile({ x: 1020, y: 1020, width: 1020, height: 1020 }, 4096, 4096, 2))
      .toMatchObject({ renderX: 1018, renderY: 1018, renderWidth: 1024, renderHeight: 1024 })
  })

  it('excludes the guide layer while retaining the mesh layer', () => {
    const liveCamera = new THREE.PerspectiveCamera()
    liveCamera.layers.enable(GUIDE_LAYER)
    const exportCamera = liveCamera.clone()
    exportCamera.layers.disable(GUIDE_LAYER)
    const mesh = new THREE.Object3D()
    const guide = new THREE.Object3D()
    guide.layers.set(GUIDE_LAYER)

    expect(exportCamera.layers.test(mesh.layers)).toBe(true)
    expect(exportCamera.layers.test(guide.layers)).toBe(false)
    expect(liveCamera.layers.test(guide.layers)).toBe(true)
  })

  it('executes a transparent four-tile capture without mutating live scene state', async () => {
    const draws: unknown[][] = []
    const renderViews: Array<{ x: number; y: number; guideVisible: boolean; background: THREE.Scene['background'] }> = []
    const progress: ViewportExportProgress[] = []
    let clearAlpha = -1
    let disposed = false
    let contextLost = false
    let yields = 0
    let encoded = false
    const outputContext = {
      clearRect: () => undefined,
      drawImage: (...args: unknown[]) => draws.push(args),
      save: () => undefined,
      beginPath: () => undefined,
      rect: () => undefined,
      clip: () => undefined,
      restore: () => undefined,
      getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 0]) }),
    } as unknown as CanvasRenderingContext2D

    function fakeCanvas(context: CanvasRenderingContext2D | null): HTMLCanvasElement {
      let width = 300
      let height = 150
      return {
        get width() { return width },
        set width(value: number) { width = value },
        get height() { return height },
        set height(value: number) { height = value },
        getContext: (kind: string) => kind === '2d' ? context : null,
        toBlob: (callback: BlobCallback) => {
          const bytes = samplePngWithDensity(width, height)
          const payload = new ArrayBuffer(bytes.byteLength)
          new Uint8Array(payload).set(bytes)
          callback(new Blob([payload], { type: 'image/png' }))
        },
      } as unknown as HTMLCanvasElement
    }

    const canvases = [fakeCanvas(outputContext), fakeCanvas(null)]
    const guide = new THREE.Object3D()
    guide.layers.set(GUIDE_LAYER)
    const scene = new THREE.Scene()
    scene.background = null
    scene.add(guide, new THREE.Object3D())
    const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 100)
    camera.layers.enable(GUIDE_LAYER)
    camera.position.set(2, -2, 3)

    const gl = {
      MAX_VIEWPORT_DIMS: 1,
      MAX_TEXTURE_SIZE: 2,
      MAX_RENDERBUFFER_SIZE: 3,
      getParameter: (parameter: number) => parameter === 1 ? new Int32Array([2048, 2048]) : 2048,
    }
    const tileCanvas = canvases[1]!
    const fakeRenderer = {
      domElement: tileCanvas,
      outputColorSpace: THREE.SRGBColorSpace,
      toneMapping: THREE.NoToneMapping,
      toneMappingExposure: 1,
      shadowMap: { enabled: false, type: THREE.PCFShadowMap },
      setPixelRatio: () => undefined,
      setClearColor: (_color: number, alpha: number) => { clearAlpha = alpha },
      getContext: () => gl,
      setSize: (width: number, height: number) => {
        tileCanvas.width = width
        tileCanvas.height = height
      },
      render: (renderScene: THREE.Scene, renderCamera: THREE.PerspectiveCamera) => {
        renderViews.push({
          x: renderCamera.view?.offsetX ?? -1,
          y: renderCamera.view?.offsetY ?? -1,
          guideVisible: renderCamera.layers.test(guide.layers),
          background: renderScene.background,
        })
      },
      dispose: () => { disposed = true },
      forceContextLoss: () => { contextLost = true },
    } as unknown as THREE.WebGLRenderer
    const liveRenderer = {
      outputColorSpace: THREE.SRGBColorSpace,
      toneMapping: THREE.NoToneMapping,
      toneMappingExposure: 1,
      shadowMap: { enabled: false, type: THREE.PCFShadowMap },
    } as unknown as THREE.WebGLRenderer
    const runtime: ViewportExportRuntime = {
      createCanvas: () => canvases.shift()!,
      createRenderer: () => fakeRenderer,
      yieldToHost: async () => { yields += 1 },
      encodeCanvas: async (canvas) => {
        encoded = true
        const bytes = samplePngWithDensity(canvas.width, canvas.height)
        const payload = new ArrayBuffer(bytes.byteLength)
        new Uint8Array(payload).set(bytes)
        return new Blob([payload], { type: 'image/png' })
      },
    }

    const result = await renderViewportPng({
      scene,
      camera,
      liveRenderer,
      width: 4096,
      height: 4096,
      supersample: 1,
      runtime,
      onProgress: (update) => progress.push(update),
    })

    expect(result.width).toBe(4096)
    expect(result.height).toBe(4096)
    expect(result.dpi).toBe(300)
    expect(result.supersample).toBe(1)
    expect(result.blob.type).toBe('image/png')
    expect(renderViews.map(({ x, y }) => [x, y])).toEqual([[0, 0], [2048, 0], [0, 2048], [2048, 2048]])
    expect(renderViews.every((view) => !view.guideVisible && view.background === null)).toBe(true)
    expect(draws.map((args) => [args[5], args[6]])).toEqual([[0, 0], [2048, 0], [0, 2048], [2048, 2048]])
    expect(clearAlpha).toBe(0)
    expect(scene.background).toBeNull()
    expect(camera.position.toArray()).toEqual([2, -2, 3])
    expect(disposed).toBe(true)
    expect(contextLost).toBe(true)
    expect(encoded).toBe(true)
    expect(yields).toBe(5)
    expect(progress.map(({ phase, progress: value, tile }) => [phase, value, tile])).toEqual([
      ['rendering', 0, 0],
      ['rendering', 0.25, 1],
      ['rendering', 0.5, 2],
      ['rendering', 0.75, 3],
      ['rendering', 1, 4],
      ['finishing', 1, 4],
    ])
  })

  it('renders a default 2× 4K export in GPU-safe tiles with complete logical coverage', async () => {
    const draws: number[][] = []
    const clips: number[][] = []
    const renderSizes: Array<[number, number]> = []
    const renderViews: Array<{
      fullWidth: number
      fullHeight: number
      x: number
      y: number
      width: number
      height: number
    }> = []
    let smoothingEnabled = false
    let smoothingQuality: ImageSmoothingQuality = 'low'
    const outputContext = {
      clearRect: () => undefined,
      drawImage: (...args: unknown[]) => draws.push(args.slice(1).map(Number)),
      save: () => undefined,
      beginPath: () => undefined,
      rect: (...args: number[]) => clips.push(args),
      clip: () => undefined,
      restore: () => undefined,
      get imageSmoothingEnabled() { return smoothingEnabled },
      set imageSmoothingEnabled(value: boolean) { smoothingEnabled = value },
      get imageSmoothingQuality() { return smoothingQuality },
      set imageSmoothingQuality(value: ImageSmoothingQuality) { smoothingQuality = value },
      getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 0]) }),
    } as unknown as CanvasRenderingContext2D

    function fakeCanvas(context: CanvasRenderingContext2D | null): HTMLCanvasElement {
      let width = 300
      let height = 150
      return {
        get width() { return width },
        set width(value: number) { width = value },
        get height() { return height },
        set height(value: number) { height = value },
        getContext: (kind: string) => kind === '2d' ? context : null,
        toBlob: (callback: BlobCallback) => {
          const bytes = samplePngWithDensity(width, height)
          const payload = new ArrayBuffer(bytes.byteLength)
          new Uint8Array(payload).set(bytes)
          callback(new Blob([payload], { type: 'image/png' }))
        },
      } as unknown as HTMLCanvasElement
    }

    const canvases = [fakeCanvas(outputContext), fakeCanvas(null)]
    const tileCanvas = canvases[1]!
    const gl = {
      MAX_VIEWPORT_DIMS: 1,
      MAX_TEXTURE_SIZE: 2,
      MAX_RENDERBUFFER_SIZE: 3,
      getParameter: (parameter: number) => parameter === 1 ? new Int32Array([2048, 2048]) : 2048,
    }
    const fakeRenderer = {
      domElement: tileCanvas,
      outputColorSpace: THREE.SRGBColorSpace,
      toneMapping: THREE.NoToneMapping,
      toneMappingExposure: 1,
      shadowMap: { enabled: false, type: THREE.PCFShadowMap },
      setPixelRatio: () => undefined,
      setClearColor: () => undefined,
      getContext: () => gl,
      setSize: (width: number, height: number) => {
        renderSizes.push([width, height])
        tileCanvas.width = width
        tileCanvas.height = height
      },
      render: (_scene: THREE.Scene, renderCamera: THREE.PerspectiveCamera) => {
        const view = renderCamera.view
        if (!view) throw new Error('Expected a tiled camera view.')
        renderViews.push({
          fullWidth: view.fullWidth,
          fullHeight: view.fullHeight,
          x: view.offsetX,
          y: view.offsetY,
          width: view.width,
          height: view.height,
        })
      },
      dispose: () => undefined,
      forceContextLoss: () => undefined,
    } as unknown as THREE.WebGLRenderer
    const liveRenderer = {
      outputColorSpace: THREE.SRGBColorSpace,
      toneMapping: THREE.NoToneMapping,
      toneMappingExposure: 1,
      shadowMap: { enabled: false, type: THREE.PCFShadowMap },
    } as unknown as THREE.WebGLRenderer
    const runtime: ViewportExportRuntime = {
      createCanvas: () => canvases.shift()!,
      createRenderer: () => fakeRenderer,
      yieldToHost: async () => undefined,
    }

    const result = await renderViewportPng({
      scene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(38, 1, 0.01, 100),
      liveRenderer,
      width: 4096,
      height: 4096,
      runtime,
    })

    expect(result).toMatchObject({ width: 4096, height: 4096, dpi: 300, supersample: 2 })
    expect(smoothingEnabled).toBe(true)
    expect(smoothingQuality).toBe('high')
    expect(renderSizes).toHaveLength(25)
    expect(renderSizes.every(([width, height]) => width <= 2048 && height <= 2048)).toBe(true)
    expect(renderViews[0]).toEqual({
      fullWidth: 8192,
      fullHeight: 8192,
      x: 0,
      y: 0,
      width: 2044,
      height: 2044,
    })
    expect(renderViews.at(-1)).toEqual({
      fullWidth: 8192,
      fullHeight: 8192,
      x: 8156,
      y: 8156,
      width: 36,
      height: 36,
    })
    expect(renderViews[1]).toMatchObject({ x: 2036, y: 0, width: 2048, height: 2044 })

    const coverage = new Uint8Array(4096 * 4096)
    for (const [x, y, width, height] of clips) {
      for (let row = y!; row < y! + height!; row += 1) {
        for (let column = x!; column < x! + width!; column += 1) {
          coverage[row * 4096 + column] += 1
        }
      }
    }
    expect(draws).toHaveLength(25)
    expect(coverage.every((count) => count === 1)).toBe(true)
  })

  it('cancels High quality between tiles and still releases its renderer and canvases', async () => {
    const controller = new AbortController()
    let renders = 0
    let disposed = false
    let contextLost = false
    let yields = 0
    const outputContext = {
      clearRect: () => undefined,
      drawImage: () => undefined,
      save: () => undefined,
      beginPath: () => undefined,
      rect: () => undefined,
      clip: () => undefined,
      restore: () => undefined,
    } as unknown as CanvasRenderingContext2D
    const fakeCanvas = (context: CanvasRenderingContext2D | null) => ({
      width: 300,
      height: 150,
      getContext: (kind: string) => kind === '2d' ? context : null,
    }) as unknown as HTMLCanvasElement
    const outputCanvas = fakeCanvas(outputContext)
    const tileCanvas = fakeCanvas(null)
    const canvases = [outputCanvas, tileCanvas]
    const gl = {
      MAX_VIEWPORT_DIMS: 1,
      MAX_TEXTURE_SIZE: 2,
      MAX_RENDERBUFFER_SIZE: 3,
      getParameter: (parameter: number) => parameter === 1 ? new Int32Array([1, 1]) : 1,
    }
    const fakeRenderer = {
      domElement: tileCanvas,
      outputColorSpace: THREE.SRGBColorSpace,
      toneMapping: THREE.NoToneMapping,
      toneMappingExposure: 1,
      shadowMap: { enabled: false, type: THREE.PCFShadowMap },
      setPixelRatio: () => undefined,
      setClearColor: () => undefined,
      getContext: () => gl,
      setSize: (width: number, height: number) => {
        tileCanvas.width = width
        tileCanvas.height = height
      },
      render: () => { renders += 1 },
      dispose: () => { disposed = true },
      forceContextLoss: () => { contextLost = true },
    } as unknown as THREE.WebGLRenderer
    const liveRenderer = {
      outputColorSpace: THREE.SRGBColorSpace,
      toneMapping: THREE.NoToneMapping,
      toneMappingExposure: 1,
      shadowMap: { enabled: false, type: THREE.PCFShadowMap },
    } as unknown as THREE.WebGLRenderer
    const runtime: ViewportExportRuntime = {
      createCanvas: () => canvases.shift()!,
      createRenderer: () => fakeRenderer,
      encodeCanvas: async () => { throw new Error('Encoding should not start after cancellation.') },
      yieldToHost: async () => {
        yields += 1
        controller.abort()
      },
    }

    await expect(renderViewportPng({
      scene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(38, 1, 0.01, 100),
      liveRenderer,
      width: 2,
      height: 1,
      supersample: 1,
      runtime,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' })

    expect(renders).toBe(1)
    expect(yields).toBe(1)
    expect(disposed).toBe(true)
    expect(contextLost).toBe(true)
    expect(outputCanvas.width).toBe(1)
    expect(outputCanvas.height).toBe(1)
    expect(tileCanvas.width).toBe(1)
    expect(tileCanvas.height).toBe(1)
  })

  it('replaces browser density metadata with one 300-PPI pHYs chunk', () => {
    const png = setPngDensity(samplePngWithDensity(), 300)
    const types: string[] = []
    let offset = 8
    let densityOffset = -1
    while (offset + 12 <= png.length) {
      const length = new DataView(png.buffer, png.byteOffset + offset, 4).getUint32(0, false)
      const type = String.fromCharCode(...png.slice(offset + 4, offset + 8))
      types.push(type)
      if (type === 'pHYs') densityOffset = offset
      offset += length + 12
      if (type === 'IEND') break
    }
    expect(types).toEqual(['IHDR', 'pHYs', 'IEND'])
    const view = new DataView(png.buffer, png.byteOffset + densityOffset + 8, 9)
    expect(view.getUint32(0, false)).toBe(11811)
    expect(view.getUint32(4, false)).toBe(11811)
    expect(view.getUint8(8)).toBe(1)
    expect(new DataView(png.buffer, png.byteOffset + densityOffset + 17, 4).getUint32(0, false)).toBe(0x78a53f76)
  })

  it('verifies encoded dimensions and an alpha-capable PNG color type', () => {
    const rgba = samplePngWithDensity(4096, 2560, 6)
    expect(inspectPngHeader(rgba)).toMatchObject({
      width: 4096,
      height: 2560,
      bitDepth: 8,
      colorType: 6,
      hasAlpha: true,
    })
    expect(() => assertPngContract(rgba, 4096, 2560, true)).not.toThrow()
    expect(() => assertPngContract(samplePngWithDensity(4096, 2560, 2), 4096, 2560, true))
      .toThrow('no alpha channel')
  })

  it('refuses to label an image transparent when every sampled corner is opaque', () => {
    const context = {
      getImageData: () => ({ data: new Uint8ClampedArray([12, 20, 30, 255]) }),
    } as unknown as CanvasRenderingContext2D
    expect(() => assertCanvasHasTransparentBackground(context, 4096, 3072))
      .toThrow('Transparency check failed')
  })
})
