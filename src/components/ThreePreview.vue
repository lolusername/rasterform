<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import {
  addStudioLighting,
  configureStudioRenderer,
  createFinalRenderScene,
  createThreeMesh,
  disposeFinalRenderScene,
} from '../lib/three'
import { viewportBackgroundPreset } from '../lib/background'
import {
  canUseImageExportWorker,
  renderImageExportInWorker,
} from '../lib/image-export-worker'
import {
  awaitExportTask,
  renderFinalImagePng,
  type FinalExportProgress,
  type FinalImagePngResult,
} from '../lib/final-image-export'
import { renderViewportPng } from '../lib/viewport-export'
import type { ViewportExportProgress, ViewportPngResult } from '../lib/viewport-export'
import type {
  AppearanceSettings,
  ColorMode,
  ImageExportBackground,
  MeshData,
  ViewportBackground,
} from '../types'

const props = withDefaults(defineProps<{
  mesh: MeshData | null
  colorMode: ColorMode
  appearance: AppearanceSettings
  background?: ViewportBackground
  interactionLocked?: boolean
}>(), {
  background: 'dark-gray',
  interactionLocked: false,
})

const emit = defineEmits<{
  'export-progress': [progress: FinalExportProgress]
}>()

const canvas = ref<HTMLCanvasElement | null>(null)
const exportActive = ref(false)
const canvasStyle = computed(() => ({
  backgroundColor: viewportBackgroundPreset(props.background).color,
}))
let renderer: THREE.WebGLRenderer | null = null
let scene: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null
let controls: OrbitControls | null = null
let object: THREE.Mesh | null = null
let composer: EffectComposer | null = null
let gtaoPass: GTAOPass | null = null
let outputPass: OutputPass | null = null
let resizeObserver: ResizeObserver | null = null
let environment: THREE.DataTexture | null = null
let environmentReady: Promise<void> | null = null
let activeExport: AbortController | null = null
const mainThreadExport = ref(false)
let animationFrame = 0
let mounted = false

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

function updateObject() {
  if (!scene) return
  disposeLiveObject()
  if (!props.mesh) return
  object = createThreeMesh(props.mesh, props.colorMode, props.appearance)
  scene.add(object)
}

function updateBackground() {
  renderer?.setClearColor(0x000000, 0)
  if (scene) scene.background = null
}

async function captureHighPng(
  dimensions: { width: number; height: number },
  background: ImageExportBackground,
): Promise<ViewportPngResult> {
  if (!canvas.value || !renderer || !camera || !props.mesh) throw new Error('There is no model to export.')
  cancelImageExport()
  const controller = new AbortController()
  activeExport = controller
  exportActive.value = true
  controls?.update()
  camera.updateMatrixWorld(true)
  const exportCamera = camera.clone()
  const exportMesh = props.mesh
  const exportColorMode = props.colorMode
  const exportAppearance: AppearanceSettings = {
    heightGradient: { ...props.appearance.heightGradient },
    clay: { ...props.appearance.clay },
  }
  const exportBackground = props.background
  try {
    await awaitExportTask(environmentReady ?? Promise.resolve(), controller.signal)
    if (controller.signal.aborted) throw new DOMException('Image export cancelled.', 'AbortError')
    if (!canvas.value || !renderer || !camera) throw new Error('Viewport is no longer available.')

    if (canUseImageExportWorker()) {
      let workerMadeProgress = false
      try {
        return await renderImageExportInWorker({
          quality: 'high',
          mesh: exportMesh,
          colorMode: exportColorMode,
          appearance: exportAppearance,
          environment,
          camera: exportCamera,
          width: dimensions.width,
          height: dimensions.height,
          background,
          studioBackground: exportBackground,
          supersample: 2,
          signal: controller.signal,
          onProgress: (progress) => {
            workerMadeProgress = true
            emit('export-progress', progress)
          },
        })
      } catch (error) {
        if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error
        if (workerMadeProgress) throw error
        // Older browsers and constrained GPUs fall back to the same tiled render
        // on the main thread only when the background renderer never started.
      }
    }

    mainThreadExport.value = true
    if (controls) controls.enabled = false
    const renderScene = createFinalRenderScene(
      exportMesh,
      exportColorMode,
      exportAppearance,
      environment,
      background,
      exportBackground,
    )
    const reportHighProgress = (progress: ViewportExportProgress) => emit('export-progress', {
      phase: progress.phase,
      progress: progress.progress,
      tile: progress.tile,
      tiles: progress.tiles,
      samples: progress.progress >= 1 ? 1 : 0,
      targetSamples: 1,
    })
    try {
      return await renderViewportPng({
        scene: renderScene.scene,
        camera: exportCamera,
        liveRenderer: renderer,
        width: dimensions.width,
        height: dimensions.height,
        supersample: 2,
        signal: controller.signal,
        onProgress: reportHighProgress,
      })
    } finally {
      disposeFinalRenderScene(renderScene)
    }
  } finally {
    if (activeExport === controller) activeExport = null
    mainThreadExport.value = false
    exportActive.value = false
    if (controls) controls.enabled = !props.interactionLocked
  }
}

async function captureFinalPng(
  dimensions: { width: number; height: number },
  background: ImageExportBackground,
): Promise<FinalImagePngResult> {
  if (!canvas.value || !camera || !props.mesh) throw new Error('There is no model to export.')
  if (Math.max(dimensions.width, dimensions.height) > 4096) {
    throw new Error('8K Final is too large for a reliable browser render. Choose 4K or High quality.')
  }
  cancelImageExport()
  const controller = new AbortController()
  activeExport = controller
  exportActive.value = true
  controls?.update()
  camera.updateMatrixWorld(true)
  const exportCamera = camera.clone()
  const exportMesh = props.mesh
  const exportColorMode = props.colorMode
  const exportAppearance: AppearanceSettings = {
    heightGradient: { ...props.appearance.heightGradient },
    clay: { ...props.appearance.clay },
  }
  const exportBackground = props.background
  try {
    await awaitExportTask(environmentReady ?? Promise.resolve(), controller.signal)
    if (controller.signal.aborted) throw new DOMException('Final image export cancelled.', 'AbortError')
    if (!canvas.value || !camera) throw new Error('Viewport is no longer available.')

    // Final stays on the main thread so its BVH worker is never nested inside
    // another worker. Some browsers leave nested module workers pending forever.
    mainThreadExport.value = true
    if (controls) controls.enabled = false
    return await renderFinalImagePng({
      mesh: exportMesh,
      colorMode: exportColorMode,
      appearance: exportAppearance,
      environment,
      camera: exportCamera,
      width: dimensions.width,
      height: dimensions.height,
      background,
      studioBackground: exportBackground,
      signal: controller.signal,
      onProgress: (progress) => emit('export-progress', progress),
    })
  } finally {
    if (activeExport === controller) activeExport = null
    mainThreadExport.value = false
    exportActive.value = false
    if (controls) controls.enabled = !props.interactionLocked
  }
}

function cancelImageExport() {
  activeExport?.abort()
}

defineExpose({ captureHighPng, captureFinalPng, cancelImageExport })

function resize() {
  if (!canvas.value || !renderer || !camera) return
  const width = Math.max(1, canvas.value.clientWidth)
  const height = Math.max(1, canvas.value.clientHeight)
  renderer.setSize(width, height, false)
  composer?.setSize(width, height)
  camera.aspect = width / height
  camera.updateProjectionMatrix()
}

function render() {
  animationFrame = requestAnimationFrame(render)
  controls?.update()
  if (!mainThreadExport.value) composer?.render()
}

async function loadEnvironment() {
  try {
    const texture = await new HDRLoader().loadAsync('/hdri/studio_small_08_1k.hdr')
    texture.mapping = THREE.EquirectangularReflectionMapping
    if (!mounted || !scene) {
      texture.dispose()
      return
    }
    environment?.dispose()
    environment = texture
    scene.environment = texture
    scene.environmentIntensity = 0.78
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
    alpha: true,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  configureStudioRenderer(renderer)
  renderer.setClearColor(0x000000, 0)

  scene = new THREE.Scene()
  updateBackground()
  camera = new THREE.PerspectiveCamera(38, 1, 0.01, 100)
  camera.position.set(2.45, -2.2, 2.15)
  camera.lookAt(0, 0, 0)

  controls = new OrbitControls(camera, canvas.value)
  controls.enableDamping = true
  controls.enablePan = false
  controls.dampingFactor = 0.08
  controls.minDistance = 1.3
  controls.maxDistance = 8
  controls.target.set(0, 0, 0.12)
  controls.enabled = !props.interactionLocked

  addStudioLighting(scene)
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
  environmentReady = loadEnvironment()
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

watch(() => props.background, updateBackground)

watch(
  () => props.interactionLocked,
  (locked) => {
    if (controls) controls.enabled = !locked && !mainThreadExport.value
  },
)

onBeforeUnmount(() => {
  mounted = false
  cancelImageExport()
  cancelAnimationFrame(animationFrame)
  resizeObserver?.disconnect()
  controls?.dispose()
  disposeLiveObject()
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
    :style="canvasStyle"
    :aria-busy="exportActive"
    :aria-label="interactionLocked || mainThreadExport
      ? '3D preview locked while the image renders.'
      : exportActive
        ? 'An image snapshot is rendering in the background. The 3D preview remains orbitable.'
        : mesh
          ? 'Orbitable 3D model preview. Drag to rotate and scroll to zoom.'
          : '3D viewport. Add content to generate a model.'"
  />
</template>
