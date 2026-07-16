<script setup lang="ts">
import { computed, nextTick, reactive, ref, shallowRef, watch } from 'vue'
import ThreePreview from './components/ThreePreview.vue'
import { composeChannelStack } from './lib/channel-stack'
import { processScalarField } from './lib/filters'
import { createDemoImage, drawPixelImage, drawScalarField, fileToPixelImage } from './lib/image'
import { buildMesh } from './lib/mesh'
import { inspectTopology } from './lib/topology'
import { downloadBlob, exportGlb, exportHeightPng, exportRecipe, exportStl } from './lib/export'
import { createDefaultAppearanceSettings } from './lib/three'
import type {
  AppearanceSettings,
  ChannelBlendMode,
  ChannelLayer,
  ClayFinish,
  ColorMode,
  FieldSettings,
  GeometryMode,
  HeightSource,
  MeshSettings,
  Recipe,
  ViewportExportLongEdge,
} from './types'

interface ThreePreviewHandle {
  captureTransparentPng: (longEdge: ViewportExportLongEdge) => Promise<{
    blob: Blob
    width: number
    height: number
    dpi: number
  }>
}

const image = shallowRef(createDemoImage())
const threePreview = ref<ThreePreviewHandle | null>(null)
const sourceCanvas = ref<HTMLCanvasElement | null>(null)
const heightCanvas = ref<HTMLCanvasElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const status = ref('Demo image · 360 × 270')
const exporting = ref(false)
const exportingViewport = ref(false)
const dragging = ref(false)
const colorMode = ref<ColorMode>('original')
const viewportExportLongEdge = ref<ViewportExportLongEdge>(4096)
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
    field: { invert: false, blur: 1, contrast: 8, quantize: 0 },
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
    field: { invert: false, blur: 1, contrast: 10, quantize: 6 },
  },
  {
    key: 'ink-emboss',
    label: 'Ink emboss',
    note: 'Inverted luminance + edges',
    layers: [
      { source: 'luminance', blend: 'add', amount: 0.58, invert: true, hueOrigin: 0, enabled: true },
      { source: 'edges', blend: 'add', amount: 0.68, invert: false, hueOrigin: 0, enabled: true },
    ],
    field: { invert: false, blur: 0, contrast: 18, quantize: 0 },
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
    version: 3,
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
    status.value = 'GLB exported'
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

async function downloadViewportPng() {
  if (!threePreview.value) return
  exportingViewport.value = true
  status.value = `Rendering ${viewportExportLongEdge.value / 1024}K PNG…`
  try {
    const result = await threePreview.value.captureTransparentPng(viewportExportLongEdge.value)
    const view = previewModes.find((mode) => mode.value === colorMode.value)?.label.toLowerCase() ?? colorMode.value
    downloadBlob(`rasterform-${view}-${result.width}x${result.height}-transparent.png`, result.blob)
    status.value = `PNG · ${result.width} × ${result.height} · transparent · ${result.dpi} PPI`
  } catch (error) {
    status.value = error instanceof Error ? error.message : 'Viewport PNG failed.'
  } finally {
    exportingViewport.value = false
  }
}
</script>

<template>
  <main
    :class="['studio', { 'is-dragging': dragging }]"
    @dragenter.prevent="dragging = true"
    @dragover.prevent="dragging = true"
    @dragleave.self.prevent="dragging = false"
    @drop.prevent="handleDrop"
  >
    <header class="tool-header">
      <h1>Rasterform</h1>
      <span>Local</span>
    </header>

    <div class="workbench">
      <aside class="control-rail" aria-label="Rasterform controls">
        <section class="control-section">
          <div class="section-number">01</div>
          <div class="section-body">
            <h2>Image</h2>
            <p>{{ image.name }} · {{ image.width }} × {{ image.height }}</p>
            <input ref="fileInput" class="sr-only" type="file" accept="image/png,image/jpeg,image/webp" @change="handleFile" />
            <div class="button-row">
              <button type="button" class="text-button" @click="fileInput?.click()">Open image</button>
              <button type="button" class="text-button" @click="resetDemo">Use demo</button>
            </div>
          </div>
        </section>

        <section class="control-section">
          <div class="section-number">02</div>
          <div class="section-body">
            <h2>Channel stack</h2>
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
            <label>
              <span>Smoothing <output>{{ fieldSettings.blur }}px</output></span>
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
        </section>

        <section class="control-section">
          <div class="section-number">03</div>
          <div class="section-body">
            <h2>Geometry</h2>
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
        </section>
      </aside>

      <section class="preview-column" aria-label="Image and mesh previews">
        <div class="preview-toolbar">
          <div>
            <span class="eyebrow">Viewport</span>
            <strong>{{ activeGeometry.label }} / {{ stackSummary }}</strong>
          </div>
          <div class="preview-tools">
            <div class="view-switcher" role="group" aria-label="Viewport material">
              <button v-for="mode in previewModes" :key="mode.value" type="button" :aria-pressed="colorMode === mode.value" @click="colorMode = mode.value">
                {{ mode.label }}
              </button>
            </div>
            <div class="viewport-export">
              <label class="sr-only" for="viewport-export-size">PNG size</label>
              <select id="viewport-export-size" v-model.number="viewportExportLongEdge" aria-label="Transparent PNG size">
                <option :value="4096">4K · 4096px</option>
                <option :value="8192">8K · 8192px</option>
              </select>
              <button type="button" :disabled="exportingViewport" @click="downloadViewportPng">
                {{ exportingViewport ? 'Rendering…' : 'Transparent PNG' }}
              </button>
            </div>
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

        <div class="three-stage">
          <ThreePreview ref="threePreview" :mesh="mesh" :color-mode="colorMode" :appearance="appearance" />
          <div v-if="dragging" class="drop-curtain">Drop image</div>
        </div>

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

        <section class="mesh-ledger" aria-labelledby="mesh-health-title">
          <div class="mesh-ledger__heading">
            <div>
              <p class="eyebrow">Mesh</p>
              <h2 id="mesh-health-title">Mesh health</h2>
            </div>
            <strong :class="['health-state', { good: topology.watertight }]">
              {{ topology.watertight ? 'watertight' : meshSettings.mode === 'solid' ? 'check mesh' : 'open surface' }}
            </strong>
          </div>
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
        </section>

        <section class="export-strip" aria-label="Export assets">
          <div>
            <p class="eyebrow">Export</p>
            <p role="status" aria-live="polite">{{ status }}</p>
          </div>
          <div class="export-actions">
            <button type="button" class="export-button primary" :disabled="exporting" @click="downloadGlb">{{ exporting ? 'Exporting…' : 'Export GLB' }}</button>
            <button type="button" class="export-button" :disabled="!topology.watertight" @click="downloadStl">Export STL</button>
            <button type="button" class="export-button" @click="exportHeightPng(heightField)">Height PNG</button>
            <button type="button" class="export-button" @click="exportRecipe(recipe())">Recipe JSON</button>
          </div>
        </section>
      </section>
    </div>
  </main>
</template>
