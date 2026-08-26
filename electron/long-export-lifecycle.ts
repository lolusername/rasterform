import type {
  DesktopLongExportOutcome,
  DesktopLongExportStartRequest,
  DesktopLongExportStartResult,
} from '../src/desktop/contracts'

export interface LongExportSleepBlocker {
  start(type: 'prevent-app-suspension'): number
  isStarted(id: number): boolean
  stop(id: number): void
}

export type NativeLongExportDownloadState = 'completed' | 'cancelled' | 'interrupted'

export interface NativeLongExportJob {
  readonly id: string
  readonly ownerWebContentsId: number
  readonly request: DesktopLongExportStartRequest
  readonly sleepBlockerId: number
}

interface ActiveLongExportJob extends NativeLongExportJob {
  rendererOutcome: DesktopLongExportOutcome | null
  ownerDestroyed: boolean
  downloadAttached: boolean
  downloadState: NativeLongExportDownloadState | null
  cancelDownload: (() => void) | null
  completionPromise: Promise<boolean> | null
  resolveCompletion: ((completed: boolean) => void) | null
  handshakeTimer: ReturnType<typeof setTimeout> | null
}

const DEFAULT_DOWNLOAD_HANDSHAKE_TIMEOUT_MS = 10_000

export interface NativeLongExportLifecycleOptions {
  downloadHandshakeTimeoutMs?: number
  setBackgroundThrottling?: (allowed: boolean) => void
}

/**
 * Owns only native lifecycle protection. Frame rendering and archive bytes stay
 * in the shared renderer and never enter this object or Electron IPC.
 *
 * A successful renderer outcome is not terminal until Electron's DownloadItem
 * reports that the ZIP is fully written. This keeps sleep and close protection
 * active during a multi-gigabyte browser download without transferring bytes.
 */
export class NativeLongExportLifecycle {
  private current: ActiveLongExportJob | null = null

  constructor(
    private readonly sleepBlocker: LongExportSleepBlocker,
    options: NativeLongExportLifecycleOptions = {},
  ) {
    this.downloadHandshakeTimeoutMs = options.downloadHandshakeTimeoutMs
      ?? DEFAULT_DOWNLOAD_HANDSHAKE_TIMEOUT_MS
    this.setBackgroundThrottling = options.setBackgroundThrottling ?? (() => undefined)
  }

  private readonly downloadHandshakeTimeoutMs: number
  private readonly setBackgroundThrottling: (allowed: boolean) => void

  get active(): NativeLongExportJob | null {
    return this.current
  }

  begin(
    ownerWebContentsId: number,
    request: DesktopLongExportStartRequest,
    createJobId: () => string,
  ): DesktopLongExportStartResult {
    if (this.current) {
      return {
        accepted: false,
        error: {
          code: 'busy',
          message: 'Another long export is already active.',
        },
      }
    }

    // Resolve the opaque ID before acquiring native resources so even an
    // unexpected ID-provider failure cannot leak a sleep blocker.
    const jobId = createJobId()
    let sleepBlockerId = -1
    try {
      sleepBlockerId = this.sleepBlocker.start('prevent-app-suspension')
      if (!this.sleepBlocker.isStarted(sleepBlockerId)) {
        try {
          this.sleepBlocker.stop(sleepBlockerId)
        } catch {
          // A failed start has no lifecycle resource that can be relied upon.
        }
        throw new Error('Sleep blocker did not start.')
      }
      // Electron's power blocker prevents App Nap/system suspension, while
      // Chromium throttling is a separate renderer scheduling policy.
      this.setBackgroundThrottling(false)
    } catch {
      try {
        if (sleepBlockerId >= 0 && this.sleepBlocker.isStarted(sleepBlockerId)) {
          this.sleepBlocker.stop(sleepBlockerId)
        }
      } catch {
        // Best-effort rollback of a partially acquired native lifecycle.
      }
      try {
        this.setBackgroundThrottling(true)
      } catch {
        // The renderer may have disappeared while protection was starting.
      }
      return {
        accepted: false,
        error: {
          code: 'sleep-protection-failed',
          message: 'Rasterform could not protect this long export from app suspension.',
        },
      }
    }

    const job: ActiveLongExportJob = {
      id: jobId,
      ownerWebContentsId,
      request: Object.freeze({ ...request }),
      sleepBlockerId,
      rendererOutcome: null,
      ownerDestroyed: false,
      downloadAttached: false,
      downloadState: null,
      cancelDownload: null,
      completionPromise: null,
      resolveCompletion: null,
      handshakeTimer: null,
    }
    this.current = job
    return { accepted: true, jobId: job.id }
  }

  attachDownload(
    ownerWebContentsId: number,
    jobId: string,
    cancelDownload: () => void,
  ): boolean {
    const job = this.current
    if (!job
      || job.id !== jobId
      || job.ownerWebContentsId !== ownerWebContentsId
      || job.downloadAttached
      || job.downloadState) return false
    job.downloadAttached = true
    job.cancelDownload = cancelDownload
    this.clearHandshakeTimer(job)
    return true
  }

  finishDownload(jobId: string, state: NativeLongExportDownloadState): boolean {
    const job = this.current
    if (!job || job.id !== jobId || !job.downloadAttached || job.downloadState) return false
    job.downloadState = state
    job.cancelDownload = null
    if (job.rendererOutcome === 'completed') {
      this.settle(job, state === 'completed')
    } else if (job.ownerDestroyed) {
      this.release(job)
    } else {
      // The DownloadItem event and renderer completion IPC can cross. Bound
      // only that handshake, never rendering or file-writing time.
      this.scheduleHandshakeTimeout(job)
    }
    return true
  }

  end(
    ownerWebContentsId: number,
    jobId: string,
    outcome: DesktopLongExportOutcome,
  ): Promise<boolean> {
    const job = this.current
    if (!job || job.id !== jobId || job.ownerWebContentsId !== ownerWebContentsId) {
      return Promise.resolve(false)
    }
    if (job.rendererOutcome) return job.completionPromise ?? Promise.resolve(false)
    job.rendererOutcome = outcome

    if (outcome !== 'completed') {
      this.cancelAttachedDownload(job)
      this.release(job)
      return Promise.resolve(true)
    }
    if (job.downloadState) {
      const completed = job.downloadState === 'completed'
      this.release(job)
      return Promise.resolve(completed)
    }

    job.completionPromise = new Promise<boolean>((resolve) => {
      job.resolveCompletion = resolve
    })
    if (!job.downloadAttached) this.scheduleHandshakeTimeout(job)
    return job.completionPromise
  }

  /** Renderer crashes retain protection only for a DownloadItem already writing. */
  releaseOwner(ownerWebContentsId: number): boolean {
    const job = this.current
    if (!job || job.ownerWebContentsId !== ownerWebContentsId) return false
    job.ownerDestroyed = true
    if (job.downloadAttached && !job.downloadState) return true
    this.release(job)
    return true
  }

  /** Explicit user-approved close: cancel any active download and release now. */
  releaseActive(cancelDownload = false): boolean {
    const job = this.current
    if (!job) return false
    if (cancelDownload) this.cancelAttachedDownload(job)
    this.release(job)
    return true
  }

  private cancelAttachedDownload(job: ActiveLongExportJob): void {
    const cancel = job.cancelDownload
    job.cancelDownload = null
    if (!cancel || job.downloadState) return
    try {
      cancel()
    } catch {
      // DownloadItem may have become terminal between checks.
    }
  }

  private scheduleHandshakeTimeout(job: ActiveLongExportJob): void {
    this.clearHandshakeTimer(job)
    job.handshakeTimer = setTimeout(() => {
      if (this.current !== job) return
      if (job.rendererOutcome === 'completed' && job.downloadState === 'completed') {
        this.settle(job, true)
      } else {
        this.settle(job, false)
      }
    }, this.downloadHandshakeTimeoutMs)
    job.handshakeTimer.unref?.()
  }

  private clearHandshakeTimer(job: ActiveLongExportJob): void {
    if (!job.handshakeTimer) return
    clearTimeout(job.handshakeTimer)
    job.handshakeTimer = null
  }

  private settle(job: ActiveLongExportJob, completed: boolean): void {
    const resolve = job.resolveCompletion
    job.resolveCompletion = null
    this.release(job)
    resolve?.(completed)
  }

  private release(job: ActiveLongExportJob): void {
    if (this.current !== job) return
    this.clearHandshakeTimer(job)
    this.current = null
    const resolve = job.resolveCompletion
    job.resolveCompletion = null
    resolve?.(false)
    try {
      if (this.sleepBlocker.isStarted(job.sleepBlockerId)) {
        this.sleepBlocker.stop(job.sleepBlockerId)
      }
    } catch {
      // Renderer destruction and app shutdown cleanup must remain best-effort.
    }
    try {
      this.setBackgroundThrottling(true)
    } catch {
      // The renderer may already be destroyed; there is nothing left to throttle.
    }
  }
}
