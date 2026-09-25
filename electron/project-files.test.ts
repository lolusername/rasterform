import { mkdtemp, mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DESKTOP_PROJECT_MAX_BYTES } from '../src/desktop/project-files'
import {
  assertProjectContents, createProjectFileHandlers, ensureProjectPath,
  isEditorFileDownload, readProjectFile, sanitizeProjectFileName, writeProjectAtomically,
} from './project-files'

const contents = JSON.stringify({ format: 'Rasterform project', version: 1, document: { name: 'test' } })

function host(overrides = {}) {
  let busy = false
  return {
    isTrusted: (event: string) => event === 'editor',
    isBusy: () => busy,
    setBusy: (value: boolean) => { busy = value },
    chooseSave: vi.fn(async (_name: string): Promise<string | null> => null),
    chooseOpen: vi.fn(async (): Promise<string | null> => null),
    confirmOverwrite: vi.fn(async (_path: string) => false),
    trackWrite: vi.fn(async (promise: Promise<void>) => { await promise }),
    didSave: vi.fn(),
    lastExportPath: () => null as string | null,
    reveal: vi.fn(),
    ...overrides,
  }
}

describe('native project boundaries', () => {
  it('sanitizes suggestions and constrains the native save extension', () => {
    expect(sanitizeProjectFileName('../flower.rasterform')).toBe('flower.rasterform')
    expect(sanitizeProjectFileName('C:\\private\\flower.rasterform')).toBe('flower.rasterform')
    expect(sanitizeProjectFileName('...')).toBe('Rasterform project.rasterform')
    expect(ensureProjectPath('/tmp/flower')).toBe('/tmp/flower.rasterform')
    expect(ensureProjectPath('/tmp/flower.RASTERFORM')).toBe('/tmp/flower.RASTERFORM')
    expect(() => assertProjectContents(contents)).not.toThrow()
    for (const source of ['', 'broken', 'null', '[]', '{}', JSON.stringify({ format: 'Rasterform project', version: 2, document: {} })]) {
      expect(() => assertProjectContents(source)).toThrow()
    }
  })

  it('rejects untrusted senders before native dialogs, filesystem access, or Reveal', async () => {
    const runtime = host()
    const handlers = createProjectFileHandlers(runtime)
    await expect(handlers.saveProject('other', { suggestedName: 'a', contents })).rejects.toThrow('Untrusted')
    await expect(handlers.openProject('other')).rejects.toThrow('Untrusted')
    await expect(handlers.revealLastExport('other')).rejects.toThrow('Untrusted')
    expect(runtime.chooseSave).not.toHaveBeenCalled()
    expect(runtime.chooseOpen).not.toHaveBeenCalled()
    expect(runtime.reveal).not.toHaveBeenCalled()
  })

  it('cancels without writing and refuses renderer-supplied destinations', async () => {
    const runtime = host()
    const handlers = createProjectFileHandlers(runtime)
    await expect(handlers.saveProject('editor', { suggestedName: 'a', contents, path: '/tmp/forbidden' })).rejects.toThrow('Invalid')
    expect(runtime.chooseSave).not.toHaveBeenCalled()
    await expect(handlers.saveProject('editor', { suggestedName: 'a', contents })).resolves.toEqual({ cancelled: true })
    await expect(handlers.openProject('editor')).resolves.toEqual({ cancelled: true })
    expect(runtime.trackWrite).not.toHaveBeenCalled()
    expect(runtime.isBusy()).toBe(false)
    await expect(handlers.revealLastExport('editor')).resolves.toBe(false)
  })

  it('serializes dialogs and releases reservations after failures', async () => {
    const busy = host({ isBusy: () => true })
    await expect(createProjectFileHandlers(busy).openProject('editor')).rejects.toThrow('current file dialog')
    const runtime = host({ chooseOpen: vi.fn(async () => { throw new Error('dialog unavailable') }) })
    await expect(createProjectFileHandlers(runtime).openProject('editor')).rejects.toThrow('dialog unavailable')
    expect(runtime.isBusy()).toBe(false)
  })

  it('writes atomically, opens exact bytes, and returns filenames without native paths', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rasterform-project-test-'))
    const destination = join(directory, 'flower.rasterform')
    try {
      await writeFile(destination, 'previous data')
      const runtime = host({ chooseSave: vi.fn(async () => destination), chooseOpen: vi.fn(async () => destination), lastExportPath: () => destination })
      const handlers = createProjectFileHandlers(runtime)
      await expect(handlers.saveProject('editor', { suggestedName: '../../flower', contents })).resolves.toEqual({ cancelled: false, fileName: 'flower.rasterform' })
      expect(runtime.chooseSave).toHaveBeenCalledWith('flower.rasterform')
      expect(runtime.trackWrite).toHaveBeenCalledTimes(1)
      expect(runtime.didSave).toHaveBeenCalledWith(destination)
      await expect(readFile(destination, 'utf8')).resolves.toBe(contents)
      await expect(handlers.openProject('editor')).resolves.toEqual({ cancelled: false, fileName: 'flower.rasterform', contents })
      await expect(handlers.revealLastExport('editor')).resolves.toBe(true)
      expect(runtime.reveal).toHaveBeenCalledWith(destination)
      expect(await readdir(directory)).toEqual(['flower.rasterform'])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('rejects the wrong extension, unsupported envelope, directories, and oversized files before allocation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rasterform-project-test-'))
    try {
      const wrong = join(directory, 'wrong.json')
      await writeFile(wrong, contents)
      await expect(readProjectFile(wrong)).rejects.toThrow('.rasterform')
      const invalid = join(directory, 'invalid.rasterform')
      await writeFile(invalid, '{}')
      await expect(readProjectFile(invalid)).rejects.toThrow('format or version')
      const folder = join(directory, 'folder.rasterform')
      await mkdir(folder)
      await expect(readProjectFile(folder)).rejects.toThrow('smaller than')
      const huge = join(directory, 'huge.rasterform')
      const handle = await open(huge, 'w')
      await handle.truncate(DESKTOP_PROJECT_MAX_BYTES + 1)
      await handle.close()
      await expect(readProjectFile(huge)).rejects.toThrow('smaller than')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('cleans temporary files on failed atomic commit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rasterform-project-test-'))
    const destination = join(directory, 'folder.rasterform')
    try {
      await mkdir(destination)
      await expect(writeProjectAtomically(destination, contents)).rejects.toThrow()
      expect(await readdir(directory)).toEqual(['folder.rasterform'])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('does not overwrite an appended-extension destination without explicit confirmation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rasterform-project-test-'))
    const destination = join(directory, 'flower.rasterform')
    try {
      await writeFile(destination, 'previous data')
      const runtime = host({ chooseSave: vi.fn(async () => join(directory, 'flower')) })
      const handlers = createProjectFileHandlers(runtime)
      await expect(handlers.saveProject('editor', { suggestedName: 'flower', contents })).resolves.toEqual({ cancelled: true })
      expect(runtime.confirmOverwrite).toHaveBeenCalledWith(destination)
      await expect(readFile(destination, 'utf8')).resolves.toBe('previous data')
      runtime.confirmOverwrite.mockResolvedValue(true)
      await expect(handlers.saveProject('editor', { suggestedName: 'flower', contents })).resolves.toEqual({ cancelled: false, fileName: 'flower.rasterform' })
      await expect(readFile(destination, 'utf8')).resolves.toBe(contents)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('tracks only app-generated still/model/recipe downloads, leaving Living Loop ZIPs alone', () => {
    for (const name of ['rasterform-photo-high.png', 'rasterform.glb', 'rasterform.stl', 'rasterform-recipe.json']) {
      expect(isEditorFileDownload('blob:rasterform://app/a', name)).toBe(true)
    }
    expect(isEditorFileDownload('https://other.test/a', 'rasterform.glb')).toBe(false)
    expect(isEditorFileDownload('blob:rasterform://render/a', 'rasterform.glb')).toBe(false)
    expect(isEditorFileDownload('blob:rasterform://app/a', 'rasterform-living-breathe-2048x2048-24fps-transparent.zip')).toBe(false)
    expect(isEditorFileDownload('blob:rasterform://app/a', 'other.png')).toBe(false)
  })
})
