export type ProgressiveRenderState = 'idle' | 'preparing' | 'rendering' | 'complete' | 'error'

export interface ProgressiveRenderSnapshot {
  state: ProgressiveRenderState
  samples: number
  targetSamples: number
  preparation: number
  error: string
}

export interface ProgressiveRenderBackend {
  readonly samples: number
  pausePathTracing: boolean
  renderSample: () => void
  updateCamera: () => void
  reset: () => void
  dispose: () => void
}

/**
 * Small renderer-agnostic state machine for a progressive accumulation pass.
 * WebGL ownership remains in the Vue component while this class keeps lifecycle
 * transitions deterministic and unit-testable.
 */
export class ProgressiveRenderController {
  private backend: ProgressiveRenderBackend | null = null
  private disposed = false
  private current: ProgressiveRenderSnapshot

  constructor(
    targetSamples: number,
    private readonly onChange: (snapshot: ProgressiveRenderSnapshot) => void,
  ) {
    this.current = {
      state: 'idle',
      samples: 0,
      targetSamples: Math.max(1, Math.round(targetSamples)),
      preparation: 0,
      error: '',
    }
  }

  get snapshot(): ProgressiveRenderSnapshot {
    return { ...this.current }
  }

  beginPreparing(): void {
    if (this.disposed) return
    this.releaseBackend()
    this.publish({ state: 'preparing', samples: 0, preparation: 0, error: '' })
  }

  updatePreparation(value: number): void {
    if (this.disposed || this.current.state !== 'preparing') return
    this.publish({ preparation: Math.min(1, Math.max(0, value)) })
  }

  attach(backend: ProgressiveRenderBackend): void {
    if (this.disposed) {
      backend.dispose()
      return
    }
    this.releaseBackend()
    this.backend = backend
    backend.pausePathTracing = false
    backend.reset()
    this.publish({ state: 'rendering', samples: 0, preparation: 1, error: '' })
  }

  tick(): void {
    if (this.disposed || this.current.state !== 'rendering' || !this.backend) return
    this.backend.renderSample()
    const samples = Math.min(this.current.targetSamples, Math.max(0, Math.floor(this.backend.samples)))
    if (samples >= this.current.targetSamples) {
      this.backend.pausePathTracing = true
      this.publish({ state: 'complete', samples })
    } else if (samples !== this.current.samples) {
      this.publish({ samples })
    }
  }

  invalidateCamera(): void {
    if (this.disposed || !this.backend) return
    this.backend.pausePathTracing = false
    this.backend.updateCamera()
    this.publish({ state: 'rendering', samples: 0, error: '' })
  }

  fail(error: unknown): void {
    if (this.disposed) return
    this.releaseBackend()
    const message = error instanceof Error ? error.message : String(error || 'Final render failed.')
    this.publish({ state: 'error', samples: 0, preparation: 0, error: message })
  }

  stop(): void {
    if (this.disposed) return
    this.releaseBackend()
    this.publish({ state: 'idle', samples: 0, preparation: 0, error: '' })
  }

  dispose(): void {
    if (this.disposed) return
    this.releaseBackend()
    this.disposed = true
  }

  private releaseBackend(): void {
    this.backend?.dispose()
    this.backend = null
  }

  private publish(update: Partial<ProgressiveRenderSnapshot>): void {
    this.current = { ...this.current, ...update }
    this.onChange(this.snapshot)
  }
}
