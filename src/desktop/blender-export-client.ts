import { heightGradientColors } from '../lib/three'
import type { AppearanceSettings, MeshData } from '../types'
import type { DesktopRenderErrorCode } from './contracts'
import {
  DESKTOP_BLENDER_EXPORT_PROTOCOL_VERSION,
  assertDesktopBlenderExportSnapshot,
  isDesktopBlendName,
  isDesktopBlenderExportCancelResult,
  isDesktopBlenderExportEvent,
  isDesktopBlenderExportSubmission,
  isDesktopSavePreparation,
  isRasterformDesktopBlenderExportBridge,
  type DesktopBlenderColorMode,
  type DesktopBlenderExportCaptureResult,
  type DesktopBlenderExportCancelResult,
  type DesktopBlenderExportEvent,
  type DesktopBlenderExportPhase,
  type DesktopBlenderExportSnapshot,
  type DesktopBlenderTopology,
  type DesktopSavedBlenderExportResult,
  type RasterformDesktopBlenderExportBridge,
} from './blender-export-contracts'

interface DesktopWindow {
  rasterformDesktop?: unknown
}

export interface CreateDesktopBlenderExportSnapshotOptions {
  mesh: MeshData
  colorMode: DesktopBlenderColorMode
  appearance: AppearanceSettings
  topology: DesktopBlenderTopology
  /** The caller already owns these arrays and will never mutate them again. */
  ownedMeshSnapshot?: boolean
}

export interface ExportBlenderProjectInDesktopOptions
  extends CreateDesktopBlenderExportSnapshotOptions {
  suggestedName: string
  /** Deferred until the native Save dialog is accepted. */
  prepareMesh?: () => Pick<CreateDesktopBlenderExportSnapshotOptions, 'mesh' | 'ownedMeshSnapshot'>
  signal?: AbortSignal
  onProgress?: (phase: DesktopBlenderExportPhase) => void
  bridge?: RasterformDesktopBlenderExportBridge | null
}

export class DesktopBlenderExportError extends Error {
  readonly code: DesktopRenderErrorCode

  constructor(code: DesktopRenderErrorCode, message: string) {
    super(message)
    this.name = 'DesktopBlenderExportError'
    this.code = code
  }
}

function abortError(): DOMException {
  return new DOMException('Blender project export cancelled.', 'AbortError')
}

function bridgeFromWindow(): RasterformDesktopBlenderExportBridge | null {
  if (typeof window === 'undefined') return null
  const candidate = (window as unknown as DesktopWindow).rasterformDesktop
  return isRasterformDesktopBlenderExportBridge(candidate) ? candidate : null
}

function cancelWithoutWaiting(
  bridge: RasterformDesktopBlenderExportBridge,
  jobId: string,
): void {
  try {
    void Promise.resolve(bridge.cancelBlenderExport(jobId)).catch(() => undefined)
  } catch {
    // Best-effort after the caller-facing operation has already settled.
  }
}

export function desktopBlenderExporterAvailable(): boolean {
  return Boolean(bridgeFromWindow())
}

export function createDesktopBlenderExportSnapshot(
  options: CreateDesktopBlenderExportSnapshotOptions,
): DesktopBlenderExportSnapshot {
  const copy = <T extends Float32Array | Uint32Array>(values: T): T => (
    options.ownedMeshSnapshot ? values : values.slice() as T
  )
  // The native manifest deliberately carries one final display-color buffer.
  // This keeps the Blender script small and makes Original/Height round-trip
  // through exactly the same POINT color attribute.
  const colors = options.colorMode === 'height'
    ? heightGradientColors(options.mesh.heights, options.appearance.heightGradient)
    : copy(options.mesh.colors)
  const mesh = {
    positions: copy(options.mesh.positions),
    indices: copy(options.mesh.indices),
    colors,
    uvs: copy(options.mesh.uvs),
    width: options.mesh.width,
    height: options.mesh.height,
    mode: options.mesh.mode,
  }
  const snapshot: DesktopBlenderExportSnapshot = {
    protocolVersion: DESKTOP_BLENDER_EXPORT_PROTOCOL_VERSION,
    mesh,
    colorMode: options.colorMode,
    appearance: {
      heightGradient: { ...options.appearance.heightGradient },
      clay: { ...options.appearance.clay },
    },
    settings: { topology: options.topology },
  }
  assertDesktopBlenderExportSnapshot(snapshot)
  return snapshot
}

async function prepareSaveWithAbort(
  bridge: RasterformDesktopBlenderExportBridge,
  suggestedName: string,
  signal?: AbortSignal,
) {
  if (signal?.aborted) throw abortError()
  const preparation = Promise.resolve(bridge.prepareBlenderExport(suggestedName))
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

export async function exportBlenderProjectInDesktop(
  options: ExportBlenderProjectInDesktopOptions,
): Promise<DesktopBlenderExportCaptureResult> {
  const bridge = options.bridge === undefined ? bridgeFromWindow() : options.bridge
  if (!bridge) {
    throw new DesktopBlenderExportError(
      'render-failed',
      'Blender project export is available in Rasterform desktop when Blender 5.2 or newer is installed.',
    )
  }
  if (!isDesktopBlendName(options.suggestedName)) {
    throw new DesktopBlenderExportError(
      'save-failed',
      'The suggested Blender project name was not a .blend filename.',
    )
  }
  if (options.signal?.aborted) throw abortError()

  let prepared: unknown
  try {
    prepared = await prepareSaveWithAbort(bridge, options.suggestedName, options.signal)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new DesktopBlenderExportError(
      'save-failed',
      'The macOS Blender project Save dialog could not be opened.',
    )
  }
  if (!isDesktopSavePreparation(prepared)) {
    throw new DesktopBlenderExportError(
      'save-failed',
      'The macOS Blender project Save dialog returned an invalid destination.',
    )
  }
  if (prepared.cancelled) throw abortError()
  const { jobId } = prepared
  if (options.signal?.aborted) {
    cancelWithoutWaiting(bridge, jobId)
    throw abortError()
  }

  let snapshot: DesktopBlenderExportSnapshot
  try {
    // Do the potentially large immutable copy only after the user accepts the
    // Save dialog. Living Form callers can hand over a mesh they already own.
    const preparedMesh = options.prepareMesh?.()
    snapshot = createDesktopBlenderExportSnapshot(preparedMesh
      ? { ...options, ...preparedMesh }
      : options)
  } catch {
    cancelWithoutWaiting(bridge, jobId)
    throw new DesktopBlenderExportError(
      'render-failed',
      'The current model could not be prepared for Blender project export.',
    )
  }

  return new Promise<DesktopBlenderExportCaptureResult>((resolve, reject) => {
    let settled = false
    let cancellationRequested = false
    let cancellationPolls = 0
    let cancellationPollTimer: ReturnType<typeof setTimeout> | null = null
    let unsubscribe: () => void = () => undefined

    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      if (cancellationPollTimer !== null) clearTimeout(cancellationPollTimer)
      options.signal?.removeEventListener('abort', handleAbort)
      try {
        unsubscribe()
      } catch {
        // A broken cleanup hook must not keep the export pending.
      }
      callback()
    }
    const fail = (error: unknown, cancel = true) => {
      if (settled) return
      if (cancel) cancelWithoutWaiting(bridge, jobId)
      finish(() => reject(error))
    }
    const acceptSavedResult = (result: DesktopSavedBlenderExportResult) => {
      const expectedFaces = snapshot.mesh.indices.length / 3
      const expectedVertices = snapshot.mesh.positions.length / 3
      if (result.topology !== snapshot.settings.topology
        || result.sourceFaces !== expectedFaces
        || result.sourceVertices !== expectedVertices) {
        fail(new DesktopBlenderExportError(
          'render-failed',
          'Blender changed the requested project export contract.',
        ))
        return
      }
      finish(() => resolve({ desktopSaved: true, ...result }))
    }
    const acceptCancellation = (candidate: DesktopBlenderExportCancelResult) => {
      if (settled) return
      if (candidate.state === 'cancelled') finish(() => reject(abortError()))
      else if (candidate.state === 'saved') acceptSavedResult(candidate.result)
      else if (candidate.state === 'error') {
        finish(() => reject(new DesktopBlenderExportError(
          candidate.error.code,
          candidate.error.message,
        )))
      } else if (cancellationPolls >= 40) {
        fail(new DesktopBlenderExportError(
          'process-gone',
          'Rasterform could not confirm that the Blender export stopped.',
        ), false)
      } else {
        cancellationPolls += 1
        cancellationPollTimer = setTimeout(requestCancellationStatus, 1_500)
      }
    }
    const requestCancellationStatus = () => {
      if (settled) return
      let cancellation: Promise<DesktopBlenderExportCancelResult>
      try {
        cancellation = bridge.cancelBlenderExport(jobId)
      } catch {
        fail(new DesktopBlenderExportError(
          'render-failed',
          'Rasterform could not send the Blender export cancellation request.',
        ), false)
        return
      }
      void Promise.resolve(cancellation).then((candidate) => {
        if (settled) return
        if (!isDesktopBlenderExportCancelResult(candidate)) {
          fail(new DesktopBlenderExportError(
            'render-failed',
            'The Blender exporter returned an invalid cancellation response.',
          ), false)
          return
        }
        acceptCancellation(candidate)
      }).catch(() => fail(new DesktopBlenderExportError(
        'render-failed',
        'Rasterform could not confirm Blender export cancellation.',
      ), false))
    }
    const handleAbort = () => {
      if (settled || cancellationRequested) return
      cancellationRequested = true
      requestCancellationStatus()
    }
    const handleEvent = (candidate: DesktopBlenderExportEvent) => {
      if (!isDesktopBlenderExportEvent(candidate)) {
        fail(new DesktopBlenderExportError(
          'render-failed',
          'The desktop runtime sent an invalid Blender export event.',
        ))
        return
      }
      if (candidate.jobId !== jobId) return
      if (candidate.type === 'progress') {
        try {
          options.onProgress?.(candidate.phase)
        } catch {
          fail(new DesktopBlenderExportError(
            'render-failed',
            'The editor could not process Blender export progress.',
          ))
        }
      } else if (candidate.type === 'saved') acceptSavedResult(candidate.result)
      else if (candidate.type === 'cancelled') finish(() => reject(abortError()))
      else finish(() => reject(new DesktopBlenderExportError(candidate.code, candidate.message)))
    }

    try {
      const registeredUnsubscribe = bridge.onBlenderExportEvent(handleEvent)
      if (typeof registeredUnsubscribe !== 'function') {
        fail(new DesktopBlenderExportError(
          'render-failed',
          'The desktop runtime did not provide a Blender export event subscription.',
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
      void Promise.resolve(bridge.submitBlenderExport(jobId, snapshot)).then((candidate) => {
        if (settled) return
        if (!isDesktopBlenderExportSubmission(candidate)) {
          fail(new DesktopBlenderExportError(
            'render-failed',
            'The desktop runtime returned an invalid Blender export acknowledgement.',
          ))
          return
        }
        if (!candidate.accepted) {
          fail(new DesktopBlenderExportError(candidate.error.code, candidate.error.message), false)
        }
      }).catch(() => fail(new DesktopBlenderExportError(
        'render-failed',
        'Blender project export could not be started.',
      )))
    } catch {
      fail(new DesktopBlenderExportError(
        'render-failed',
        'Blender project export could not be started.',
      ))
    }
  })
}
