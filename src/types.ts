export type HeightSource =
  | 'luminance'
  | 'hue'
  | 'saturation'
  | 'value'
  | 'red'
  | 'green'
  | 'blue'
  | 'alpha'
  | 'edges'

export type GeometryMode = 'plane' | 'centered' | 'solid'
export type ColorMode = 'original' | 'height' | 'clay' | 'wireframe'
export type ChannelBlendMode = 'normal' | 'add' | 'subtract' | 'multiply' | 'screen' | 'max' | 'min'
export type CompositeFinish = 'detail' | 'blob'
export type ClayFinish = 'matte' | 'glossy' | 'metallic'
export type ViewportBackground = 'white' | 'dark-gray' | 'black'
export type ImageExportQuality = 'high' | 'final' | 'pro'
export type ImageExportBackground = 'transparent' | 'studio'
export type ImageExportView = 'current' | 'straight-on'
export type ImageExportLongEdge = 2048 | 4096 | 8192
export type ViewportSupersample = 1 | 2
export type WorkspaceMode = 'image' | 'text'
export type TextAlignment = 'left' | 'center' | 'right'
export type FontSource = 'default' | 'detected' | 'local'
export type LivingFormBehavior = 'breathe' | 'ripple' | 'flow' | 'melt'

export interface PixelImage {
  /** Working raster dimensions used to build the mesh. */
  width: number
  height: number
  /** Original decoded file dimensions, retained without keeping the full source bitmap. */
  sourceWidth: number
  sourceHeight: number
  data: Uint8ClampedArray
  name: string
}

export interface ScalarField {
  width: number
  height: number
  values: Float32Array
}

export interface FieldSettings {
  invert: boolean
  blur: number
  contrast: number
  quantize: number
  finish: CompositeFinish
  blobDilation: number
  blobSmoothing: number
}

export interface ChannelLayer {
  id: string
  source: HeightSource
  blend: ChannelBlendMode
  amount: number
  invert: boolean
  hueOrigin: number
  enabled: boolean
}

export interface HeightGradientSettings {
  low: string
  mid: string
  high: string
  midpoint: number
}

export interface ClaySettings {
  color: string
  finish: ClayFinish
}

export interface AppearanceSettings {
  heightGradient: HeightGradientSettings
  clay: ClaySettings
}

export interface LivingFormSettings {
  enabled: boolean
  behavior: LivingFormBehavior
  /** Normalized deformation strength. */
  amount: number
  /** Spatial cycles across the form. */
  frequency: number
  /** Stable variation control. */
  seed: number
  /** Seconds in one complete seamless loop. */
  duration: number
}

export interface MeshSettings {
  mode: GeometryMode
  resolution: number
  depth: number
  midpoint: number
  baseThickness: number
}

export interface TextShapeSettings {
  text: string
  alignment: TextAlignment
  tracking: number
  lineHeight: number
  depth: number
  bevelSize: number
  bevelThickness: number
  bevelSegments: number
  resolution: number
  finish: CompositeFinish
  blobDilation: number
  blobSmoothing: number
}

export interface FontChoice {
  id: string
  label: string
  family: string
  style: string
  source: FontSource
  cssFamily: string
  postscriptName?: string
}

export interface MeshData {
  positions: Float32Array
  indices: Uint32Array
  colors: Float32Array
  uvs: Float32Array
  heights: Float32Array
  width: number
  height: number
  mode: GeometryMode
}

export interface TopologyReport {
  vertices: number
  edges: number
  faces: number
  boundaryEdges: number
  boundaryLoops: number
  connectedComponents: number
  nonManifoldEdges: number
  eulerCharacteristic: number
  watertight: boolean
  degenerateFaces: number
}

export interface Recipe {
  version: 6
  app: 'Rasterform'
  image: { name: string; width: number; height: number }
  channels: ChannelLayer[]
  field: FieldSettings
  mesh: MeshSettings
  appearance: AppearanceSettings
  livingForm: LivingFormSettings & { phase: number }
  createdAt: string
}

export interface TextRecipe {
  version: 6
  app: 'Rasterform'
  workspace: 'text'
  text: Omit<TextShapeSettings, 'text'> & { value: string }
  font: Pick<FontChoice, 'label' | 'family' | 'style' | 'source' | 'postscriptName'>
  appearance: AppearanceSettings
  livingForm: LivingFormSettings & { phase: number }
  createdAt: string
}
