import type {
  ImageExportBackground,
  LivingFormSettings,
  ViewportBackground,
} from '../types'
import { assertPngContract } from './viewport-export'
import {
  createStoredZipArchive,
  type StoredZipArchive,
  type StoredZipArchiveOptions,
  type StoredZipProjection,
} from './zip-writer'

export const LIVING_FORM_FRAME_RATES = [12, 24, 30] as const
export type LivingFormFrameRate = (typeof LIVING_FORM_FRAME_RATES)[number]

export interface LivingFormLoopProgress {
  phase: 'rendering' | 'packaging'
  progress: number
  frame: number
  frames: number
}

export interface LivingFormLoopManifest {
  schema: 'rasterform-living-form-loop'
  version: 1
  app: 'Rasterform'
  createdAt: string
  dimensions: { width: number; height: number }
  timing: {
    fps: LivingFormFrameRate
    durationSeconds: number
    frameCount: number
    phaseStep: number
    duplicateEndFrame: false
  }
  render: {
    quality: 'high-2x'
    encoding: 'lossless-rgba-png'
    background: ImageExportBackground
    studioBackground: ViewportBackground
  }
  livingForm: LivingFormSettings
  files: {
    pattern: string
    first: string
    last: string
  }
}

export interface LivingFormLoopExportOptions {
  width: number
  height: number
  fps: LivingFormFrameRate
  settings: LivingFormSettings
  background: ImageExportBackground
  studioBackground: ViewportBackground
  signal?: AbortSignal
  onProgress?: (progress: LivingFormLoopProgress) => void
  renderFrame: (
    phase: number,
    frame: number,
    frames: number,
  ) => Promise<Blob>
  /** Primarily for deterministic tests. */
  createdAt?: Date
  /** Primarily for deterministic storage and capacity tests. */
  archiveOptions?: StoredZipArchiveOptions
}

export interface LivingFormLoopExportResult {
  blob: Blob
  width: number
  height: number
  fps: LivingFormFrameRate
  durationSeconds: number
  frames: number
  archiveStorage: StoredZipArchive['storage']
  cleanup: () => Promise<void>
}

function abortError(): DOMException {
  return new DOMException('Living Form export cancelled.', 'AbortError')
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

function finiteInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${label} must be a positive integer.`)
  return value
}

export function calculateLivingFormFrameCount(
  durationSeconds: number,
  fps: LivingFormFrameRate,
): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 1 || durationSeconds > 12) {
    throw new RangeError('Living Form duration must be between 1 and 12 seconds.')
  }
  if (!LIVING_FORM_FRAME_RATES.includes(fps)) throw new RangeError('Unsupported Living Form frame rate.')
  return Math.round(durationSeconds * fps)
}

/** The terminal phase is deliberately excluded so frame zero is never duplicated. */
export function livingFormFramePhase(frame: number, frames: number): number {
  const count = finiteInteger(frames, 'Frame count')
  if (!Number.isInteger(frame) || frame < 0 || frame >= count) {
    throw new RangeError('Living Form frame index is outside the loop.')
  }
  return frame / count
}

export function livingFormFrameName(frame: number, frames: number): string {
  const count = finiteInteger(frames, 'Frame count')
  if (!Number.isInteger(frame) || frame < 0 || frame >= count) {
    throw new RangeError('Living Form frame index is outside the loop.')
  }
  const digits = Math.max(4, String(count).length)
  return `frames/rasterform-${String(frame + 1).padStart(digits, '0')}.png`
}

function snapshotSettings(settings: LivingFormSettings): LivingFormSettings {
  return {
    enabled: true,
    behavior: settings.behavior,
    amount: Math.max(0, Math.min(1, settings.amount)),
    frequency: Math.max(0.25, Math.min(8, settings.frequency)),
    seed: Number.isFinite(settings.seed) ? settings.seed : 0,
    duration: Math.max(1, Math.min(12, settings.duration)),
  }
}

export function createLivingFormLoopManifest(
  options: Omit<LivingFormLoopExportOptions, 'renderFrame' | 'signal' | 'onProgress' | 'archiveOptions'>,
): LivingFormLoopManifest {
  const frames = calculateLivingFormFrameCount(options.settings.duration, options.fps)
  return {
    schema: 'rasterform-living-form-loop',
    version: 1,
    app: 'Rasterform',
    createdAt: (options.createdAt ?? new Date()).toISOString(),
    dimensions: {
      width: finiteInteger(options.width, 'Loop width'),
      height: finiteInteger(options.height, 'Loop height'),
    },
    timing: {
      fps: options.fps,
      durationSeconds: options.settings.duration,
      frameCount: frames,
      phaseStep: 1 / frames,
      duplicateEndFrame: false,
    },
    render: {
      quality: 'high-2x',
      encoding: 'lossless-rgba-png',
      background: options.background,
      studioBackground: options.studioBackground,
    },
    livingForm: snapshotSettings(options.settings),
    files: {
      pattern: 'frames/rasterform-####.png',
      first: livingFormFrameName(0, frames),
      last: livingFormFrameName(frames - 1, frames),
    },
  }
}

/**
 * Render each unique loop phase, validate every PNG, and package the lossless
 * frames with their exact timing contract. Existing still Final rendering is
 * intentionally not involved in this High 2x animation master.
 */
export async function exportLivingFormPngSequence(
  options: LivingFormLoopExportOptions,
): Promise<LivingFormLoopExportResult> {
  const manifest = createLivingFormLoopManifest(options)
  const { frameCount } = manifest.timing
  throwIfAborted(options.signal)
  const archive = await createStoredZipArchive(options.archiveOptions)

  try {
    throwIfAborted(options.signal)
    await archive.add({
      name: 'manifest.json',
      data: `${JSON.stringify(manifest, null, 2)}\n`,
      modifiedAt: options.createdAt,
    }, { signal: options.signal })

    let largestFrameBytes = 0

    for (let frame = 0; frame < frameCount; frame += 1) {
      throwIfAborted(options.signal)
      options.onProgress?.({
        phase: 'rendering',
        progress: frame / frameCount,
        frame,
        frames: frameCount,
      })
      const blob = await options.renderFrame(livingFormFramePhase(frame, frameCount), frame, frameCount)
      throwIfAborted(options.signal)
      const bytes = new Uint8Array(await blob.arrayBuffer())
      throwIfAborted(options.signal)
      assertPngContract(
        bytes,
        manifest.dimensions.width,
        manifest.dimensions.height,
        options.background === 'transparent',
      )
      largestFrameBytes = Math.max(largestFrameBytes, bytes.byteLength)
      if (archive.capacityBytes !== null) {
        const remaining: StoredZipProjection[] = []
        for (let pending = frame; pending < frameCount; pending += 1) {
          remaining.push({
            name: livingFormFrameName(pending, frameCount),
            size: largestFrameBytes,
          })
        }
        const projectedSize = archive.projectedSize(remaining)
        if (projectedSize > archive.capacityBytes) {
          const destination = archive.capacitySource === 'storage-estimate'
            ? 'available private browser storage'
            : 'this browser’s in-memory ZIP fallback'
          throw new Error(`This lossless loop is too large for ${destination}.`)
        }
      }
      await archive.add({
        name: livingFormFrameName(frame, frameCount),
        data: blob,
        bytes,
        modifiedAt: options.createdAt,
      }, { signal: options.signal })
      throwIfAborted(options.signal)
      options.onProgress?.({
        phase: 'rendering',
        progress: (frame + 1) / frameCount,
        frame: frame + 1,
        frames: frameCount,
      })
    }

    throwIfAborted(options.signal)
    options.onProgress?.({ phase: 'packaging', progress: 0, frame: frameCount, frames: frameCount })
    const blob = await archive.complete({ signal: options.signal })
    throwIfAborted(options.signal)
    options.onProgress?.({ phase: 'packaging', progress: 1, frame: frameCount, frames: frameCount })
    return {
      blob,
      width: manifest.dimensions.width,
      height: manifest.dimensions.height,
      fps: manifest.timing.fps,
      durationSeconds: manifest.timing.durationSeconds,
      frames: frameCount,
      archiveStorage: archive.storage,
      cleanup: () => archive.cleanup(),
    }
  } catch (error) {
    await archive.abort()
    throw error
  }
}
