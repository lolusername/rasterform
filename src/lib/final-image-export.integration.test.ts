import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import type { MeshData } from '../types'
import { createDefaultAppearanceSettings } from './three'
import { renderFinalImagePng } from './final-image-export'
import { inspectPngHeader, type ExportCanvas } from './viewport-export'

const tracerAudit = vi.hoisted(() => ({ renderSamples: 0, sceneBuilds: 0 }))

vi.mock('three-gpu-pathtracer', async () => {
  const THREE = await import('three')
  class WebGLPathTracer {
    _pathTracer = {
      material: {
        fragmentShader: 'void main() { gl_FragColor.a *= opacity; }',
        needsUpdate: false,
      },
    }
    bounces = 0
    transmissiveBounces = 0
    multipleImportanceSampling = false
    filterGlossyFactor = 0
    tiles = new THREE.Vector2(1, 1)
    dynamicLowRes = false
    lowResScale = 1
    renderScale = 1
    renderDelay = 0
    minSamples = 1
    fadeDuration = 0
    rasterizeScene = false
    renderToCanvas = false
    samples = 0
    readonly target = { texture: new THREE.Texture() }
    readonly isCompiling = false

    setBVHWorker() {}
    async setSceneAsync(_scene: THREE.Scene, _camera: THREE.Camera, options?: { onProgress?: (value: number) => void }) {
      tracerAudit.sceneBuilds += 1
      options?.onProgress?.(1)
    }
    setCamera() { this.samples = 0 }
    renderSample() {
      tracerAudit.renderSamples += 1
      this.samples += 1
    }
    dispose() { this.target.texture.dispose() }
  }
  class DenoiseMaterial extends THREE.MeshBasicMaterial {
    constructor(_settings: unknown) { super() }
  }
  return { WebGLPathTracer, DenoiseMaterial }
})

vi.mock('three-mesh-bvh/worker', () => ({
  GenerateMeshBVHWorker: class {
    generate() { return Promise.resolve(null) }
    dispose() {}
  },
}))

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let value = 0; value < 256; value += 1) {
    let crc = value
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
    table[value] = crc >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(data.length + 12)
  const view = new DataView(chunk.buffer)
  view.setUint32(0, data.length, false)
  for (let index = 0; index < 4; index += 1) chunk[index + 4] = type.charCodeAt(index)
  chunk.set(data, 8)
  view.setUint32(data.length + 8, crc32(chunk.subarray(4, data.length + 8)), false)
  return chunk
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.length
  }
  return bytes
}

function copiedBuffer(bytes: Uint8Array): ArrayBuffer {
  const payload = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(payload).set(bytes)
  return payload
}

async function transformBytes(bytes: Uint8Array, transform: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const stream = new Blob([copiedBuffer(bytes)]).stream().pipeThrough(transform)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function encodeRgbaPng(width: number, height: number, pixels: Uint8ClampedArray): Promise<Uint8Array> {
  const header = new Uint8Array(13)
  const headerView = new DataView(header.buffer)
  headerView.setUint32(0, width, false)
  headerView.setUint32(4, height, false)
  header.set([8, 6, 0, 0, 0], 8)

  const scanlines = new Uint8Array(height * (width * 4 + 1))
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1)
    scanlines[row] = 0
    scanlines.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), row + 1)
  }
  return concatenate([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', await transformBytes(scanlines, new CompressionStream('deflate'))),
    pngChunk('IEND', new Uint8Array()),
  ])
}

class MemoryCanvas {
  private internalWidth = 1
  private internalHeight = 1
  pixels = new Uint8ClampedArray(4)
  readonly context = new MemoryCanvasContext(this)

  get width() { return this.internalWidth }
  set width(value: number) {
    this.internalWidth = Math.max(1, Math.round(value))
    this.resetPixels()
  }

  get height() { return this.internalHeight }
  set height(value: number) {
    this.internalHeight = Math.max(1, Math.round(value))
    this.resetPixels()
  }

  getContext(kind: string) {
    return kind === '2d' ? this.context : null
  }

  paintModel() {
    const left = Math.max(1, Math.floor(this.width / 3))
    const right = Math.min(this.width - 1, Math.ceil(this.width * 2 / 3))
    const top = Math.max(1, Math.floor(this.height / 3))
    const bottom = Math.min(this.height - 1, Math.ceil(this.height * 2 / 3))
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        const offset = (y * this.width + x) * 4
        this.pixels.set([50 + x * 3, 80 + y * 4, 180, 255], offset)
      }
    }
  }

  private resetPixels() {
    this.pixels = new Uint8ClampedArray(this.width * this.height * 4)
  }
}

class MemoryCanvasContext {
  fillStyle = '#000000'
  imageSmoothingEnabled = false
  imageSmoothingQuality: ImageSmoothingQuality = 'low'

  constructor(private readonly canvas: MemoryCanvas) {}

  clearRect(..._bounds: number[]) {
    this.canvas.pixels.fill(0)
  }

  fillRect() {
    throw new Error('The transparent integration fixture should not paint a studio background.')
  }

  save() {}
  beginPath() {}
  rect() {}
  clip() {}
  restore() {}

  drawImage(
    source: MemoryCanvas,
    sourceX: number,
    sourceY: number,
    sourceWidth: number,
    sourceHeight: number,
    destinationX: number,
    destinationY: number,
    destinationWidth: number,
    destinationHeight: number,
  ) {
    for (let y = 0; y < destinationHeight; y += 1) {
      const sampleY = Math.min(source.height - 1, Math.floor(sourceY + y * sourceHeight / destinationHeight))
      for (let x = 0; x < destinationWidth; x += 1) {
        const sampleX = Math.min(source.width - 1, Math.floor(sourceX + x * sourceWidth / destinationWidth))
        const sourceOffset = (sampleY * source.width + sampleX) * 4
        const destinationOffset = ((destinationY + y) * this.canvas.width + destinationX + x) * 4
        this.canvas.pixels.set(source.pixels.subarray(sourceOffset, sourceOffset + 4), destinationOffset)
      }
    }
  }
}

interface RenderAudit {
  clearAlphas: number[]
  renderSizes: Array<[number, number]>
}

function fakeRenderer(canvas: MemoryCanvas, audit: RenderAudit): THREE.WebGLRenderer {
  const gl = {
    MAX_VIEWPORT_DIMS: 1,
    MAX_TEXTURE_SIZE: 2,
    MAX_RENDERBUFFER_SIZE: 3,
    getParameter: (parameter: number) => parameter === 1 ? new Int32Array([4096, 4096]) : 4096,
    isContextLost: () => false,
  }
  return {
    domElement: canvas,
    debug: { checkShaderErrors: true, onShaderError: null },
    outputColorSpace: THREE.SRGBColorSpace,
    toneMapping: THREE.NoToneMapping,
    toneMappingExposure: 1,
    shadowMap: { enabled: false, type: THREE.PCFShadowMap },
    setPixelRatio: () => undefined,
    setClearColor: (_color: THREE.ColorRepresentation, alpha = 1) => { audit.clearAlphas.push(alpha) },
    setRenderTarget: () => undefined,
    setSize: (width: number, height: number) => {
      audit.renderSizes.push([width, height])
      canvas.width = width
      canvas.height = height
    },
    clear: () => canvas.context.clearRect(0, 0, canvas.width, canvas.height),
    render: () => {
      canvas.paintModel()
    },
    getContext: () => gl,
    dispose: () => undefined,
    forceContextLoss: () => undefined,
  } as unknown as THREE.WebGLRenderer
}

function meshFixture(): MeshData {
  return {
    positions: new Float32Array([-0.7, -0.5, 0, 0.7, -0.5, 0, 0, 0.7, 0.2]),
    indices: new Uint32Array([0, 1, 2]),
    colors: new Float32Array([0.9, 0.3, 0.2, 0.2, 0.8, 0.4, 0.3, 0.4, 0.9]),
    uvs: new Float32Array([0, 0, 1, 0, 0.5, 1]),
    heights: new Float32Array([0, 0.5, 1]),
    width: 3,
    height: 1,
    mode: 'plane',
  }
}

interface DecodedPng {
  chunkTypes: string[]
  idatBytes: number
  pixels: Uint8Array
}

async function decodePng(bytes: Uint8Array, width: number, height: number): Promise<DecodedPng> {
  expect(bytes.subarray(0, 8)).toEqual(PNG_SIGNATURE)
  const chunks: Uint8Array[] = []
  const chunkTypes: string[] = []
  let idatBytes = 0
  let offset = 8
  while (offset + 12 <= bytes.length) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false)
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    const data = bytes.slice(offset + 8, offset + 8 + length)
    const expectedCrc = new DataView(bytes.buffer, bytes.byteOffset + offset + 8 + length, 4).getUint32(0, false)
    expect(crc32(bytes.subarray(offset + 4, offset + 8 + length))).toBe(expectedCrc)
    chunkTypes.push(type)
    if (type === 'IDAT') {
      chunks.push(data)
      idatBytes += data.length
    }
    offset += length + 12
    if (type === 'IEND') break
  }

  const scanlines = await transformBytes(concatenate(chunks), new DecompressionStream('deflate'))
  const pixels = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1)
    expect(scanlines[row]).toBe(0)
    pixels.set(scanlines.subarray(row + 1, row + 1 + width * 4), y * width * 4)
  }
  return { chunkTypes, idatBytes, pixels }
}

describe('Final PNG integration', () => {
  it('composes and encodes a decodable, contentful transparent PNG', async () => {
    tracerAudit.renderSamples = 0
    tracerAudit.sceneBuilds = 0
    const width = 9
    const height = 7
    const canvases = [new MemoryCanvas(), new MemoryCanvas()]
    const audit: RenderAudit = { clearAlphas: [], renderSizes: [] }
    const result = await renderFinalImagePng({
      mesh: meshFixture(),
      colorMode: 'clay',
      appearance: createDefaultAppearanceSettings(),
      environment: null,
      camera: new THREE.PerspectiveCamera(38, width / height, 0.01, 100),
      width,
      height,
      background: 'transparent',
      studioBackground: 'dark-gray',
      signal: new AbortController().signal,
      runtime: {
        createCanvas: () => canvases.shift() as unknown as ExportCanvas,
        createRenderer: (canvas) => fakeRenderer(canvas as unknown as MemoryCanvas, audit),
        encodeCanvas: async (canvas) => {
          const memory = canvas as unknown as MemoryCanvas
          const bytes = await encodeRgbaPng(memory.width, memory.height, memory.pixels)
          return new Blob([copiedBuffer(bytes)], { type: 'image/png' })
        },
        yieldToHost: async () => undefined,
        now: () => 0,
      },
    })

    expect(result).toMatchObject({ width, height, dpi: 300, samples: 6144, tiles: 1 })
    expect(tracerAudit).toEqual({ renderSamples: 6144, sceneBuilds: 1 })
    expect(audit.renderSizes).toEqual([[width, height]])
    expect(audit.clearAlphas).toEqual([0, 0])
    const bytes = new Uint8Array(await result.blob.arrayBuffer())
    expect(inspectPngHeader(bytes)).toMatchObject({ width, height, bitDepth: 8, colorType: 6, hasAlpha: true })

    const decoded = await decodePng(bytes, width, height)
    expect(decoded.chunkTypes).toEqual(['IHDR', 'pHYs', 'IDAT', 'IEND'])
    expect(decoded.idatBytes).toBeGreaterThan(0)
    const pixel = (x: number, y: number) => decoded.pixels.slice((y * width + x) * 4, (y * width + x + 1) * 4)
    expect([...pixel(0, 0)]).toEqual([0, 0, 0, 0])
    expect([...pixel(width - 1, height - 1)]).toEqual([0, 0, 0, 0])
    expect([...pixel(Math.floor(width / 2), Math.floor(height / 2))][3]).toBe(255)

    const opaqueColors = new Set<string>()
    for (let offset = 0; offset < decoded.pixels.length; offset += 4) {
      if (decoded.pixels[offset + 3] === 255) {
        opaqueColors.add(`${decoded.pixels[offset]},${decoded.pixels[offset + 1]},${decoded.pixels[offset + 2]}`)
      }
    }
    expect(opaqueColors.size).toBeGreaterThan(1)
  })
})
