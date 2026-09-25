import { describe, expect, it, vi } from 'vitest'
import { editorDocumentFixture } from '../../tests/fixtures/editor-document'
import { createEditorHistory } from './editor-history'

describe('editor history', () => {
  it('groups one complete slider drag into one undo action and can redo exactly', () => {
    const document = editorDocumentFixture()
    const history = createEditorHistory(document)
    history.beginGesture('Adjust depth')
    for (let index = 1; index <= 100; index++) {
      document.mesh.depth = index / 100
      history.record(document)
    }
    expect(history.canUndo).toBe(true)
    expect(history.undoCount).toBe(0)
    history.endGesture()
    expect(history.undoCount).toBe(1)
    expect(history.undoLabel).toBe('Adjust depth')
    expect(history.undo()!.mesh.depth).toBe(0.58)
    expect(history.redoLabel).toBe('Adjust depth')
    expect(history.redo()!.mesh.depth).toBe(1)
    expect(history.current.image.data).toBe(document.image.data)
  })

  it('restores presets, removed channels, source images, modes, and appearance exactly', () => {
    const initial = editorDocumentFixture()
    const document = editorDocumentFixture()
    const history = createEditorHistory(initial)
    document.channels = []
    document.selectedChannelId = ''
    document.workspace = 'text'
    document.text.text = 'Something different'
    document.imageAppearance.clay.finish = 'metallic'
    history.record(document, 'Apply preset')
    expect(history.undo()).toEqual(initial)
    expect(history.redo()).toEqual(document)
    expect(history.current.image.data).toBe(document.image.data)
  })

  it('deduplicates unchanged state and a gesture returned to its starting value', () => {
    const document = editorDocumentFixture()
    const history = createEditorHistory(document)
    expect(history.record(document)).toBe(false)
    history.beginGesture()
    document.mesh.depth = 1
    history.record(document)
    document.mesh.depth = 0.58
    history.record(document)
    expect(history.endGesture()).toBe(false)
    expect(history.canUndo).toBe(false)
  })

  it('retains redo when a no-op gesture ends, but drops it after a new edit', () => {
    const document = editorDocumentFixture()
    const history = createEditorHistory(document)
    document.mesh.depth = 1
    history.record(document)
    const previous = history.undo()!
    history.beginGesture()
    history.record(previous)
    history.endGesture()
    expect(history.canRedo).toBe(true)
    previous.mesh.depth = 0.8
    history.record(previous)
    expect(history.canRedo).toBe(false)
    expect(history.redo()).toBeNull()
  })

  it('handles nested gesture boundaries and undo requested while dragging', () => {
    const document = editorDocumentFixture()
    const history = createEditorHistory(document)
    history.beginGesture('Change')
    history.beginGesture('Nested')
    document.mesh.depth = 1
    history.record(document)
    history.endGesture()
    expect(history.inGesture).toBe(true)
    expect(history.undo()!.mesh.depth).toBe(0.58)
    expect(history.inGesture).toBe(false)
    expect(history.redo()!.mesh.depth).toBe(1)
  })

  it('bounds history and never exposes mutable settings held by it', () => {
    const document = editorDocumentFixture()
    const history = createEditorHistory(document, { capacity: 2 })
    for (let depth = 1; depth <= 4; depth++) {
      document.mesh.depth = depth
      history.record(document)
    }
    expect(history.undoCount).toBe(2)
    history.current.channels[0].amount = 0
    expect(history.current.channels[0].amount).toBe(0.86)
    expect(history.undo()!.mesh.depth).toBe(3)
    expect(history.undo()!.mesh.depth).toBe(2)
    expect(history.undo()).toBeNull()
  })

  it('keeps named alternatives and restores them as one undoable action', () => {
    const document = editorDocumentFixture()
    const history = createEditorHistory(document, { checkpointCapacity: 2 })
    const first = history.checkpoint('Jagged')
    first.document.field.blur = 50
    document.field.finish = 'blob'
    document.field.blur = 3
    history.record(document, 'Try rounded')
    const second = history.checkpoint('Rounded')
    expect(history.restoreCheckpoint(first.id)!.field.blur).toBe(1)
    expect(history.undo()!.field.blur).toBe(3)
    expect(history.checkpoints[0].name).toBe('Jagged')
    history.checkpoint('Third')
    expect(history.checkpoints.map((checkpoint) => checkpoint.name)).toEqual(['Rounded', 'Third'])
    expect(history.restoreCheckpoint(first.id)).toBeNull()
    expect(history.removeCheckpoint(second.id)).toBe(true)
    expect(history.removeCheckpoint(second.id)).toBe(false)
  })

  it('resets history for a project restore and notifies state consumers', () => {
    const onChange = vi.fn()
    const document = editorDocumentFixture()
    const history = createEditorHistory(document, { onChange })
    history.checkpoint()
    history.beginGesture()
    document.mesh.depth = 1
    history.record(document)
    history.reset(document)
    expect(history.canUndo).toBe(false)
    expect(history.canRedo).toBe(false)
    expect(history.inGesture).toBe(false)
    expect(history.checkpoints).toHaveLength(0)
    expect(history.current.mesh.depth).toBe(1)
    expect(onChange).toHaveBeenCalled()
  })

  it('can preflight a failed restore without moving undo or redo cursors', () => {
    const document = editorDocumentFixture()
    const history = createEditorHistory(document)
    document.mesh.depth = 1
    history.record(document)
    const candidate = history.peekUndo()!
    expect(candidate.mesh.depth).toBe(0.58)
    candidate.mesh.depth = 8
    expect(history.current.mesh.depth).toBe(1)
    expect(history.canUndo).toBe(true)
    expect(history.canRedo).toBe(false)
    history.undo()
    expect(history.peekRedo()!.mesh.depth).toBe(1)
    expect(history.canRedo).toBe(true)
    history.beginGesture()
    document.mesh.depth = 0.2
    history.record(document)
    expect(history.peekRedo()).toBeNull()
    expect(history.peekUndo()!.mesh.depth).toBe(0.58)
  })
})
