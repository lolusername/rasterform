import type * as THREE from 'three'
import type {
  AppearanceSettings,
  ImageExportBackground,
  MeshData,
  ViewportBackground,
} from '../types'
import { snapshotCamera, snapshotMesh } from '../lib/image-export-worker'
import { isDesktopPngName, type DesktopFinalColorMode, type DesktopRenderErrorCode } from './contracts'
import {
  DESKTOP_PRO_RENDER_PROTOCOL_VERSION,
  assertDesktopProRenderSnapshot,
  isDesktopProCancelResult,
  isDesktopProRendererAvailability,
  isDesktopProRenderEvent,
  isDesktopProRenderSubmission,
  isDesktopSavePreparation,
  isRasterformDesktopProBridge,
  type DesktopProCancelResult,
  type DesktopProCaptureResult,
  type DesktopProRenderEvent,
  type DesktopProRenderSettings,
  type DesktopProRenderSnapshot,
  type DesktopProRendererAvailability,
  type DesktopSavedProResult,
  type RasterformDesktopProBridge,
} from './pro-contracts'
import type { FinalExportProgress } from '../lib/final-image-export'

interface DesktopWindow {
  rasterformDesktop?: unknown
}

export interface CreateDesktopProRenderSnapshotOptions {
  mesh: MeshData
  camera: THREE.PerspectiveCamera
  colorMode: DesktopFinalColorMode
  appearance: AppearanceSettings
  width: number
  height: number
  background: ImageExportBackground
  studioBackground: ViewportBackground
  settings: DesktopProRenderSettings
}

export interface RenderProImageInDesktopOptions extends CreateDesktopProRenderSnapshotOptions {
  suggestedName: string
  signal?: AbortSignal
  onProgress?: (progress: FinalExportProgress) => void
  bridge?: RasterformDesktopProBridge | null
}

export class DesktopProRenderError extends Error {
  readonly code: DesktopRenderErrorCode

  constructor(code: DesktopRenderErrorCode, message: string) {
    super(message)
    this.name = 'DesktopProRenderError'
    this.code = code
  }
}

function abortError(): DOMException {
  return new DOMException('Pro render cancelled.', 'AbortError')
}

function proBridgeFromWindow(): RasterformDesktopProBridge | null {
  if (typeof window === 'undefined') return null
  const candidate = (window as unknown as DesktopWindow).rasterformDesktop
  if (candidate === undefined || !isRasterformDesktopProBridge(candidate)) return null
  return candidate
}

function cancelWithoutWaiting(bridge: RasterformDesktopProBridge, jobId: string): void {
  try {
    void Promise.resolve(bridge.cancelProRender(jobId)).catch(() => undefined)
  } catch {
    // Cancellation is best-effort after the caller-facing operation settles.
  }
}

export function desktopProRendererAvailable(): boolean {
  return Boolean(proBridgeFromWindow())
}

export async function probeDesktopProRenderer(
  bridge: RasterformDesktopProBridge | null = proBridgeFromWindow(),
): Promise<DesktopProRendererAvailability | null> {
  if (!bridge) return null
  let candidate: unknown
  try {
    candidate = await bridge.probeProRenderer()
  } catch {
    throw new DesktopProRenderError('render-failed', 'Rasterform could not inspect the Blender renderer.')
  }
  if (!isDesktopProRendererAvailability(candidate)) {
    throw new DesktopProRenderError('render-failed', 'The desktop renderer returned an invalid Blender probe.')
  }
  return candidate
}

export function createDesktopProRenderSnapshot(
  options: CreateDesktopProRenderSnapshotOptions,
): DesktopProRenderSnapshot {
  const snapshot: DesktopProRenderSnapshot = {
    protocolVersion: DESKTOP_PRO_RENDER_PROTOCOL_VERSION,
    mesh: snapshotMesh(options.mesh),
    camera: snapshotCamera(options.camera),
    colorMode: options.colorMode,
    appearance: {
      heightGradient: { ...options.appearance.heightGradient },
      clay: { ...options.appearance.clay },
    },
    width: options.width,
    height: options.height,
    background: options.background,
    studioBackground: options.studioBackground,
    settings: { ...options.settings },
  }
  assertDesktopProRenderSnapshot(snapshot)
  return snapshot
}

async function prepareSaveWithAbort(
  bridge: RasterformDesktopProBridge,
  suggestedName: string,
  signal?: AbortSignal,
) {
  if (signal?.aborted) throw abortError()
  const preparation = Promise.resolve(bridge.prepareProSave(suggestedName))
  if (!signal) return preparation
  let handleAbort: (() => void) | null = null
  const aborted = new Promise<never>((_resolve, reject) => {
    handleAbort = () => reject(abortError())
    signal.addEventListener('abort', handleAbort, { once: true })
  })
  try {
    return await Promise.race([preparation, aborted])
  } catch (error) {
    if (signal.aborted) {
      void preparation.then((result) => {
        if (isDesktopSavePreparation(result) && !result.cancelled) {
          cancelWithoutWaiting(bridge, result.jobId)
        }
      }).catch(() => undefined)
    }
    throw error
  } finally {
    if (handleAbort) signal.removeEventListener('abort', handleAbort)
  }
}

export async function renderProImageInDesktop(
  options: RenderProImageInDesktopOptions,
): Promise<DesktopProCaptureResult> {
  const bridge = options.bridge === undefined ? proBridgeFromWindow() : options.bridge
  if (!bridge) {
    throw new DesktopProRenderError(
      'render-failed',
      'Cycles Pro is available only in the Rasterform desktop renderer lab.',
    )
  }
  if (!isDesktopPngName(options.suggestedName)) {
    throw new DesktopProRenderError('save-failed', 'The suggested Pro render name was not a PNG filename.')
  }
  if (options.signal?.aborted) throw abortError()

  let snapshot: DesktopProRenderSnapshot
  try {
    snapshot = createDesktopProRenderSnapshot(options)
  } catch {
    throw new DesktopProRenderError('render-failed', 'The current model could not be prepared for Cycles Pro.')
  }

  let prepared: unknown
  try {
    prepared = await prepareSaveWithAbort(bridge, options.suggestedName, options.signal)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new DesktopProRenderError('save-failed', 'The macOS Pro Save dialog could not be opened.')
  }
  if (!isDesktopSavePreparation(prepared)) {
    throw new DesktopProRenderError('save-failed', 'The macOS Pro Save dialog returned an invalid destination.')
  }
  if (prepared.cancelled) throw abortError()
  const { jobId } = prepared
  if (options.signal?.aborted) {
    cancelWithoutWaiting(bridge, jobId)
    throw abortError()
  }

  return new Promise<DesktopProCaptureResult>((resolve, reject) => {
    let settled = false
    let cancellationRequested = false
    let unsubscribe: () => void = () => undefined

    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener('abort', handleAbort)
      try {
        unsubscribe()
      } catch {
        // A broken cleanup hook must not keep the render pending.
      }
      callback()
    }
    const fail = (error: unknown, cancel = true) => {
      if (settled) return
      if (cancel) cancelWithoutWaiting(bridge, jobId)
      finish(() => reject(error))
    }
    const acceptSavedResult = (result: DesktopSavedProResult) => {
      if (result.width !== snapshot.width
        || result.height !== snapshot.height
        || result.maxSamples !== snapshot.settings.maxSamples
        || result.noiseThreshold !== snapshot.settings.noiseThreshold) {
        fail(new DesktopProRenderError('render-failed', 'Cycles Pro changed the requested output contract.'))
        return
      }
      finish(() => resolve({ desktopSaved: true, ...result }))
    }
    const handleAbort = () => {
      if (settled || cancellationRequested) return
      cancellationRequested = true
      let cancellation: Promise<DesktopProCancelResult>
      try {
        cancellation = bridge.cancelProRender(jobId)
      } catch {
        fail(new DesktopProRenderError(
          'render-failed',
          'Rasterform could not send the Pro render cancellation request.',
        ), false)
        return
      }
      void Promise.resolve(cancellation).then((candidate) => {
        if (settled) return
        if (!isDesktopProCancelResult(candidate)) {
          fail(new DesktopProRenderError('render-failed', 'The Pro renderer returned an invalid cancellation response.'), false)
          return
        }
        if (candidate.state === 'cancelled') finish(() => reject(abortError()))
        else if (candidate.state === 'saved') acceptSavedResult(candidate.result)
        else if (candidate.state === 'error') {
          finish(() => reject(new DesktopProRenderError(candidate.error.code, candidate.error.message)))
        }
      }).catch(() => fail(new DesktopProRenderError(
        'render-failed',
        'Rasterform could not confirm Pro render cancellation.',
      ), false))
    }
    const handleEvent = (candidate: DesktopProRenderEvent) => {
      if (!isDesktopProRenderEvent(candidate)) {
        fail(new DesktopProRenderError('render-failed', 'The desktop runtime sent an invalid Pro render event.'))
        return
      }
      if (candidate.jobId !== jobId) return
      if (candidate.type === 'progress') {
        try {
          options.onProgress?.(candidate.progress)
        } catch {
          fail(new DesktopProRenderError(
            'render-failed',
            'The editor could not process Pro render progress.',
          ))
        }
      }
      else if (candidate.type === 'saved') acceptSavedResult(candidate.result)
      else if (candidate.type === 'cancelled') finish(() => reject(abortError()))
      else finish(() => reject(new DesktopProRenderError(candidate.code, candidate.message)))
    }

    try {
      const registeredUnsubscribe = bridge.onProRenderEvent(handleEvent)
      if (typeof registeredUnsubscribe !== 'function') {
        fail(new DesktopProRenderError('render-failed', 'The desktop runtime did not provide a Pro event subscription.'))
        return
      }
      unsubscribe = registeredUnsubscribe
      if (settled) {
        unsubscribe()
        return
      }
      options.signal?.addEventListener('abort', handleAbort, { once: true })
      if (options.signal?.aborted) {
        handleAbort()
        return
      }
      void Promise.resolve(bridge.submitProRender(jobId, snapshot)).then((candidate) => {
        if (settled) return
        if (!isDesktopProRenderSubmission(candidate)) {
          fail(new DesktopProRenderError('render-failed', 'The desktop runtime returned an invalid Pro acknowledgement.'))
          return
        }
        if (!candidate.accepted) {
          fail(new DesktopProRenderError(candidate.error.code, candidate.error.message), false)
        }
      }).catch(() => fail(new DesktopProRenderError('render-failed', 'Cycles Pro could not be started.')))
    } catch {
      fail(new DesktopProRenderError('render-failed', 'Cycles Pro could not be started.'))
    }
  })
}
