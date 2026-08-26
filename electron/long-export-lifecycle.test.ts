import { describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_LONG_EXPORT_PROTOCOL_VERSION,
  type DesktopLongExportStartRequest,
} from '../src/desktop/contracts'
import { NativeLongExportLifecycle, type LongExportSleepBlocker } from './long-export-lifecycle'

function request(frames = 96): DesktopLongExportStartRequest {
  return {
    protocolVersion: DESKTOP_LONG_EXPORT_PROTOCOL_VERSION,
    kind: 'living-loop',
    frames,
  }
}

function harness(started = true) {
  const active = new Set<number>()
  const start = vi.fn(() => {
    const id = 42
    if (started) active.add(id)
    return id
  })
  const stop = vi.fn((id: number) => { active.delete(id) })
  const setBackgroundThrottling = vi.fn()
  const blocker: LongExportSleepBlocker = {
    start,
    stop,
    isStarted: vi.fn((id) => active.has(id)),
  }
  return {
    lifecycle: new NativeLongExportLifecycle(blocker, { setBackgroundThrottling }),
    start,
    stop,
    setBackgroundThrottling,
  }
}

describe('native long-export lifecycle', () => {
  it('holds app suspension protection until both renderer and ZIP download finish', async () => {
    const { lifecycle, start, stop, setBackgroundThrottling } = harness()
    const result = lifecycle.begin(7, request(), () => 'living_job_1')

    expect(result).toEqual({ accepted: true, jobId: 'living_job_1' })
    expect(start).toHaveBeenCalledWith('prevent-app-suspension')
    expect(setBackgroundThrottling).toHaveBeenCalledWith(false)
    expect(lifecycle.active).toMatchObject({
      id: 'living_job_1',
      ownerWebContentsId: 7,
      request: { kind: 'living-loop', frames: 96 },
    })
    await expect(lifecycle.end(8, 'living_job_1', 'completed')).resolves.toBe(false)
    await expect(lifecycle.end(7, 'stale_job', 'completed')).resolves.toBe(false)
    expect(stop).not.toHaveBeenCalled()
    const cancelDownload = vi.fn()
    expect(lifecycle.attachDownload(7, 'living_job_1', cancelDownload)).toBe(true)
    const completion = lifecycle.end(7, 'living_job_1', 'completed')
    await Promise.resolve()
    expect(stop).not.toHaveBeenCalled()
    expect(lifecycle.active?.id).toBe('living_job_1')
    expect(lifecycle.finishDownload('living_job_1', 'completed')).toBe(true)
    await expect(completion).resolves.toBe(true)
    expect(stop).toHaveBeenCalledWith(42)
    expect(setBackgroundThrottling).toHaveBeenLastCalledWith(true)
    expect(cancelDownload).not.toHaveBeenCalled()
    expect(lifecycle.active).toBeNull()
  })

  it('rejects overlap without disturbing the protected active job', () => {
    const { lifecycle, stop } = harness()
    expect(lifecycle.begin(7, request(), () => 'first')).toMatchObject({ accepted: true })
    expect(lifecycle.begin(7, request(120), () => 'second')).toEqual({
      accepted: false,
      error: { code: 'busy', message: 'Another long export is already active.' },
    })
    expect(lifecycle.active?.id).toBe('first')
    expect(stop).not.toHaveBeenCalled()
  })

  it('fails closed when native sleep protection cannot start', () => {
    const { lifecycle, stop } = harness(false)
    expect(lifecycle.begin(7, request(), () => 'unprotected')).toMatchObject({
      accepted: false,
      error: { code: 'sleep-protection-failed' },
    })
    expect(stop).toHaveBeenCalledWith(42)
    expect(lifecycle.active).toBeNull()
  })

  it('rolls back sleep protection if Chromium background throttling cannot be disabled', () => {
    const active = new Set<number>()
    const stop = vi.fn((id: number) => { active.delete(id) })
    const lifecycle = new NativeLongExportLifecycle({
      start: () => { active.add(42); return 42 },
      isStarted: (id) => active.has(id),
      stop,
    }, {
      setBackgroundThrottling: (allowed) => {
        if (!allowed) throw new Error('Renderer unavailable.')
      },
    })

    expect(lifecycle.begin(7, request(), () => 'unthrottled')).toMatchObject({
      accepted: false,
      error: { code: 'sleep-protection-failed' },
    })
    expect(stop).toHaveBeenCalledWith(42)
    expect(active.size).toBe(0)
  })

  it('releases protection when the owning renderer is destroyed or the app closes', () => {
    const first = harness()
    first.lifecycle.begin(7, request(), () => 'renderer_job')
    expect(first.lifecycle.releaseOwner(8)).toBe(false)
    expect(first.lifecycle.releaseOwner(7)).toBe(true)
    expect(first.stop).toHaveBeenCalledWith(42)

    const second = harness()
    second.lifecycle.begin(7, request(), () => 'closing_job')
    const cancelDownload = vi.fn()
    second.lifecycle.attachDownload(7, 'closing_job', cancelDownload)
    expect(second.lifecycle.releaseActive(true)).toBe(true)
    expect(second.lifecycle.releaseActive()).toBe(false)
    expect(cancelDownload).toHaveBeenCalledOnce()
    expect(second.stop).toHaveBeenCalledWith(42)
  })

  it('retains protection after a renderer crash while an attached download finishes', () => {
    const { lifecycle, stop } = harness()
    lifecycle.begin(7, request(), () => 'surviving_download')
    lifecycle.attachDownload(7, 'surviving_download', vi.fn())

    expect(lifecycle.releaseOwner(7)).toBe(true)
    expect(lifecycle.active?.id).toBe('surviving_download')
    expect(stop).not.toHaveBeenCalled()
    lifecycle.finishDownload('surviving_download', 'completed')
    expect(lifecycle.active).toBeNull()
    expect(stop).toHaveBeenCalledWith(42)
  })

  it('reports an interrupted completed export and cancels downloads for renderer failure', async () => {
    const interrupted = harness()
    interrupted.lifecycle.begin(7, request(), () => 'interrupted_job')
    interrupted.lifecycle.attachDownload(7, 'interrupted_job', vi.fn())
    const completion = interrupted.lifecycle.end(7, 'interrupted_job', 'completed')
    interrupted.lifecycle.finishDownload('interrupted_job', 'interrupted')
    await expect(completion).resolves.toBe(false)
    expect(interrupted.stop).toHaveBeenCalledWith(42)

    const failed = harness()
    const cancelDownload = vi.fn()
    failed.lifecycle.begin(7, request(), () => 'failed_job')
    failed.lifecycle.attachDownload(7, 'failed_job', cancelDownload)
    await expect(failed.lifecycle.end(7, 'failed_job', 'failed')).resolves.toBe(true)
    expect(cancelDownload).toHaveBeenCalledOnce()
    expect(failed.stop).toHaveBeenCalledWith(42)
  })

  it('releases after a bounded handshake when no matching download starts', async () => {
    const active = new Set<number>()
    const blocker: LongExportSleepBlocker = {
      start: () => { active.add(42); return 42 },
      isStarted: (id) => active.has(id),
      stop: (id) => { active.delete(id) },
    }
    const lifecycle = new NativeLongExportLifecycle(blocker, {
      downloadHandshakeTimeoutMs: 5,
    })
    lifecycle.begin(7, request(), () => 'missing_download')
    await expect(lifecycle.end(7, 'missing_download', 'completed')).resolves.toBe(false)
    expect(lifecycle.active).toBeNull()
    expect(active.size).toBe(0)
  })
})
