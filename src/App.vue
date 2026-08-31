<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import ThreePreview from './components/ThreePreview.vue'
import {
  VIEWPORT_BACKGROUNDS,
  isViewportBackground,
  viewportBackgroundFromShortcut,
  viewportBackgroundPreset,
} from './lib/background'
import { composeChannelStack } from './lib/channel-stack'
import { processScalarField } from './lib/filters'
import { createDemoImage, drawPixelImage, drawScalarField, fileToPixelImage } from './lib/image'
import { buildMesh } from './lib/mesh'
import { createTextMesh } from './lib/text-mesh'
import {
  SYSTEM_SANS_FONT,
  cleanupRegisteredFont,
  discoverPassiveFonts,
  queryLocalFontFaces,
  registerLocalFont,
  supportsLocalFontAccess,
  type LocalFontRecord,
  type RegisteredFont,
} from './lib/local-fonts'
import { inspectTopology } from './lib/topology'
import { downloadBlob, exportGlb, exportHeightPng, exportRecipe, exportStl } from './lib/export'
import {
  finalSampleTarget,
  type FinalExportProgress,
  type FinalImagePngResult,
} from './lib/final-image-export'
import {
  DesktopFinalRenderError,
  beginDesktopLongExport,
  endDesktopLongExport,
  type DesktopFinalCaptureResult,
  type DesktopLongExportSession,
} from './desktop/client'
import {
  DesktopProRenderError,
  desktopProRendererAvailable,
  probeDesktopProRenderer,
} from './desktop/pro-client'
import {
  DEFAULT_DESKTOP_PRO_RENDER_SETTINGS,
  type DesktopProCaptureResult,
  type DesktopProRendererAvailability,
  type DesktopProRenderSettings,
} from './desktop/pro-contracts'
import {
  DesktopBlenderExportError,
  desktopBlenderExporterAvailable,
  exportBlenderProjectInDesktop,
} from './desktop/blender-export-client'
import type {
  DesktopBlenderExportPhase,
  DesktopBlenderTopology,
} from './desktop/blender-export-contracts'
import { createDefaultAppearanceSettings } from './lib/three'
import {
  calculateStillImageDimensions,
  calculateViewportDimensions,
  type ViewportPngResult,
} from './lib/viewport-export'
import {
  DEFAULT_LIVING_FORM_SETTINGS,
  animateLivingFormMesh,
  createLivingFormEngine,
  normalizeLivingFormPhase,
  type LivingFormEngine,
} from './lib/living-form'
import {
  LIVING_FORM_FRAME_RATES,
  calculateLivingFormFrameCount,
  exportLivingFormPngSequence,
  type LivingFormFrameRate,
  type LivingFormLoopProgress,
} from './lib/living-form-export'
import { cleanupStaleStoredZipArchives } from './lib/zip-writer'
import type {
  AppearanceSettings,
  ChannelBlendMode,
  ChannelLayer,
  ClayFinish,
  ColorMode,
  FieldSettings,
  GeometryMode,
  HeightSource,
  ImageExportBackground,
  ImageExportLongEdge,
  ImageExportQuality,
  ImageExportView,
  FontChoice,
  LivingFormBehavior,
  LivingFormSettings,
  MeshSettings,
  MeshData,
  Recipe,
  TextRecipe,
  TextShapeSettings,
  ViewportBackground,
  WorkspaceMode,
} from './types'

interface ThreePreviewHandle {
  beginLivingFormLoopExport: (settings: LivingFormSettings) => void
  endLivingFormLoopExport: () => void
  captureHighPng: (
    dimensions: { width: number; height: number },
    background: ImageExportBackground,
    livingPhase?: number,
    view?: ImageExportView,
  ) => Promise<ViewportPngResult>
  captureFinalPng: (
    dimensions: { width: number; height: number },
    background: ImageExportBackground,
    suggestedName?: string,
    livingPhase?: number,
    view?: ImageExportView,
  ) => Promise<FinalImagePngResult | DesktopFinalCaptureResult>
  captureProRender: (
    dimensions: { width: number; height: number },
    background: ImageExportBackground,
    settings: DesktopProRenderSettings,
    suggestedName?: string,
    livingPhase?: number,
    view?: ImageExportView,
  ) => Promise<DesktopProCaptureResult>
  cancelImageExport: () => void
}

interface ImageExportRequestSnapshot {
  dimensions: { width: number; height: number }
  view: ImageExportView
  quality: ImageExportQuality
  background: ImageExportBackground
  viewportBackground: ViewportBackground
  colorMode: ColorMode
  samples: number
  proSettings: DesktopProRenderSettings
  livingEnabled: boolean
  livingPhase: number
}

interface LivingLoopExportRequestSnapshot {
  dimensions: { width: number; height: number }
  fps: LivingFormFrameRate
  frameCount: number
  settings: LivingFormSettings
  background: ImageExportBackground
  studioBackground: ViewportBackground
}

const image = shallowRef(createDemoImage())
const threePreview = ref<ThreePreviewHandle | null>(null)
const sourceCanvas = ref<HTMLCanvasElement | null>(null)
const heightCanvas = ref<HTMLCanvasElement | null>(null)
const sourceThumbCanvas = ref<HTMLCanvasElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const threeStage = ref<HTMLElement | null>(null)
const backgroundMenu = ref<HTMLDivElement | null>(null)
const backgroundTrigger = ref<HTMLButtonElement | null>(null)
const status = ref('Demo image · 360 × 270')
const exporting = ref(false)
const exportingBlenderProject = ref(false)
const blenderExportDetails = ref<HTMLDetailsElement | null>(null)
const blenderExportTopology = ref<DesktopBlenderTopology>('balanced')
const blenderExportPhase = ref<DesktopBlenderExportPhase>('preparing')
const blenderExportError = ref('')
const blenderExportNotice = ref('')
let blenderExportController: AbortController | null = null
const dragging = ref(false)
const workspace = ref<WorkspaceMode>('image')
const imageColorMode = ref<ColorMode>('original')
const textColorMode = ref<ColorMode>('clay')
const colorMode = computed<ColorMode>({
  get: () => workspace.value === 'image' ? imageColorMode.value : textColorMode.value,
  set: (mode) => {
    if (workspace.value === 'image') imageColorMode.value = mode
    else textColorMode.value = mode
  },
})
const imageExportOpen = ref(false)
const exportingImage = ref(false)
const imageExportQuality = ref<ImageExportQuality>('high')
const imageExportLongEdge = ref<ImageExportLongEdge>(4096)
const imageExportView = ref<ImageExportView>('current')
const imageExportBackground = ref<ImageExportBackground>('transparent')
const imageExportKind = ref<'still' | 'loop'>('still')
const livingLoopLongEdge = ref<2048 | 4096>(2048)
const livingLoopFps = ref<LivingFormFrameRate>(24)
const imageExportError = ref('')
const imageExportNotice = ref('')
const imageExportAnnouncement = ref('')
const livingLoopNativeSaving = ref(false)
const activeImageExportRequest = shallowRef<ImageExportRequestSnapshot | null>(null)
const activeLivingLoopRequest = shallowRef<LivingLoopExportRequestSnapshot | null>(null)
const livingLoopProgress = reactive<LivingFormLoopProgress>({
  phase: 'rendering',
  progress: 0,
  frame: 0,
  frames: 0,
})
let livingLoopController: AbortController | null = null
let activeLivingLoopFrame: { frame: number; frames: number } | null = null
let livingLoopWakeLock: WakeLockSentinel | null = null
const BACKGROUND_STORAGE_KEY = 'rasterform:viewport-background'
const desktopFinalAvailable = window.rasterformDesktop?.protocolVersion === 1
const desktopProBridgeAvailable = desktopProRendererAvailable()
const desktopBlenderBridgeAvailable = desktopBlenderExporterAvailable()
const desktopProRenderer = ref<DesktopProRendererAvailability | null>(null)
const desktopProProbePending = ref(desktopProBridgeAvailable)
const desktopProProbeError = ref('')
const proRenderSettings = reactive<DesktopProRenderSettings>({
  ...DEFAULT_DESKTOP_PRO_RENDER_SETTINGS,
})

function initialViewportBackground(): ViewportBackground {
  try {
    const saved = window.localStorage.getItem(BACKGROUND_STORAGE_KEY)
    if (isViewportBackground(saved)) return saved
  } catch {
    // A blocked storage API should never prevent the viewport from loading.
  }
  return 'dark-gray'
}

const viewportBackground = ref<ViewportBackground>(initialViewportBackground())
const backgroundMenuPosition = ref<{ x: number; y: number } | null>(null)
let backgroundMenuReturnFocus: HTMLElement | null = null
const imageExportProgress = reactive<FinalExportProgress>({
  phase: 'preparing',
  progress: 0,
  tile: 0,
  tiles: 0,
  samples: 0,
  targetSamples: 1,
})
const imageAppearance = reactive<AppearanceSettings>(createDefaultAppearanceSettings())
const textAppearance = reactive<AppearanceSettings>({
  ...createDefaultAppearanceSettings(),
  clay: { color: '#d9ff63', finish: 'matte' },
})
const appearance = computed<AppearanceSettings>(() => workspace.value === 'image' ? imageAppearance : textAppearance)
const imageLivingForm = reactive<LivingFormSettings>({
  ...DEFAULT_LIVING_FORM_SETTINGS,
  seed: 17,
})
const textLivingForm = reactive<LivingFormSettings>({
  ...DEFAULT_LIVING_FORM_SETTINGS,
  behavior: 'flow',
  amount: 0.42,
  frequency: 1.25,
  seed: 31,
})
const livingForm = computed<LivingFormSettings>(() => workspace.value === 'image' ? imageLivingForm : textLivingForm)
const imageLivingPhase = ref(0)
const textLivingPhase = ref(0)
const livingPhase = computed<number>({
  get: () => workspace.value === 'image' ? imageLivingPhase.value : textLivingPhase.value,
  set: (phase) => {
    const normalized = normalizeLivingFormPhase(phase)
    if (workspace.value === 'image') imageLivingPhase.value = normalized
    else textLivingPhase.value = normalized
  },
})
const livingPlaying = ref(false)
let livingAnimationFrame = 0
let livingAnimationTime = 0
let livingAnimationElapsed = 0
let channelSequence = 0

function createChannelLayer(
  source: HeightSource,
  overrides: Partial<Omit<ChannelLayer, 'id'>> = {},
): ChannelLayer {
  channelSequence += 1
  return {
    id: `channel-${channelSequence}`,
    source,
    blend: 'add',
    amount: 1,
    invert: false,
    hueOrigin: 0,
    enabled: true,
    ...overrides,
  }
}

const fieldSettings = reactive<FieldSettings>({
  invert: false,
  blur: 1,
  contrast: 8,
  quantize: 0,
  finish: 'detail',
  blobDilation: 6,
  blobSmoothing: 8,
})

const channelLayers = reactive<ChannelLayer[]>([
  createChannelLayer('luminance', { amount: 0.86 }),
  createChannelLayer('edges', { blend: 'add', amount: 0.28 }),
])
const selectedChannelId = ref(channelLayers[0]?.id ?? '')

const meshSettings = reactive<MeshSettings>({
  mode: 'solid',
  resolution: 88,
  depth: 0.58,
  midpoint: 0.5,
  baseThickness: 0.26,
})

const textSettings = reactive<TextShapeSettings>({
  text: 'Rasterform',
  alignment: 'center',
  tracking: 0,
  lineHeight: 1.06,
  depth: 0.34,
  bevelSize: 0.035,
  bevelThickness: 0.035,
  bevelSegments: 4,
  resolution: 420,
  finish: 'detail',
  blobDilation: 5,
  blobSmoothing: 6,
})
const fontChoices = shallowRef<FontChoice[]>([{ ...SYSTEM_SANS_FONT }])
const selectedFontId = ref(SYSTEM_SANS_FONT.id)
const fontStatus = ref('System font ready')
const fontBusy = ref(false)
const fontAccessSupported = supportsLocalFontAccess()
const requestedFontRecords = shallowRef<LocalFontRecord[]>([])
let activeFontRegistration: RegisteredFont | undefined
let activeFontRegistrationId: string | undefined
let passiveFontCleanup: (() => void) | undefined
let passiveFontRequest = 0
let fontOperation = 0
let fontStatusRevision = 0
let appDisposed = false
const textMesh = shallowRef<MeshData | null>(null)
const textBuildError = ref('')
const textBuilding = ref(false)
let textBuildTimer = 0

const selectedFont = computed(() => fontChoices.value.find((font) => font.id === selectedFontId.value) ?? fontChoices.value[0]!)

function mergeFontChoices(...groups: readonly FontChoice[][]): FontChoice[] {
  const activeChoice = activeFontRegistrationId
    ? fontChoices.value.find((font) => font.id === activeFontRegistrationId)
    : undefined
  const merged: FontChoice[] = []
  const seen = new Set<string>()

  for (const group of groups) {
    for (const font of group) {
      if (seen.has(font.id)) continue
      seen.add(font.id)
      merged.push(activeChoice?.id === font.id ? activeChoice : font)
    }
  }
  if (activeChoice && !seen.has(activeChoice.id)) merged.push(activeChoice)
  return merged
}

const heightSources: Array<{ value: HeightSource; label: string }> = [
  { value: 'luminance', label: 'Luminance' },
  { value: 'hue', label: 'Hue target' },
  { value: 'saturation', label: 'Saturation' },
  { value: 'value', label: 'Value' },
  { value: 'red', label: 'Red' },
  { value: 'green', label: 'Green' },
  { value: 'blue', label: 'Blue' },
  { value: 'alpha', label: 'Alpha' },
  { value: 'edges', label: 'Edges' },
]

const blendModes: Array<{ value: ChannelBlendMode; label: string }> = [
  { value: 'normal', label: 'Mix' },
  { value: 'add', label: 'Raise' },
  { value: 'subtract', label: 'Carve' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'screen', label: 'Screen' },
  { value: 'max', label: 'Peak' },
  { value: 'min', label: 'Valley' },
]

interface StackPreset {
  key: string
  label: string
  note: string
  layers: Array<Omit<ChannelLayer, 'id'>>
  field: FieldSettings
}

const stackPresets: StackPreset[] = [
  {
    key: 'tonal-detail',
    label: 'Tonal detail',
    note: 'Luminance + edges',
    layers: [
      { source: 'luminance', blend: 'add', amount: 0.86, invert: false, hueOrigin: 0, enabled: true },
      { source: 'edges', blend: 'add', amount: 0.28, invert: false, hueOrigin: 0, enabled: true },
    ],
    field: {
      invert: false,
      blur: 1,
      contrast: 8,
      quantize: 0,
      finish: 'detail',
      blobDilation: 6,
      blobSmoothing: 8,
    },
  },
  {
    key: 'chroma-strata',
    label: 'Chroma strata',
    note: 'Saturation + hue + edges',
    layers: [
      { source: 'saturation', blend: 'add', amount: 0.74, invert: false, hueOrigin: 0, enabled: true },
      { source: 'hue', blend: 'screen', amount: 0.72, invert: false, hueOrigin: 0.96, enabled: true },
      { source: 'edges', blend: 'add', amount: 0.2, invert: false, hueOrigin: 0, enabled: true },
    ],
    field: {
      invert: false,
      blur: 1,
      contrast: 10,
      quantize: 6,
      finish: 'detail',
      blobDilation: 6,
      blobSmoothing: 8,
    },
  },
  {
    key: 'ink-emboss',
    label: 'Ink emboss',
    note: 'Inverted luminance + edges',
    layers: [
      { source: 'luminance', blend: 'add', amount: 0.58, invert: true, hueOrigin: 0, enabled: true },
      { source: 'edges', blend: 'add', amount: 0.68, invert: false, hueOrigin: 0, enabled: true },
    ],
    field: {
      invert: false,
      blur: 0,
      contrast: 18,
      quantize: 0,
      finish: 'detail',
      blobDilation: 6,
      blobSmoothing: 8,
    },
  },
]

const geometryModes: Array<{ value: GeometryMode; label: string; note: string }> = [
  { value: 'plane', label: 'Raised relief', note: 'Open surface · zero at base' },
  { value: 'centered', label: 'Centered relief', note: 'Open surface · midpoint at zero' },
  { value: 'solid', label: 'Solid relief', note: 'Closed back and sides' },
]

const previewModes: Array<{ value: ColorMode; label: string }> = [
  { value: 'original', label: 'Photo' },
  { value: 'height', label: 'Height' },
  { value: 'clay', label: 'Clay' },
  { value: 'wireframe', label: 'Wireframe' },
]
const textPreviewModes: Array<{ value: ColorMode; label: string }> = [
  { value: 'clay', label: 'Material' },
  { value: 'wireframe', label: 'Wireframe' },
]
const activePreviewModes = computed(() => workspace.value === 'image' ? previewModes : textPreviewModes)

const clayFinishes: Array<{ value: ClayFinish; label: string }> = [
  { value: 'matte', label: 'Matte' },
  { value: 'glossy', label: 'Glossy' },
  { value: 'metallic', label: 'Metallic' },
]

const livingFormBehaviors: Array<{ value: LivingFormBehavior; label: string; note: string }> = [
  { value: 'breathe', label: 'Breathe', note: 'A soft whole-form inhale and release.' },
  { value: 'ripple', label: 'Ripple', note: 'Concentric waves travel through the surface.' },
  { value: 'flow', label: 'Flow', note: 'Multiple fields drift through one another.' },
  { value: 'melt', label: 'Melt', note: 'The form slumps and organically reforms.' },
]
const activeLivingBehavior = computed(() => livingFormBehaviors.find((item) => item.value === livingForm.value.behavior)!)
const livingFormStatus = computed(() => !livingForm.value.enabled
  ? 'Off'
  : livingPlaying.value
    ? 'Playing'
    : 'Paused')

const gradientPreviewStyle = computed(() => ({
  background: `linear-gradient(90deg, ${appearance.value.heightGradient.low} 0%, ${appearance.value.heightGradient.mid} ${Math.round(appearance.value.heightGradient.midpoint * 100)}%, ${appearance.value.heightGradient.high} 100%)`,
}))
const activeBackground = computed(() => viewportBackgroundPreset(viewportBackground.value))
const backgroundMenuStyle = computed(() => backgroundMenuPosition.value
  ? {
      left: `${backgroundMenuPosition.value.x}px`,
      top: `${backgroundMenuPosition.value.y}px`,
    }
  : undefined)
const activeFrameSize = computed(() => workspace.value === 'image'
  ? { width: image.value.width, height: image.value.height }
  : { width: 16, height: 9 })
const effectiveImageExportView = computed<ImageExportView>(() => (
  workspace.value === 'image' ? imageExportView.value : 'current'
))
const imageExportDimensions = computed(() => calculateStillImageDimensions(
  activeFrameSize.value.width,
  activeFrameSize.value.height,
  image.value.sourceWidth,
  image.value.sourceHeight,
  imageExportLongEdge.value,
  effectiveImageExportView.value,
))
const straightOnExceedsFourK = computed(() => (
  effectiveImageExportView.value === 'straight-on'
  && Math.max(imageExportDimensions.value.width, imageExportDimensions.value.height) > 4096
))
const livingLoopDimensions = computed(() => calculateViewportDimensions(
  activeFrameSize.value.width,
  activeFrameSize.value.height,
  livingLoopLongEdge.value,
))
const livingLoopFrameCount = computed(() => calculateLivingFormFrameCount(
  livingForm.value.duration,
  livingLoopFps.value,
))
const desktopProReady = computed(() => Boolean(
  desktopProBridgeAvailable && desktopProRenderer.value?.available,
))
const proRenderSettingsAreProduction = computed(() => (
  proRenderSettings.maxSamples === DEFAULT_DESKTOP_PRO_RENDER_SETTINGS.maxSamples
  && proRenderSettings.minSamples === DEFAULT_DESKTOP_PRO_RENDER_SETTINGS.minSamples
  && proRenderSettings.noiseThreshold === DEFAULT_DESKTOP_PRO_RENDER_SETTINGS.noiseThreshold
  && proRenderSettings.maxBounces === DEFAULT_DESKTOP_PRO_RENDER_SETTINGS.maxBounces
  && proRenderSettings.denoise === DEFAULT_DESKTOP_PRO_RENDER_SETTINGS.denoise
))
const desktopProStatus = computed(() => {
  if (desktopProProbePending.value) return 'Checking Blender…'
  if (desktopProRenderer.value?.available) {
    const version = desktopProRenderer.value.blenderVersion
      ? `Blender ${desktopProRenderer.value.blenderVersion}`
      : 'Blender Cycles'
    return `${version} · ${desktopProRenderer.value.device ?? 'renderer ready'}`
  }
  return desktopProRenderer.value?.message
    || desktopProProbeError.value
    || 'Cycles Pro is not available.'
})
const blenderTopologyOptions: ReadonlyArray<{
  value: DesktopBlenderTopology
  label: string
  note: string
}> = [
  { value: 'exact', label: 'Exact', note: 'No geometry changes' },
  { value: 'balanced', label: 'Balanced', note: 'Editable quads · recommended' },
  { value: 'lightweight', label: 'Lightweight', note: 'Lowest working mesh' },
]
const activeBlenderTopology = computed(() => (
  blenderTopologyOptions.find((option) => option.value === blenderExportTopology.value)!
))
const blenderExportProgressLabel = computed(() => {
  if (blenderExportPhase.value === 'preparing') return 'Preparing an isolated Blender project…'
  if (blenderExportPhase.value === 'retopologizing') return 'Rebuilding editable topology in Blender…'
  if (blenderExportPhase.value === 'unwrapping') return 'Creating a padded UV layout…'
  return 'Compressing and saving the Blender project…'
})
const blenderExportHelp = computed(() => {
  if (!desktopBlenderBridgeAvailable) {
    return 'Blender-ready retopology requires Rasterform desktop and Blender 5.2 or newer. Exact GLB remains available in the browser.'
  }
  if (!desktopProReady.value) return desktopProStatus.value
  if (colorMode.value === 'wireframe') {
    return 'Choose Original, Height, or Clay before preparing an editable Blender surface.'
  }
  const method = workspace.value === 'image'
    ? 'Regular image reliefs are rebuilt as an efficient quad grid.'
    : 'Irregular text geometry is rebuilt with sharp borders, open boundaries, and color attributes protected.'
  if (blenderExportTopology.value === 'exact') {
    return 'Saves the current source mesh and material in a clean one-object .blend without changing geometry. The visible Living Form phase is baked in.'
  }
  const density = blenderExportTopology.value === 'balanced'
    ? 'Balanced lowers the face count while favoring shape detail.'
    : 'Lightweight uses the lowest practical working mesh.'
  return `${method} ${density} A new padded UV map and angle-aware smooth shading are included. Rasterform uses a separate background Blender process and never opens, saves, or closes your current Blender project.`
})
const displayLivingLoopRequest = computed<LivingLoopExportRequestSnapshot>(() =>
  activeLivingLoopRequest.value ?? {
    dimensions: livingLoopDimensions.value,
    fps: livingLoopFps.value,
    frameCount: livingLoopFrameCount.value,
    settings: { ...livingForm.value },
    background: imageExportBackground.value,
    studioBackground: viewportBackground.value,
  })
const displayImageExportRequest = computed<ImageExportRequestSnapshot>(() =>
  activeImageExportRequest.value ?? {
    dimensions: imageExportDimensions.value,
    view: effectiveImageExportView.value,
    quality: imageExportQuality.value,
    background: imageExportBackground.value,
    viewportBackground: viewportBackground.value,
    colorMode: colorMode.value,
    samples: imageExportQuality.value === 'pro'
      ? proRenderSettings.maxSamples
      : imageExportQuality.value === 'final'
        ? finalSampleTarget(colorMode.value, appearance.value)
        : 1,
    proSettings: { ...proRenderSettings },
    livingEnabled: livingForm.value.enabled,
    livingPhase: livingPhase.value,
  })
const imageExportUnsupported = computed(() => {
  const request = displayImageExportRequest.value
  if (request.quality === 'high') return false
  if (request.colorMode === 'wireframe'
    || Math.max(request.dimensions.width, request.dimensions.height) > 4096) return true
  return request.quality === 'pro' && !desktopProReady.value
})
const imageExportSummary = computed(() => {
  const request = displayImageExportRequest.value
  const { width, height } = request.dimensions
  const background = request.background === 'transparent'
    ? 'transparent'
    : `${viewportBackgroundPreset(request.viewportBackground).label.toLowerCase()} background`
  const quality = request.quality === 'pro'
    ? 'Cycles Pro'
    : request.quality === 'final'
      ? 'Final'
      : 'High'
  const view = request.view === 'straight-on' ? 'Straight on' : 'Current view'
  const living = request.livingEnabled ? ` · Living Form ${Math.round(request.livingPhase * 100)}%` : ''
  const format = request.quality === 'pro' ? 'PNG + EXR' : 'PNG'
  return `${quality} · ${view} · ${width.toLocaleString()} × ${height.toLocaleString()} px · ${background} ${format}${living}`
})
const livingLoopSummary = computed(() => {
  const request = displayLivingLoopRequest.value
  const { width, height } = request.dimensions
  const behavior = livingFormBehaviors.find((item) => item.value === request.settings.behavior)?.label
    ?? request.settings.behavior
  const background = request.background === 'transparent'
    ? 'transparent RGBA'
    : `${viewportBackgroundPreset(request.studioBackground).label.toLowerCase()} background`
  return `${behavior} · ${request.frameCount} frames · ${request.fps} fps · ${width.toLocaleString()} × ${height.toLocaleString()} px · ${background}`
})
const livingLoopHelp = computed(() => {
  const sizeWarning = Math.max(
    displayLivingLoopRequest.value.dimensions.width,
    displayLivingLoopRequest.value.dimensions.height,
  ) === 4096
    ? ' 4K sequences can be very large and may take a long time.'
    : ''
  return `Lossless PNG master with 2× edge smoothing. Model, material, camera, and background are snapshotted when export starts. Frame zero is not duplicated at the end, so the ZIP loops cleanly in After Effects, Resolve, Blender, or Premiere.${sizeWarning}`
})
const livingLoopProgressLabel = computed(() => {
  if (livingLoopNativeSaving.value) return 'Saving Living Form ZIP to disk · keep Rasterform open…'
  if (livingLoopProgress.phase === 'packaging') return 'Packaging lossless PNG sequence…'
  const frame = Math.min(livingLoopProgress.frames, livingLoopProgress.frame + 1)
  return `Rendering frame ${frame.toLocaleString()} of ${livingLoopProgress.frames.toLocaleString()} · ${Math.round(livingLoopProgress.progress * 100)}%`
})
const livingLoopProgressBarValue = computed<number | undefined>(() => livingLoopNativeSaving.value
  ? undefined
  : livingLoopProgress.phase === 'packaging'
    ? 0.98 + livingLoopProgress.progress * 0.02
    : livingLoopProgress.progress * 0.98)
const imageExportHelp = computed(() => {
  const request = displayImageExportRequest.value
  const pose = request.livingEnabled ? ' The visible Living Form phase is baked into this still.' : ''
  const straightOn = request.view === 'straight-on'
    ? ' Renders the complete relief head-on at the uploaded image’s original dimensions; your orbit and zoom stay unchanged.'
    : ''
  if (request.colorMode === 'wireframe') return `Wireframe exports use High quality.${straightOn}${pose}`
  if (request.quality === 'high') return `Clean 2× edge smoothing. Renders from a background snapshot so you can keep using the studio.${straightOn}${pose}`
  if (Math.max(request.dimensions.width, request.dimensions.height) > 4096) {
    const renderer = request.quality === 'pro' ? 'Cycles Pro' : 'Final'
    return request.view === 'straight-on'
      ? `The original is ${request.dimensions.width.toLocaleString()} × ${request.dimensions.height.toLocaleString()} px; ${renderer} supports up to 4K. Choose High to keep the exact original dimensions, or switch to Current view. Rasterform will not resize it.`
      : `${renderer} supports up to 4K. Choose 4K or High quality.`
  }
  if (request.quality === 'pro') {
    return `Blender Cycles renders up to ${request.proSettings.maxSamples.toLocaleString()} samples, waits for at least ${request.proSettings.minSamples.toLocaleString()}, and ${request.proSettings.denoise ? 'finishes with OpenImageDenoise' : 'keeps denoising off'}. It saves a display-ready PNG and a multipart EXR with 16-bit color passes plus full-precision data passes.${straightOn}${pose} Rasterform launches a separate background Blender process and never opens, saves, or changes your open Blender project. It works while Blender is open; simultaneous renders share GPU and memory, so both may run slower.`
  }
  return desktopFinalAvailable
    ? `Path-traced light and shadows · ${request.samples} samples with gentle denoising · renders separately so the studio stays responsive.${straightOn}${pose}`
    : `Path-traced light and shadows · ${request.samples} samples with gentle denoising · Final may pause the studio while it renders.${straightOn}${pose}`
})
const imageExportActionLabel = computed(() => {
  if (exportingImage.value) return 'Cancel render'
  const straightOn = effectiveImageExportView.value === 'straight-on' ? ' straight-on' : ''
  if (imageExportQuality.value === 'pro') return `Render & save${straightOn} PNG + EXR`
  if (imageExportQuality.value === 'final') return `Render & export${straightOn} PNG`
  return `Export${straightOn} PNG`
})
const imageExportProgressLabel = computed(() => {
  const pro = displayImageExportRequest.value.quality === 'pro'
  if (imageExportProgress.phase === 'preparing') return `${pro ? 'Preparing Blender Cycles scene' : 'Preparing geometry'} · ${Math.round(imageExportProgress.progress * 100)}%`
  if (imageExportProgress.phase === 'finishing') return pro ? 'Saving PNG + EXR…' : 'Finishing PNG…'
  if (displayImageExportRequest.value.quality === 'high') return `Rendering supersampled tiles · ${Math.round(imageExportProgress.progress * 100)}%`
  if (imageExportProgress.samples === 0) return pro ? 'Starting background Blender Cycles…' : 'Preparing Final renderer…'
  if (pro) return `Cycles · ${imageExportProgress.samples.toLocaleString()} / ${imageExportProgress.targetSamples.toLocaleString()} samples · ${Math.round(imageExportProgress.progress * 100)}%`
  return `Refining light and shadows · ${Math.round(imageExportProgress.progress * 100)}%`
})
const imageExportProgressBarValue = computed(() => {
  const request = displayImageExportRequest.value
  const separateRenderer = request.quality === 'pro'
    || (request.quality === 'final' && desktopFinalAvailable)
  if (!separateRenderer) return imageExportProgress.progress
  if (imageExportProgress.phase === 'preparing') return imageExportProgress.progress * 0.1
  if (imageExportProgress.phase === 'finishing') return 0.96 + imageExportProgress.progress * 0.04
  return 0.1 + imageExportProgress.progress * 0.86
})

const rawField = computed(() => composeChannelStack(image.value, channelLayers))
const heightField = computed(() => processScalarField(rawField.value, fieldSettings))
const imageMesh = computed(() => buildMesh(heightField.value, image.value, meshSettings))
const mesh = computed<MeshData | null>(() => workspace.value === 'image' ? imageMesh.value : textMesh.value)
const topology = computed(() => mesh.value ? inspectTopology(mesh.value) : null)
const activeGeometry = computed(() => workspace.value === 'text'
  ? { value: 'solid' as const, label: 'Extruded text', note: 'Closed beveled geometry' }
  : geometryModes.find((mode) => mode.value === meshSettings.mode)!)
const faceLabel = computed(() => topology.value?.faces.toLocaleString() ?? '—')
const activeSourceName = computed(() => workspace.value === 'image' ? image.value.name : selectedFont.value.label)
const hasModel = computed(() => Boolean(mesh.value))
const enabledChannelLayers = computed(() => channelLayers.filter((layer) => layer.enabled))
const baseLayerId = computed(() => enabledChannelLayers.value[0]?.id ?? null)
const selectedChannel = computed(() => channelLayers.find((layer) => layer.id === selectedChannelId.value) ?? channelLayers[0])
const selectedChannelIndex = computed(() => channelLayers.findIndex((layer) => layer.id === selectedChannel.value?.id))
const stackSummary = computed(() => {
  const labels = enabledChannelLayers.value.map((layer) => sourceLabel(layer.source))
  if (labels.length === 0) return 'Stack muted'
  if (labels.length <= 2) return labels.join(' + ')
  return `${labels[0]} + ${labels[1]} + ${labels.length - 2} more`
})

async function connectFonts() {
  const operation = ++fontOperation
  const statusRevision = ++fontStatusRevision
  fontBusy.value = true
  fontStatus.value = 'Waiting for font permission…'
  // The permission-gated call must remain in the click task, before the first await.
  const request = queryLocalFontFaces()
  try {
    const records = await request
    if (appDisposed || operation !== fontOperation) return
    requestedFontRecords.value = records
    const existing = fontChoices.value.filter((font) => font.source !== 'local')
    fontChoices.value = mergeFontChoices(existing, records)
    if (statusRevision === fontStatusRevision) {
      fontStatus.value = records.length
        ? `${records.length.toLocaleString()} installed faces available`
        : 'No additional fonts were shared'
    }
  } catch (error) {
    if (appDisposed || operation !== fontOperation) return
    const name = error instanceof DOMException ? error.name : ''
    if (statusRevision === fontStatusRevision) {
      fontStatus.value = name === 'NotAllowedError'
        ? 'Font access was not granted; detected fonts remain available'
        : 'Could not browse fonts; detected fonts remain available'
    }
  } finally {
    if (!appDisposed && operation === fontOperation) fontBusy.value = false
  }
}

async function handleFontChange() {
  const operation = ++fontOperation
  const statusRevision = ++fontStatusRevision
  const record = requestedFontRecords.value.find((font) => font.id === selectedFontId.value)
  if (!record) {
    cleanupRegisteredFont(activeFontRegistration)
    activeFontRegistration = undefined
    activeFontRegistrationId = undefined
    fontBusy.value = false
    fontStatus.value = `${selectedFont.value.label} ready`
    rebuildTextMesh()
    return
  }
  fontBusy.value = true
  fontStatus.value = `Loading ${record.label}…`
  try {
    const registration = await registerLocalFont(record.fontData)
    if (appDisposed || operation !== fontOperation || selectedFontId.value !== record.id) {
      cleanupRegisteredFont(registration)
      return
    }
    cleanupRegisteredFont(activeFontRegistration)
    activeFontRegistration = registration
    activeFontRegistrationId = record.id
    fontChoices.value = fontChoices.value.map((font) => font.id === record.id
      ? { ...registration.choice, id: record.id }
      : font)
    if (statusRevision === fontStatusRevision) fontStatus.value = `${record.label} ready`
    rebuildTextMesh()
  } catch {
    if (appDisposed || operation !== fontOperation || selectedFontId.value !== record.id) return
    cleanupRegisteredFont(activeFontRegistration)
    activeFontRegistration = undefined
    activeFontRegistrationId = undefined
    selectedFontId.value = SYSTEM_SANS_FONT.id
    if (statusRevision === fontStatusRevision) fontStatus.value = 'That face could not be read; using System Sans'
    rebuildTextMesh()
  } finally {
    if (!appDisposed && operation === fontOperation) fontBusy.value = false
  }
}

function rebuildTextMesh() {
  window.clearTimeout(textBuildTimer)
  textBuilding.value = true
  textBuildError.value = ''
  textBuildTimer = window.setTimeout(() => {
    try {
      const result = createTextMesh(textSettings.text, selectedFont.value.cssFamily, { ...textSettings })
      textMesh.value = result?.mesh ?? null
      if (workspace.value === 'text') {
        status.value = result
          ? `${selectedFont.value.label} · ${inspectTopology(result.mesh).faces.toLocaleString()} triangles`
          : 'Type something to generate a model'
      }
    } catch (error) {
      textMesh.value = null
      textBuildError.value = error instanceof Error ? error.message : 'Text geometry could not be generated.'
    } finally {
      textBuilding.value = false
    }
  }, 90)
}

function animateLivingForm(time: number) {
  livingAnimationFrame = window.requestAnimationFrame(animateLivingForm)
  const previous = livingAnimationTime
  livingAnimationTime = time
  if (!previous || !livingPlaying.value || !livingForm.value.enabled) return
  // Ignore long background-tab gaps instead of making the form jump on return.
  const elapsed = Math.min(100, Math.max(0, time - previous))
  livingAnimationElapsed += elapsed
  // The preview and exported loop top out at 30 unique frames per second. Keeping
  // the reactive editor clock on that cadence avoids re-rendering the entire
  // inspector and recomputing a dense mesh on 60–120 Hz displays.
  if (livingAnimationElapsed < 1000 / 30) return
  livingPhase.value = livingPhase.value + livingAnimationElapsed / (livingForm.value.duration * 1000)
  livingAnimationElapsed = 0
}

function toggleLivingFormPlayback() {
  if (!livingForm.value.enabled) livingForm.value.enabled = true
  livingPlaying.value = !livingPlaying.value
  livingAnimationTime = performance.now()
  livingAnimationElapsed = 0
}

function restartLivingForm() {
  livingPhase.value = 0
  livingAnimationTime = performance.now()
  livingAnimationElapsed = 0
}

function pauseLivingFormForScrub() {
  livingPlaying.value = false
  livingAnimationElapsed = 0
}

function switchWorkspace(next: WorkspaceMode) {
  livingPlaying.value = false
  livingAnimationElapsed = 0
  workspace.value = next
  imageExportOpen.value = false
  closeBackgroundMenu()
  status.value = next === 'image'
    ? `${image.value.name} · ${image.value.sourceWidth} × ${image.value.sourceHeight}`
    : textMesh.value
      ? `${selectedFont.value.label} · text model ready`
      : 'Preparing text model…'
}

function handleWorkspaceTabKeydown(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const next: WorkspaceMode = event.key === 'ArrowLeft' || event.key === 'Home' ? 'image' : 'text'
  switchWorkspace(next)
  void nextTick(() => document.getElementById(`${next}-workspace-tab`)?.focus())
}

function sourceLabel(source: HeightSource): string {
  return heightSources.find((item) => item.value === source)?.label ?? source
}

function blendLabel(blend: ChannelBlendMode): string {
  return blendModes.find((item) => item.value === blend)?.label ?? blend
}

function closeBackgroundMenu(restoreFocus = false) {
  const returnFocus = backgroundMenuReturnFocus
  backgroundMenuPosition.value = null
  backgroundMenuReturnFocus = null
  if (restoreFocus) void nextTick(() => returnFocus?.focus({ preventScroll: true }))
}

function chooseViewportBackground(background: ViewportBackground) {
  viewportBackground.value = background
  closeBackgroundMenu(true)
  status.value = `Viewport background · ${viewportBackgroundPreset(background).label}`
}

function clampBackgroundMenuPosition(x: number, y: number) {
  const stage = threeStage.value
  if (!stage) return { x: 12, y: 12 }
  const width = stage.clientWidth
  const height = stage.clientHeight
  return {
    x: Math.min(Math.max(8, x), Math.max(8, width - 204)),
    y: Math.min(Math.max(8, y), Math.max(8, height - 166)),
  }
}

async function showBackgroundMenu(x: number, y: number, returnFocus: HTMLElement) {
  backgroundMenuReturnFocus = returnFocus
  backgroundMenuPosition.value = clampBackgroundMenuPosition(x, y)
  await nextTick()
  backgroundMenu.value
    ?.querySelector<HTMLElement>('[aria-checked="true"]')
    ?.focus()
}

function openBackgroundMenu(event: MouseEvent) {
  const stage = threeStage.value
  if (!stage) return
  const bounds = stage.getBoundingClientRect()
  void showBackgroundMenu(event.clientX - bounds.left, event.clientY - bounds.top, stage)
}

function toggleBackgroundMenuFromTrigger() {
  if (backgroundMenuPosition.value) {
    closeBackgroundMenu()
    return
  }
  const stage = threeStage.value
  if (!stage) return
  void showBackgroundMenu(stage.clientWidth - 212, 12, backgroundTrigger.value ?? stage)
}

function focusThreeStage(event: PointerEvent) {
  if (backgroundMenu.value?.contains(event.target as Node)) return
  threeStage.value?.focus({ preventScroll: true })
}

function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.matches('input, select, textarea, [contenteditable="true"], [contenteditable=""]')
}

function handleGlobalKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && backgroundMenuPosition.value) {
    event.preventDefault()
    closeBackgroundMenu(true)
    return
  }
  if (
    event.defaultPrevented
    || event.metaKey
    || event.ctrlKey
    || event.altKey
    || isEditableShortcutTarget(event.target)
  ) return
  const background = viewportBackgroundFromShortcut(event.key)
  if (!background) return
  event.preventDefault()
  chooseViewportBackground(background)
}

function handleBackgroundMenuKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' || event.key === ' ') {
    const background = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-background]')?.dataset.background
    if (isViewportBackground(background)) {
      event.preventDefault()
      chooseViewportBackground(background)
    }
    return
  }
  const items = [...(backgroundMenu.value?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])]
  if (!items.length) return
  const current = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement))
  let next = current
  if (event.key === 'ArrowDown') next = (current + 1) % items.length
  else if (event.key === 'ArrowUp') next = (current - 1 + items.length) % items.length
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = items.length - 1
  else return
  event.preventDefault()
  items[next]?.focus()
}

function handleDocumentPointerDown(event: PointerEvent) {
  if (!backgroundMenuPosition.value || !(event.target instanceof Node)) return
  if (backgroundMenu.value?.contains(event.target) || backgroundTrigger.value?.contains(event.target)) return
  closeBackgroundMenu()
}

function handleDocumentFocusIn(event: FocusEvent) {
  if (!backgroundMenuPosition.value || !(event.target instanceof Node)) return
  if (backgroundMenu.value?.contains(event.target) || backgroundTrigger.value?.contains(event.target)) return
  closeBackgroundMenu()
}

function handleWindowResize() {
  closeBackgroundMenu()
}

async function acquireLivingLoopWakeLock(): Promise<void> {
  try {
    livingLoopWakeLock = await navigator.wakeLock?.request('screen') ?? null
  } catch {
    // Wake lock is best-effort on the web; the desktop shell also protects long jobs.
    livingLoopWakeLock = null
  }
}

async function releaseLivingLoopWakeLock(): Promise<void> {
  const wakeLock = livingLoopWakeLock
  livingLoopWakeLock = null
  if (!wakeLock || wakeLock.released) return
  try {
    await wakeLock.release()
  } catch {
    // The browser may already have released it when the tab became hidden.
  }
}

function resetProRenderSettings() {
  Object.assign(proRenderSettings, DEFAULT_DESKTOP_PRO_RENDER_SETTINGS)
  imageExportNotice.value = 'Cycles Pro restored to the production preset.'
  imageExportError.value = ''
}

async function refreshDesktopProRenderer(): Promise<void> {
  if (!desktopProBridgeAvailable) return
  desktopProProbePending.value = true
  desktopProProbeError.value = ''
  try {
    desktopProRenderer.value = await probeDesktopProRenderer()
    if (!desktopProRenderer.value?.available && imageExportQuality.value === 'pro') {
      imageExportQuality.value = 'high'
    }
  } catch (error) {
    desktopProRenderer.value = null
    desktopProProbeError.value = error instanceof Error
      ? error.message
      : 'Rasterform could not inspect the Blender renderer.'
    if (imageExportQuality.value === 'pro') imageExportQuality.value = 'high'
  } finally {
    desktopProProbePending.value = false
  }
}

onMounted(() => {
  appDisposed = false
  void cleanupStaleStoredZipArchives()
  void refreshDesktopProRenderer()
  window.addEventListener('keydown', handleGlobalKeydown)
  window.addEventListener('resize', handleWindowResize)
  document.addEventListener('pointerdown', handleDocumentPointerDown)
  document.addEventListener('focusin', handleDocumentFocusIn)
  livingAnimationTime = performance.now()
  livingAnimationFrame = window.requestAnimationFrame(animateLivingForm)
  rebuildTextMesh()
  const request = ++passiveFontRequest
  const statusRevision = fontStatusRevision
  void discoverPassiveFonts().then((discovery) => {
    if (appDisposed || request !== passiveFontRequest) {
      discovery.cleanup()
      return
    }
    passiveFontCleanup?.()
    passiveFontCleanup = discovery.cleanup
    fontChoices.value = mergeFontChoices(discovery.choices, requestedFontRecords.value)
    const detected = discovery.choices.length - 1
    if (statusRevision === fontStatusRevision) {
      fontStatus.value = detected > 0
        ? `${detected} detected font${detected === 1 ? '' : 's'} ready`
        : 'System font ready'
    }
  })
})

onBeforeUnmount(() => {
  appDisposed = true
  fontOperation += 1
  passiveFontRequest += 1
  window.removeEventListener('keydown', handleGlobalKeydown)
  window.removeEventListener('resize', handleWindowResize)
  document.removeEventListener('pointerdown', handleDocumentPointerDown)
  document.removeEventListener('focusin', handleDocumentFocusIn)
  window.cancelAnimationFrame(livingAnimationFrame)
  livingLoopController?.abort()
  blenderExportController?.abort()
  void releaseLivingLoopWakeLock()
  window.clearTimeout(textBuildTimer)
  cleanupRegisteredFont(activeFontRegistration)
  activeFontRegistration = undefined
  activeFontRegistrationId = undefined
  passiveFontCleanup?.()
  passiveFontCleanup = undefined
})

watch(viewportBackground, (background) => {
  try {
    window.localStorage.setItem(BACKGROUND_STORAGE_KEY, background)
  } catch {
    // Background switching remains available when storage is blocked.
  }
})

watch([exportingImage, exportingBlenderProject], ([isExportingImage, isExportingBlender]) => {
  const isExporting = isExportingImage || isExportingBlender
  if (isExporting) closeBackgroundMenu()
  if (isExportingBlender) {
    void nextTick(() => {
      if (blenderExportDetails.value) blenderExportDetails.value.open = true
    })
  }
})

watch([() => selectedFont.value.cssFamily, textSettings], rebuildTextMesh, { deep: true })

watch(() => livingForm.value.enabled, (enabled) => {
  if (!enabled) livingPlaying.value = false
})

watch(() => proRenderSettings.maxSamples, (maximum) => {
  if (proRenderSettings.minSamples > maximum) proRenderSettings.minSamples = maximum
})

function selectColorMode(mode: ColorMode) {
  if (mode === 'wireframe' && imageExportQuality.value !== 'high' && !exportingImage.value) {
    imageExportQuality.value = 'high'
    imageExportNotice.value = 'Wireframe exports use High quality.'
  }
  colorMode.value = mode
}

function selectImageExportView(view: ImageExportView) {
  if (workspace.value !== 'image' || exportingImage.value) return
  imageExportView.value = view
  imageExportError.value = ''
  if (view === 'straight-on' && imageExportQuality.value !== 'high'
    && Math.max(image.value.sourceWidth, image.value.sourceHeight) > 4096) {
    const renderer = imageExportQuality.value === 'pro' ? 'Cycles Pro' : 'Final'
    imageExportNotice.value = `${renderer} supports up to 4K. Choose High to keep the exact ${image.value.sourceWidth.toLocaleString()} × ${image.value.sourceHeight.toLocaleString()} original dimensions.`
  } else {
    imageExportNotice.value = ''
  }
}

function selectImageExportQuality(quality: ImageExportQuality) {
  if (quality === 'pro' && !desktopProReady.value) {
    imageExportNotice.value = desktopProStatus.value
    return
  }
  if (quality !== 'high' && colorMode.value === 'wireframe') {
    imageExportNotice.value = 'Wireframe exports use High quality.'
    return
  }
  if (quality !== 'high' && straightOnExceedsFourK.value) {
    const renderer = quality === 'pro' ? 'Cycles Pro' : 'Final'
    imageExportNotice.value = `${renderer} supports up to 4K. Choose High to keep the exact ${imageExportDimensions.value.width.toLocaleString()} × ${imageExportDimensions.value.height.toLocaleString()} original dimensions, or switch to Current view.`
    return
  }
  if (quality !== 'high' && imageExportLongEdge.value === 8192) {
    imageExportLongEdge.value = 4096
    imageExportNotice.value = `${quality === 'pro' ? 'Cycles Pro' : 'Final'} supports up to 4K; size changed to 4K.`
  } else {
    imageExportNotice.value = ''
  }
  imageExportQuality.value = quality
  imageExportError.value = ''
}

let lastAnnouncedPhase: FinalExportProgress['phase'] | '' = ''
let lastAnnouncedBucket = -1
let lastAnnouncedLivingPhase: LivingFormLoopProgress['phase'] | '' = ''

function handleImageExportProgress(progress: FinalExportProgress) {
  if (activeLivingLoopFrame) {
    const overall = (activeLivingLoopFrame.frame + progress.progress) / activeLivingLoopFrame.frames
    Object.assign(livingLoopProgress, {
      phase: 'rendering',
      progress: overall,
      frame: activeLivingLoopFrame.frame,
      frames: activeLivingLoopFrame.frames,
    } satisfies LivingFormLoopProgress)
    const bucket = Math.floor(overall * 20)
    if (bucket !== lastAnnouncedBucket) {
      lastAnnouncedBucket = bucket
      imageExportAnnouncement.value = livingLoopProgressLabel.value
    }
    return
  }
  Object.assign(imageExportProgress, progress)
  const bucket = Math.floor(progress.progress * 10)
  if (progress.phase !== lastAnnouncedPhase || bucket !== lastAnnouncedBucket) {
    lastAnnouncedPhase = progress.phase
    lastAnnouncedBucket = bucket
    imageExportAnnouncement.value = imageExportProgressLabel.value
  }
}

function addChannel() {
  if (channelLayers.length >= 5) return
  const suggestedSources: HeightSource[] = ['edges', 'saturation', 'hue', 'value']
  const source = suggestedSources[Math.min(suggestedSources.length - 1, Math.max(0, channelLayers.length - 1))] ?? 'edges'
  const layer = createChannelLayer(source, { amount: source === 'edges' ? 0.3 : 0.5 })
  channelLayers.push(layer)
  selectedChannelId.value = layer.id
  status.value = `${sourceLabel(source)} added to the channel stack.`
}

function removeChannel(index: number) {
  if (channelLayers.length <= 1) return
  const [removed] = channelLayers.splice(index, 1)
  if (!removed) return
  if (removed.id === selectedChannelId.value) {
    selectedChannelId.value = channelLayers[Math.min(index, channelLayers.length - 1)]?.id ?? ''
  }
  status.value = `${sourceLabel(removed.source)} removed from the channel stack.`
}

function moveChannel(index: number, direction: -1 | 1) {
  const destination = index + direction
  if (destination < 0 || destination >= channelLayers.length) return
  const [layer] = channelLayers.splice(index, 1)
  if (!layer) return
  channelLayers.splice(destination, 0, layer)
  status.value = 'Channel order changed; the first enabled channel remains the base.'
}

function applyPreset(preset: StackPreset) {
  channelLayers.splice(
    0,
    channelLayers.length,
    ...preset.layers.map((layer) => createChannelLayer(layer.source, layer)),
  )
  selectedChannelId.value = channelLayers[0]?.id ?? ''
  Object.assign(fieldSettings, preset.field)
  status.value = `${preset.label} applied`
}

async function updateCanvases() {
  await nextTick()
  if (sourceCanvas.value) drawPixelImage(sourceCanvas.value, image.value)
  if (sourceThumbCanvas.value) drawPixelImage(sourceThumbCanvas.value, image.value)
  if (heightCanvas.value) drawScalarField(heightCanvas.value, heightField.value)
}

watch([image, heightField], updateCanvases, { immediate: true })

async function openFile(file?: File) {
  if (!file) return
  try {
    image.value = await fileToPixelImage(file)
    status.value = `${file.name} · ${image.value.sourceWidth} × ${image.value.sourceHeight}`
  } catch (error) {
    status.value = error instanceof Error ? error.message : 'Could not open that image.'
  }
}

function handleFile(event: Event) {
  const input = event.target as HTMLInputElement
  void openFile(input.files?.[0])
}

function handleDrop(event: DragEvent) {
  dragging.value = false
  if (event.dataTransfer?.files?.[0]) switchWorkspace('image')
  void openFile(event.dataTransfer?.files?.[0])
}

function resetDemo() {
  image.value = createDemoImage()
  status.value = 'Demo restored'
}

function recipe(): Recipe {
  return {
    version: 6,
    app: 'Rasterform',
    image: { name: image.value.name, width: image.value.sourceWidth, height: image.value.sourceHeight },
    channels: channelLayers.map((layer) => ({ ...layer })),
    field: { ...fieldSettings },
    mesh: { ...meshSettings },
    appearance: {
      heightGradient: { ...imageAppearance.heightGradient },
      clay: { ...imageAppearance.clay },
    },
    livingForm: { ...imageLivingForm, phase: imageLivingPhase.value },
    createdAt: new Date().toISOString(),
  }
}

function textRecipe(): TextRecipe {
  const { text, ...shape } = textSettings
  return {
    version: 6,
    app: 'Rasterform',
    workspace: 'text',
    text: { ...shape, value: text },
    font: {
      label: selectedFont.value.label,
      family: selectedFont.value.family,
      style: selectedFont.value.style,
      source: selectedFont.value.source,
      postscriptName: selectedFont.value.postscriptName,
    },
    appearance: {
      heightGradient: { ...textAppearance.heightGradient },
      clay: { ...textAppearance.clay },
    },
    livingForm: { ...textLivingForm, phase: textLivingPhase.value },
    createdAt: new Date().toISOString(),
  }
}

function currentMeshSnapshot(): MeshData | null {
  if (!mesh.value) return null
  return livingForm.value.enabled
    ? animateLivingFormMesh(mesh.value, livingPhase.value, livingForm.value)
    : mesh.value
}

const blenderLivingFormEngines = new WeakMap<MeshData, LivingFormEngine>()

function currentBlenderMeshSnapshot(): { mesh: MeshData; owned: boolean } | null {
  const source = mesh.value
  if (!source) return null
  if (!livingForm.value.enabled) return { mesh: source, owned: false }
  let engine = blenderLivingFormEngines.get(source)
  if (!engine) {
    engine = createLivingFormEngine(source)
    blenderLivingFormEngines.set(source, engine)
  }
  // The engine is cached per immutable source mesh. These arrays are created
  // specifically for this export, so the client can hand them to IPC without
  // cloning the full animated mesh a second time.
  return {
    mesh: {
      ...source,
      positions: engine.samplePositions(livingPhase.value, livingForm.value),
      indices: source.indices.slice(),
      colors: source.colors.slice(),
      uvs: source.uvs.slice(),
    },
    owned: true,
  }
}

async function downloadGlb() {
  const exportMesh = currentMeshSnapshot()
  if (!exportMesh) return
  exporting.value = true
  status.value = 'Exporting GLB…'
  try {
    await exportGlb(exportMesh, colorMode.value, appearance.value)
    status.value = 'GLB exported for Blender / Cycles'
  } catch (error) {
    status.value = error instanceof Error ? error.message : 'GLB export failed.'
  } finally {
    exporting.value = false
  }
}

function friendlyBlenderExportError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return ''
  if (error instanceof DesktopBlenderExportError) {
    if (error.code === 'save-failed') {
      return 'macOS could not save the Blender project. Choose a writable location and try again; your design is safe.'
    }
    if (error.code === 'process-gone') {
      return 'The isolated Blender exporter stopped unexpectedly. Your Rasterform design and any open Blender project are safe.'
    }
    if (error.code === 'request-expired') {
      return 'The Blender project save reservation expired before preparation started. Try the export again.'
    }
    return error.message
  }
  return error instanceof Error ? error.message : 'Blender project export failed.'
}

async function downloadBlenderProject() {
  if (exportingBlenderProject.value) {
    blenderExportController?.abort()
    blenderExportNotice.value = 'Cancelling Blender project export…'
    return
  }
  const sourceMesh = mesh.value
  if (!sourceMesh || colorMode.value === 'wireframe' || !desktopProReady.value) return
  const controller = new AbortController()
  blenderExportController = controller
  exportingBlenderProject.value = true
  blenderExportPhase.value = 'preparing'
  blenderExportError.value = ''
  blenderExportNotice.value = ''
  status.value = `Preparing ${activeBlenderTopology.value.label.toLowerCase()} Blender project…`
  try {
    const result = await exportBlenderProjectInDesktop({
      mesh: sourceMesh,
      prepareMesh: () => {
        const prepared = currentBlenderMeshSnapshot()
        if (!prepared) throw new Error('The model is no longer available.')
        return { mesh: prepared.mesh, ownedMeshSnapshot: prepared.owned }
      },
      colorMode: colorMode.value,
      appearance: appearance.value,
      topology: blenderExportTopology.value,
      suggestedName: `rasterform-${blenderExportTopology.value}.blend`,
      signal: controller.signal,
      onProgress: (phase) => {
        blenderExportPhase.value = phase
      },
    })
    const reduction = result.sourceFaces > 0
      ? Math.max(0, Math.round((1 - result.outputTriangleCount / result.sourceFaces) * 100))
      : 0
    blenderExportNotice.value = result.topology === 'exact'
      ? `Saved ${result.fileName} · exact ${result.outputFaces.toLocaleString()}-face model · ${result.uvLayerName}`
      : `Saved ${result.fileName} · ${result.outputFaces.toLocaleString()} editable polygons · ${result.outputTriangleCount.toLocaleString()} render triangles${reduction > 0 ? ` (${reduction}% fewer)` : ''} · ${result.quads.toLocaleString()} quads · ${result.uvLayerName}`
    status.value = `Blender project saved · ${result.fileName}`
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      blenderExportNotice.value = 'Blender project export cancelled. No destination file was changed.'
      status.value = 'Blender project export cancelled'
    } else {
      blenderExportError.value = friendlyBlenderExportError(error)
      status.value = 'Blender project export failed'
    }
  } finally {
    if (blenderExportController === controller) blenderExportController = null
    exportingBlenderProject.value = false
  }
}

function keepBlenderExportAccordionOpen(event: Event) {
  if (!exportingBlenderProject.value) return
  const details = event.currentTarget as HTMLDetailsElement
  if (!details.open) details.open = true
}

function downloadStl() {
  const exportMesh = currentMeshSnapshot()
  if (!exportMesh || !topology.value?.watertight) return
  exportStl(exportMesh)
  status.value = 'STL exported · geometry only'
}

function cancelImageExport() {
  if (livingLoopNativeSaving.value) return
  livingLoopController?.abort()
  threePreview.value?.cancelImageExport()
  imageExportNotice.value = imageExportKind.value === 'loop'
    ? 'Cancelling Living Form export…'
    : 'Cancelling image export…'
}

function friendlyImageExportError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return ''
  if (error instanceof DesktopProRenderError) {
    if (error.code === 'save-failed') {
      return 'macOS could not save the Cycles Pro PNG + EXR pair. Your design is safe; choose a writable location and try Pro again.'
    }
    if (error.code === 'process-gone') {
      return 'The separate background Blender process stopped unexpectedly. Your open Blender project and Rasterform design are safe; try Pro again.'
    }
    if (error.code === 'request-expired') {
      return 'The Cycles Pro save reservation expired before rendering started. Open Pro and try again.'
    }
    return `${error.message} Your design and any open Blender project are safe.`
  }
  if (error instanceof DesktopFinalRenderError) {
    if (error.code === 'save-failed') {
      return 'macOS could not save the Final PNG. Your design is safe; choose a writable location and try Final again.'
    }
    if (error.code === 'process-gone') {
      return 'The separate Final renderer stopped unexpectedly. Your design is safe; try Final again.'
    }
    if (error.code === 'request-expired') {
      return 'The Final save reservation expired before rendering started. Open Final and try again.'
    }
    return 'The separate Final renderer could not finish. Your design is safe; try Final again.'
  }
  const message = error instanceof Error ? error.message : ''
  const requestedQuality = activeImageExportRequest.value?.quality
  const requestedFinal = requestedQuality === 'final'
  const requestedPro = requestedQuality === 'pro'
  if (message.includes('Cycles Pro supports')) return 'Cycles Pro supports 2K and 4K still renders. Choose 4K or use High quality for 8K.'
  if (message.includes('8K Final')) return 'Final quality supports up to 4K. Choose 4K or use High quality for 8K.'
  if (message.includes('canvas') || message.includes('size')) {
    return requestedPro
      ? 'Cycles Pro could not prepare the requested image size. Your design is safe; retry Pro with the same settings.'
      : requestedFinal
      ? 'The device could not allocate the requested Final canvas. Close other graphics-heavy apps and retry Final with the same settings.'
      : 'The device could not allocate this image canvas. Close other graphics-heavy apps and try the export again.'
  }
  if (message.includes('context') || message.includes('progress')) {
    return requestedPro
      ? 'The background Blender render stopped before it could save both files. Your design is safe; retry Pro with the same settings.'
      : requestedFinal
      ? 'Final rendering stopped on this device. Your design is safe; retry Final with the same settings.'
      : 'High-quality rendering stopped on this device. Your design is safe; try the export again.'
  }
  if (message.includes('Transparency check failed')) {
    return `The transparency check failed, so Rasterform did not save a bad file. Retry ${requestedPro ? 'Pro' : requestedFinal ? 'Final' : 'the export'} with the same settings.`
  }
  return requestedPro
    ? 'Cycles Pro could not finish. Your Rasterform design and any open Blender project are safe; retry Pro with the same settings.'
    : requestedFinal
    ? 'Final could not finish on this device. Your design is safe; retry Final with the same settings.'
    : 'Image export could not finish on this device. Your design is safe; try the export again.'
}

async function downloadImagePng() {
  if (!threePreview.value || !mesh.value) return
  if (exportingImage.value) {
    cancelImageExport()
    return
  }
  if (imageExportUnsupported.value) return
  const request: ImageExportRequestSnapshot = {
    dimensions: { ...imageExportDimensions.value },
    view: effectiveImageExportView.value,
    quality: imageExportQuality.value,
    background: imageExportBackground.value,
    viewportBackground: viewportBackground.value,
    colorMode: colorMode.value,
    samples: imageExportQuality.value === 'pro'
      ? proRenderSettings.maxSamples
      : imageExportQuality.value === 'final'
        ? finalSampleTarget(colorMode.value, appearance.value)
        : 1,
    proSettings: { ...proRenderSettings },
    livingEnabled: livingForm.value.enabled,
    livingPhase: livingPhase.value,
  }
  activeImageExportRequest.value = request
  exportingImage.value = true
  imageExportError.value = ''
  imageExportNotice.value = ''
  imageExportAnnouncement.value = request.quality === 'pro'
    ? 'Preparing Cycles Pro image.'
    : request.quality === 'final'
      ? 'Preparing final image.'
      : 'Rendering image.'
  lastAnnouncedPhase = ''
  lastAnnouncedBucket = -1
  Object.assign(imageExportProgress, {
    phase: request.quality === 'high' ? 'rendering' : 'preparing',
    progress: 0,
    tile: 0,
    tiles: 0,
    samples: 0,
    targetSamples: request.samples,
  } satisfies FinalExportProgress)
  try {
    const view = previewModes.find((mode) => mode.value === request.colorMode)?.label.toLowerCase() ?? request.colorMode
    const background = request.background === 'transparent' ? 'transparent' : request.viewportBackground
    const quality = request.quality
    const cameraView = request.view === 'straight-on' ? '-straight-on' : ''
    const fileName = `rasterform-${view}-${quality}${cameraView}-${request.dimensions.width}x${request.dimensions.height}-${background}.png`
    const result = request.quality === 'pro'
      ? await threePreview.value.captureProRender(
          request.dimensions,
          request.background,
          request.proSettings,
          fileName,
          request.livingPhase,
          request.view,
        )
      : request.quality === 'final'
        ? await threePreview.value.captureFinalPng(request.dimensions, request.background, fileName, request.livingPhase, request.view)
        : await threePreview.value.captureHighPng(request.dimensions, request.background, request.livingPhase, request.view)
    if ('pngFileName' in result) {
      status.value = `Cycles Pro · ${result.width} × ${result.height} · up to ${result.maxSamples.toLocaleString()} samples · PNG + EXR · ${result.device}`
      imageExportNotice.value = `PNG + EXR saved together as ${result.pngFileName} and ${result.exrFileName} · ${result.width.toLocaleString()} × ${result.height.toLocaleString()}.`
    } else {
      if (!('desktopSaved' in result)) downloadBlob(fileName, result.blob)
      const sampleDetail = 'samples' in result ? ` · ${result.samples} samples` : ' · 2× edge smoothing'
      status.value = `PNG · ${result.width} × ${result.height}${sampleDetail} · ${background} · ${result.dpi} PPI`
      imageExportNotice.value = 'desktopSaved' in result
        ? `PNG saved as ${result.fileName} · ${result.width.toLocaleString()} × ${result.height.toLocaleString()}.`
        : `PNG download started · ${result.width.toLocaleString()} × ${result.height.toLocaleString()}.`
    }
  } catch (error) {
    const friendly = friendlyImageExportError(error)
    if (friendly) imageExportError.value = friendly
    else imageExportNotice.value = 'Image export cancelled.'
  } finally {
    exportingImage.value = false
    activeImageExportRequest.value = null
    if (colorMode.value === 'wireframe' && imageExportQuality.value !== 'high') {
      imageExportQuality.value = 'high'
    }
  }
}

function friendlyLivingFormExportError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return ''
  const message = error instanceof Error ? error.message : ''
  if (message.includes('too large')) {
    return 'This browser cannot safely store the full lossless sequence. Use Rasterform desktop or a browser with private file storage; render quality was not changed.'
  }
  if (message.includes('PNG')) {
    return 'A loop frame failed validation, so Rasterform did not save a damaged sequence. Your design is safe; try the export again.'
  }
  return 'The Living Form sequence could not finish on this device. Your design and still-image Final settings are unchanged.'
}

async function downloadLivingFormLoop() {
  if (!threePreview.value || !mesh.value) return
  if (exportingImage.value) {
    cancelImageExport()
    return
  }
  if (!livingForm.value.enabled) {
    imageExportError.value = 'Enable Living Form in Properties before exporting a loop.'
    return
  }

  const controller = new AbortController()
  livingLoopController = controller
  const request: LivingLoopExportRequestSnapshot = {
    dimensions: { ...livingLoopDimensions.value },
    fps: livingLoopFps.value,
    frameCount: calculateLivingFormFrameCount(livingForm.value.duration, livingLoopFps.value),
    settings: { ...livingForm.value },
    background: imageExportBackground.value,
    studioBackground: viewportBackground.value,
  }
  activeLivingLoopRequest.value = request
  exportingImage.value = true
  imageExportError.value = ''
  imageExportNotice.value = ''
  imageExportAnnouncement.value = 'Preparing Living Form loop.'
  lastAnnouncedBucket = -1
  lastAnnouncedLivingPhase = ''
  Object.assign(livingLoopProgress, {
    phase: 'rendering',
    progress: 0,
    frame: 0,
    frames: request.frameCount,
  } satisfies LivingFormLoopProgress)

  let desktopLongExport: DesktopLongExportSession | null = null
  let desktopOutcome: 'completed' | 'cancelled' | 'failed' = 'failed'
  let completedLoopCleanup: (() => Promise<void>) | null = null
  let cleanupScheduled = false
  const scheduleCompletedLoopCleanup = () => {
    const cleanup = completedLoopCleanup
    if (!cleanup || cleanupScheduled) return
    cleanupScheduled = true
    window.setTimeout(() => void cleanup(), 24 * 60 * 60 * 1000)
  }
  try {
    threePreview.value.beginLivingFormLoopExport(request.settings)
    desktopLongExport = await beginDesktopLongExport({ frames: request.frameCount })
    await acquireLivingLoopWakeLock()
    if (controller.signal.aborted) throw new DOMException('Living Form export cancelled.', 'AbortError')
    const result = await exportLivingFormPngSequence({
      width: request.dimensions.width,
      height: request.dimensions.height,
      fps: request.fps,
      settings: request.settings,
      background: request.background,
      studioBackground: request.studioBackground,
      signal: controller.signal,
      renderFrame: async (phase, frame, frames) => {
        activeLivingLoopFrame = { frame, frames }
        const result = await threePreview.value!.captureHighPng(request.dimensions, request.background, phase)
        return result.blob
      },
      onProgress: (progress) => {
        if (progress.phase === 'packaging') activeLivingLoopFrame = null
        Object.assign(livingLoopProgress, progress)
        const bucket = Math.floor(progress.progress * 20)
        if (progress.phase !== lastAnnouncedLivingPhase || bucket !== lastAnnouncedBucket) {
          lastAnnouncedLivingPhase = progress.phase
          lastAnnouncedBucket = bucket
          imageExportAnnouncement.value = livingLoopProgressLabel.value
        }
      },
    })
    const backgroundLabel = request.background === 'transparent' ? 'transparent' : request.studioBackground
    const fileName = `rasterform-living-${request.settings.behavior}-${request.dimensions.width}x${request.dimensions.height}-${result.fps}fps-${backgroundLabel}.zip`
    completedLoopCleanup = result.cleanup
    downloadBlob(fileName, result.blob)
    // Browsers do not expose download-completion events. Retain a private-file
    // archive long enough for multi-gigabyte downloads; stale archives are also
    // scavenged on a later export.
    if (!desktopLongExport) {
      if (result.archiveStorage === 'temporary-file') scheduleCompletedLoopCleanup()
      else void result.cleanup()
    }
    status.value = `Living Form · ${result.frames} lossless frames · ${result.width} × ${result.height} · ${result.fps} fps`
    imageExportNotice.value = desktopLongExport
      ? `All ${result.frames.toLocaleString()} frames are complete · saving the lossless ZIP…`
      : `PNG sequence download started · ${result.frames.toLocaleString()} frames · seamless ${result.durationSeconds}s loop.`
    imageExportAnnouncement.value = imageExportNotice.value
    desktopOutcome = 'completed'
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') desktopOutcome = 'cancelled'
    const friendly = friendlyLivingFormExportError(error)
    if (friendly) {
      imageExportError.value = friendly
      imageExportAnnouncement.value = friendly
    } else {
      imageExportNotice.value = 'Living Form export cancelled.'
      imageExportAnnouncement.value = imageExportNotice.value
    }
  } finally {
    threePreview.value?.endLivingFormLoopExport()
    if (desktopLongExport && desktopOutcome === 'completed') {
      livingLoopNativeSaving.value = true
      imageExportAnnouncement.value = 'Saving Living Form ZIP.'
    }
    let nativeCleanupSafe = false
    try {
      const desktopSaved = await endDesktopLongExport(desktopLongExport, desktopOutcome)
      nativeCleanupSafe = desktopSaved
      if (desktopLongExport && desktopOutcome === 'completed' && desktopSaved) {
        imageExportNotice.value = `Living Form ZIP saved · ${request.frameCount.toLocaleString()} lossless frames · seamless ${request.settings.duration}s loop.`
        imageExportAnnouncement.value = imageExportNotice.value
      }
      if (desktopLongExport && desktopOutcome === 'completed' && !desktopSaved) {
        imageExportNotice.value = ''
        imageExportError.value = 'macOS did not finish saving the Living Form ZIP. Your design and full-quality frames are unchanged; export the loop again.'
        imageExportAnnouncement.value = imageExportError.value
        status.value = 'Living Form ZIP was not saved'
      }
    } catch {
      if (desktopLongExport && desktopOutcome === 'completed') {
        imageExportNotice.value = ''
        imageExportError.value = 'macOS could not confirm the Living Form ZIP save. Your design is safe; export the loop again.'
        imageExportAnnouncement.value = imageExportError.value
        status.value = 'Living Form ZIP save could not be confirmed'
      }
    }
    if (desktopLongExport && nativeCleanupSafe && completedLoopCleanup) {
      try {
        await completedLoopCleanup()
      } catch {
        // The ZIP is already terminal; stale private storage is scavenged later.
      }
    } else if (desktopLongExport && completedLoopCleanup) {
      scheduleCompletedLoopCleanup()
    }
    livingLoopNativeSaving.value = false
    await releaseLivingLoopWakeLock()
    if (livingLoopController === controller) livingLoopController = null
    activeLivingLoopFrame = null
    activeLivingLoopRequest.value = null
    exportingImage.value = false
  }
}
</script>

<template>
  <main
    :class="['editor-app', { 'export-open': imageExportOpen }]"
    @dragenter.prevent="dragging = workspace === 'image'"
    @dragover.prevent="dragging = workspace === 'image'"
    @dragleave.self.prevent="dragging = false"
    @drop.prevent="handleDrop"
  >
    <header class="app-bar">
      <div class="brand-lockup">
        <span class="brand-mark" aria-hidden="true"></span>
        <strong>Rasterform</strong>
      </div>
      <div class="workspace-tabs" role="tablist" aria-label="Workspace" @keydown="handleWorkspaceTabKeydown">
        <button
          id="image-workspace-tab"
          type="button"
          role="tab"
          :aria-selected="workspace === 'image'"
          :tabindex="workspace === 'image' ? 0 : -1"
          :disabled="exportingImage || exportingBlenderProject"
          aria-controls="workspace-panel"
          @click="switchWorkspace('image')"
        >Image</button>
        <button
          id="text-workspace-tab"
          type="button"
          role="tab"
          :aria-selected="workspace === 'text'"
          :tabindex="workspace === 'text' ? 0 : -1"
          :disabled="exportingImage || exportingBlenderProject"
          aria-controls="workspace-panel"
          @click="switchWorkspace('text')"
        >Text</button>
      </div>
      <p class="document-name" :title="activeSourceName">{{ activeSourceName }}</p>
      <button
        type="button"
        class="top-export"
        :aria-expanded="imageExportOpen"
        aria-controls="export-inspector"
        :disabled="exportingImage || exportingBlenderProject"
        @click="imageExportOpen = !imageExportOpen"
      >{{ imageExportOpen ? 'Back to edit' : 'Export' }}</button>
    </header>

    <div id="workspace-panel" class="editor-grid" role="tabpanel" :aria-labelledby="`${workspace}-workspace-tab`">
      <aside class="editor-panel build-panel" aria-label="Build controls">
        <div class="panel-title">
          <div>
            <span class="panel-kicker">Build</span>
            <h2>{{ workspace === 'image' ? 'Image relief' : '3D type' }}</h2>
          </div>
          <span class="live-dot">Live</span>
        </div>

        <template v-if="workspace === 'image'">
          <details class="inspector-section" open>
            <summary><span>Source</span><small>{{ image.sourceWidth }} × {{ image.sourceHeight }}</small></summary>
            <div class="inspector-body">
              <div class="source-card">
                <canvas ref="sourceThumbCanvas" aria-label="Source image preview" />
                <div><strong>{{ image.name }}</strong><small>{{ image.sourceWidth }} × {{ image.sourceHeight }} px</small></div>
              </div>
              <input ref="fileInput" class="sr-only" type="file" accept="image/png,image/jpeg,image/webp" @change="handleFile" />
              <div class="compact-buttons">
                <button type="button" class="primary-control" @click="fileInput?.click()">Choose image</button>
                <button type="button" @click="resetDemo">Demo</button>
              </div>
            </div>
          </details>

          <details class="inspector-section" open>
            <summary><span>Channels</span><small>{{ stackSummary }}</small></summary>
            <div class="inspector-body">
              <div class="preset-pills" role="group" aria-label="Channel presets">
                <button v-for="preset in stackPresets" :key="preset.key" type="button" :title="preset.note" @click="applyPreset(preset)">{{ preset.label }}</button>
              </div>
              <ul class="layer-list" aria-label="Image channels">
                <li
                  v-for="(layer, index) in channelLayers"
                  :key="layer.id"
                  :class="{ selected: layer.id === selectedChannelId, muted: !layer.enabled }"
                >
                  <label class="visibility-toggle"><input v-model="layer.enabled" type="checkbox" /><span aria-hidden="true">●</span><span class="sr-only">Show {{ sourceLabel(layer.source) }}</span></label>
                  <button type="button" class="layer-name" :aria-pressed="layer.id === selectedChannelId" @click="selectedChannelId = layer.id">
                    <strong>{{ sourceLabel(layer.source) }}</strong><small>{{ layer.id === baseLayerId ? 'Base' : blendLabel(layer.blend) }} · {{ Math.round(layer.amount * 100) }}%</small>
                  </button>
                  <div class="layer-actions">
                    <button type="button" :disabled="index === 0" :aria-label="`Move ${sourceLabel(layer.source)} up`" @click="moveChannel(index, -1)">↑</button>
                    <button type="button" :disabled="index === channelLayers.length - 1" :aria-label="`Move ${sourceLabel(layer.source)} down`" @click="moveChannel(index, 1)">↓</button>
                    <button type="button" :disabled="channelLayers.length === 1" :aria-label="`Remove ${sourceLabel(layer.source)}`" @click="removeChannel(index)">×</button>
                  </div>
                </li>
              </ul>
              <button type="button" class="wide-control" :disabled="channelLayers.length >= 5" @click="addChannel">{{ channelLayers.length >= 5 ? 'Channel limit reached' : 'Add channel' }}</button>

              <div v-if="selectedChannel" class="sub-inspector">
                <div class="sub-inspector-title">Selected channel</div>
                <label class="control-row"><span>Image property</span><select v-model="selectedChannel.source"><option v-for="source in heightSources" :key="source.value" :value="source.value">{{ source.label }}</option></select></label>
                <label v-if="selectedChannel.id !== baseLayerId" class="control-row"><span>Combine</span><select v-model="selectedChannel.blend" :disabled="!selectedChannel.enabled"><option v-for="mode in blendModes" :key="mode.value" :value="mode.value">{{ mode.label }}</option></select></label>
                <label class="slider-control"><span>Influence <output>{{ Math.round(selectedChannel.amount * 100) }}%</output></span><input v-model.number="selectedChannel.amount" type="range" min="0" max="1" step="0.01" /></label>
                <label v-if="selectedChannel.source === 'hue'" class="slider-control"><span>Target hue <output>{{ Math.round(selectedChannel.hueOrigin * 360) }}°</output></span><input v-model.number="selectedChannel.hueOrigin" type="range" min="0" max="1" step="0.005" /></label>
                <label class="check-control"><input v-model="selectedChannel.invert" type="checkbox" />Invert channel</label>
              </div>
            </div>
          </details>
        </template>

        <template v-else>
          <details class="inspector-section" open>
            <summary><span>Content</span><small>{{ textSettings.text.length }} chars</small></summary>
            <div class="inspector-body">
              <label class="text-input-label" for="text-content">Text</label>
              <textarea id="text-content" v-model="textSettings.text" rows="4" maxlength="120" spellcheck="false" placeholder="Type something…"></textarea>
              <div class="alignment-control" role="group" aria-label="Text alignment">
                <button type="button" :aria-pressed="textSettings.alignment === 'left'" @click="textSettings.alignment = 'left'">Left</button>
                <button type="button" :aria-pressed="textSettings.alignment === 'center'" @click="textSettings.alignment = 'center'">Center</button>
                <button type="button" :aria-pressed="textSettings.alignment === 'right'" @click="textSettings.alignment = 'right'">Right</button>
              </div>
              <label class="slider-control"><span>Tracking <output>{{ Math.round(textSettings.tracking * 100) }}%</output></span><input v-model.number="textSettings.tracking" type="range" min="-0.08" max="0.3" step="0.005" /></label>
              <label class="slider-control"><span>Line height <output>{{ textSettings.lineHeight.toFixed(2) }}</output></span><input v-model.number="textSettings.lineHeight" type="range" min="0.8" max="1.8" step="0.02" /></label>
            </div>
          </details>

          <details class="inspector-section" open>
            <summary><span>Font</span><small>{{ selectedFont.style }}</small></summary>
            <div class="inspector-body">
              <label class="stacked-control"><span>Font face</span><select v-model="selectedFontId" :disabled="fontBusy" @change="handleFontChange"><option v-for="font in fontChoices" :key="font.id" :value="font.id">{{ font.label }} · {{ font.style }}</option></select></label>
              <button v-if="fontAccessSupported" type="button" class="wide-control primary-control" :disabled="fontBusy" @click="connectFonts">{{ fontBusy ? 'Loading fonts…' : 'Browse installed fonts' }}</button>
              <p class="inline-note" role="status">{{ fontStatus }}</p>
              <p class="inline-note">Fonts stay in this browser session and are never uploaded.</p>
            </div>
          </details>

          <details class="inspector-section" open>
            <summary><span>Sampling</span><small>{{ textSettings.resolution }} px</small></summary>
            <div class="inspector-body">
              <label class="slider-control"><span>Outline detail <output>{{ textSettings.resolution }}px</output></span><input v-model.number="textSettings.resolution" type="range" min="180" max="720" step="20" /></label>
              <p class="inline-note">Higher detail makes curves and counters cleaner.</p>
            </div>
          </details>
        </template>
      </aside>

      <section class="viewport-pane" aria-label="3D editor viewport">
        <div class="viewport-toolbar">
          <div class="view-switcher" role="group" aria-label="Viewport material">
            <button v-for="mode in activePreviewModes" :key="mode.value" type="button" :aria-pressed="colorMode === mode.value" @click="selectColorMode(mode.value)">{{ mode.label }}</button>
          </div>
          <div class="viewport-toolbar-meta"><span>{{ activeGeometry.label }}</span><span>{{ faceLabel }} tris</span></div>
          <button
            ref="backgroundTrigger"
            type="button"
            class="background-trigger"
            aria-haspopup="menu"
            aria-controls="viewport-background-menu"
            :aria-expanded="Boolean(backgroundMenuPosition)"
            :title="`Background: ${activeBackground.label} (W / G / B)`"
            @click="toggleBackgroundMenuFromTrigger"
          ><span class="background-trigger__swatch" :style="{ backgroundColor: activeBackground.color }" aria-hidden="true"></span><span class="background-label">Background</span></button>
        </div>

        <div
          ref="threeStage"
          class="three-stage"
          role="region"
          tabindex="0"
          aria-label="3D viewport. Right-click for background colors. Keyboard shortcuts: W for white, G for dark gray, B for black."
          aria-keyshortcuts="W G B"
          @pointerdown="focusThreeStage"
          @contextmenu.prevent.stop="openBackgroundMenu"
        >
          <ThreePreview
            ref="threePreview"
            :mesh="mesh"
            :color-mode="colorMode"
            :appearance="appearance"
            :background="viewportBackground"
            :interaction-locked="exportingImage && imageExportKind === 'loop'"
            :living-form="livingForm"
            :living-phase="livingPhase"
            @export-progress="handleImageExportProgress"
          />
          <div v-if="workspace === 'text' && (textBuilding || !mesh)" class="viewport-message" role="status">
            <span v-if="textBuilding" class="spinner" aria-hidden="true"></span>
            <strong>{{ textBuilding ? 'Building type…' : 'Type something to begin' }}</strong>
            <small v-if="textBuildError">{{ textBuildError }}</small>
          </div>
          <div
            v-if="backgroundMenuPosition"
            id="viewport-background-menu"
            ref="backgroundMenu"
            class="background-menu"
            :style="backgroundMenuStyle"
            role="menu"
            aria-label="Viewport background"
            @click.stop
            @keydown="handleBackgroundMenuKeydown"
            @contextmenu.prevent.stop
          >
            <p>Background</p>
            <button
              v-for="preset in VIEWPORT_BACKGROUNDS"
              :key="preset.value"
              type="button"
              role="menuitemradio"
              :data-background="preset.value"
              :aria-checked="viewportBackground === preset.value"
              :tabindex="viewportBackground === preset.value ? 0 : -1"
              @click="chooseViewportBackground(preset.value)"
            ><span class="background-menu__swatch" :style="{ backgroundColor: preset.color }" aria-hidden="true"></span><span>{{ preset.label }}</span><kbd>{{ preset.shortcut }}</kbd></button>
          </div>
          <div v-if="dragging" class="drop-curtain">Drop image</div>
        </div>
      </section>

      <aside class="editor-panel style-panel" aria-label="Style and export controls">
        <template v-if="!imageExportOpen">
          <div class="panel-title">
            <div><span class="panel-kicker">Inspector</span><h2>Properties</h2></div>
          </div>

          <details v-if="workspace === 'image'" class="inspector-section" open>
            <summary><span>Geometry</span><small>{{ activeGeometry.label }}</small></summary>
            <div class="inspector-body">
              <div class="segmented stacked" role="group" aria-label="Geometry mode">
                <button v-for="mode in geometryModes" :key="mode.value" type="button" :aria-pressed="meshSettings.mode === mode.value" @click="meshSettings.mode = mode.value"><span>{{ mode.label }}</span><small>{{ mode.note }}</small></button>
              </div>
              <label class="slider-control"><span>Depth <output>{{ meshSettings.depth.toFixed(2) }}</output></span><input v-model.number="meshSettings.depth" type="range" min="0.02" max="1.4" step="0.02" /></label>
              <label class="slider-control"><span>Midpoint <output>{{ meshSettings.midpoint.toFixed(2) }}</output></span><input v-model.number="meshSettings.midpoint" type="range" min="0" max="1" step="0.01" /></label>
              <label v-if="meshSettings.mode === 'solid'" class="slider-control"><span>Base thickness <output>{{ meshSettings.baseThickness.toFixed(2) }}</output></span><input v-model.number="meshSettings.baseThickness" type="range" min="0.06" max="0.8" step="0.02" /></label>
              <label class="slider-control"><span>Mesh detail <output>{{ meshSettings.resolution }}</output></span><input v-model.number="meshSettings.resolution" type="range" min="16" max="180" step="4" /></label>
            </div>
          </details>

          <details v-else class="inspector-section" open>
            <summary><span>Geometry</span><small>Beveled solid</small></summary>
            <div class="inspector-body">
              <label class="slider-control"><span>Extrusion <output>{{ textSettings.depth.toFixed(2) }}</output></span><input v-model.number="textSettings.depth" type="range" min="0.06" max="0.9" step="0.01" /></label>
              <label class="slider-control"><span>Bevel width <output>{{ textSettings.bevelSize.toFixed(3) }}</output></span><input v-model.number="textSettings.bevelSize" type="range" min="0" max="0.12" step="0.005" /></label>
              <label class="slider-control"><span>Bevel depth <output>{{ textSettings.bevelThickness.toFixed(3) }}</output></span><input v-model.number="textSettings.bevelThickness" type="range" min="0" max="0.12" step="0.005" /></label>
              <label class="slider-control"><span>Bevel smoothness <output>{{ textSettings.bevelSegments }}</output></span><input v-model.number="textSettings.bevelSegments" type="range" min="1" max="8" step="1" /></label>
            </div>
          </details>

          <details class="inspector-section" open>
            <summary><span>Surface</span><small>{{ (workspace === 'image' ? fieldSettings.finish : textSettings.finish) === 'blob' ? 'Blob' : 'Detail' }}</small></summary>
            <div class="inspector-body">
              <div class="segmented" role="group" aria-label="Surface finish">
                <button type="button" :aria-pressed="(workspace === 'image' ? fieldSettings.finish : textSettings.finish) === 'detail'" @click="workspace === 'image' ? fieldSettings.finish = 'detail' : textSettings.finish = 'detail'">Detail</button>
                <button type="button" :aria-pressed="(workspace === 'image' ? fieldSettings.finish : textSettings.finish) === 'blob'" @click="workspace === 'image' ? fieldSettings.finish = 'blob' : textSettings.finish = 'blob'">Blob</button>
              </div>
              <p class="inline-note">Blob expands forms and rounds sharp peaks into exaggerated organic surfaces.</p>
              <template v-if="workspace === 'image'">
                <template v-if="fieldSettings.finish === 'blob'">
                  <label class="slider-control"><span>Dilation <output>{{ fieldSettings.blobDilation }}px</output></span><input v-model.number="fieldSettings.blobDilation" type="range" min="0" max="20" step="1" /></label>
                  <label class="slider-control"><span>Smoothing <output>{{ fieldSettings.blobSmoothing }}px</output></span><input v-model.number="fieldSettings.blobSmoothing" type="range" min="0" max="24" step="1" /></label>
                </template>
                <label class="slider-control"><span>Base smoothing <output>{{ fieldSettings.blur }}px</output></span><input v-model.number="fieldSettings.blur" type="range" min="0" max="8" step="1" /></label>
                <label class="slider-control"><span>Contrast <output>{{ fieldSettings.contrast > 0 ? '+' : '' }}{{ fieldSettings.contrast }}</output></span><input v-model.number="fieldSettings.contrast" type="range" min="-50" max="50" step="1" /></label>
                <label class="slider-control"><span>Quantize <output>{{ fieldSettings.quantize < 2 ? 'Off' : fieldSettings.quantize }}</output></span><input v-model.number="fieldSettings.quantize" type="range" min="0" max="12" step="1" /></label>
                <label class="check-control"><input v-model="fieldSettings.invert" type="checkbox" />Invert composite</label>
              </template>
              <template v-else-if="textSettings.finish === 'blob'">
                <label class="slider-control"><span>Dilation <output>{{ textSettings.blobDilation }}px</output></span><input v-model.number="textSettings.blobDilation" type="range" min="0" max="20" step="1" /></label>
                <label class="slider-control"><span>Smoothing <output>{{ textSettings.blobSmoothing }}px</output></span><input v-model.number="textSettings.blobSmoothing" type="range" min="0" max="24" step="1" /></label>
              </template>
            </div>
          </details>

          <details class="inspector-section" open>
            <summary><span>Living Form</span><small :class="{ success: livingForm.enabled }">{{ livingFormStatus }}</small></summary>
            <div class="inspector-body">
              <label class="check-control"><input v-model="livingForm.enabled" type="checkbox" />Enable kinetic form</label>
              <div class="segmented motion-presets" role="group" aria-label="Living Form behavior">
                <button
                  v-for="behavior in livingFormBehaviors"
                  :key="behavior.value"
                  type="button"
                  :title="behavior.note"
                  :aria-pressed="livingForm.behavior === behavior.value"
                  @click="livingForm.behavior = behavior.value"
                >{{ behavior.label }}</button>
              </div>
              <p class="inline-note">{{ activeLivingBehavior.note }} Motion is procedural, deterministic, and closes on an exact seamless loop.</p>
              <label class="slider-control"><span>Intensity <output>{{ Math.round(livingForm.amount * 100) }}%</output></span><input v-model.number="livingForm.amount" aria-label="Living Form intensity" :aria-valuetext="`${Math.round(livingForm.amount * 100)}%`" type="range" min="0" max="1" step="0.01" /></label>
              <label class="slider-control"><span>Complexity <output>{{ livingForm.frequency.toFixed(2) }}</output></span><input v-model.number="livingForm.frequency" aria-label="Living Form complexity" :aria-valuetext="livingForm.frequency.toFixed(2)" type="range" min="0.25" max="5" step="0.05" /></label>
              <label class="slider-control"><span>Variation <output>{{ Math.round(livingForm.seed) }}</output></span><input v-model.number="livingForm.seed" aria-label="Living Form variation" :aria-valuetext="`${Math.round(livingForm.seed)}`" type="range" min="0" max="100" step="1" /></label>
              <label class="slider-control"><span>Loop duration <output>{{ livingForm.duration.toFixed(1) }}s</output></span><input v-model.number="livingForm.duration" aria-label="Living Form loop duration" :aria-valuetext="`${livingForm.duration.toFixed(1)} seconds`" type="range" min="1" max="12" step="0.5" /></label>
              <div class="living-transport">
                <button type="button" class="primary-control" :aria-pressed="livingPlaying" :disabled="!hasModel" @click="toggleLivingFormPlayback">{{ livingPlaying ? 'Pause' : 'Play' }}</button>
                <button type="button" :disabled="!hasModel" @click="restartLivingForm">Restart</button>
              </div>
              <label class="slider-control"><span>Phase <output>{{ Math.round(livingPhase * 100) }}%</output></span><input v-model.number="livingPhase" aria-label="Living Form phase" :aria-valuetext="`${Math.round(livingPhase * 100)}%`" type="range" min="0" max="0.999" step="0.001" @input="pauseLivingFormForScrub" /></label>
            </div>
          </details>

          <details class="inspector-section" open>
            <summary><span>Material</span><small>{{ colorMode === 'clay' ? appearance.clay.finish : colorMode }}</small></summary>
            <div class="inspector-body">
              <template v-if="colorMode === 'clay'">
                <label class="color-control"><span>Color</span><div><input v-model="appearance.clay.color" type="color" aria-label="Material color" /><output>{{ appearance.clay.color }}</output></div></label>
                <div class="segmented" role="group" aria-label="Material finish"><button v-for="finish in clayFinishes" :key="finish.value" type="button" :aria-pressed="appearance.clay.finish === finish.value" @click="appearance.clay.finish = finish.value">{{ finish.label }}</button></div>
              </template>
              <template v-else-if="colorMode === 'height'">
                <div class="gradient-preview" :style="gradientPreviewStyle" aria-hidden="true"></div>
                <div class="color-grid">
                  <label><span>Low</span><input v-model="appearance.heightGradient.low" type="color" /></label>
                  <label><span>Mid</span><input v-model="appearance.heightGradient.mid" type="color" /></label>
                  <label><span>High</span><input v-model="appearance.heightGradient.high" type="color" /></label>
                </div>
                <label class="slider-control"><span>Midpoint <output>{{ Math.round(appearance.heightGradient.midpoint * 100) }}%</output></span><input v-model.number="appearance.heightGradient.midpoint" type="range" min="0.05" max="0.95" step="0.01" /></label>
              </template>
              <p v-else class="inline-note">Switch to {{ workspace === 'text' ? 'Material' : 'Clay' }} to edit color and finish.</p>
            </div>
          </details>

          <details v-if="workspace === 'image'" class="inspector-section">
            <summary><span>Reference maps</span><small>{{ image.width }} × {{ image.height }}</small></summary>
            <div class="inspector-body map-stack"><figure><figcaption>Source</figcaption><canvas ref="sourceCanvas" aria-label="Source image preview" /></figure><figure><figcaption>Height field</figcaption><canvas ref="heightCanvas" aria-label="Computed height field preview" /></figure></div>
          </details>

          <details class="inspector-section">
            <summary><span>Mesh health</span><small :class="{ success: topology?.watertight }">{{ topology?.watertight ? 'Ready' : hasModel ? 'Open' : 'Empty' }}</small></summary>
            <div v-if="topology" class="inspector-body health-grid">
              <div><span>Vertices</span><strong>{{ topology.vertices.toLocaleString() }}</strong></div>
              <div><span>Faces</span><strong>{{ topology.faces.toLocaleString() }}</strong></div>
              <div><span>Loops</span><strong>{{ topology.boundaryLoops }}</strong></div>
              <div><span>Components</span><strong>{{ topology.connectedComponents }}</strong></div>
              <div><span>Boundary edges</span><strong>{{ topology.boundaryEdges }}</strong></div>
              <div><span>Non-manifold</span><strong>{{ topology.nonManifoldEdges }}</strong></div>
              <div><span>Degenerate</span><strong>{{ topology.degenerateFaces }}</strong></div>
              <p>{{ topology.watertight ? 'Closed geometry, ready for STL.' : 'STL needs closed geometry. GLB and PNG remain available.' }}</p>
            </div>
          </details>
        </template>

        <section v-else id="export-inspector" class="export-inspector" :aria-busy="exportingImage || exportingBlenderProject">
          <div class="panel-title export-title"><div><span class="panel-kicker">Output</span><h2>Export model</h2></div><button type="button" class="icon-control" :disabled="exportingImage || exportingBlenderProject" aria-label="Close export" @click="imageExportOpen = false">×</button></div>
          <fieldset class="export-group"><legend>Output</legend><div class="segmented cards"><button type="button" :aria-pressed="imageExportKind === 'still'" :disabled="exportingImage" @click="imageExportKind = 'still'; imageExportError = ''; imageExportNotice = ''"><strong>Still</strong><small>PNG image</small></button><button type="button" :aria-pressed="imageExportKind === 'loop'" :disabled="exportingImage" @click="imageExportKind = 'loop'; imageExportError = ''; imageExportNotice = ''"><strong>Living loop</strong><small>PNG sequence</small></button></div></fieldset>

          <template v-if="imageExportKind === 'still'">
            <div class="export-summary">{{ imageExportSummary }}</div>
            <fieldset v-if="workspace === 'image'" class="export-group"><legend>View</legend><div class="segmented cards"><button type="button" :aria-pressed="imageExportView === 'current'" :disabled="exportingImage" @click="selectImageExportView('current')"><strong>Current view</strong><small>Orbit &amp; zoom</small></button><button type="button" :aria-pressed="imageExportView === 'straight-on'" :disabled="exportingImage" @click="selectImageExportView('straight-on')"><strong>Straight on</strong><small>Front face · original size</small></button></div></fieldset>
            <fieldset class="export-group"><legend>Render quality</legend><div :class="['segmented', 'cards', 'render-quality-cards', { 'has-pro': desktopProBridgeAvailable }]"><button type="button" :aria-pressed="imageExportQuality === 'high'" :disabled="exportingImage" @click="selectImageExportQuality('high')"><strong>High</strong><small>Clean and quick</small></button><button type="button" :aria-pressed="imageExportQuality === 'final'" :disabled="exportingImage || colorMode === 'wireframe' || straightOnExceedsFourK" :title="straightOnExceedsFourK ? 'Final supports up to 4K. Choose High for exact original dimensions.' : 'Path-traced Final render'" @click="selectImageExportQuality('final')"><strong>Final</strong><small>Refined light</small></button><button v-if="desktopProBridgeAvailable" type="button" :aria-pressed="imageExportQuality === 'pro'" :disabled="exportingImage || colorMode === 'wireframe' || !desktopProReady || straightOnExceedsFourK" :title="straightOnExceedsFourK ? 'Cycles Pro supports up to 4K. Choose High for exact original dimensions.' : desktopProReady ? 'Blender Cycles Pro' : desktopProStatus" @click="selectImageExportQuality('pro')"><strong>Pro</strong><small>{{ desktopProProbePending ? 'Checking Blender' : desktopProReady ? 'Cycles · PNG + EXR' : 'Unavailable' }}</small></button></div></fieldset>
            <fieldset v-if="effectiveImageExportView === 'straight-on'" class="export-group"><legend>Dimensions</legend><output class="source-dimensions"><span>Original image</span><strong>{{ imageExportDimensions.width.toLocaleString() }} × {{ imageExportDimensions.height.toLocaleString() }} px</strong></output></fieldset>
            <fieldset v-else class="export-group"><legend>Long edge</legend><div class="segmented"><button type="button" :aria-pressed="imageExportLongEdge === 2048" :disabled="exportingImage" @click="imageExportLongEdge = 2048">2K</button><button type="button" :aria-pressed="imageExportLongEdge === 4096" :disabled="exportingImage" @click="imageExportLongEdge = 4096">4K</button><button type="button" :aria-pressed="imageExportLongEdge === 8192" :disabled="exportingImage || imageExportQuality !== 'high'" @click="imageExportLongEdge = 8192">8K</button></div></fieldset>
            <fieldset class="export-group"><legend>Background</legend><div class="segmented cards"><button type="button" :aria-pressed="imageExportBackground === 'transparent'" :disabled="exportingImage" @click="imageExportBackground = 'transparent'">Transparent</button><button type="button" :aria-pressed="imageExportBackground === 'studio'" :disabled="exportingImage" @click="imageExportBackground = 'studio'">Current<small>{{ activeBackground.label }}</small></button></div></fieldset>
            <details v-if="imageExportQuality === 'pro'" class="pro-render-controls">
              <summary><span>Advanced Cycles controls</span><small>{{ proRenderSettingsAreProduction ? 'Production' : 'Custom' }}</small></summary>
              <div class="pro-render-controls__body">
                <p class="pro-render-status">{{ desktopProStatus }}</p>
                <label class="slider-control"><span>Maximum samples <output>{{ proRenderSettings.maxSamples.toLocaleString() }}</output></span><input v-model.number="proRenderSettings.maxSamples" type="range" min="64" max="8192" step="64" :disabled="exportingImage" /></label>
                <label class="slider-control"><span>Minimum samples <output>{{ proRenderSettings.minSamples.toLocaleString() }}</output></span><input v-model.number="proRenderSettings.minSamples" type="range" min="64" :max="proRenderSettings.maxSamples" step="64" :disabled="exportingImage" /></label>
                <label class="slider-control"><span>Noise threshold <output>{{ proRenderSettings.noiseThreshold.toFixed(3) }}</output></span><input v-model.number="proRenderSettings.noiseThreshold" type="range" min="0.001" max="0.05" step="0.001" :disabled="exportingImage" /></label>
                <label class="slider-control"><span>Light bounces <output>{{ proRenderSettings.maxBounces }}</output></span><input v-model.number="proRenderSettings.maxBounces" type="range" min="2" max="16" step="1" :disabled="exportingImage" /></label>
                <label class="check-control"><input v-model="proRenderSettings.denoise" type="checkbox" :disabled="exportingImage" />OpenImageDenoise final pass</label>
                <button type="button" class="pro-production-reset" :disabled="exportingImage || proRenderSettingsAreProduction" @click="resetProRenderSettings">Reset production preset</button>
              </div>
            </details>
            <p class="inline-note">{{ imageExportHelp }}</p>
          </template>

          <template v-else>
            <div class="export-summary">{{ livingLoopSummary }}</div>
            <fieldset class="export-group"><legend>Render quality</legend><div class="segmented cards"><button type="button" aria-pressed="true" disabled><strong>High 2×</strong><small>Lossless frames</small></button><button type="button" aria-pressed="false" disabled><strong>Final</strong><small>Still images only</small></button></div></fieldset>
            <fieldset class="export-group"><legend>Long edge</legend><div class="segmented cards"><button type="button" :aria-pressed="livingLoopLongEdge === 2048" :disabled="exportingImage" @click="livingLoopLongEdge = 2048">2K</button><button type="button" :aria-pressed="livingLoopLongEdge === 4096" :disabled="exportingImage" @click="livingLoopLongEdge = 4096">4K</button></div></fieldset>
            <fieldset class="export-group"><legend>Frame rate</legend><div class="segmented"><button v-for="fps in LIVING_FORM_FRAME_RATES" :key="fps" type="button" :aria-pressed="livingLoopFps === fps" :disabled="exportingImage" @click="livingLoopFps = fps">{{ fps }} fps</button></div></fieldset>
            <fieldset class="export-group"><legend>Timing</legend><label class="slider-control"><span>Duration <output>{{ displayLivingLoopRequest.settings.duration.toFixed(1) }}s · {{ displayLivingLoopRequest.frameCount }} frames</output></span><input v-model.number="livingForm.duration" aria-label="Living Loop duration" :aria-valuetext="`${displayLivingLoopRequest.settings.duration.toFixed(1)} seconds, ${displayLivingLoopRequest.frameCount} frames`" type="range" min="1" max="12" step="0.5" :disabled="exportingImage" /></label></fieldset>
            <fieldset class="export-group"><legend>Background</legend><div class="segmented cards"><button type="button" :aria-pressed="imageExportBackground === 'transparent'" :disabled="exportingImage" @click="imageExportBackground = 'transparent'">Transparent</button><button type="button" :aria-pressed="imageExportBackground === 'studio'" :disabled="exportingImage" @click="imageExportBackground = 'studio'">Current<small>{{ viewportBackgroundPreset(displayLivingLoopRequest.studioBackground).label }}</small></button></div></fieldset>
            <p class="inline-note">{{ livingLoopHelp }}</p>
            <p v-if="!livingForm.enabled" class="export-message error" role="alert">Enable Living Form in Properties to export a loop.</p>
          </template>

          <div v-if="exportingImage" class="render-progress"><span>{{ imageExportKind === 'loop' ? livingLoopProgressLabel : imageExportProgressLabel }}</span><progress :value="imageExportKind === 'loop' ? livingLoopProgressBarValue : imageExportProgressBarValue" max="1" :aria-label="imageExportKind === 'loop' ? 'Living Form export progress' : 'Image export progress'" :aria-valuetext="imageExportKind === 'loop' ? livingLoopProgressLabel : imageExportProgressLabel"></progress><button type="button" :disabled="livingLoopNativeSaving" @click="cancelImageExport">{{ livingLoopNativeSaving ? 'Saving…' : 'Cancel' }}</button></div>
          <p class="sr-only" aria-live="polite">{{ imageExportAnnouncement }}</p>
          <p v-if="imageExportError" class="export-message error" role="alert">{{ imageExportError }}</p>
          <p v-else-if="imageExportNotice" class="export-message" role="status">{{ imageExportNotice }}</p>
          <button v-if="imageExportKind === 'still'" type="button" class="render-button" :disabled="imageExportUnsupported || !hasModel || exportingBlenderProject" @click="downloadImagePng">{{ imageExportActionLabel }}</button>
          <button v-else type="button" class="render-button" :disabled="livingLoopNativeSaving || !hasModel || !livingForm.enabled || exportingBlenderProject" @click="downloadLivingFormLoop">{{ livingLoopNativeSaving ? 'Saving ZIP…' : exportingImage ? 'Cancel sequence' : 'Export lossless loop ZIP' }}</button>

          <div class="file-export-section">
            <h3>3D &amp; project files</h3>
            <button type="button" :disabled="exporting || exportingImage || exportingBlenderProject || !hasModel" @click="downloadGlb">{{ exporting ? 'Preparing exact GLB…' : 'Exact GLB · portable mesh' }}</button>

            <details v-if="desktopBlenderBridgeAvailable" ref="blenderExportDetails" class="blender-export-controls" @toggle="keepBlenderExportAccordionOpen">
              <summary><span>Blender project</span><small>{{ activeBlenderTopology.label }} · .blend</small></summary>
              <div class="blender-export-controls__body">
                <fieldset class="export-group blender-topology-group">
                  <legend>Topology</legend>
                  <div class="segmented cards blender-topology-cards">
                    <button v-for="option in blenderTopologyOptions" :key="option.value" type="button" :aria-pressed="blenderExportTopology === option.value" :disabled="exportingBlenderProject" @click="blenderExportTopology = option.value; blenderExportError = ''; blenderExportNotice = ''"><strong>{{ option.label }}</strong><small>{{ option.note }}</small></button>
                  </div>
                </fieldset>
                <p id="blender-export-help" class="blender-export-help">{{ blenderExportHelp }}</p>
                <div v-if="exportingBlenderProject" class="render-progress blender-export-progress" role="status" aria-live="polite" aria-atomic="true"><span>{{ blenderExportProgressLabel }}</span><progress aria-label="Blender project export progress"></progress><button type="button" @click="downloadBlenderProject">Cancel</button></div>
                <p v-if="blenderExportError" class="export-message error" role="alert">{{ blenderExportError }}</p>
                <p v-else-if="blenderExportNotice" class="export-message" role="status">{{ blenderExportNotice }}</p>
                <button type="button" class="blender-export-button" aria-describedby="blender-export-help" :disabled="!hasModel || !desktopProReady || colorMode === 'wireframe' || exporting || exportingImage" @click="downloadBlenderProject">{{ exportingBlenderProject ? 'Cancel Blender export' : 'Save Blender project (.blend)' }}</button>
              </div>
            </details>
            <p v-else class="blender-export-help blender-export-help--web">{{ blenderExportHelp }}</p>

            <button type="button" :disabled="exportingImage || exportingBlenderProject || !topology?.watertight" @click="downloadStl">STL geometry</button>
            <button v-if="workspace === 'image'" type="button" :disabled="exportingImage || exportingBlenderProject" @click="exportHeightPng(heightField)">Height PNG</button>
            <button type="button" :disabled="exportingImage || exportingBlenderProject" @click="exportRecipe(workspace === 'image' ? recipe() : textRecipe())">Recipe JSON</button>
          </div>
        </section>
      </aside>
    </div>

    <footer class="status-bar">
      <span>{{ status }}</span>
      <span v-if="textBuilding && workspace === 'text'">Updating geometry…</span>
      <span v-else>{{ topology?.watertight ? 'Closed mesh' : hasModel ? 'Open mesh' : 'No model' }} · {{ faceLabel }} triangles</span>
      <span class="shortcut-hint">Right-click · W / G / B background</span>
    </footer>
  </main>

</template>
