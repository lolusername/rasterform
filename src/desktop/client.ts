import type * as THREE from 'three'
import type {
  AppearanceSettings,
  ImageExportBackground,
  MeshData,
  ViewportBackground,
} from '../types'
import { finalSampleTarget, type FinalExportProgress } from '../lib/final-image-export'
import { finalTileCount } from '../lib/final-quality'
import { snapshotCamera, snapshotMesh } from '../lib/image-export-worker'
import { PNG_DPI } from '../lib/viewport-export'
import {
  DESKTOP_LONG_EXPORT_PROTOCOL_VERSION,
  DESKTOP_PROTOCOL_VERSION,
  assertDesktopFinalRenderSnapshot,
  isDesktopFinalCancelResult,
  isDesktopFinalRenderSubmission,
  isDesktopLongExportEndResult,
  isDesktopLongExportStartRequest,
  isDesktopLongExportStartResult,
  isDesktopPngName,
  isDesktopRenderEvent,
  isDesktopSavePreparation,
  isRasterformDesktopBridge,
  isRasterformDesktopLongExportBridge,
  type DesktopFinalColorMode,
  type DesktopFinalCancelResult,
  type DesktopFinalCaptureResult,
  type DesktopFinalRenderSnapshot,
  type DesktopLongExportErrorCode,
  type DesktopLongExportOutcome,
  type DesktopSavedFinalResult,
  type DesktopRenderErrorCode,
  type DesktopRenderEvent,
  type RasterformDesktopBridge,
  type RasterformDesktopLongExportBridge,
} from './contracts'

export type { DesktopFinalCaptureResult } from './contracts'

interface DesktopWindow {
  rasterformDesktop?: unknown
}

export interface CreateDesktopFinalRenderSnapshotOptions {
  mesh: MeshData
  camera: THREE.PerspectiveCamera
  colorMode: DesktopFinalColorMode
  appearance: AppearanceSettings
  width: number
  height: number
  background: ImageExportBackground
  studioBackground: ViewportBackground
}

export interface RenderFinalImageInDesktopOptions extends CreateDesktopFinalRenderSnapshotOptions {
  suggestedName: string
  signal?: AbortSignal
  onProgress?: (progress: FinalExportProgress) => void
  /** Test/integration injection; omitted means discover the optional window bridge. */
  bridge?: RasterformDesktopBridge | null
}

export interface BeginDesktopLongExportOptions {
  frames: number
  /** Test/integration injection; omitted means discover the optional window bridge. */
  bridge?: RasterformDesktopLongExportBridge | null
}

export interface DesktopLongExportSession {
  readonly jobId: string
}

export class DesktopFinalRenderError extends Error {
  readonly code: DesktopRenderErrorCode

  constructor(code: DesktopRenderErrorCode, message: string) {
    super(message)
    this.name = 'DesktopFinalRenderError'
    this.code = code
  }
}

export class DesktopLongExportError extends Error {
  readonly code: DesktopLongExportErrorCode

  constructor(code: DesktopLongExportErrorCode, message: string) {
    super(message)
    this.name = 'DesktopLongExportError'
    this.code = code
  }
}

const longExportSessionBridges = new WeakMap<DesktopLongExportSession, RasterformDesktopLongExportBridge>()

function abortError(): DOMException {
  return new DOMException('Final image export cancelled.', 'AbortError')
}

function cancelWithoutWaiting(bridge: RasterformDesktopBridge, jobId: string): void {
  try {
    void Promise.resolve(bridge.cancelFinalRender(jobId)).catch(() => undefined)
  } catch {
    // Cancellation is best-effort after the caller-facing operation settles.
  }
}

export function rasterformDesktopBridge(): RasterformDesktopBridge | null {
  if (typeof window === 'undefined') return null
  const candidate = (window as unknown as DesktopWindow).rasterformDesktop
  if (candidate === undefined) return null
  if (!isRasterformDesktopBridge(candidate)) {
    throw new DesktopFinalRenderError(
      'render-failed',
      'This Rasterform desktop runtime uses an unsupported render protocol.',
    )
  }
  return candidate
}

export function rasterformDesktopLongExportBridge(): RasterformDesktopLongExportBridge | null {
  if (typeof window === 'undefined') return null
  const candidate = (window as unknown as DesktopWindow).rasterformDesktop
  if (candidate === undefined) return null
  // An older Final-v1 desktop remains valid; it simply uses the shared web
  // fallback for this independently versioned optional lifecycle.
  if (isRasterformDesktopBridge(candidate) && !isRasterformDesktopLongExportBridge(candidate)) return null
  if (!isRasterformDesktopLongExportBridge(candidate)) {
    throw new DesktopLongExportError(
      'invalid-request',
      'This Rasterform desktop runtime uses an unsupported long-export protocol.',
    )
  }
  return candidate
}

/**
 * Ask the optional desktop shell to protect a shared Living Loop render from
 * app suspension. Null means the ordinary browser path should continue.
 */
export async function beginDesktopLongExport(
  options: BeginDesktopLongExportOptions,
): Promise<DesktopLongExportSession | null> {
  const bridge = options.bridge === undefined ? rasterformDesktopLongExportBridge() : options.bridge
  if (!bridge) return null
  const request = {
    protocolVersion: DESKTOP_LONG_EXPORT_PROTOCOL_VERSION,
    kind: 'living-loop',
    frames: options.frames,
  } as const
  if (!isDesktopLongExportStartRequest(request)) {
    throw new DesktopLongExportError(
      'invalid-request',
      'The Living Loop frame count is outside the native lifecycle contract.',
    )
  }

  let candidate: unknown
  try {
    candidate = await bridge.beginLongExport(request)
  } catch {
    throw new DesktopLongExportError(
      'invalid-request',
      'The desktop runtime could not start Living Loop protection.',
    )
  }
  if (!isDesktopLongExportStartResult(candidate)) {
    throw new DesktopLongExportError(
      'invalid-request',
      'The desktop runtime returned an invalid long-export acknowledgement.',
    )
  }
  if (!candidate.accepted) {
    throw new DesktopLongExportError(candidate.error.code, candidate.error.message)
  }
  const session: DesktopLongExportSession = Object.freeze({ jobId: candidate.jobId })
  longExportSessionBridges.set(session, bridge)
  return session
}

/** Release native protection. No frame or archive bytes cross this boundary. */
export async function endDesktopLongExport(
  session: DesktopLongExportSession | null,
  outcome: DesktopLongExportOutcome,
): Promise<boolean> {
  if (!session) return false
  const bridge = longExportSessionBridges.get(session)
  if (!bridge) {
    throw new DesktopLongExportError('invalid-request', 'The long-export session is not active.')
  }

  let candidate: unknown
  try {
    candidate = await bridge.endLongExport(session.jobId, outcome)
  } catch {
    throw new DesktopLongExportError(
      'invalid-request',
      'The desktop runtime could not end Living Loop protection.',
    )
  }
  if (!isDesktopLongExportEndResult(candidate)) {
    throw new DesktopLongExportError(
      'invalid-request',
      'The desktop runtime returned an invalid long-export completion acknowledgement.',
    )
  }
  longExportSessionBridges.delete(session)
  return candidate.ended
}

export function createDesktopFinalRenderSnapshot(
  options: CreateDesktopFinalRenderSnapshotOptions,
): DesktopFinalRenderSnapshot {
  const snapshot: DesktopFinalRenderSnapshot = {
    protocolVersion: DESKTOP_PROTOCOL_VERSION,
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
  }
  assertDesktopFinalRenderSnapshot(snapshot)
  return snapshot
}

async function prepareSaveWithAbort(
  bridge: RasterformDesktopBridge,
  suggestedName: string,
  signal?: AbortSignal,
) {
  if (signal?.aborted) throw abortError()
  const preparation = Promise.resolve(bridge.prepareFinalSave(suggestedName))
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

/**
 * Ask the native shell for a destination and run Final in the desktop render
 * process. A null result means there is no desktop bridge, so callers should
 * continue through the existing browser renderer unchanged.
 */
export async function renderFinalImageInDesktop(
  options: RenderFinalImageInDesktopOptions,
): Promise<DesktopFinalCaptureResult | null> {
  const bridge = options.bridge === undefined ? rasterformDesktopBridge() : options.bridge
  if (!bridge) return null
  if (!isDesktopPngName(options.suggestedName)) {
    throw new DesktopFinalRenderError(
      'save-failed',
      'The suggested Final render name was not a valid PNG filename.',
    )
  }
  if (options.signal?.aborted) throw abortError()

  let snapshot: DesktopFinalRenderSnapshot
  try {
    snapshot = createDesktopFinalRenderSnapshot(options)
  } catch {
    throw new DesktopFinalRenderError(
      'render-failed',
      'The current model could not be prepared for the separate Final renderer.',
    )
  }
  let prepared: Awaited<ReturnType<RasterformDesktopBridge['prepareFinalSave']>>
  try {
    prepared = await prepareSaveWithAbort(bridge, options.suggestedName, options.signal)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new DesktopFinalRenderError('save-failed', 'The macOS Save dialog could not be opened.')
  }
  if (!isDesktopSavePreparation(prepared)) {
    throw new DesktopFinalRenderError('save-failed', 'The macOS Save dialog returned an invalid destination.')
  }
  if (prepared.cancelled) throw abortError()
  const { jobId } = prepared
  if (options.signal?.aborted) {
    cancelWithoutWaiting(bridge, jobId)
    throw abortError()
  }

  return new Promise<DesktopFinalCaptureResult>((resolve, reject) => {
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
        // A broken cleanup hook must not keep the caller's promise pending.
      }
      callback()
    }
    const fail = (error: unknown, cancel = true) => {
      if (settled) return
      if (cancel) cancelWithoutWaiting(bridge, jobId)
      finish(() => reject(error))
    }
    const acceptSavedResult = (result: DesktopSavedFinalResult) => {
      const expectedSamples = finalSampleTarget(snapshot.colorMode, snapshot.appearance)
      if (result.width !== snapshot.width
        || result.height !== snapshot.height
        || result.dpi !== PNG_DPI
        || result.samples !== expectedSamples
        || result.tiles !== finalTileCount(snapshot.width, snapshot.height)) {
        fail(new DesktopFinalRenderError(
          'render-failed',
          'The desktop Final render did not preserve the requested output contract.',
        ))
        return
      }
      finish(() => resolve({ desktopSaved: true, ...result }))
    }
    const handleCancellationResult = (candidate: DesktopFinalCancelResult) => {
      if (settled) return
      switch (candidate.state) {
        case 'cancelling':
        case 'saving':
          // Rendering cancellation completes with an event. Saving is an
          // intentionally non-cancellable terminal phase and must report the
          // actual saved/save-failed outcome instead of a false cancellation.
          break
        case 'cancelled':
          finish(() => reject(abortError()))
          break
        case 'saved':
          acceptSavedResult(candidate.result)
          break
        case 'error':
          finish(() => reject(new DesktopFinalRenderError(
            candidate.error.code,
            candidate.error.message,
          )))
          break
      }
    }
    const handleAbort = () => {
      if (settled || cancellationRequested) return
      cancellationRequested = true
      let cancellation: Promise<DesktopFinalCancelResult>
      try {
        cancellation = bridge.cancelFinalRender(jobId)
      } catch {
        fail(new DesktopFinalRenderError(
          'render-failed',
          'Rasterform could not send the Final render cancellation request.',
        ), false)
        return
      }
      void Promise.resolve(cancellation).then((candidate) => {
        if (settled) return
        if (!isDesktopFinalCancelResult(candidate)) {
          fail(new DesktopFinalRenderError(
            'render-failed',
            'The desktop runtime returned an invalid cancellation response.',
          ), false)
          return
        }
        handleCancellationResult(candidate)
      }).catch(() => fail(new DesktopFinalRenderError(
        'render-failed',
        'Rasterform could not confirm the Final render cancellation request.',
      ), false))
    }
    const handleEvent = (candidate: DesktopRenderEvent) => {
      if (!isDesktopRenderEvent(candidate)) {
        fail(new DesktopFinalRenderError(
          'render-failed',
          'The desktop runtime sent an invalid Final render event.',
        ))
        return
      }
      if (candidate.jobId !== jobId) return
      switch (candidate.type) {
        case 'progress':
          try {
            options.onProgress?.(candidate.progress)
          } catch {
            fail(new DesktopFinalRenderError(
              'render-failed',
              'The editor could not process Final render progress.',
            ))
          }
          break
        case 'saved': {
          acceptSavedResult(candidate.result)
          break
        }
        case 'cancelled':
          finish(() => reject(abortError()))
          break
        case 'error':
          finish(() => reject(new DesktopFinalRenderError(candidate.code, candidate.message)))
          break
      }
    }

    try {
      const registeredUnsubscribe = bridge.onFinalRenderEvent(handleEvent)
      if (typeof registeredUnsubscribe !== 'function') {
        fail(new DesktopFinalRenderError(
          'render-failed',
          'The desktop runtime did not provide a valid Final render event subscription.',
        ))
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
      const submission = bridge.submitFinalRender(jobId, snapshot)
      void Promise.resolve(submission).then((candidate) => {
        if (settled) return
        if (!isDesktopFinalRenderSubmission(candidate)) {
          fail(new DesktopFinalRenderError(
            'render-failed',
            'The desktop runtime returned an invalid Final render acknowledgement.',
          ))
          return
        }
        if (!candidate.accepted) {
          fail(new DesktopFinalRenderError(candidate.error.code, candidate.error.message), false)
        }
      }).catch(() => fail(new DesktopFinalRenderError(
        'render-failed',
        'The separate Final renderer could not be started.',
      )))
    } catch {
      fail(new DesktopFinalRenderError(
        'render-failed',
        'The separate Final renderer could not be started.',
      ))
    }
  })
}
