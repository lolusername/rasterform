import { describe, expect, it, vi } from 'vitest'
import type { Camera, Scene } from 'three'
import type { BVHWorker, WebGLPathTracer } from 'three-gpu-pathtracer'
import { buildPathTracingScene } from './path-tracer-setup'

function fixtures(reject = false) {
  const events: string[] = []
  const worker = {
    generate: vi.fn(),
    dispose: vi.fn(() => events.push('dispose-worker')),
  }
  const tracer = {
    setBVHWorker: vi.fn(() => events.push('set-worker')),
    setSceneAsync: vi.fn(async () => {
      events.push('build-scene')
      if (reject) throw new Error('BVH failed')
    }),
  }

  return {
    events,
    worker: worker as unknown as BVHWorker & { dispose: () => void },
    tracer: tracer as unknown as WebGLPathTracer,
  }
}

describe('path tracer scene setup', () => {
  it('registers the worker before starting the asynchronous scene build', async () => {
    const { events, tracer, worker } = fixtures()

    await buildPathTracingScene(
      tracer,
      worker,
      {} as Scene,
      {} as Camera,
      vi.fn(),
    )

    expect(events).toEqual(['set-worker', 'build-scene', 'dispose-worker'])
  })

  it('always disposes the externally owned worker when scene generation fails', async () => {
    const { events, tracer, worker } = fixtures(true)

    await expect(buildPathTracingScene(
      tracer,
      worker,
      {} as Scene,
      {} as Camera,
      vi.fn(),
    )).rejects.toThrow('BVH failed')

    expect(events).toEqual(['set-worker', 'build-scene', 'dispose-worker'])
  })

  it('disposes the worker even when worker registration itself fails', async () => {
    const worker = { generate: vi.fn(), dispose: vi.fn() }
    const tracer = {
      setBVHWorker: vi.fn(() => { throw new Error('Worker unavailable') }),
      setSceneAsync: vi.fn(),
    }

    await expect(buildPathTracingScene(
      tracer as unknown as WebGLPathTracer,
      worker as unknown as BVHWorker & { dispose: () => void },
      {} as Scene,
      {} as Camera,
      vi.fn(),
    )).rejects.toThrow('Worker unavailable')

    expect(worker.dispose).toHaveBeenCalledOnce()
    expect(tracer.setSceneAsync).not.toHaveBeenCalled()
  })
})
