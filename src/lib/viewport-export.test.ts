import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  GUIDE_LAYER,
  calculateRenderTiles,
  calculateViewportDimensions,
  renderTransparentViewportPng,
  setPngDensity,
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

function samplePngWithDensity(): Uint8Array {
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', new Uint8Array(13)),
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
    let clearAlpha = -1
    let disposed = false
    let contextLost = false
    const outputContext = {
      clearRect: () => undefined,
      drawImage: (...args: unknown[]) => draws.push(args),
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
          const bytes = samplePngWithDensity()
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
    const liveBackground = new THREE.Color('#123456')
    scene.background = liveBackground
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
    }

    const result = await renderTransparentViewportPng({
      scene,
      camera,
      liveRenderer,
      viewportWidth: 1000,
      viewportHeight: 1000,
      longEdge: 4096,
      runtime,
    })

    expect(result.width).toBe(4096)
    expect(result.height).toBe(4096)
    expect(result.dpi).toBe(300)
    expect(result.blob.type).toBe('image/png')
    expect(renderViews.map(({ x, y }) => [x, y])).toEqual([[0, 0], [2048, 0], [0, 2048], [2048, 2048]])
    expect(renderViews.every((view) => !view.guideVisible && view.background === null)).toBe(true)
    expect(draws.map((args) => [args[5], args[6]])).toEqual([[0, 0], [2048, 0], [0, 2048], [2048, 2048]])
    expect(clearAlpha).toBe(0)
    expect(scene.background).toBe(liveBackground)
    expect(camera.position.toArray()).toEqual([2, -2, 3])
    expect(disposed).toBe(true)
    expect(contextLost).toBe(true)
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
})
