import { describe, expect, it } from 'vitest'
import appSource from '../App.vue?raw'

const app = appSource.split('<template>')[1]!
const controls = [...app.matchAll(/<NumberControl\b[^>]*\/>/g)].map(([tag]) => tag)

function controlsFor(model: string): string[] {
  return controls.filter((tag) => tag.includes(`v-model="${model}"`))
}

describe('numeric UI preserves existing authored setting ranges', () => {
  it.each([
    ['selectedChannel.amount', '0', '1', '0.01'],
    ['selectedChannel.hueOrigin', '0', '1', '0.005'],
    ['textSettings.tracking', '-0.08', '0.3', '0.005'],
    ['textSettings.lineHeight', '0.8', '1.8', '0.02'],
    ['textSettings.resolution', '180', '720', '20'],
    ['strataSettings.layers', '2', '24', '1'],
    ['strataSettings.thickness', '0.005', '0.12', '0.005'],
    ['strataSettings.separation', '0', '0.18', '0.005'],
    ['meshSettings.midpoint', '0', '1', '0.01'],
    ['meshSettings.baseThickness', '0.06', '0.8', '0.02'],
    ['textSettings.depth', '0.06', '0.9', '0.01'],
    ['textSettings.bevelSize', '0', '0.12', '0.005'],
    ['textSettings.bevelThickness', '0', '0.12', '0.005'],
    ['textSettings.bevelSegments', '1', '8', '1'],
    ['fieldSettings.quantize', '0', '12', '1'],
    ['textSettings.blobDilation', '0', '20', '1'],
    ['textSettings.blobSmoothing', '0', '24', '1'],
    ['livingForm.amount', '0', '1', '0.01'],
    ['livingForm.frequency', '0.25', '5', '0.05'],
    ['livingForm.seed', '0', '100', '1'],
    ['livingForm.duration', '1', '12', '0.5'],
    ['livingPhase', '0', '0.999', '0.001'],
    ['appearance.heightGradient.midpoint', '0.05', '0.95', '0.01'],
    ['proRenderSettings.maxSamples', '64', '8192', '64'],
    ['proRenderSettings.minSamples', '64', 'proRenderSettings.maxSamples', '64'],
    ['proRenderSettings.noiseThreshold', '0.001', '0.05', '0.001'],
    ['proRenderSettings.maxBounces', '2', '16', '1'],
  ])('%s keeps its original min/max/step', (model, min, max, step) => {
    const matches = controlsFor(model)
    expect(matches.length).toBeGreaterThan(0)
    for (const control of matches) {
      expect(control).toContain(`:min="${min}"`)
      expect(control).toContain(`:max="${max}"`)
      expect(control).toContain(`:step="${step}"`)
    }
  })

  it.each([
    ['selectedChannel.amount', '100'],
    ['selectedChannel.hueOrigin', '360'],
    ['textSettings.tracking', '100'],
    ['livingForm.amount', '100'],
    ['livingPhase', '100'],
    ['appearance.heightGradient.midpoint', '100'],
  ])('%s changes display units only', (model, scale) => {
    expect(controlsFor(model)[0]).toContain(`:display-scale="${scale}"`)
  })

  it('retains loop scrubbing, export locks and distinct midpoint meanings', () => {
    expect(controlsFor('livingPhase')[0]).toContain('@update:model-value="pauseLivingFormForScrub"')
    for (const model of ['maxSamples', 'minSamples', 'noiseThreshold', 'maxBounces']) {
      expect(controlsFor(`proRenderSettings.${model}`)[0]).toContain(':disabled="exportingImage"')
    }
    expect(controlsFor('livingForm.duration')).toHaveLength(2)
    expect(controlsFor('livingForm.duration')[1]).toContain(':disabled="exportingImage"')
    expect(controlsFor('meshSettings.midpoint')[0]).toContain('label="Relief midpoint"')
    expect(controlsFor('appearance.heightGradient.midpoint')[0]).toContain('label="Gradient color midpoint"')
  })
})
