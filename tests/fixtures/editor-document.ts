import type { EditorDocument } from '../../src/lib/editor-document'
import { createDemoImage } from '../../src/lib/image'
import { SYSTEM_SANS_FONT } from '../../src/lib/local-fonts'
import { DEFAULT_LIVING_FORM_SETTINGS } from '../../src/lib/living-form'
import { DEFAULT_STRATA_SETTINGS } from '../../src/lib/strata'
import { createDefaultAppearanceSettings } from '../../src/lib/three'

export function editorDocumentFixture(): EditorDocument {
  return {
    image: createDemoImage(4, 3), workspace: 'image',
    channels: [
      { id: 'channel-1', source: 'luminance', blend: 'add', amount: 0.86, invert: false, hueOrigin: 0, enabled: true },
      { id: 'channel-2', source: 'edges', blend: 'add', amount: 0.28, invert: false, hueOrigin: 0, enabled: true },
    ],
    selectedChannelId: 'channel-1',
    field: { invert: false, blur: 1, contrast: 8, quantize: 0, finish: 'detail', blobDilation: 6, blobSmoothing: 8 },
    mesh: { mode: 'solid', resolution: 88, depth: 0.58, midpoint: 0.5, baseThickness: 0.26 },
    strata: { ...DEFAULT_STRATA_SETTINGS },
    text: {
      text: 'Rasterform', alignment: 'center', tracking: 0, lineHeight: 1.06, depth: 0.34,
      bevelSize: 0.035, bevelThickness: 0.035, bevelSegments: 4, resolution: 420,
      finish: 'detail', blobDilation: 5, blobSmoothing: 6,
    },
    font: { ...SYSTEM_SANS_FONT },
    imageAppearance: createDefaultAppearanceSettings(), textAppearance: createDefaultAppearanceSettings(),
    imageLivingForm: { ...DEFAULT_LIVING_FORM_SETTINGS, seed: 17 },
    textLivingForm: { ...DEFAULT_LIVING_FORM_SETTINGS, behavior: 'flow', amount: 0.42, frequency: 1.25, seed: 31 },
    imageLivingPhase: 0, textLivingPhase: 0, imageColorMode: 'original', textColorMode: 'clay',
    viewportBackground: 'dark-gray',
    camera: {
      position: [2, 1, 3], quaternion: [0, 0, 0, 1], target: [0, 0, 0], up: [0, 1, 0],
      fov: 45, near: 0.01, far: 100, zoom: 1, filmGauge: 35, filmOffset: 0,
    },
  }
}
