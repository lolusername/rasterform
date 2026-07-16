import * as THREE from 'three'
import type { ViewportExportLongEdge } from '../types'

export const GUIDE_LAYER = 31
export const PNG_DPI = 300

export interface ViewportDimensions {
  width: number
  height: number
}

export interface RenderTile extends ViewportDimensions {
  x: number
  y: number
}

export interface ViewportPngResult extends ViewportDimensions {
  blob: Blob
  dpi: number
}

export interface ViewportExportRuntime {
  createCanvas: () => HTMLCanvasElement
  createRenderer: (canvas: HTMLCanvasElement) => THREE.WebGLRenderer
}

export function calculateViewportDimensions(
  viewportWidth: number,
  viewportHeight: number,
  longEdge: ViewportExportLongEdge,
): ViewportDimensions {
  const sourceWidth = Math.max(1, Number.isFinite(viewportWidth) ? viewportWidth : 1)
  const sourceHeight = Math.max(1, Number.isFinite(viewportHeight) ? viewportHeight : 1)
  if (sourceWidth >= sourceHeight) {
    return {
      width: longEdge,
      height: Math.max(1, Math.round(longEdge * sourceHeight / sourceWidth)),
    }
  }
  return {
    width: Math.max(1, Math.round(longEdge * sourceWidth / sourceHeight)),
    height: longEdge,
  }
}

export function calculateRenderTiles(width: number, height: number, tileEdge: number): RenderTile[] {
  const safeWidth = Math.max(1, Math.round(width))
  const safeHeight = Math.max(1, Math.round(height))
  const edge = Math.max(1, Math.round(tileEdge))
  const tiles: RenderTile[] = []
  for (let y = 0; y < safeHeight; y += edge) {
    for (let x = 0; x < safeWidth; x += edge) {
      tiles.push({
        x,
        y,
        width: Math.min(edge, safeWidth - x),
        height: Math.min(edge, safeHeight - y),
      })
    }
  }
  return tiles
}

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

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  new DataView(target.buffer, target.byteOffset, target.byteLength).setUint32(offset, value >>> 0, false)
}

function chunkType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset + 4] ?? 0,
    bytes[offset + 5] ?? 0,
    bytes[offset + 6] ?? 0,
    bytes[offset + 7] ?? 0,
  )
}

function createDensityChunk(dpi: number): Uint8Array {
  const pixelsPerMeter = Math.max(1, Math.round(dpi / 0.0254))
  const chunk = new Uint8Array(21)
  writeUint32(chunk, 0, 9)
  chunk.set([0x70, 0x48, 0x59, 0x73], 4) // pHYs
  writeUint32(chunk, 8, pixelsPerMeter)
  writeUint32(chunk, 12, pixelsPerMeter)
  chunk[16] = 1
  writeUint32(chunk, 17, crc32(chunk.subarray(4, 17)))
  return chunk
}

/** Replace any browser-authored pHYs chunk with an explicit print density. */
export function setPngDensity(bytes: Uint8Array, dpi = PNG_DPI): Uint8Array {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  if (bytes.length < 33 || signature.some((value, index) => bytes[index] !== value)) {
    throw new Error('The viewport encoder did not return a valid PNG.')
  }

  const chunks: Uint8Array[] = [bytes.slice(0, 8)]
  const density = createDensityChunk(dpi)
  let offset = 8
  let foundHeader = false

  while (offset + 12 <= bytes.length) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false)
    const total = length + 12
    if (offset + total > bytes.length) throw new Error('The viewport PNG is truncated.')
    const type = chunkType(bytes, offset)
    const chunk = bytes.slice(offset, offset + total)
    if (type !== 'pHYs') chunks.push(chunk)
    if (type === 'IHDR') {
      chunks.push(density)
      foundHeader = true
    }
    offset += total
    if (type === 'IEND') break
  }

  if (!foundHeader) throw new Error('The viewport PNG is missing its header.')
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const output = new Uint8Array(size)
  let cursor = 0
  for (const chunk of chunks) {
    output.set(chunk, cursor)
    cursor += chunk.length
  }
  return output
}

async function canvasPng(canvas: HTMLCanvasElement): Promise<Blob> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('The browser could not encode the viewport PNG.')
  return blob
}

export async function renderTransparentViewportPng(options: {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  liveRenderer: THREE.WebGLRenderer
  viewportWidth: number
  viewportHeight: number
  longEdge: ViewportExportLongEdge
  runtime?: ViewportExportRuntime
}): Promise<ViewportPngResult> {
  const { width, height } = calculateViewportDimensions(
    options.viewportWidth,
    options.viewportHeight,
    options.longEdge,
  )
  const runtime = options.runtime ?? {
    createCanvas: () => document.createElement('canvas'),
    createRenderer: (canvas: HTMLCanvasElement) => new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    }),
  }
  const outputCanvas = runtime.createCanvas()
  outputCanvas.width = width
  outputCanvas.height = height
  const output = outputCanvas.getContext('2d', { alpha: true })
  if (!output || outputCanvas.width !== width || outputCanvas.height !== height) {
    throw new Error(`${options.longEdge / 1024}K canvas unavailable. Try 4K.`)
  }
  output.clearRect(0, 0, width, height)

  const tileCanvas = runtime.createCanvas()
  let tileRenderer: THREE.WebGLRenderer | null = null
  const liveBackground = options.scene.background
  try {
    options.scene.background = null
    tileRenderer = runtime.createRenderer(tileCanvas)
    tileRenderer.setPixelRatio(1)
    tileRenderer.outputColorSpace = options.liveRenderer.outputColorSpace
    tileRenderer.toneMapping = options.liveRenderer.toneMapping
    tileRenderer.toneMappingExposure = options.liveRenderer.toneMappingExposure
    tileRenderer.shadowMap.enabled = options.liveRenderer.shadowMap.enabled
    tileRenderer.shadowMap.type = options.liveRenderer.shadowMap.type
    tileRenderer.setClearColor(0x000000, 0)

    const gl = tileRenderer.getContext()
    const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array
    const tileEdge = Math.max(1, Math.min(
      2048,
      Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 2048,
      Number(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE)) || 2048,
      Number(viewport[0]) || 2048,
      Number(viewport[1]) || 2048,
    ))
    const tiles = calculateRenderTiles(width, height, tileEdge)
    const exportCamera = options.camera.clone()
    exportCamera.aspect = width / height
    exportCamera.clearViewOffset()
    exportCamera.layers.disable(GUIDE_LAYER)
    exportCamera.updateProjectionMatrix()
    exportCamera.updateMatrixWorld(true)
    options.scene.updateMatrixWorld(true)

    for (const tile of tiles) {
      tileRenderer.setSize(tile.width, tile.height, false)
      exportCamera.setViewOffset(width, height, tile.x, tile.y, tile.width, tile.height)
      exportCamera.updateProjectionMatrix()
      tileRenderer.render(options.scene, exportCamera)
      output.drawImage(
        tileRenderer.domElement,
        0,
        0,
        tile.width,
        tile.height,
        tile.x,
        tile.y,
        tile.width,
        tile.height,
      )
    }

    options.scene.background = liveBackground
    const raw = await canvasPng(outputCanvas)
    const png = setPngDensity(new Uint8Array(await raw.arrayBuffer()), PNG_DPI)
    const payload = new ArrayBuffer(png.byteLength)
    new Uint8Array(payload).set(png)
    return { blob: new Blob([payload], { type: 'image/png' }), width, height, dpi: PNG_DPI }
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown rendering error.'
    throw new Error(`Viewport PNG failed: ${detail}`)
  } finally {
    options.scene.background = liveBackground
    tileRenderer?.dispose()
    tileRenderer?.forceContextLoss()
    tileCanvas.width = 1
    tileCanvas.height = 1
    outputCanvas.width = 1
    outputCanvas.height = 1
  }
}
