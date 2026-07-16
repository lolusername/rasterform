import { describe, expect, it, vi } from 'vitest'
import { ProgressiveRenderController } from './progressive-render'
import type { ProgressiveRenderBackend, ProgressiveRenderSnapshot } from './progressive-render'

function backend(step = 1): ProgressiveRenderBackend & { disposed: boolean; cameraUpdates: number } {
  let samples = 0
  let disposed = false
  let cameraUpdates = 0
  return {
    get samples() { return samples },
    pausePathTracing: false,
    get disposed() { return disposed },
    get cameraUpdates() { return cameraUpdates },
    renderSample() { samples += step },
    updateCamera() { samples = 0; cameraUpdates += 1 },
    reset() { samples = 0 },
    dispose() { disposed = true },
  }
}

describe('progressive render controller', () => {
  it('moves from preparation through accumulation to a bounded complete state', () => {
    const snapshots: ProgressiveRenderSnapshot[] = []
    const render = backend(1)
    const controller = new ProgressiveRenderController(3, (snapshot) => snapshots.push(snapshot))

    controller.beginPreparing()
    controller.updatePreparation(0.4)
    controller.attach(render)
    controller.tick()
    controller.tick()
    controller.tick()
    controller.tick()

    expect(snapshots.map(({ state }) => state)).toContain('preparing')
    expect(controller.snapshot).toMatchObject({ state: 'complete', samples: 3, targetSamples: 3 })
    expect(render.pausePathTracing).toBe(true)
  })

  it('restarts accumulation when the camera changes', () => {
    const render = backend()
    const controller = new ProgressiveRenderController(4, vi.fn())
    controller.attach(render)
    controller.tick()
    controller.tick()
    controller.invalidateCamera()

    expect(controller.snapshot).toMatchObject({ state: 'rendering', samples: 0 })
    expect(render.cameraUpdates).toBe(1)
    expect(render.pausePathTracing).toBe(false)
  })

  it('disposes stale backends on replacement, failure, and final disposal', () => {
    const first = backend()
    const second = backend()
    const controller = new ProgressiveRenderController(2, vi.fn())
    controller.attach(first)
    controller.attach(second)
    expect(first.disposed).toBe(true)

    controller.fail(new Error('WebGL2 unavailable'))
    expect(second.disposed).toBe(true)
    expect(controller.snapshot).toMatchObject({ state: 'error', error: 'WebGL2 unavailable' })

    const stale = backend()
    controller.dispose()
    controller.attach(stale)
    expect(stale.disposed).toBe(true)
  })
})
