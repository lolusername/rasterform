import { describe, expect, it } from 'vitest'
import { getDesktopProjectFilesBridge, isDesktopProjectSaveRequest } from './project-files'

describe('optional native project file bridge', () => {
  it('requires the complete supported capability but does not require Electron in the web build', () => {
    const bridge = { projectFilesProtocolVersion: 1, saveProject() {}, openProject() {}, revealLastExport() {} }
    expect(getDesktopProjectFilesBridge(bridge)).toBe(bridge)
    for (const value of [undefined, null, {}, { ...bridge, projectFilesProtocolVersion: 2 }, { ...bridge, openProject: undefined }]) {
      expect(getDesktopProjectFilesBridge(value)).toBeNull()
    }
  })

  it('accepts serialized content plus a suggested filename, never destination paths or other fields', () => {
    expect(isDesktopProjectSaveRequest({ suggestedName: 'Flower.rasterform', contents: '{}' })).toBe(true)
    expect(isDesktopProjectSaveRequest({ suggestedName: 'Flower.rasterform', contents: '{}', path: '/tmp/file' })).toBe(false)
    for (const value of [null, [], {}, { suggestedName: 'a', contents: '' }, { suggestedName: 2, contents: '{}' }]) {
      expect(isDesktopProjectSaveRequest(value)).toBe(false)
    }
  })
})
