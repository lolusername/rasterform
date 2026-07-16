<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import type { WebGLPathTracer } from 'three-gpu-pathtracer'
import {
  addStudioLighting,
  configureStudioRenderer,
  createFinalRenderScene,
  createStudioFloor,
  createThreeMesh,
  placeStudioFloor,
} from '../lib/three'
import { ProgressiveRenderController } from '../lib/progressive-render'
import type { ProgressiveRenderSnapshot } from '../lib/progressive-render'
import {
  GUIDE_LAYER,
  renderTransparentViewportPng,
  setPngDensity,
} from '../lib/viewport-export'
import { buildPathTracingScene } from '../lib/path-tracer-setup'
import type {
  AppearanceSettings,
  ColorMode,
  MeshData,
  RenderMode,
  ViewportExportLongEdge,
  ViewportSupersample,
} from '../types'
import type { ViewportPngResult } from '../lib/viewport-export'

const props = withDefaults(defineProps<{
  mesh: MeshData
  colorMode: ColorMode
  appearance: AppearanceSettings
  renderMode?: RenderMode
  finalTargetSamples?: number
}>(), {
  renderMode: 'realtime',
  finalTargetSamples: 64,
})

const emit = defineEmits<{
  'final-progress': [snapshot: ProgressiveRenderSnapshot]
  'final-invalidated': []
}>()

const canvas = ref<HTMLCanvasElement | null>(null)
let renderer: THREE.WebGLRenderer | null = null
let scene: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null
let controls: OrbitControls | null = null
let object: THREE.Mesh | null = null
let floor: THREE.Mesh | null = null
let grid: THREE.GridHelper | null = null
let composer: EffectComposer | null = null
let gtaoPass: GTAOPass | null = null
let outputPass: OutputPass | null = null
let resizeObserver: ResizeObserver | null = null
let environment: THREE.DataTexture | null = null
let pathTracer: WebGLPathTracer | null = null
let finalScene: THREE.Scene | null = null
let animationFrame = 0
let finalBuildGeneration = 0
let mounted = false

const finalRender = new ProgressiveRenderController(
  props.finalTargetSamples,
  (snapshot) => emit('final-progress', snapshot),
)

function disposeMaterial(material: THREE.Material | THREE.Material[]) {
  if (Array.isArray(material)) material.forEach((item) => item.dispose())
  else material.dispose()
}

function disposeLiveObject() {
  if (!object || !scene) return
  scene.remove(object)
  object.geometry.dispose()
  disposeMaterial(object.material)
  object = null
}

function disposeFinalScene(target: THREE.Scene | null = finalScene) {
  if (!target) return
  target.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return
    child.geometry.dispose()
    disposeMaterial(child.material)
  })
  if (finalScene === target) finalScene = null
}

function stopFinalRender() {
  finalBuildGeneration += 1
  finalRender.stop()
  pathTracer = null
  disposeFinalScene()
}

function updateObject() {
  if (!scene) return
  const invalidatesFinal = object !== null && props.renderMode === 'final'
  if (invalidatesFinal) stopFinalRender()
  disposeLiveObject()
  object = createThreeMesh(props.mesh, props.colorMode, props.appearance)
  scene.add(object)
  if (floor) placeStudioFloor(floor, object)
  if (grid && floor) grid.position.z = floor.position.z + 0.002
  if (invalidatesFinal) emit('final-invalidated')
}

async function captureTransparentPng(
  longEdge: ViewportExportLongEdge,
  supersample: ViewportSupersample = 2,
): Promise<ViewportPngResult> {
  if (!canvas.value || !renderer || !scene || !camera) throw new Error('Viewport is not ready.')
  controls?.update()
  camera.updateMatrixWorld(true)
  return renderTransparentViewportPng({
    scene,
    camera,
    liveRenderer: renderer,
    viewportWidth: canvas.value.clientWidth,
    viewportHeight: canvas.value.clientHeight,
    longEdge,
    supersample,
  })
}

async function captureFinalPng(): Promise<ViewportPngResult & { samples: number }> {
  if (!canvas.value || !pathTracer || finalRender.snapshot.samples < 1) {
    throw new Error('Start Final Render and wait for at least one sample first.')
  }
  const raw = await new Promise<Blob | null>((resolve) => canvas.value!.toBlob(resolve, 'image/png'))
  if (!raw) throw new Error('The browser could not encode the Final Render canvas.')
  const bytes = setPngDensity(new Uint8Array(await raw.arrayBuffer()))
  const payload = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(payload).set(bytes)
  return {
    blob: new Blob([payload], { type: 'image/png' }),
    width: canvas.value.width,
    height: canvas.value.height,
    dpi: 300,
    supersample: 1,
    samples: finalRender.snapshot.samples,
  }
}

defineExpose({ captureTransparentPng, captureFinalPng })

function resize() {
  if (!canvas.value || !renderer || !camera) return
  const width = Math.max(1, canvas.value.clientWidth)
  const height = Math.max(1, canvas.value.clientHeight)
  renderer.setSize(width, height, false)
  composer?.setSize(width, height)
  camera.aspect = width / height
  camera.updateProjectionMatrix()
  if (props.renderMode === 'final' && pathTracer) finalRender.invalidateCamera()
}

function handleCameraChange() {
  if (props.renderMode === 'final' && pathTracer) finalRender.invalidateCamera()
}

function render() {
  animationFrame = requestAnimationFrame(render)
  controls?.update()
  if (props.renderMode === 'final' && pathTracer) finalRender.tick()
  else composer?.render()
}

async function prepareFinalRender() {
  if (!renderer || !camera || !mounted) return
  if (props.colorMode === 'wireframe') {
    finalRender.fail(new Error('Final Render supports Photo, Height, and Clay materials.'))
    return
  }

  stopFinalRender()
  const generation = finalBuildGeneration
  finalRender.beginPreparing()
  let buildingTracer: WebGLPathTracer | null = null
  let renderScene: THREE.Scene | null = null

  try {
    const [{ WebGLPathTracer }, { GenerateMeshBVHWorker }] = await Promise.all([
      import('three-gpu-pathtracer'),
      import('three-mesh-bvh/worker'),
    ])
    if (!mounted || generation !== finalBuildGeneration || !renderer || !camera) return

    const bundle = createFinalRenderScene(
      props.mesh,
      props.colorMode,
      props.appearance,
      environment,
    )
    renderScene = bundle.scene
    finalScene = renderScene

    const tracer = new WebGLPathTracer(renderer)
    buildingTracer = tracer
    tracer.bounces = 6
    tracer.transmissiveBounces = 4
    tracer.filterGlossyFactor = 0.5
    tracer.tiles.set(2, 2)
    tracer.dynamicLowRes = true
    tracer.lowResScale = 0.25
    tracer.renderScale = 1
    tracer.renderDelay = 75
    tracer.minSamples = 1
    tracer.fadeDuration = 250
    tracer.rasterizeSceneCallback = () => composer?.render()

    await buildPathTracingScene(
      tracer,
      new GenerateMeshBVHWorker(),
      renderScene,
      camera,
      (progress) => finalRender.updatePreparation(progress),
    )

    if (!mounted || generation !== finalBuildGeneration) {
      tracer.dispose()
      disposeFinalScene(renderScene)
      return
    }
    tracer.updateEnvironment()
    finalRender.attach(tracer)
    pathTracer = tracer
    buildingTracer = null
  } catch (error) {
    buildingTracer?.dispose()
    disposeFinalScene(renderScene)
    if (generation !== finalBuildGeneration) return
    pathTracer = null
    finalRender.fail(error)
  }
}

async function loadEnvironment() {
  try {
    const texture = await new RGBELoader().loadAsync('/hdri/studio_small_08_1k.hdr')
    texture.mapping = THREE.EquirectangularReflectionMapping
    if (!mounted || !scene) {
      texture.dispose()
      return
    }
    environment?.dispose()
    environment = texture
    scene.environment = texture
    scene.environmentIntensity = 0.78
    if (finalScene) {
      finalScene.environment = texture
      finalScene.environmentIntensity = 0.86
      if (pathTracer) {
        pathTracer.updateEnvironment()
        finalRender.invalidateCamera()
      }
    }
  } catch {
    // The direct studio lights remain a deliberate offline fallback.
  }
}

onMounted(() => {
  if (!canvas.value) return
  mounted = true
  renderer = new THREE.WebGLRenderer({
    canvas: canvas.value,
    antialias: true,
    alpha: false,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  configureStudioRenderer(renderer)
  renderer.setClearColor(0x111310, 1)

  scene = new THREE.Scene()
  camera = new THREE.PerspectiveCamera(38, 1, 0.01, 100)
  camera.position.set(2.45, -2.2, 2.15)
  camera.lookAt(0, 0, 0)
  camera.layers.enable(GUIDE_LAYER)

  controls = new OrbitControls(camera, canvas.value)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.minDistance = 1.3
  controls.maxDistance = 8
  controls.target.set(0, 0, 0.12)
  controls.addEventListener('change', handleCameraChange)

  addStudioLighting(scene)
  floor = createStudioFloor()
  floor.layers.set(GUIDE_LAYER)
  scene.add(floor)
  grid = new THREE.GridHelper(4, 16, 0x52574e, 0x2a2e29)
  grid.rotation.x = Math.PI / 2
  grid.layers.set(GUIDE_LAYER)
  scene.add(grid)
  updateObject()

  composer = new EffectComposer(renderer)
  composer.addPass(new RenderPass(scene, camera))
  gtaoPass = new GTAOPass(scene, camera, 1, 1)
  gtaoPass.output = GTAOPass.OUTPUT.Default
  gtaoPass.blendIntensity = 0.78
  gtaoPass.updateGtaoMaterial({
    radius: 0.32,
    distanceExponent: 1.4,
    thickness: 0.7,
    distanceFallOff: 1,
    scale: 1,
    samples: 16,
  })
  gtaoPass.updatePdMaterial({ rings: 2, radiusExponent: 2, samples: 12, lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 7 })
  composer.addPass(gtaoPass)
  outputPass = new OutputPass()
  composer.addPass(outputPass)

  resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(canvas.value)
  resize()
  void loadEnvironment()
  if (props.renderMode === 'final') void prepareFinalRender()
  render()
})

watch(
  () => [
    props.mesh,
    props.colorMode,
    props.appearance.heightGradient.low,
    props.appearance.heightGradient.mid,
    props.appearance.heightGradient.high,
    props.appearance.heightGradient.midpoint,
    props.appearance.clay.color,
    props.appearance.clay.finish,
  ] as const,
  updateObject,
  { deep: false },
)

watch(
  () => props.renderMode,
  (mode) => {
    if (!mounted) return
    if (mode === 'final') void prepareFinalRender()
    else stopFinalRender()
  },
)

onBeforeUnmount(() => {
  mounted = false
  finalBuildGeneration += 1
  cancelAnimationFrame(animationFrame)
  resizeObserver?.disconnect()
  controls?.removeEventListener('change', handleCameraChange)
  controls?.dispose()
  stopFinalRender()
  finalRender.dispose()
  disposeLiveObject()
  floor?.geometry.dispose()
  if (floor) disposeMaterial(floor.material)
  gtaoPass?.dispose()
  outputPass?.dispose()
  composer?.dispose()
  environment?.dispose()
  renderer?.dispose()
})
</script>

<template>
  <canvas
    ref="canvas"
    class="three-preview"
    aria-label="Orbitable 3D preview of the channel-driven relief. Drag to rotate and scroll to zoom."
  />
</template>
