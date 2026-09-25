import { isDesktopEditorTextAction } from '../src/desktop/editor-commands'

interface EditorTextCommandHost<Event> {
  isTrusted(event: Event): boolean
  undo(event: Event): void
  redo(event: Event): void
}

/** The renderer may request only native text Undo/Redo for its own trusted editor. */
export function createEditorTextCommandHandler<Event>(host: EditorTextCommandHost<Event>) {
  return async (event: Event, action: unknown): Promise<void> => {
    if (!host.isTrusted(event)) throw new Error('Untrusted editor text command.')
    if (!isDesktopEditorTextAction(action)) throw new Error('Invalid editor text command.')
    if (action === 'undo') host.undo(event)
    else host.redo(event)
  }
}
