import { describe, expect, it, vi } from 'vitest'
import { createEditorTextCommandHandler } from './editor-commands'

describe('native text command boundary', () => {
  function fixture() {
    const host = { isTrusted: (event: string) => event === 'editor', undo: vi.fn(), redo: vi.fn() }
    return { host, handle: createEditorTextCommandHandler(host) }
  }

  it('rejects foreign windows/frames before performing any native text action', async () => {
    const { host, handle } = fixture()
    for (const sender of ['renderer', 'foreign-window', 'foreign-frame']) {
      await expect(handle(sender, 'undo')).rejects.toThrow('Untrusted')
      await expect(handle(sender, 'redo')).rejects.toThrow('Untrusted')
    }
    expect(host.undo).not.toHaveBeenCalled()
    expect(host.redo).not.toHaveBeenCalled()
  })

  it('rejects arbitrary methods and structured payloads from even the trusted editor', async () => {
    const { host, handle } = fixture()
    for (const action of [null, {}, ['undo'], { action: 'undo' }, 'open-project', 'executeJavaScript', '__proto__']) {
      await expect(handle('editor', action)).rejects.toThrow('Invalid')
    }
    expect(host.undo).not.toHaveBeenCalled()
    expect(host.redo).not.toHaveBeenCalled()
  })

  it('dispatches exactly one matching native operation to the validated sender', async () => {
    const { host, handle } = fixture()
    await handle('editor', 'undo')
    expect(host.undo).toHaveBeenCalledExactlyOnceWith('editor')
    expect(host.redo).not.toHaveBeenCalled()
    await handle('editor', 'redo')
    expect(host.redo).toHaveBeenCalledExactlyOnceWith('editor')
    expect(host.undo).toHaveBeenCalledTimes(1)
  })
})
