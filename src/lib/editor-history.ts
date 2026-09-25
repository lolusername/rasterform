import { cloneEditorDocument, editorDocumentsEqual, type EditorDocument } from './editor-document'

export interface EditorCheckpoint {
  id: number
  name: string
  createdAt: number
  document: EditorDocument
}

export interface EditorHistoryOptions {
  /** Maximum undo actions, not bitmap copies. Defaults to 100. */
  capacity?: number
  /** Maximum kept alternatives, oldest first. Defaults to 8. */
  checkpointCapacity?: number
  onChange?: () => void
}

interface Entry { document: EditorDocument; label: string }

/**
 * Framework-independent history. A pointer/keyboard slider gesture is one action:
 * beginGesture -> any number of record calls -> endGesture.
 * Callers suppress their state watcher while applying undo/redo snapshots.
 */
export function createEditorHistory(initial: EditorDocument, options: EditorHistoryOptions = {}) {
  const boundedCapacity = (value: number | undefined, fallback: number) =>
    Number.isFinite(value) ? Math.min(1000, Math.max(1, Math.floor(value!))) : fallback
  const capacity = boundedCapacity(options.capacity, 100)
  const checkpointCapacity = boundedCapacity(options.checkpointCapacity, 8)
  let current = cloneEditorDocument(initial)
  const past: Entry[] = []
  const future: Entry[] = []
  const checkpoints: EditorCheckpoint[] = []
  let checkpointSequence = 0
  let gesture: Entry | null = null
  let gestureDepth = 0
  const changed = () => options.onChange?.()
  const addPast = (entry: Entry) => {
    past.push(entry)
    if (past.length > capacity) past.splice(0, past.length - capacity)
    future.length = 0
  }
  function endGesture(): boolean {
    if (!gesture) return false
    gestureDepth -= 1
    if (gestureDepth > 0) return false
    const start = gesture
    gesture = null
    gestureDepth = 0
    const modified = !editorDocumentsEqual(start.document, current)
    if (modified) addPast(start)
    changed()
    return modified
  }
  function finishGesture() {
    if (!gesture) return
    gestureDepth = 1
    endGesture()
  }
  function record(document: EditorDocument, label = 'Edit'): boolean {
    if (editorDocumentsEqual(current, document)) return false
    if (!gesture) addPast({ document: current, label })
    current = cloneEditorDocument(document)
    changed()
    return true
  }
  return {
    get current(): EditorDocument { return cloneEditorDocument(current) },
    get canUndo(): boolean { return past.length > 0 || !!(gesture && !editorDocumentsEqual(gesture.document, current)) },
    get canRedo(): boolean { return !gesture && future.length > 0 },
    get undoLabel(): string { return gesture?.label ?? past.at(-1)?.label ?? '' },
    get redoLabel(): string { return future.at(-1)?.label ?? '' },
    get undoCount(): number { return past.length },
    get redoCount(): number { return future.length },
    get inGesture(): boolean { return gesture !== null },
    get checkpoints(): EditorCheckpoint[] {
      return checkpoints.map((checkpoint) => ({ ...checkpoint, document: cloneEditorDocument(checkpoint.document) }))
    },
    beginGesture(label = 'Adjust'): void {
      if (!gesture) gesture = { document: cloneEditorDocument(current), label }
      gestureDepth += 1
      changed()
    },
    endGesture,
    record,
    /** Preflight fallible restores (for example missing fonts) before moving the cursor. */
    peekUndo(): EditorDocument | null {
      if (gesture && !editorDocumentsEqual(gesture.document, current)) return cloneEditorDocument(gesture.document)
      return past.length ? cloneEditorDocument(past[past.length - 1].document) : null
    },
    peekRedo(): EditorDocument | null {
      if (gesture && !editorDocumentsEqual(gesture.document, current)) return null
      return future.length ? cloneEditorDocument(future[future.length - 1].document) : null
    },
    undo(): EditorDocument | null {
      finishGesture()
      const previous = past.pop()
      if (!previous) return null
      future.push({ document: current, label: previous.label })
      current = previous.document
      changed()
      return cloneEditorDocument(current)
    },
    redo(): EditorDocument | null {
      finishGesture()
      const next = future.pop()
      if (!next) return null
      past.push({ document: current, label: next.label })
      if (past.length > capacity) past.shift()
      current = next.document
      changed()
      return cloneEditorDocument(current)
    },
    /** Update non-authored UI context without introducing an undo action. */
    synchronize(document: EditorDocument): void {
      finishGesture()
      current = cloneEditorDocument(document)
      changed()
    },
    checkpoint(name = `Version ${checkpointSequence + 1}`): EditorCheckpoint {
      finishGesture()
      const checkpoint = {
        id: ++checkpointSequence, name, createdAt: Date.now(), document: cloneEditorDocument(current),
      }
      checkpoints.push(checkpoint)
      if (checkpoints.length > checkpointCapacity) checkpoints.shift()
      changed()
      return { ...checkpoint, document: cloneEditorDocument(checkpoint.document) }
    },
    restoreCheckpoint(id: number): EditorDocument | null {
      finishGesture()
      const checkpoint = checkpoints.find((candidate) => candidate.id === id)
      if (!checkpoint) return null
      record(checkpoint.document, `Restore ${checkpoint.name}`)
      return cloneEditorDocument(current)
    },
    removeCheckpoint(id: number): boolean {
      const index = checkpoints.findIndex((checkpoint) => checkpoint.id === id)
      if (index < 0) return false
      checkpoints.splice(index, 1)
      changed()
      return true
    },
    reset(document: EditorDocument, keepCheckpoints = false): void {
      gesture = null
      gestureDepth = 0
      past.length = 0
      future.length = 0
      if (!keepCheckpoints) checkpoints.length = 0
      current = cloneEditorDocument(document)
      changed()
    },
  }
}

export type EditorHistory = ReturnType<typeof createEditorHistory>
