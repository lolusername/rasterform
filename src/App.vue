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
import { inspectTopology } from './lib/topology'
import { downloadBlob, exportGlb, exportHeightPng, exportRecipe, exportStl } from './lib/export'
import {
  finalSampleTarget,
  type FinalExportProgress,
  type FinalImagePngResult,
} from './lib/final-image-export'
import { createDefaultAppearanceSettings } from './lib/three'
import { calculateViewportDimensions, type ViewportPngResult } from './lib/viewport-export'
import { fitViewportFrame } from './lib/viewport-frame'
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
  MeshSettings,
  Recipe,
  ViewportBackground,
} from './types'

interface ThreePreviewHandle {
  captureHighPng: (
    dimensions: { width: number; height: number },
    background: ImageExportBackground,
  ) => Promise<ViewportPngResult>
  captureFinalPng: (
    dimensions: { width: number; height: number },
    background: ImageExportBackground,
  ) => Promise<FinalImagePngResult>
  cancelImageExport: () => void
}

interface ImageExportRequestSnapshot {
  dimensions: { width: number; height: number }
  quality: ImageExportQuality
  background: ImageExportBackground
  viewportBackground: ViewportBackground
  colorMode: ColorMode
  samples: number
}

const image = shallowRef(createDemoImage())
const threePreview = ref<ThreePreviewHandle | null>(null)
const sourceCanvas = ref<HTMLCanvasElement | null>(null)
const heightCanvas = ref<HTMLCanvasElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const threeStage = ref<HTMLElement | null>(null)
const backgroundMenu = ref<HTMLDivElement | null>(null)
const backgroundTrigger = ref<HTMLButtonElement | null>(null)
const status = ref('Demo image · 360 × 270')
const exporting = ref(false)
const dragging = ref(false)
const colorMode = ref<ColorMode>('original')
const imageExportOpen = ref(false)
const exportingImage = ref(false)
const imageExportQuality = ref<ImageExportQuality>('high')
const imageExportLongEdge = ref<ImageExportLongEdge>(4096)
const imageExportBackground = ref<ImageExportBackground>('transparent')
const imageExportError = ref('')
const imageExportNotice = ref('')
const imageExportAnnouncement = ref('')
const activeImageExportRequest = shallowRef<ImageExportRequestSnapshot | null>(null)
const BACKGROUND_STORAGE_KEY = 'rasterform:viewport-background'
const stageBounds = reactive({ width: 1, height: 1 })
let stageResizeObserver: ResizeObserver | null = null

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
const appearance = reactive<AppearanceSettings>(createDefaultAppearanceSettings())
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
  { value: 'plane', label: 'Raised plane', note: 'Open surface · zero at base' },
  { value: 'centered', label: 'Centered plane', note: 'Open surface · midpoint at zero' },
  { value: 'solid', label: 'Solid tile', note: 'Closed back and sides' },
]

const previewModes: Array<{ value: ColorMode; label: string }> = [
  { value: 'original', label: 'Photo' },
  { value: 'height', label: 'Height' },
  { value: 'clay', label: 'Clay' },
  { value: 'wireframe', label: 'Wireframe' },
]

const clayFinishes: Array<{ value: ClayFinish; label: string }> = [
  { value: 'matte', label: 'Matte' },
  { value: 'glossy', label: 'Glossy' },
  { value: 'metallic', label: 'Metallic' },
]

const gradientPreviewStyle = computed(() => ({
  background: `linear-gradient(90deg, ${appearance.heightGradient.low} 0%, ${appearance.heightGradient.mid} ${Math.round(appearance.heightGradient.midpoint * 100)}%, ${appearance.heightGradient.high} 100%)`,
}))
const activeBackground = computed(() => viewportBackgroundPreset(viewportBackground.value))
const backgroundMenuStyle = computed(() => backgroundMenuPosition.value
  ? {
      left: `${backgroundMenuPosition.value.x}px`,
      top: `${backgroundMenuPosition.value.y}px`,
    }
  : undefined)
const imageExportDimensions = computed(() => calculateViewportDimensions(
  image.value.width,
  image.value.height,
  imageExportLongEdge.value,
))
const displayImageExportRequest = computed<ImageExportRequestSnapshot>(() =>
  activeImageExportRequest.value ?? {
    dimensions: imageExportDimensions.value,
    quality: imageExportQuality.value,
    background: imageExportBackground.value,
    viewportBackground: viewportBackground.value,
    colorMode: colorMode.value,
    samples: imageExportQuality.value === 'final'
      ? finalSampleTarget(colorMode.value, appearance)
      : 1,
  })
const exportPreviewFrameStyle = computed(() => {
  if (!imageExportOpen.value) return undefined
  const frame = fitViewportFrame(
    image.value.width / image.value.height,
    stageBounds.width,
    stageBounds.height,
  )
  return {
    width: `${frame.width}px`,
    height: `${frame.height}px`,
  }
})
const imageExportUnsupported = computed(() => {
  const request = displayImageExportRequest.value
  return request.quality === 'final'
    && (request.colorMode === 'wireframe' || Math.max(request.dimensions.width, request.dimensions.height) > 4096)
})
const imageExportSummary = computed(() => {
  const request = displayImageExportRequest.value
  const { width, height } = request.dimensions
  const background = request.background === 'transparent'
    ? 'transparent'
    : `${viewportBackgroundPreset(request.viewportBackground).label.toLowerCase()} background`
  const quality = request.quality === 'final' ? 'Final' : 'High'
  return `${quality} · ${width.toLocaleString()} × ${height.toLocaleString()} px · ${background} PNG`
})
const imageExportHelp = computed(() => {
  const request = displayImageExportRequest.value
  if (request.colorMode === 'wireframe') return 'Wireframe exports use High quality.'
  if (request.quality === 'high') return 'Clean 2× edge smoothing. Renders from a background snapshot so you can keep using the studio.'
  if (Math.max(request.dimensions.width, request.dimensions.height) > 4096) return '8K Final is too large for a reliable browser render. Choose 4K or High quality.'
  return `Refined light and shadows · ${request.samples} samples with gentle denoising · background snapshot rendering keeps the studio responsive.`
})
const imageExportProgressLabel = computed(() => {
  if (imageExportProgress.phase === 'preparing') return `Preparing geometry · ${Math.round(imageExportProgress.progress * 100)}%`
  if (imageExportProgress.phase === 'finishing') return 'Finishing PNG…'
  if (displayImageExportRequest.value.quality === 'high') return `Rendering supersampled tiles · ${Math.round(imageExportProgress.progress * 100)}%`
  if (imageExportProgress.samples === 0) return 'Preparing Final renderer…'
  return `Refining light and shadows · ${Math.round(imageExportProgress.progress * 100)}%`
})

const rawField = computed(() => composeChannelStack(image.value, channelLayers))
const heightField = computed(() => processScalarField(rawField.value, fieldSettings))
const mesh = computed(() => buildMesh(heightField.value, image.value, meshSettings))
const topology = computed(() => inspectTopology(mesh.value))
const activeGeometry = computed(() => geometryModes.find((mode) => mode.value === meshSettings.mode)!)
const faceLabel = computed(() => topology.value.faces.toLocaleString())
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
  const focused = document.activeElement
  const shortcutIsScoped = focused === threeStage.value
    || focused === backgroundTrigger.value
    || (focused instanceof Node && Boolean(backgroundMenu.value?.contains(focused)))
  if (!shortcutIsScoped) return
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

function updateStageBounds() {
  if (!threeStage.value) return
  stageBounds.width = Math.max(1, threeStage.value.clientWidth)
  stageBounds.height = Math.max(1, threeStage.value.clientHeight)
}

onMounted(() => {
  window.addEventListener('keydown', handleGlobalKeydown)
  window.addEventListener('resize', handleWindowResize)
  document.addEventListener('pointerdown', handleDocumentPointerDown)
  document.addEventListener('focusin', handleDocumentFocusIn)
  stageResizeObserver = new ResizeObserver(updateStageBounds)
  if (threeStage.value) stageResizeObserver.observe(threeStage.value)
  updateStageBounds()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleGlobalKeydown)
  window.removeEventListener('resize', handleWindowResize)
  document.removeEventListener('pointerdown', handleDocumentPointerDown)
  document.removeEventListener('focusin', handleDocumentFocusIn)
  stageResizeObserver?.disconnect()
  stageResizeObserver = null
})

watch(viewportBackground, (background) => {
  try {
    window.localStorage.setItem(BACKGROUND_STORAGE_KEY, background)
  } catch {
    // Background switching remains available when storage is blocked.
  }
})

watch(exportingImage, (isExporting) => {
  if (isExporting) closeBackgroundMenu()
})

function selectColorMode(mode: ColorMode) {
  if (mode === 'wireframe' && imageExportQuality.value === 'final' && !exportingImage.value) {
    imageExportQuality.value = 'high'
    imageExportNotice.value = 'Wireframe exports use High quality.'
  }
  colorMode.value = mode
}

function selectImageExportQuality(quality: ImageExportQuality) {
  if (quality === 'final' && colorMode.value === 'wireframe') {
    imageExportNotice.value = 'Wireframe exports use High quality.'
    return
  }
  if (quality === 'final' && imageExportLongEdge.value === 8192) {
    imageExportLongEdge.value = 4096
    imageExportNotice.value = 'Final supports up to 4K; size changed to 4K.'
  } else {
    imageExportNotice.value = ''
  }
  imageExportQuality.value = quality
  imageExportError.value = ''
}

let lastAnnouncedPhase: FinalExportProgress['phase'] | '' = ''
let lastAnnouncedBucket = -1

function handleImageExportProgress(progress: FinalExportProgress) {
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
  if (heightCanvas.value) drawScalarField(heightCanvas.value, heightField.value)
}

watch([image, heightField], updateCanvases, { immediate: true })

async function openFile(file?: File) {
  if (!file) return
  try {
    image.value = await fileToPixelImage(file)
    status.value = `${file.name} · ${image.value.width} × ${image.value.height}`
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
  void openFile(event.dataTransfer?.files?.[0])
}

function resetDemo() {
  image.value = createDemoImage()
  status.value = 'Demo restored'
}

function recipe(): Recipe {
  return {
    version: 4,
    app: 'Rasterform',
    image: { name: image.value.name, width: image.value.width, height: image.value.height },
    channels: channelLayers.map((layer) => ({ ...layer })),
    field: { ...fieldSettings },
    mesh: { ...meshSettings },
    appearance: {
      heightGradient: { ...appearance.heightGradient },
      clay: { ...appearance.clay },
    },
    createdAt: new Date().toISOString(),
  }
}

async function downloadGlb() {
  exporting.value = true
  status.value = 'Exporting GLB…'
  try {
    await exportGlb(mesh.value, colorMode.value, appearance)
    status.value = 'GLB exported for Blender / Cycles'
  } catch (error) {
    status.value = error instanceof Error ? error.message : 'GLB export failed.'
  } finally {
    exporting.value = false
  }
}

function downloadStl() {
  if (!topology.value.watertight) return
  exportStl(mesh.value)
  status.value = 'STL exported · geometry only'
}

function cancelImageExport() {
  threePreview.value?.cancelImageExport()
  imageExportNotice.value = 'Cancelling image export…'
}

function friendlyImageExportError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return ''
  const message = error instanceof Error ? error.message : ''
  if (message.includes('8K Final')) return 'Final quality supports up to 4K. Choose 4K or use High quality for 8K.'
  if (message.includes('canvas') || message.includes('size')) return 'This image is too large for the device. Choose 2K or use High quality.'
  if (message.includes('context') || message.includes('progress')) return 'Final rendering stopped on this device. Your design is safe; try again or use High quality.'
  if (message.includes('Transparency check failed')) return 'The transparency check failed, so Rasterform did not save a bad file. Try High quality.'
  return 'Image export could not finish on this device. Your design is safe; try High quality or a smaller size.'
}

async function downloadImagePng() {
  if (!threePreview.value) return
  if (exportingImage.value) {
    cancelImageExport()
    return
  }
  if (imageExportUnsupported.value) return
  const request: ImageExportRequestSnapshot = {
    dimensions: { ...imageExportDimensions.value },
    quality: imageExportQuality.value,
    background: imageExportBackground.value,
    viewportBackground: viewportBackground.value,
    colorMode: colorMode.value,
    samples: imageExportQuality.value === 'final'
      ? finalSampleTarget(colorMode.value, appearance)
      : 1,
  }
  activeImageExportRequest.value = request
  exportingImage.value = true
  imageExportError.value = ''
  imageExportNotice.value = ''
  imageExportAnnouncement.value = request.quality === 'final' ? 'Preparing final image.' : 'Rendering image.'
  lastAnnouncedPhase = ''
  lastAnnouncedBucket = -1
  Object.assign(imageExportProgress, {
    phase: request.quality === 'final' ? 'preparing' : 'rendering',
    progress: 0,
    tile: 0,
    tiles: 0,
    samples: 0,
    targetSamples: request.samples,
  } satisfies FinalExportProgress)
  try {
    const result = request.quality === 'final'
      ? await threePreview.value.captureFinalPng(request.dimensions, request.background)
      : await threePreview.value.captureHighPng(request.dimensions, request.background)
    const view = previewModes.find((mode) => mode.value === request.colorMode)?.label.toLowerCase() ?? request.colorMode
    const background = request.background === 'transparent' ? 'transparent' : request.viewportBackground
    const quality = request.quality === 'final' ? 'final' : 'high'
    downloadBlob(`rasterform-${view}-${quality}-${result.width}x${result.height}-${background}.png`, result.blob)
    const sampleDetail = 'samples' in result ? ` · ${result.samples} samples` : ' · 2× edge smoothing'
    status.value = `PNG · ${result.width} × ${result.height}${sampleDetail} · ${background} · ${result.dpi} PPI`
    imageExportNotice.value = `PNG download started · ${result.width.toLocaleString()} × ${result.height.toLocaleString()}.`
  } catch (error) {
    const friendly = friendlyImageExportError(error)
    if (friendly) imageExportError.value = friendly
    else imageExportNotice.value = 'Image export cancelled.'
  } finally {
    exportingImage.value = false
    activeImageExportRequest.value = null
    if (colorMode.value === 'wireframe' && imageExportQuality.value === 'final') {
      imageExportQuality.value = 'high'
    }
  }
}
</script>

<template>
  <main
    :class="['studio', { 'is-dragging': dragging, 'is-exporting-image': exportingImage }]"
    @dragenter.prevent="dragging = true"
    @dragover.prevent="dragging = true"
    @dragleave.self.prevent="dragging = false"
    @drop.prevent="handleDrop"
  >
    <header class="tool-header">
      <h1>Rasterform</h1>
      <span>Relief studio</span>
    </header>

    <div class="workbench">
      <aside class="control-rail" aria-label="Rasterform controls">
        <details class="control-section" name="control-rail">
          <summary class="section-summary">
            <span class="section-summary__title" role="heading" aria-level="2">Image</span>
            <span class="section-summary__meta">{{ image.name }}</span>
          </summary>
          <div class="section-body">
            <p>{{ image.name }} · {{ image.width }} × {{ image.height }}</p>
            <input ref="fileInput" class="sr-only" type="file" accept="image/png,image/jpeg,image/webp" @change="handleFile" />
            <div class="button-row">
              <button type="button" class="text-button" @click="fileInput?.click()">Open image</button>
              <button type="button" class="text-button" @click="resetDemo">Use demo</button>
            </div>
          </div>
        </details>

        <details class="control-section" name="control-rail" open>
          <summary class="section-summary">
            <span class="section-summary__title" role="heading" aria-level="2">Channel stack</span>
            <span class="section-summary__meta">{{ stackSummary }}</span>
          </summary>
          <div class="section-body">
            <div class="preset-row" role="group" aria-label="Channel stack presets">
              <button
                v-for="preset in stackPresets"
                :key="preset.key"
                type="button"
                :aria-label="`${preset.label}: ${preset.note}`"
                @click="applyPreset(preset)"
              >
                {{ preset.label }}
              </button>
            </div>

            <ol class="channel-stack" aria-label="Ordered image channel layers">
              <li
                v-for="(layer, index) in channelLayers"
                :key="layer.id"
                :class="['channel-layer', { 'is-muted': !layer.enabled, 'is-selected': layer.id === selectedChannelId }]"
              >
                <div class="channel-layer__row">
                  <label class="channel-toggle">
                    <input v-model="layer.enabled" type="checkbox" />
                    <span class="sr-only">Include {{ sourceLabel(layer.source) }} in the composite</span>
                  </label>
                  <button
                    type="button"
                    class="channel-layer__select"
                    :aria-pressed="layer.id === selectedChannelId"
                    @click="selectedChannelId = layer.id"
                  >
                    <span>CH {{ String(index + 1).padStart(2, '0') }}</span>
                    <strong>{{ sourceLabel(layer.source) }}</strong>
                    <small>{{ layer.id === baseLayerId ? 'Base' : blendLabel(layer.blend) }} · {{ Math.round(layer.amount * 100) }}%</small>
                  </button>
                  <div class="channel-layer__actions">
                    <button type="button" :disabled="index === 0" :aria-label="`Move ${sourceLabel(layer.source)} up`" @click="moveChannel(index, -1)">↑</button>
                    <button type="button" :disabled="index === channelLayers.length - 1" :aria-label="`Move ${sourceLabel(layer.source)} down`" @click="moveChannel(index, 1)">↓</button>
                    <button type="button" :disabled="channelLayers.length === 1" :aria-label="`Remove ${sourceLabel(layer.source)}`" @click="removeChannel(index)">×</button>
                  </div>
                </div>
              </li>
            </ol>

            <button type="button" class="add-channel" :disabled="channelLayers.length >= 5" @click="addChannel">
              {{ channelLayers.length >= 5 ? 'Five-channel limit' : '+ Add channel' }}
            </button>

            <fieldset v-if="selectedChannel" class="channel-inspector">
              <legend>Selected / CH {{ String(selectedChannelIndex + 1).padStart(2, '0') }}</legend>
                <label>
                  <span>Image property</span>
                  <select v-model="selectedChannel.source">
                    <option v-for="source in heightSources" :key="source.value" :value="source.value">{{ source.label }}</option>
                  </select>
                </label>
                <label v-if="selectedChannel.id !== baseLayerId">
                  <span>Combine</span>
                  <select v-model="selectedChannel.blend" :disabled="!selectedChannel.enabled">
                    <option v-for="mode in blendModes" :key="mode.value" :value="mode.value">{{ mode.label }}</option>
                  </select>
                </label>
                <label>
                  <span>Influence <output>{{ Math.round(selectedChannel.amount * 100) }}%</output></span>
                  <input v-model.number="selectedChannel.amount" type="range" min="0" max="1" step="0.01" />
                </label>
                <label v-if="selectedChannel.source === 'hue'">
                  <span>Target hue <output>{{ Math.round(selectedChannel.hueOrigin * 360) }}°</output></span>
                  <input v-model.number="selectedChannel.hueOrigin" type="range" min="0" max="1" step="0.005" />
                  <small>Circular hue distance; gray maps to zero.</small>
                </label>
                <label class="check-label channel-invert"><input v-model="selectedChannel.invert" type="checkbox" /> Invert this channel</label>
            </fieldset>

            <h3 class="composite-heading">Composite finish</h3>
            <div class="composite-finish-switcher" role="group" aria-label="Composite surface finish" aria-describedby="blob-mode-help">
              <button type="button" :aria-pressed="fieldSettings.finish === 'detail'" @click="fieldSettings.finish = 'detail'">
                Detail
              </button>
              <button type="button" :aria-pressed="fieldSettings.finish === 'blob'" @click="fieldSettings.finish = 'blob'">
                Blob mode
              </button>
            </div>
            <p id="blob-mode-help" class="control-help">
              Blob mode expands high forms, then rounds them into exaggerated organic surfaces without sharp peaks.
            </p>
            <template v-if="fieldSettings.finish === 'blob'">
              <label>
                <span>Blob dilation <output>{{ fieldSettings.blobDilation }}px</output></span>
                <input v-model.number="fieldSettings.blobDilation" type="range" min="0" max="20" step="1" aria-describedby="blob-mode-help" />
                <small>Spreads raised areas outward before rounding.</small>
              </label>
              <label>
                <span>Blob smoothing <output>{{ fieldSettings.blobSmoothing }}px</output></span>
                <input v-model.number="fieldSettings.blobSmoothing" type="range" min="0" max="24" step="1" aria-describedby="blob-mode-help" />
                <small>Softens the dilated field into broad, organic mounds.</small>
              </label>
            </template>
            <label>
              <span>Base smoothing <output>{{ fieldSettings.blur }}px</output></span>
              <input v-model.number="fieldSettings.blur" type="range" min="0" max="8" step="1" />
            </label>
            <label>
              <span>Contrast <output>{{ fieldSettings.contrast > 0 ? '+' : '' }}{{ fieldSettings.contrast }}</output></span>
              <input v-model.number="fieldSettings.contrast" type="range" min="-50" max="50" step="1" />
            </label>
            <label>
              <span>Quantize <output>{{ fieldSettings.quantize < 2 ? 'off' : `${fieldSettings.quantize} levels` }}</output></span>
              <input v-model.number="fieldSettings.quantize" type="range" min="0" max="12" step="1" />
            </label>
            <label class="check-label"><input v-model="fieldSettings.invert" type="checkbox" /> Invert composite</label>
          </div>
        </details>

        <details class="control-section" name="control-rail">
          <summary class="section-summary">
            <span class="section-summary__title" role="heading" aria-level="2">Geometry</span>
            <span class="section-summary__meta">{{ activeGeometry.label }}</span>
          </summary>
          <div class="section-body">
            <div class="mode-list" role="group" aria-label="Geometry mode">
              <button
                v-for="mode in geometryModes"
                :key="mode.value"
                type="button"
                :aria-pressed="meshSettings.mode === mode.value"
                @click="meshSettings.mode = mode.value"
              >
                <strong>{{ mode.label }}</strong><small>{{ mode.note }}</small>
              </button>
            </div>
            <label>
              <span>Depth <output>{{ meshSettings.depth.toFixed(2) }}</output></span>
              <input v-model.number="meshSettings.depth" type="range" min="0.02" max="1.4" step="0.02" />
            </label>
            <label>
              <span>Midpoint <output>{{ meshSettings.midpoint.toFixed(2) }}</output></span>
              <input v-model.number="meshSettings.midpoint" type="range" min="0" max="1" step="0.01" />
            </label>
            <label v-if="meshSettings.mode === 'solid'">
              <span>Base thickness <output>{{ meshSettings.baseThickness.toFixed(2) }}</output></span>
              <input v-model.number="meshSettings.baseThickness" type="range" min="0.06" max="0.8" step="0.02" />
            </label>
            <label>
              <span>Mesh resolution <output>{{ meshSettings.resolution }}</output></span>
              <input v-model.number="meshSettings.resolution" type="range" min="16" max="180" step="4" />
              <small>{{ faceLabel }} triangles</small>
            </label>
          </div>
        </details>
      </aside>

      <section class="preview-column" aria-label="Image and mesh previews">
        <div class="preview-toolbar">
          <div>
            <span class="eyebrow">Viewport</span>
            <strong>{{ activeGeometry.label }} / {{ stackSummary }}</strong>
          </div>
          <div class="preview-tools">
            <div class="view-switcher" role="group" aria-label="Viewport material">
              <button v-for="mode in previewModes" :key="mode.value" type="button" :aria-pressed="colorMode === mode.value" @click="selectColorMode(mode.value)">
                {{ mode.label }}
              </button>
            </div>
            <button
              ref="backgroundTrigger"
              type="button"
              class="background-trigger"
              aria-haspopup="menu"
              aria-controls="viewport-background-menu"
              :aria-expanded="Boolean(backgroundMenuPosition)"
              :aria-label="`Viewport background: ${activeBackground.label}. Choose a background color.`"
              :title="`Background: ${activeBackground.label} (W / G / B)`"
              @click="toggleBackgroundMenuFromTrigger"
            >
              <span class="background-trigger__swatch" :style="{ backgroundColor: activeBackground.color }" aria-hidden="true"></span>
              <span>BG</span>
            </button>
            <button
              type="button"
              class="export-image-trigger"
              :aria-expanded="imageExportOpen"
              aria-controls="image-export-panel"
              :disabled="exportingImage"
              @click="imageExportOpen = !imageExportOpen"
            >
              {{ imageExportOpen ? 'Close export' : 'Export image…' }}
            </button>
          </div>
        </div>

        <div v-if="colorMode === 'height'" class="material-controls" aria-label="Height gradient settings">
          <div class="material-controls__label">Height gradient</div>
          <div class="gradient-preview" :style="gradientPreviewStyle" aria-hidden="true"></div>
          <div class="gradient-pickers">
            <label>
              <span>Low</span>
              <input v-model="appearance.heightGradient.low" type="color" aria-label="Low height color" />
              <output>{{ appearance.heightGradient.low }}</output>
            </label>
            <label>
              <span>Mid</span>
              <input v-model="appearance.heightGradient.mid" type="color" aria-label="Middle height color" />
              <output>{{ appearance.heightGradient.mid }}</output>
            </label>
            <label>
              <span>High</span>
              <input v-model="appearance.heightGradient.high" type="color" aria-label="High height color" />
              <output>{{ appearance.heightGradient.high }}</output>
            </label>
          </div>
          <label class="gradient-midpoint">
            <span>Midpoint <output>{{ Math.round(appearance.heightGradient.midpoint * 100) }}%</output></span>
            <input v-model.number="appearance.heightGradient.midpoint" type="range" min="0.05" max="0.95" step="0.01" />
          </label>
        </div>

        <div v-if="colorMode === 'clay'" class="material-controls clay-controls" aria-label="Clay material settings">
          <label class="clay-color">
            <span>Clay color</span>
            <input v-model="appearance.clay.color" type="color" aria-label="Clay color" />
            <output>{{ appearance.clay.color }}</output>
          </label>
          <div>
            <span class="material-controls__label">Finish</span>
            <div class="finish-switcher" role="group" aria-label="Clay finish">
              <button v-for="finish in clayFinishes" :key="finish.value" type="button" :aria-pressed="appearance.clay.finish === finish.value" @click="appearance.clay.finish = finish.value">
                {{ finish.label }}
              </button>
            </div>
          </div>
        </div>

        <div
          ref="threeStage"
          :class="['three-stage', { 'is-export-framed': imageExportOpen }]"
          role="region"
          tabindex="0"
          aria-label="3D viewport. Right-click for background colors. Keyboard shortcuts: W for white, G for dark gray, B for black."
          aria-keyshortcuts="W G B"
          @pointerdown="focusThreeStage"
          @contextmenu.prevent.stop="openBackgroundMenu"
        >
          <div class="three-viewport-frame" :style="exportPreviewFrameStyle">
            <ThreePreview
              ref="threePreview"
              :mesh="mesh"
              :color-mode="colorMode"
              :appearance="appearance"
              :background="viewportBackground"
              @export-progress="handleImageExportProgress"
            />
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
            >
              <span class="background-menu__swatch" :style="{ backgroundColor: preset.color }" aria-hidden="true"></span>
              <span>{{ preset.label }}</span>
              <kbd>{{ preset.shortcut }}</kbd>
            </button>
          </div>
          <div v-if="dragging" class="drop-curtain">Drop image</div>
        </div>

        <section
          v-if="imageExportOpen"
          id="image-export-panel"
          class="image-export-panel"
          aria-labelledby="image-export-title"
          :aria-busy="exportingImage"
        >
          <header class="image-export-header">
            <div>
              <p class="eyebrow">Image export</p>
              <h2 id="image-export-title">Export a finished PNG</h2>
            </div>
            <div class="image-export-header__meta">
              <p class="image-export-summary" role="status" aria-label="Export summary">{{ imageExportSummary }}</p>
              <button type="button" class="image-export-close" :disabled="exportingImage" @click="imageExportOpen = false">Close</button>
            </div>
          </header>

          <div class="image-export-options">
            <fieldset>
              <legend>Quality</legend>
              <div class="export-choice-group">
                <button
                  type="button"
                  :aria-pressed="imageExportQuality === 'high'"
                  :disabled="exportingImage"
                  @click="selectImageExportQuality('high')"
                ><strong>High</strong><small>Clean and quick</small></button>
                <button
                  type="button"
                  :aria-pressed="imageExportQuality === 'final'"
                  :disabled="exportingImage || colorMode === 'wireframe'"
                  @click="selectImageExportQuality('final')"
                ><strong>Final</strong><small>Refined lighting</small></button>
              </div>
            </fieldset>

            <fieldset>
              <legend>Size</legend>
              <div class="export-choice-group size-choices">
                <button type="button" :aria-pressed="imageExportLongEdge === 2048" :disabled="exportingImage" @click="imageExportLongEdge = 2048">2K<small>2048 px</small></button>
                <button type="button" :aria-pressed="imageExportLongEdge === 4096" :disabled="exportingImage" @click="imageExportLongEdge = 4096">4K<small>4096 px</small></button>
                <button type="button" :aria-pressed="imageExportLongEdge === 8192" :disabled="exportingImage || imageExportQuality === 'final'" @click="imageExportLongEdge = 8192">8K<small>8192 px</small></button>
              </div>
            </fieldset>

            <fieldset>
              <legend>Background</legend>
              <div class="export-choice-group">
                <button type="button" :aria-pressed="imageExportBackground === 'transparent'" :disabled="exportingImage" @click="imageExportBackground = 'transparent'">Transparent</button>
                <button type="button" :aria-pressed="imageExportBackground === 'studio'" :disabled="exportingImage" @click="imageExportBackground = 'studio'">
                  Current background<small>{{ activeBackground.label }}</small>
                </button>
              </div>
            </fieldset>
          </div>

          <p class="image-export-help">{{ imageExportHelp }}</p>
          <div v-if="exportingImage" class="image-export-progress">
            <span>{{ imageExportProgressLabel }}</span>
            <progress
              :value="imageExportProgress.progress"
              max="1"
              aria-label="Final image render progress"
              :aria-valuetext="imageExportProgressLabel"
            >{{ imageExportProgress.progress }}</progress>
            <details v-if="imageExportProgress.phase === 'rendering'">
              <summary>Render details</summary>
              <p v-if="displayImageExportRequest.quality === 'final'">Tile {{ imageExportProgress.tile }} / {{ imageExportProgress.tiles }} · {{ imageExportProgress.samples }} / {{ imageExportProgress.targetSamples }} samples</p>
              <p v-else>Tile {{ imageExportProgress.tile }} / {{ imageExportProgress.tiles }} · 2× supersampling</p>
            </details>
          </div>
          <p class="sr-only" aria-live="polite">{{ imageExportAnnouncement }}</p>
          <p v-if="imageExportError" class="image-export-message is-error" role="alert">{{ imageExportError }}</p>
          <p v-else-if="imageExportNotice" class="image-export-message" role="status" aria-live="polite">{{ imageExportNotice }}</p>

          <div class="image-export-actions">
            <button v-if="imageExportError && imageExportQuality === 'final'" type="button" class="export-fallback" @click="selectImageExportQuality('high')">Use High quality</button>
            <button
              type="button"
              class="image-export-primary"
              :disabled="imageExportUnsupported"
              @click="downloadImagePng"
            >
              {{ exportingImage
                ? 'Cancel export'
                : imageExportQuality === 'final' ? 'Render & export PNG' : 'Export PNG' }}
            </button>
          </div>
        </section>

        <details class="preview-drawer">
          <summary class="preview-drawer__summary">
            <span>
              <span class="eyebrow">Reference maps</span>
              <strong role="heading" aria-level="2">Source &amp; height field</strong>
            </span>
            <span class="preview-drawer__meta">{{ image.width }} × {{ image.height }}</span>
          </summary>
          <div class="two-d-previews">
            <figure>
              <figcaption><span>source</span><strong>{{ image.name }}</strong></figcaption>
              <canvas ref="sourceCanvas" aria-label="Source image preview" />
            </figure>
            <figure>
              <figcaption><span>derived field</span><strong>{{ stackSummary }}</strong></figcaption>
              <canvas ref="heightCanvas" aria-label="Computed grayscale height map preview" />
            </figure>
          </div>
        </details>

        <details class="mesh-ledger">
          <summary class="mesh-ledger__heading">
            <span class="mesh-ledger__title">
              <span class="eyebrow">Mesh</span>
              <span id="mesh-health-title" class="mesh-ledger__name" role="heading" aria-level="2">Mesh health</span>
            </span>
            <strong :class="['health-state', { good: topology.watertight }]">
              {{ topology.watertight ? 'watertight' : meshSettings.mode === 'solid' ? 'check mesh' : 'open surface' }}
            </strong>
          </summary>
          <div class="mesh-ledger__body">
            <dl>
              <div><dt>Vertices</dt><dd>{{ topology.vertices.toLocaleString() }}</dd></div>
              <div><dt>Faces</dt><dd>{{ topology.faces.toLocaleString() }}</dd></div>
              <div><dt>Boundary loops</dt><dd>{{ topology.boundaryLoops }}</dd></div>
              <div><dt>Non-manifold edges</dt><dd>{{ topology.nonManifoldEdges }}</dd></div>
              <div><dt>Components</dt><dd>{{ topology.connectedComponents }}</dd></div>
              <div><dt>Euler χ</dt><dd>{{ topology.eulerCharacteristic }}</dd></div>
            </dl>
            <p>
              {{ topology.watertight
                ? 'STL ready'
                : 'STL requires a closed mesh' }}
            </p>
          </div>
        </details>

        <section class="export-strip" aria-label="3D and project files">
          <div>
            <p class="eyebrow">3D &amp; project files</p>
            <p role="status" aria-live="polite">{{ status }}</p>
          </div>
          <div class="export-actions">
            <button type="button" class="export-button primary" :disabled="exporting" @click="downloadGlb">{{ exporting ? 'Exporting…' : 'GLB for Blender / Cycles' }}</button>
            <button type="button" class="export-button" :disabled="!topology.watertight" @click="downloadStl">Export STL</button>
            <button type="button" class="export-button" @click="exportHeightPng(heightField)">Height PNG</button>
            <button type="button" class="export-button" @click="exportRecipe(recipe())">Recipe JSON</button>
          </div>
        </section>
      </section>
    </div>
  </main>
</template>
