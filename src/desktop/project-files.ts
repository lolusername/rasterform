import type { RasterformDesktopBlenderExportBridge } from './blender-export-contracts'

export const DESKTOP_PROJECT_FILES_PROTOCOL_VERSION = 1
export const DESKTOP_PROJECT_MAX_BYTES = 768 * 1024 * 1024

export interface DesktopProjectSaveRequest {
  suggestedName: string
  contents: string
}

export type DesktopProjectSaveResult = { cancelled: true } | { cancelled: false; fileName: string }
export type DesktopProjectOpenResult = { cancelled: true } | { cancelled: false; fileName: string; contents: string }

export interface DesktopProjectFilesCapabilities {
  readonly projectFilesProtocolVersion: typeof DESKTOP_PROJECT_FILES_PROTOCOL_VERSION
  saveProject(request: DesktopProjectSaveRequest): Promise<DesktopProjectSaveResult>
  openProject(): Promise<DesktopProjectOpenResult>
  revealLastExport(): Promise<boolean>
}

export type RasterformDesktopProjectFilesBridge = RasterformDesktopBlenderExportBridge & DesktopProjectFilesCapabilities

/** Older desktop installations remain usable without these optional capabilities. */
export function getDesktopProjectFilesBridge(
  value: unknown = typeof window === 'undefined' ? undefined : window.rasterformDesktop,
): DesktopProjectFilesCapabilities | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<DesktopProjectFilesCapabilities>
  return candidate.projectFilesProtocolVersion === DESKTOP_PROJECT_FILES_PROTOCOL_VERSION
    && typeof candidate.saveProject === 'function'
    && typeof candidate.openProject === 'function'
    && typeof candidate.revealLastExport === 'function'
    ? candidate as DesktopProjectFilesCapabilities
    : null
}

export function isDesktopProjectSaveRequest(value: unknown): value is DesktopProjectSaveRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const request = value as Record<string, unknown>
  return Object.keys(request).every((key) => key === 'suggestedName' || key === 'contents')
    && typeof request.suggestedName === 'string'
    && request.suggestedName.length <= 4096
    && typeof request.contents === 'string'
    && request.contents.length > 0
    && request.contents.length <= DESKTOP_PROJECT_MAX_BYTES
}
