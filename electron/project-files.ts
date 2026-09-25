import { randomUUID } from 'node:crypto'
import { lstat, open, rename, unlink } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import {
  DESKTOP_PROJECT_MAX_BYTES,
  isDesktopProjectSaveRequest,
  type DesktopProjectOpenResult,
  type DesktopProjectSaveResult,
} from '../src/desktop/project-files'

const PROJECT_EXTENSION = '.rasterform'

export function sanitizeProjectFileName(value: string): string {
  const clean = basename(value.replaceAll('\\', '/')).normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f/:]/g, '-').replace(/^\.+/, '')
    .replace(/\s+/g, ' ').trim()
  const stem = clean.toLowerCase().endsWith(PROJECT_EXTENSION) ? clean.slice(0, -PROJECT_EXTENSION.length) : clean
  return `${stem.slice(0, 160).replace(/[. ]+$/g, '') || 'Rasterform project'}${PROJECT_EXTENSION}`
}

export function ensureProjectPath(value: string): string {
  return extname(value).toLowerCase() === PROJECT_EXTENSION ? value : `${value}${PROJECT_EXTENSION}`
}

export function assertProjectContents(contents: string): void {
  if (!contents.length || contents.length > DESKTOP_PROJECT_MAX_BYTES
    || Buffer.byteLength(contents, 'utf8') > DESKTOP_PROJECT_MAX_BYTES) {
    throw new Error('This project exceeds the supported 768 MiB file size.')
  }
  let parsed: unknown
  try { parsed = JSON.parse(contents) } catch { throw new Error('This is not a readable Rasterform project file.') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('This is not a Rasterform project file.')
  }
  const project = parsed as Record<string, unknown>
  if (project.format !== 'Rasterform project' || project.version !== 1
    || !project.document || typeof project.document !== 'object' || Array.isArray(project.document)) {
    throw new Error('This Rasterform project format or version is not supported.')
  }
  // Detailed authored-state and asset validation runs in the renderer before
  // replacing its current document. Main only admits the bounded file envelope.
}

export async function writeProjectAtomically(destination: string, contents: string): Promise<void> {
  const temporary = join(dirname(destination), `.rasterform-project-${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    await rename(temporary, destination)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

export async function readProjectFile(path: string): Promise<string> {
  if (extname(path).toLowerCase() !== PROJECT_EXTENSION) throw new Error('Choose a .rasterform project file.')
  const handle = await open(path, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > DESKTOP_PROJECT_MAX_BYTES) throw new Error('Choose a Rasterform project smaller than 768 MiB.')
    // Read from the same open descriptor we sized, with a strict allocation cap.
    const bytes = Buffer.alloc(stat.size + 1)
    let total = 0
    while (total < bytes.length) {
      const { bytesRead } = await handle.read(bytes, total, bytes.length - total, total)
      if (bytesRead === 0) break
      total += bytesRead
    }
    if (total > stat.size) throw new Error('The project file changed while opening. Try again.')
    const contents = bytes.subarray(0, total).toString('utf8')
    assertProjectContents(contents)
    return contents
  } finally {
    await handle.close()
  }
}

interface ProjectFileHost<Event> {
  isTrusted(event: Event): boolean
  isBusy(): boolean
  setBusy(value: boolean): void
  chooseSave(fileName: string): Promise<string | null>
  chooseOpen(): Promise<string | null>
  confirmOverwrite(path: string): Promise<boolean>
  trackWrite(promise: Promise<void>): Promise<void>
  didSave(path: string): void
  lastExportPath(): string | null
  reveal(path: string): void
}

/** All destinations originate in native dialogs, never in renderer requests. */
export function createProjectFileHandlers<Event>(host: ProjectFileHost<Event>) {
  function assertTrusted(event: Event) {
    if (!host.isTrusted(event)) throw new Error('Untrusted project file request.')
  }
  function reserveDialog(event: Event) {
    assertTrusted(event)
    if (host.isBusy()) throw new Error('Finish the current file dialog before opening another.')
    host.setBusy(true)
  }
  return {
    async saveProject(event: Event, request: unknown): Promise<DesktopProjectSaveResult> {
      assertTrusted(event)
      if (!isDesktopProjectSaveRequest(request)) throw new Error('Invalid project save request.')
      assertProjectContents(request.contents)
      reserveDialog(event)
      try {
        const selected = await host.chooseSave(sanitizeProjectFileName(request.suggestedName))
        if (!selected) return { cancelled: true }
        const destination = ensureProjectPath(selected)
        // If the native dialog omitted the extension, its overwrite warning
        // covered a different path. Confirm the actual suffixed destination.
        if (destination !== selected) {
          let exists = false
          try { await lstat(destination); exists = true } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
          if (exists && !await host.confirmOverwrite(destination)) return { cancelled: true }
        }
        await host.trackWrite(writeProjectAtomically(destination, request.contents))
        host.didSave(destination)
        return { cancelled: false, fileName: basename(destination) }
      } finally { host.setBusy(false) }
    },
    async openProject(event: Event): Promise<DesktopProjectOpenResult> {
      reserveDialog(event)
      try {
        const selected = await host.chooseOpen()
        if (!selected) return { cancelled: true }
        const contents = await readProjectFile(selected)
        return { cancelled: false, fileName: basename(selected), contents }
      } finally { host.setBusy(false) }
    },
    async revealLastExport(event: Event): Promise<boolean> {
      assertTrusted(event)
      const path = host.lastExportPath()
      if (!path) return false
      host.reveal(path)
      return true
    },
  }
}

export function isEditorFileDownload(url: string, fileName: string): boolean {
  return url.startsWith('blob:rasterform://app/')
    && /^rasterform[-.]/i.test(fileName)
    && ['.png', '.glb', '.stl', '.json', PROJECT_EXTENSION].includes(extname(fileName).toLowerCase())
}
