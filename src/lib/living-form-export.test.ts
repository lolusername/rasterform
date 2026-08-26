import { describe, expect, it, vi } from 'vitest'
import type { LivingFormSettings } from '../types'
import {
  calculateLivingFormFrameCount,
  createLivingFormLoopManifest,
  exportLivingFormPngSequence,
  livingFormFrameName,
  livingFormFramePhase,
} from './living-form-export'

const onePixelRgbaPng = Uint8Array.from(atob(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL5WQAAAABJRU5ErkJggg==',
), (character) => character.charCodeAt(0))

const settings: LivingFormSettings = {
  enabled: true,
  behavior: 'flow',
  amount: 0.7,
  frequency: 2.25,
  seed: 11,
  duration: 2,
}

describe('Living Form loop contract', () => {
  it('derives exact frame counts and never includes the duplicate terminal phase', () => {
    expect(calculateLivingFormFrameCount(2, 24)).toBe(48)
    expect(livingFormFramePhase(0, 48)).toBe(0)
    expect(livingFormFramePhase(47, 48)).toBe(47 / 48)
    expect(livingFormFramePhase(47, 48)).toBeLessThan(1)
    expect(() => livingFormFramePhase(48, 48)).toThrow(/outside/)
  })

  it('writes a truthful timing and quality manifest', () => {
    const manifest = createLivingFormLoopManifest({
      width: 2048,
      height: 1536,
      fps: 24,
      settings,
      background: 'transparent',
      studioBackground: 'black',
      createdAt: new Date('2026-08-10T12:00:00.000Z'),
    })
    expect(manifest.timing).toMatchObject({
      fps: 24,
      durationSeconds: 2,
      frameCount: 48,
      duplicateEndFrame: false,
    })
    expect(manifest.render).toEqual({
      quality: 'high-2x',
      encoding: 'lossless-rgba-png',
      background: 'transparent',
      studioBackground: 'black',
    })
    expect(manifest.files.first).toBe('frames/rasterform-0001.png')
    expect(manifest.files.last).toBe('frames/rasterform-0048.png')
    expect(manifest.livingForm).not.toBe(settings)
  })

  it('renders every unique phase in order and packages PNGs with the manifest', async () => {
    const shortSettings = { ...settings, duration: 1 }
    const phases: number[] = []
    const progress: number[] = []
    const result = await exportLivingFormPngSequence({
      width: 1,
      height: 1,
      fps: 12,
      settings: shortSettings,
      background: 'transparent',
      studioBackground: 'dark-gray',
      createdAt: new Date('2026-08-10T12:00:00.000Z'),
      archiveOptions: { preferTemporaryFile: false },
      renderFrame: async (phase) => {
        phases.push(phase)
        return new Blob([onePixelRgbaPng], { type: 'image/png' })
      },
      onProgress: (event) => progress.push(event.phase === 'rendering' ? event.progress : 1),
    })
    const bytes = new Uint8Array(await result.blob.arrayBuffer())
    const archiveText = new TextDecoder().decode(bytes)

    expect(result.frames).toBe(12)
    expect(result.archiveStorage).toBe('memory')
    expect(phases).toEqual(Array.from({ length: 12 }, (_, index) => index / 12))
    expect(phases).not.toContain(1)
    expect(archiveText).toContain('manifest.json')
    expect(archiveText).toContain(livingFormFrameName(11, 12))
    expect(progress.every((value, index) => index === 0 || value >= (progress[index - 1] ?? 0))).toBe(true)
    await result.cleanup()
  })

  it('reuses each already validated PNG byte snapshot instead of reading its Blob twice', async () => {
    const blob = new Blob([onePixelRgbaPng], { type: 'image/png' })
    const read = vi.spyOn(blob, 'arrayBuffer')
    const result = await exportLivingFormPngSequence({
      width: 1,
      height: 1,
      fps: 12,
      settings: { ...settings, duration: 1 },
      background: 'transparent',
      studioBackground: 'black',
      archiveOptions: { preferTemporaryFile: false },
      renderFrame: async () => blob,
    })

    expect(read).toHaveBeenCalledTimes(12)
    await result.cleanup()
  })

  it('fails the bounded memory fallback after the first frame establishes an oversized projection', async () => {
    let rendered = 0
    await expect(exportLivingFormPngSequence({
      width: 1,
      height: 1,
      fps: 30,
      settings: { ...settings, duration: 12 },
      background: 'transparent',
      studioBackground: 'dark-gray',
      archiveOptions: {
        preferTemporaryFile: false,
        memoryLimitBytes: 4096,
      },
      renderFrame: async () => {
        rendered += 1
        return new Blob([onePixelRgbaPng], { type: 'image/png' })
      },
    })).rejects.toThrow(/too large.*in-memory/i)
    expect(rendered).toBe(1)
  })

  it('rejects a dimension-mismatched frame before it enters the archive', async () => {
    await expect(exportLivingFormPngSequence({
      width: 2,
      height: 1,
      fps: 12,
      settings: { ...settings, duration: 1 },
      background: 'transparent',
      studioBackground: 'dark-gray',
      archiveOptions: { preferTemporaryFile: false },
      renderFrame: async () => new Blob([onePixelRgbaPng], { type: 'image/png' }),
    })).rejects.toThrow(/dimension check failed/i)
  })

  it('stops before rendering when cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    let rendered = false
    await expect(exportLivingFormPngSequence({
      width: 1,
      height: 1,
      fps: 12,
      settings: { ...settings, duration: 1 },
      background: 'transparent',
      studioBackground: 'dark-gray',
      signal: controller.signal,
      renderFrame: async () => {
        rendered = true
        return new Blob([onePixelRgbaPng])
      },
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(rendered).toBe(false)
  })
})
