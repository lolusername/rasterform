import type { RasterformDesktopProjectFilesBridge } from './project-files'

export const DESKTOP_EDITOR_COMMANDS_PROTOCOL_VERSION = 1

export type DesktopEditorCommand = 'undo' | 'redo' | 'open-project' | 'save-project'
export type DesktopEditorTextAction = 'undo' | 'redo'

export interface DesktopEditorCommandsCapabilities {
  readonly editorCommandsProtocolVersion: typeof DESKTOP_EDITOR_COMMANDS_PROTOCOL_VERSION
  onEditorCommand(listener: (command: DesktopEditorCommand) => void): () => void
  editText(action: DesktopEditorTextAction): Promise<void>
}

export type RasterformDesktopEditorCommandsBridge = RasterformDesktopProjectFilesBridge & DesktopEditorCommandsCapabilities

/** Detect independently: web, older installed apps, and other bridges still work. */
export function getDesktopEditorCommandsBridge(
  value: unknown = typeof window === 'undefined' ? undefined : window.rasterformDesktop,
): DesktopEditorCommandsCapabilities | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Partial<DesktopEditorCommandsCapabilities>
  return candidate.editorCommandsProtocolVersion === DESKTOP_EDITOR_COMMANDS_PROTOCOL_VERSION
    && typeof candidate.onEditorCommand === 'function'
    && typeof candidate.editText === 'function'
    ? candidate as DesktopEditorCommandsCapabilities
    : null
}

export function isDesktopEditorTextAction(value: unknown): value is DesktopEditorTextAction {
  return value === 'undo' || value === 'redo'
}

export function isDesktopEditorCommand(value: unknown): value is DesktopEditorCommand {
  return isDesktopEditorTextAction(value) || value === 'open-project' || value === 'save-project'
}
