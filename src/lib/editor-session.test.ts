import { describe, expect, it, vi } from 'vitest'
import { editorDocumentFixture } from '../../tests/fixtures/editor-document'
import { createEditorSessionPersistence, createIndexedDbEditorSessionStorage, type EditorSessionStorage } from './editor-session'

function memoryStorage(): EditorSessionStorage {
  let value: unknown
  return {
    read: async () => value,
    write: async (next) => { value = structuredClone(next) },
    remove: async () => { value = undefined },
  }
}

describe('session recovery', () => {
  it('identifies a saved snapshot without changing the project format', async () => {
    const storage = memoryStorage()
    const session = createEditorSessionPersistence(storage)
    const before = Date.now()
    await session.save(editorDocumentFixture())
    const after = Date.now()
    await session.load()
    expect(session.loadedAt).toBeGreaterThanOrEqual(before)
    expect(session.loadedAt).toBeLessThanOrEqual(after)
    await session.clear()
    expect(await session.load()).toBeNull()
    expect(session.loadedAt).toBeNull()
  })

  it('loads older snapshots without a date and ignores invalid date metadata', async () => {
    const storage = memoryStorage()
    const session = createEditorSessionPersistence(storage)
    const document = editorDocumentFixture()
    for (const savedAt of [undefined, 'yesterday', -1, Infinity]) {
      await storage.write({ version: 1, document, savedAt })
      expect(await session.load()).toEqual(document)
      expect(session.loadedAt).toBeNull()
    }
  })

  it('round-trips typed pixels and original source Blob without base64 or data loss', async () => {
    const document = editorDocumentFixture()
    document.image.sourceBlob = new Blob(['preserve the compressed original'], { type: 'image/png' })
    const session = createEditorSessionPersistence(memoryStorage())
    expect(await session.load()).toBeNull()
    await session.save(document)
    const restored = (await session.load())!
    expect(restored).toEqual(document)
    expect(restored.image.data).toBeInstanceOf(Uint8ClampedArray)
    expect(await restored.image.sourceBlob!.text()).toBe('preserve the compressed original')
  })

  it('orders slow writes so stale saves cannot overwrite newer work', async () => {
    const storage = memoryStorage()
    const write = storage.write
    let release!: () => void
    const firstWrite = new Promise<void>((resolve) => { release = resolve })
    const received: unknown[] = []
    storage.write = async (document) => {
      received.push(document)
      if (received.length === 1) await firstWrite
      await write(document)
    }
    const session = createEditorSessionPersistence(storage)
    const document = editorDocumentFixture()
    const first = session.save(document)
    document.mesh.depth = 1
    const second = session.save(document)
    document.mesh.depth = 2 // Mutation after save does not affect its settings snapshot.
    await Promise.resolve()
    expect(received).toHaveLength(1)
    release()
    await Promise.all([first, second])
    expect(received).toHaveLength(2)
    expect((await session.load())!.mesh.depth).toBe(1)
    expect(session.revision).toBe(2)
  })

  it('clear waits for older saves and cannot be undone by a late write', async () => {
    const storage = memoryStorage()
    const session = createEditorSessionPersistence(storage)
    const save = session.save(editorDocumentFixture())
    const clear = session.clear()
    await Promise.all([save, clear])
    expect(await session.load()).toBeNull()
  })

  it('reports failures but allows later saves to succeed', async () => {
    const storage = memoryStorage()
    const write = storage.write
    storage.write = vi.fn().mockRejectedValueOnce(new DOMException('Storage is full', 'QuotaExceededError')).mockImplementation(write)
    const session = createEditorSessionPersistence(storage)
    await expect(session.save(editorDocumentFixture())).rejects.toThrow('Storage is full')
    await session.save(editorDocumentFixture())
    expect(await session.load()).not.toBeNull()
  })

  it('reports old or corrupt sessions rather than loading partial state', async () => {
    const storage = memoryStorage()
    const session = createEditorSessionPersistence(storage)
    await storage.write({ version: 99 })
    await expect(session.load()).rejects.toThrow(/unsupported version/)
    await storage.write({ version: 1, document: { image: {} } })
    await expect(session.load()).rejects.toThrow(/incomplete or damaged/)
  })

  it('reports unavailable browser storage without preventing project-file saving', async () => {
    const storage = createIndexedDbEditorSessionStorage(undefined)
    await expect(storage.read()).rejects.toThrow(/unavailable/)
  })
})
