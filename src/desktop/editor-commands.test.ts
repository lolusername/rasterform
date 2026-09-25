import { describe, expect, it } from 'vitest'
import { getDesktopEditorCommandsBridge, isDesktopEditorCommand, isDesktopEditorTextAction } from './editor-commands'

describe('optional native editor commands', () => {
  it('detects the complete capability independently of renderer/project protocol versions', () => {
    const bridge = { editorCommandsProtocolVersion: 1, onEditorCommand() { return () => {} }, async editText() {} }
    expect(getDesktopEditorCommandsBridge(bridge)).toBe(bridge)
    for (const value of [undefined, null, [], {}, { protocolVersion: 1 },
      { ...bridge, editorCommandsProtocolVersion: 2 }, { ...bridge, onEditorCommand: undefined },
      { ...bridge, editText: 'undo' }]) {
      expect(getDesktopEditorCommandsBridge(value)).toBeNull()
    }
  })

  it('admits only the four enumerated editor commands and two native text actions', () => {
    for (const command of ['undo', 'redo', 'open-project', 'save-project']) expect(isDesktopEditorCommand(command)).toBe(true)
    for (const action of ['undo', 'redo']) expect(isDesktopEditorTextAction(action)).toBe(true)
    for (const value of [undefined, null, '', {}, [], ['undo'], { action: 'undo' }, 'executeJavaScript', '__proto__', 'save-project:/tmp/x']) {
      expect(isDesktopEditorCommand(value)).toBe(false)
      expect(isDesktopEditorTextAction(value)).toBe(false)
    }
    expect(isDesktopEditorTextAction('open-project')).toBe(false)
    expect(isDesktopEditorTextAction('save-project')).toBe(false)
  })
})
