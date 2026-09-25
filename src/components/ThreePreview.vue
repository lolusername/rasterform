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
  createImageExportWorkerSession,
  decideImageExportWorkerFailure,
  renderImageExportInWorker,
  type ImageExportWorkerSession,
} from '../lib/image-export-worker'
import {
  awaitExportTask,
  renderFinalImagePng,
  type FinalExportProgress,
  type FinalImagePngResult,
} from '../lib/final-image-export'
import {
  renderFinalImageInDesktop,
  type DesktopFinalCaptureResult,
} from '../desktop/client'
import { renderProImageInDesktop } from '../desktop/pro-client'
import type {
  DesktopProCaptureResult,
  DesktopProRenderSettings,
} from '../desktop/pro-contracts'
import { renderViewportPng } from '../lib/viewport-export'
import type { ViewportExportProgress, ViewportPngResult } from '../lib/viewport-export'
import { createStillExportCamera } from '../lib/straight-on-camera'
import { fitStrataCamera } from '../lib/strata-frame'
import { fitViewportFrame } from '../lib/viewport-frame'
import {
  capturePreviewCamera,
  createOutputPreviewCamera,
  isPreviewCameraSnapshot,
  restorePreviewCamera,
  type OutputCompositionPreview,
  type PreviewCameraSnapshot,
} from '../lib/preview-camera'
import {
  DEFAULT_LIVING_FORM_SETTINGS,
  createLivingFormEngine,
  normalizeLivingFormPhase,
  type LivingFormEngine,
} from '../lib/living-form'
import type {
  AppearanceSettings,
  ColorMode,
  ImageExportBackground,
  ImageExportView,
  LivingFormSettings,
  MeshData,
  ViewportBackground,
} from '../types'

const props = withDefaults(defineProps<{
  mesh: MeshData | null
  colorMode: ColorMode
  appearance: AppearanceSettings
  background?: ViewportBackground
  interactionLocked?: boolean
  livingForm?: LivingFormSettings
  livingPhase?: number
  outputPreview?: OutputCompositionPreview | null
}>(), {
  background: 'dark-gray',
  interactionLocked: false,
  livingForm: () => ({ ...DEFAULT_LIVING_FORM_SETTINGS }),
  livingPhase: 0,
  outputPreview: null,
})

const emit = defineEmits<{
  'export-progress': [progress: FinalExportProgress]
  'camera-change': [snapshot: PreviewCameraSnapshot]
}>()

const host = ref<HTMLDivElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
const exportActive = ref(false)
const screenFrame = ref({ width: 1, height: 1 })
const frameStyle = computed(() => ({
  width: `${screenFrame.value.width}px`,
  height: `${screenFrame.value.height}px`,
}))
const canvasStyle = computed(() => ({
  backgroundColor: props.outputPreview?.background === 'transparent' && props.outputPreview.checkerboard
    ? 'transparent'
    : viewportBackgroundPreset(props.background).color,
}))
const straightOnPreview = computed(() => props.outputPreview?.view === 'straight-on')
let renderer: THREE.WebGLRenderer | null = null
let scene: THREE.Scene | null = null
// OrbitControls and all captures own this editing camera. Composition previews
// use a separate camera so entering Export can never rewrite the authored view.
let camera: THREE.PerspectiveCamera | null = null
let outputCamera: THREE.PerspectiveCamera | null = null
let outputCameraDirty = true
let controls: OrbitControls | null = null
let object: THREE.Mesh | null = null
let livingFormEngine: LivingFormEngine | null = null
let appliedLivingFrame = ''
let livingFrameDirty = true
let composer: EffectComposer | null = null
let renderPass: RenderPass | null = null
let gtaoPass: GTAOPass | null = null
let outputPass: OutputPass | null = null
let resizeObserver: ResizeObserver | null = null
let environment: THREE.DataTexture | null = null
let environmentReady: Promise<void> | null = null
let activeExport: AbortController | null = null
const mainThreadExport = ref(false)
let animationFrame = 0
let mounted = false
let framedMesh: MeshData | null = null
let cameraChangeTimer: ReturnType<typeof setTimeout> | null = null
let cameraGestureActive = false
let cameraChangePending = false

interface LivingFormLoopSnapshot {
  engine: LivingFormEngine
  settings: LivingFormSettings
  colorMode: ColorMode
  appearance: AppearanceSettings
  camera: THREE.PerspectiveCamera
  studioBackground: ViewportBackground
  workerSession: ImageExportWorkerSession | null
  workerDisabled: boolean
}

let livingFormLoopSnapshot: LivingFormLoopSnapshot | null = null

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
  livingFormEngine = null
  appliedLivingFrame = ''
  livingFrameDirty = true
}

function livingFrameKey(): string {
  const settings = props.livingForm
  const phase = settings.enabled ? normalizeLivingFormPhase(props.livingPhase) : 0
  return [
    settings.enabled ? 1 : 0,
    phase,
    settings.behavior,
    settings.amount,
    settings.frequency,
    settings.seed,
  ].join(':')
}

/** Update only the reusable position buffer; never rebuild the mesh per frame. */
function applyLivingFormFrame(force = false) {
  if (!object || !livingFormEngine) return
  if (!force && !livingFrameDirty) return
  const key = livingFrameKey()
  if (!force && key === appliedLivingFrame) {
    livingFrameDirty = false
    return
  }
  const position = object.geometry.getAttribute('position')
  if (!(position instanceof THREE.BufferAttribute) || !(position.array instanceof Float32Array)) return
  const settings = props.livingForm.enabled
    ? props.livingForm
    : { ...props.livingForm, amount: 0 }
  livingFormEngine.writePositions(position.array, props.livingPhase, settings)
  position.needsUpdate = true
  object.geometry.computeVertexNormals()
  appliedLivingFrame = key
  livingFrameDirty = false
  outputCameraDirty = true
}

function snapshotLivingFormMesh(phase = props.livingPhase): MeshData {
  if (!props.mesh) throw new Error('There is no model to export.')
  if (!props.livingForm.enabled) return props.mesh
  const engine = livingFormEngine ?? createLivingFormEngine(props.mesh)
  return engine.sampleMesh(phase, props.livingForm)
}

function beginLivingFormLoopExport(settings: LivingFormSettings): void {
  if (!props.mesh || !camera) throw new Error('There is no model to export.')
  endLivingFormLoopExport()
  controls?.update()
  camera.updateMatrixWorld(true)
  let workerSession: ImageExportWorkerSession | null = null
  let workerDisabled = !canUseImageExportWorker()
  if (!workerDisabled) {
    try {
      workerSession = createImageExportWorkerSession()
    } catch {
      // The established main-thread High renderer remains the reliable fallback.
      workerDisabled = true
    }
  }
  livingFormLoopSnapshot = {
    engine: createLivingFormEngine(props.mesh),
    settings: { ...settings, enabled: true },
    colorMode: props.colorMode,
    appearance: {
      heightGradient: { ...props.appearance.heightGradient },
      clay: { ...props.appearance.clay },
    },
    camera: camera.clone(),
    studioBackground: props.background,
    workerSession,
    workerDisabled,
  }
}

function endLivingFormLoopExport(): void {
  livingFormLoopSnapshot?.workerSession?.dispose()
  livingFormLoopSnapshot = null
}

function updateObject() {
  if (!scene) return
  disposeLiveObject()
  if (!props.mesh) return
  object = createThreeMesh(props.mesh, props.colorMode, props.appearance)
  // Living Form can expand beyond the immutable base bounds. With one studio
  // object, disabling frustum culling is cheaper and safer than rebuilding both
  // bounding volumes on every displayed phase.
  object.frustumCulled = false
  const position = object.geometry.getAttribute('position')
  const normal = object.geometry.getAttribute('normal')
  if (position instanceof THREE.BufferAttribute) position.setUsage(THREE.DynamicDrawUsage)
  if (normal instanceof THREE.BufferAttribute) normal.setUsage(THREE.DynamicDrawUsage)
  livingFormEngine = createLivingFormEngine(props.mesh)
  scene.add(object)
  if (camera && controls && framedMesh !== props.mesh
    && (props.mesh.mode === 'strata' || framedMesh?.mode === 'strata')) {
    // Match the actual screen aspect before fitting; never enlarge the canvas.
    if (host.value) camera.aspect = Math.max(1, host.value.clientWidth) / Math.max(1, host.value.clientHeight)
    const distance = fitStrataCamera(camera, controls.target, object.geometry.boundingBox!)
    controls.maxDistance = Math.max(8, distance * 2)
    controls.update()
  }
  framedMesh = props.mesh
  applyLivingFormFrame(true)
  outputCameraDirty = true
}

function updateBackground() {
  renderer?.setClearColor(0x000000, 0)
  if (scene) scene.background = null
}

function updateInteractionEnabled() {
  if (controls) controls.enabled = !props.interactionLocked && !mainThreadExport.value && !straightOnPreview.value
}

/** Clear OrbitControls inertia while keeping the exact current authored view. */
function clearOrbitMomentum() {
  if (!camera || !controls) return
  const snapshot = capturePreviewCamera(camera, controls.target)
  const damping = controls.enableDamping
  controls.enableDamping = false
  controls.update()
  restorePreviewCamera(camera, controls.target, snapshot)
  controls.update()
  controls.enableDamping = damping
}

function getCameraSnapshot(): PreviewCameraSnapshot | null {
  return camera && controls ? capturePreviewCamera(camera, controls.target) : null
}

function cancelPendingCameraChange() {
  if (cameraChangeTimer !== null) clearTimeout(cameraChangeTimer)
  cameraChangeTimer = null
  cameraChangePending = false
}

function scheduleCameraChange() {
  cameraChangePending = true
  if (cameraChangeTimer !== null) clearTimeout(cameraChangeTimer)
  cameraChangeTimer = setTimeout(() => {
    cameraChangeTimer = null
    if (cameraGestureActive || !mounted) return
    cameraChangePending = false
    const snapshot = getCameraSnapshot()
    if (snapshot) emit('camera-change', snapshot)
  }, 350)
}

function setCameraSnapshot(snapshot: PreviewCameraSnapshot): boolean {
  if (!camera || !controls || !isPreviewCameraSnapshot(snapshot)) return false
  cancelPendingCameraChange()
  clearOrbitMomentum()
  restorePreviewCamera(camera, controls.target, snapshot)
  // Saved views can legitimately be farther away than the initial studio limit.
  controls.maxDistance = Math.max(8, camera.position.distanceTo(controls.target) * 2)
  controls.update()
  outputCameraDirty = true
  return true
}

/** Fit the authored camera to the current visible-phase geometry. */
function fitCamera(): void {
  if (!camera || !controls || !object) return
  cancelPendingCameraChange()
  clearOrbitMomentum()
  applyLivingFormFrame()
  object.geometry.computeBoundingBox()
  if (!object.geometry.boundingBox) return
  const distance = fitStrataCamera(camera, controls.target, object.geometry.boundingBox)
  controls.maxDistance = Math.max(8, distance * 2)
  controls.update()
  outputCameraDirty = true
  scheduleCameraChange()
}

function resetCamera(): void {
  if (!camera || !controls) return
  cancelPendingCameraChange()
  clearOrbitMomentum()
  camera.fov = 38
  camera.near = 0.01
  camera.far = 100
  camera.zoom = 1
  camera.filmGauge = 35
  camera.filmOffset = 0
  camera.up.set(0, 1, 0)
  camera.position.set(2.45, -2.2, 2.15)
  camera.clearViewOffset()
  controls.target.set(0, 0, 0.12)
  controls.maxDistance = 8
  controls.update()
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld(true)
  if (props.mesh?.mode === 'strata') fitCamera()
  outputCameraDirty = true
  scheduleCameraChange()
}

function displayCamera(): THREE.PerspectiveCamera | null {
  if (!camera || !props.outputPreview || !props.mesh) return camera
  if (props.outputPreview.view === 'current') {
    // Reuse the preview camera during orbiting; capture uses the same pose and
    // independently applies this exact output ratio, not rounded CSS dimensions.
    outputCamera ??= camera.clone()
    outputCamera.copy(camera)
    outputCamera.aspect = props.outputPreview.width / props.outputPreview.height
    outputCamera.clearViewOffset()
    outputCamera.updateProjectionMatrix()
    outputCamera.updateMatrixWorld(true)
  } else if (!outputCamera || outputCameraDirty) {
    const position = object?.geometry.getAttribute('position')
    const visibleMesh = position instanceof THREE.BufferAttribute && position.array instanceof Float32Array
      ? { ...props.mesh, positions: position.array }
      : props.mesh
    outputCamera = createOutputPreviewCamera(visibleMesh, camera, props.outputPreview)
  }
  outputCameraDirty = false
  return outputCamera
}

/** Small UI-only image for a kept version/job; never used as export pixels. */
function capturePreviewThumbnail(): string | null {
  if (!canvas.value || !renderer || !props.mesh || mainThreadExport.value) return null
  try {
    // A job thumbnail must not advance orbit damping after capture has already
    // taken its camera snapshot. It observes the current view, never edits it.
    renderFrame(false)
    const width = canvas.value.width
    const height = canvas.value.height
    const scale = Math.min(1, 320 / Math.max(width, height))
    const thumbnail = document.createElement('canvas')
    thumbnail.width = Math.max(1, Math.round(width * scale))
    thumbnail.height = Math.max(1, Math.round(height * scale))
    const context = thumbnail.getContext('2d')
    if (!context) return null
    context.fillStyle = viewportBackgroundPreset(props.background).color
    context.fillRect(0, 0, thumbnail.width, thumbnail.height)
    context.drawImage(canvas.value, 0, 0, thumbnail.width, thumbnail.height)
    return thumbnail.toDataURL('image/png')
  } catch {
    return null
  }
}

async function captureHighPng(
  dimensions: { width: number; height: number },
  background: ImageExportBackground,
  livingPhase = props.livingPhase,
  view: ImageExportView = 'current',
): Promise<ViewportPngResult> {
  const loopSnapshot = livingFormLoopSnapshot
  if (!canvas.value || !renderer || !camera || (!props.mesh && !loopSnapshot)) {
    throw new Error('There is no model to export.')
  }
  cancelImageExport()
  const controller = new AbortController()
  activeExport = controller
  exportActive.value = true
  if (!loopSnapshot) {
    controls?.update()
    camera.updateMatrixWorld(true)
  }
  const exportMesh = loopSnapshot
    ? loopSnapshot.engine.sampleMesh(livingPhase, loopSnapshot.settings)
    : snapshotLivingFormMesh(livingPhase)
  const cameraTemplate = loopSnapshot?.camera ?? camera
  const exportCamera = createStillExportCamera(exportMesh, dimensions, cameraTemplate, view)
  const exportColorMode = loopSnapshot?.colorMode ?? props.colorMode
  const exportAppearance: AppearanceSettings = loopSnapshot
    ? {
        heightGradient: { ...loopSnapshot.appearance.heightGradient },
        clay: { ...loopSnapshot.appearance.clay },
      }
    : {
        heightGradient: { ...props.appearance.heightGradient },
        clay: { ...props.appearance.clay },
      }
  const exportBackground = loopSnapshot?.studioBackground ?? props.background
  try {
    await awaitExportTask(environmentReady ?? Promise.resolve(), controller.signal)
    if (controller.signal.aborted) throw new DOMException('Image export cancelled.', 'AbortError')
    if (!canvas.value || !renderer || !camera) throw new Error('Viewport is no longer available.')

    if (canUseImageExportWorker() && (!loopSnapshot || !loopSnapshot.workerDisabled)) {
      let workerMadeProgress = false
      try {
        const options = {
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
          onProgress: (progress: FinalExportProgress) => {
            workerMadeProgress = true
            emit('export-progress', progress)
          },
        } as const
        return await (loopSnapshot?.workerSession
          ? loopSnapshot.workerSession.render(options)
          : renderImageExportInWorker(options))
      } catch (error) {
        const failure = decideImageExportWorkerFailure({
          error,
          signal: controller.signal,
          sequence: Boolean(loopSnapshot),
          workerMadeProgress,
        })
        if (loopSnapshot && failure.disableSequenceWorker) {
          loopSnapshot.workerSession?.dispose()
          loopSnapshot.workerSession = null
          // Retire a failed WebGL context for the rest of this sequence. The
          // current frame has not been archived yet, so the exact same snapshot
          // can safely restart on the established main-thread High renderer.
          loopSnapshot.workerDisabled = true
        }
        if (!failure.retryOnMainThread) throw error
        // Older browsers and constrained GPUs fall back to the same tiled render
        // on the main thread. Loop frames retry even after progress because the
        // caller has not committed the frame until this promise resolves.
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
    updateInteractionEnabled()
  }
}

async function captureFinalPng(
  dimensions: { width: number; height: number },
  background: ImageExportBackground,
  suggestedName = 'rasterform-final.png',
  livingPhase = props.livingPhase,
  view: ImageExportView = 'current',
): Promise<FinalImagePngResult | DesktopFinalCaptureResult> {
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
  const exportMesh = snapshotLivingFormMesh(livingPhase)
  const exportCamera = createStillExportCamera(exportMesh, dimensions, camera, view)
  const exportColorMode = props.colorMode
  const exportAppearance: AppearanceSettings = {
    heightGradient: { ...props.appearance.heightGradient },
    clay: { ...props.appearance.clay },
  }
  const exportBackground = props.background
  try {
    // The desktop shell snapshots this exact scene into a separate Chromium
    // renderer process. When the optional bridge is absent, null preserves the
    // established browser path below without changing its quality or behavior.
    const desktopResult = exportColorMode === 'wireframe'
      ? null
      : await renderFinalImageInDesktop({
          mesh: exportMesh,
          colorMode: exportColorMode,
          appearance: exportAppearance,
          camera: exportCamera,
          width: dimensions.width,
          height: dimensions.height,
          background,
          studioBackground: exportBackground,
          suggestedName,
          signal: controller.signal,
          onProgress: (progress) => emit('export-progress', progress),
        })
    if (desktopResult) return desktopResult

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
    updateInteractionEnabled()
  }
}

async function captureProRender(
  dimensions: { width: number; height: number },
  background: ImageExportBackground,
  settings: DesktopProRenderSettings,
  suggestedName = 'rasterform-pro.png',
  livingPhase = props.livingPhase,
  view: ImageExportView = 'current',
): Promise<DesktopProCaptureResult> {
  if (!camera || !props.mesh) throw new Error('There is no model to export.')
  if (Math.max(dimensions.width, dimensions.height) > 4096) {
    throw new Error('Cycles Pro supports 2K and 4K still renders.')
  }
  if (props.colorMode === 'wireframe') {
    throw new Error('Wireframe exports use High quality.')
  }

  cancelImageExport()
  const controller = new AbortController()
  activeExport = controller
  exportActive.value = true
  controls?.update()
  camera.updateMatrixWorld(true)
  const exportMesh = snapshotLivingFormMesh(livingPhase)
  const exportCamera = createStillExportCamera(exportMesh, dimensions, camera, view)
  const exportColorMode = props.colorMode
  const exportAppearance: AppearanceSettings = {
    heightGradient: { ...props.appearance.heightGradient },
    clay: { ...props.appearance.clay },
  }
  const exportBackground = props.background

  try {
    return await renderProImageInDesktop({
      mesh: exportMesh,
      colorMode: exportColorMode,
      appearance: exportAppearance,
      camera: exportCamera,
      width: dimensions.width,
      height: dimensions.height,
      background,
      studioBackground: exportBackground,
      settings: { ...settings },
      suggestedName,
      signal: controller.signal,
      onProgress: (progress) => emit('export-progress', progress),
    })
  } finally {
    if (activeExport === controller) activeExport = null
    exportActive.value = false
    updateInteractionEnabled()
  }
}

function cancelImageExport() {
  activeExport?.abort()
}

defineExpose({
  captureHighPng,
  captureFinalPng,
  captureProRender,
  cancelImageExport,
  beginLivingFormLoopExport,
  endLivingFormLoopExport,
  getCameraSnapshot,
  setCameraSnapshot,
  fitCamera,
  resetCamera,
  capturePreviewThumbnail,
})

function resize() {
  if (!host.value || !renderer || !camera) return
  const width = Math.max(1, Math.floor(host.value.clientWidth))
  const height = Math.max(1, Math.floor(host.value.clientHeight))
  const frame = props.outputPreview
    ? fitViewportFrame(props.outputPreview.width / props.outputPreview.height, width, height)
    : { width, height }
  screenFrame.value = frame
  renderer.setSize(frame.width, frame.height, false)
  composer?.setSize(frame.width, frame.height)
  // The editing lens remains tied to the available studio, never the temporary
  // output frame. Export dimensions are handled only by the preview/capture lens.
  camera.aspect = width / height
  camera.updateProjectionMatrix()
  outputCameraDirty = true
}

function renderFrame(updateControls = true) {
  applyLivingFormFrame()
  if (updateControls && controls?.enabled) controls.update()
  const currentCamera = displayCamera()
  if (currentCamera) {
    if (renderPass) renderPass.camera = currentCamera
    if (gtaoPass) gtaoPass.camera = currentCamera
  }
  if (!mainThreadExport.value) composer?.render()
}

function render() {
  animationFrame = requestAnimationFrame(render)
  renderFrame()
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
  updateInteractionEnabled()
  controls.addEventListener('start', () => {
    cameraGestureActive = true
    cameraChangePending = true
    if (cameraChangeTimer !== null) clearTimeout(cameraChangeTimer)
    cameraChangeTimer = null
  })
  controls.addEventListener('change', () => {
    // Includes damping updates after pointer release. Project restore does not
    // start a gesture, so it cannot create a feedback loop in authored history.
    if (cameraChangePending) scheduleCameraChange()
  })
  controls.addEventListener('end', () => {
    cameraGestureActive = false
    scheduleCameraChange()
  })

  addStudioLighting(scene)
  updateObject()

  composer = new EffectComposer(renderer)
  renderPass = new RenderPass(scene, camera)
  composer.addPass(renderPass)
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
  if (host.value) resizeObserver.observe(host.value)
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
  () => [props.outputPreview?.view, props.outputPreview?.width, props.outputPreview?.height] as const,
  () => {
    clearOrbitMomentum()
    outputCameraDirty = true
    updateInteractionEnabled()
    resize()
  },
  { flush: 'post' },
)

watch(
  () => [
    props.livingForm.enabled,
    props.livingForm.behavior,
    props.livingForm.amount,
    props.livingForm.frequency,
    props.livingForm.seed,
    props.livingPhase,
  ] as const,
  () => {
    livingFrameDirty = true
  },
  { deep: false, flush: 'sync' },
)

watch(
  () => props.interactionLocked,
  updateInteractionEnabled,
)

onBeforeUnmount(() => {
  mounted = false
  cancelPendingCameraChange()
  cancelImageExport()
  endLivingFormLoopExport()
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
  <div ref="host" class="three-preview-host" :class="{ 'has-output-frame': outputPreview }">
    <div
      class="three-preview-frame"
      :class="{ 'shows-alpha-checker': outputPreview?.background === 'transparent' && outputPreview.checkerboard }"
      :style="frameStyle"
    >
      <canvas
        ref="canvas"
        class="three-preview"
        :style="canvasStyle"
        :aria-busy="exportActive"
        :aria-label="interactionLocked || mainThreadExport
          ? '3D preview locked while the image renders.'
          : straightOnPreview
            ? 'Straight-on output composition preview. Your editing camera is preserved.'
            : exportActive
              ? 'An image snapshot is rendering in the background. The 3D preview remains orbitable.'
              : mesh
                ? 'Orbitable 3D model preview. Drag to rotate and scroll to zoom.'
                : '3D viewport. Add content to generate a model.'"
      />
      <div v-if="outputPreview" class="three-output-frame-border" aria-hidden="true"></div>
    </div>
  </div>
</template>

<style scoped>
.three-preview-host {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.three-preview-host.has-output-frame { background: #171717; }
.three-preview-frame { position: relative; flex: none; max-width: 100%; max-height: 100%; overflow: hidden; }
.three-preview { position: absolute; inset: 0; width: 100%; height: 100%; max-width: 100%; max-height: 100%; }
.shows-alpha-checker {
  background-color: #666;
  background-image: conic-gradient(#888 25%, transparent 0 50%, #888 0 75%, transparent 0);
  background-size: 20px 20px;
}
.three-output-frame-border { position: absolute; inset: 0; pointer-events: none; box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.24); }
</style>
