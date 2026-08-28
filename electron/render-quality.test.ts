import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'
import * as THREE from 'three'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeshData } from '../src/types'
import {
  FINAL_BATCH_BUDGET_MS,
  FINAL_DENOISE_PADDING,
  FINAL_DENOISE_SETTINGS,
  FINAL_PATH_TRACER_TILES,
  FINAL_TILE_EDGE,
  finalSampleTarget,
  renderFinalImagePng,
} from '../src/lib/final-image-export'
import { createDefaultAppearanceSettings } from '../src/lib/three'
import type { ExportCanvas } from '../src/lib/viewport-export'

const qualityAudit = vi.hoisted(() => ({
  tracer: null as null | {
    bounces: number
    transmissiveBounces: number
    multipleImportanceSampling: boolean
    filterGlossyFactor: number
    tiles: { x: number; y: number }
    dynamicLowRes: boolean
    lowResScale: number
    renderScale: number
    renderDelay: number
    minSamples: number
    fadeDuration: number
    rasterizeScene: boolean
    renderToCanvas: boolean
    samples: number
    _pathTracer: {
      material: {
        fragmentShader: string
        defines?: Record<string, number>
      }
    }
  },
  denoiseSettings: null as unknown,
  sceneBuilds: 0,
}))

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
    dynamicLowRes = true
    lowResScale = 1
    renderScale = 0.25
    renderDelay = 1
    minSamples = 0
    fadeDuration = 1
    rasterizeScene = true
    renderToCanvas = true
    samples = 0
    readonly target = { texture: new THREE.Texture() }
    readonly isCompiling = false

    constructor(_renderer: THREE.WebGLRenderer) {
      qualityAudit.tracer = this
    }

    setBVHWorker() {}

    async setSceneAsync(
      _scene: THREE.Scene,
      _camera: THREE.Camera,
      options?: { onProgress?: (value: number) => void },
    ) {
      qualityAudit.sceneBuilds += 1
      options?.onProgress?.(1)
    }

    setCamera() {
      this.samples = 0
    }

    renderSample() {
      this.samples += 1
    }

    dispose() {
      this.target.texture.dispose()
    }
  }

  class DenoiseMaterial extends THREE.MeshBasicMaterial {
    constructor(settings: unknown) {
      super()
      qualityAudit.denoiseSettings = settings
    }
  }

  return { WebGLPathTracer, DenoiseMaterial }
})

vi.mock('three-mesh-bvh/worker', () => ({
  GenerateMeshBVHWorker: class {
    dispose() {}
  },
}))

class TinyCanvas {
  width = 1
  height = 1

  readonly context = {
    fillStyle: '#000000',
    clearRect: () => undefined,
    fillRect: () => undefined,
    drawImage: () => undefined,
  }

  getContext(kind: string) {
    return kind === '2d' ? this.context : null
  }
}

function fakeRenderer(canvas: TinyCanvas): THREE.WebGLRenderer {
  const gl = {
    MAX_VIEWPORT_DIMS: 1,
    MAX_TEXTURE_SIZE: 2,
    MAX_RENDERBUFFER_SIZE: 3,
    getParameter: (parameter: number) => parameter === 1 ? new Int32Array([16_384, 16_384]) : 16_384,
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
    setClearColor: () => undefined,
    setRenderTarget: () => undefined,
    setSize: (width: number, height: number) => {
      canvas.width = width
      canvas.height = height
    },
    clear: () => undefined,
    render: () => undefined,
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

function onePixelRgbaPng(): Blob {
  const encoded = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  )
  const payload = new ArrayBuffer(encoded.byteLength)
  new Uint8Array(payload).set(encoded)
  return new Blob([payload], { type: 'image/png' })
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}

describe('desktop Final quality delegation', () => {
  beforeEach(() => {
    qualityAudit.tracer = null
    qualityAudit.denoiseSettings = null
    qualityAudit.sceneBuilds = 0
  })

  it('runs the shared renderer with the complete production quality contract', async () => {
    const canvases = [new TinyCanvas(), new TinyCanvas()]
    const appearance = createDefaultAppearanceSettings()
    const result = await renderFinalImagePng({
      mesh: meshFixture(),
      colorMode: 'clay',
      appearance,
      environment: null,
      camera: new THREE.PerspectiveCamera(38, 1, 0.01, 100),
      width: 1,
      height: 1,
      background: 'transparent',
      studioBackground: 'dark-gray',
      runtime: {
        createCanvas: () => canvases.shift() as unknown as ExportCanvas,
        createRenderer: (canvas) => fakeRenderer(canvas as unknown as TinyCanvas),
        encodeCanvas: async () => onePixelRgbaPng(),
        yieldToHost: async () => undefined,
        now: () => 0,
      },
    })

    expect(result).toMatchObject({ width: 1, height: 1, dpi: 300, samples: 6144, tiles: 1 })
    expect(qualityAudit.sceneBuilds).toBe(1)
    expect(qualityAudit.tracer).toMatchObject({
      bounces: 4,
      transmissiveBounces: 2,
      multipleImportanceSampling: true,
      filterGlossyFactor: 0.75,
      tiles: { x: 3, y: 3 },
      dynamicLowRes: false,
      lowResScale: 0.01,
      renderScale: 1,
      renderDelay: 0,
      minSamples: 1,
      fadeDuration: 0,
      rasterizeScene: false,
      renderToCanvas: false,
      samples: 6144,
    })
    expect(qualityAudit.denoiseSettings).toEqual({
      sigma: 2.5,
      kSigma: 1.5,
      threshold: 0.055,
    })
    expect(FINAL_TILE_EDGE).toBe(1024)
    expect(FINAL_DENOISE_PADDING).toBe(8)
    expect(FINAL_BATCH_BUDGET_MS).toBe(6)
    expect(FINAL_PATH_TRACER_TILES).toBe(3)
    expect(FINAL_DENOISE_SETTINGS).toEqual({ sigma: 2.5, kSigma: 1.5, threshold: 0.055 })
    expect(qualityAudit.tracer?._pathTracer.material.defines?.RANDOM_TYPE).toBe(0)
    expect(qualityAudit.tracer?._pathTracer.material.fragmentShader).toContain('isnan( gl_FragColor.rgb )')

    appearance.clay.finish = 'glossy'
    expect(finalSampleTarget('clay', appearance)).toBe(8192)
    appearance.clay.finish = 'metallic'
    expect(finalSampleTarget('clay', appearance)).toBe(8192)
  })

  it('makes the hidden renderer delegate to the shared quality owner without a sample override', async () => {
    const rendererPath = fileURLToPath(new URL('./render/renderer.ts', import.meta.url))
    const source = ts.createSourceFile(
      rendererPath,
      await readFile(rendererPath, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    )
    const sharedImport = source.statements.find((statement): statement is ts.ImportDeclaration => (
      ts.isImportDeclaration(statement)
      && ts.isStringLiteral(statement.moduleSpecifier)
      && statement.moduleSpecifier.text === '../../src/lib/final-image-export'
    ))
    expect(sharedImport).toBeDefined()
    const importedNames = sharedImport?.importClause?.namedBindings
      && ts.isNamedImports(sharedImport.importClause.namedBindings)
      ? sharedImport.importClause.namedBindings.elements.map((element) => element.name.text)
      : []
    expect(importedNames).toEqual(expect.arrayContaining(['finalSampleTarget', 'renderFinalImagePng']))

    const renderCalls: ts.CallExpression[] = []
    const targetCalls: ts.CallExpression[] = []
    const progressCalls: ts.CallExpression[] = []
    walk(source, (node) => {
      if (!ts.isCallExpression(node)) return
      if (ts.isIdentifier(node.expression)) {
        if (node.expression.text === 'renderFinalImagePng') renderCalls.push(node)
        if (node.expression.text === 'finalSampleTarget') targetCalls.push(node)
      }
      if (ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'progress') progressCalls.push(node)
    })

    expect(renderCalls).toHaveLength(1)
    expect(targetCalls).toHaveLength(1)
    const options = renderCalls[0]?.arguments[0]
    expect(options && ts.isObjectLiteralExpression(options)).toBe(true)
    if (!options || !ts.isObjectLiteralExpression(options)) return
    const optionNames = options.properties.flatMap((property) => {
      if (ts.isShorthandPropertyAssignment(property)) return [property.name.text]
      if (!ts.isPropertyAssignment(property) || !property.name) return []
      return ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
        ? [property.name.text]
        : []
    })
    expect(optionNames).toEqual(expect.arrayContaining([
      'mesh',
      'colorMode',
      'appearance',
      'environment',
      'camera',
      'width',
      'height',
      'background',
      'studioBackground',
      'signal',
      'onProgress',
    ]))
    expect(optionNames).not.toContain('samples')
    expect(optionNames).not.toContain('sampleTarget')
    expect(optionNames).not.toContain('runtime')

    const preparingProgress = progressCalls.find((call) => {
      const payload = call.arguments[1]
      return payload && ts.isObjectLiteralExpression(payload)
        && payload.properties.some((property) => ts.isPropertyAssignment(property)
          && ts.isIdentifier(property.name)
          && property.name.text === 'phase'
          && ts.isStringLiteral(property.initializer)
          && property.initializer.text === 'preparing')
    })
    expect(preparingProgress).toBeDefined()
    const preparingPayload = preparingProgress?.arguments[1]
    expect(preparingPayload && ts.isObjectLiteralExpression(preparingPayload)).toBe(true)
    if (!preparingPayload || !ts.isObjectLiteralExpression(preparingPayload)) return
    expect(preparingPayload.properties.some((property) => (
      ts.isShorthandPropertyAssignment(property) && property.name.text === 'targetSamples'
    ))).toBe(true)
  })
})
