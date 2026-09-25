import { cloneEditorDocument, validateEditorDocument, type EditorDocument } from './editor-document'

const SESSION_DATABASE = 'rasterform-editor-session'
const SESSION_STORE = 'documents'
const SESSION_KEY = 'current'
const SESSION_VERSION = 1

export interface EditorSessionStorage {
  read(): Promise<unknown>
  write(value: unknown): Promise<void>
  remove(): Promise<void>
}

export class EditorSessionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EditorSessionError'
  }
}

/** Binary pixels/Blob assets use IndexedDB structured cloning, not localStorage/base64. */
export function createIndexedDbEditorSessionStorage(factory: IDBFactory | undefined = globalThis.indexedDB): EditorSessionStorage {
  let databasePromise: Promise<IDBDatabase> | undefined
  function database(): Promise<IDBDatabase> {
    if (!factory) return Promise.reject(new EditorSessionError('Session recovery is unavailable in this browser. Keep this window open until you finish exporting.'))
    if (!databasePromise) {
      databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
        const request = factory.open(SESSION_DATABASE, SESSION_VERSION)
        let blocked = false
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(SESSION_STORE)) request.result.createObjectStore(SESSION_STORE)
        }
        request.onsuccess = () => {
          const opened = request.result
          if (blocked) { opened.close(); return }
          opened.onversionchange = () => { opened.close(); databasePromise = undefined }
          resolve(opened)
        }
        request.onerror = () => reject(request.error ?? new EditorSessionError('Session storage could not be opened.'))
        request.onblocked = () => {
          blocked = true
          reject(new EditorSessionError('Session storage is blocked by another Rasterform window.'))
        }
      }).catch((error) => { databasePromise = undefined; throw error })
    }
    return databasePromise
  }
  async function transaction(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest): Promise<unknown> {
    const opened = await database()
    return new Promise((resolve, reject) => {
      const transaction = opened.transaction(SESSION_STORE, mode)
      const request = action(transaction.objectStore(SESSION_STORE))
      transaction.oncomplete = () => resolve(request.result)
      transaction.onerror = () => reject(transaction.error ?? request.error ?? new EditorSessionError('Session recovery could not be saved.'))
      transaction.onabort = () => reject(transaction.error ?? new EditorSessionError('Session storage was interrupted.'))
    })
  }
  return {
    read: () => transaction('readonly', (store) => store.get(SESSION_KEY)),
    write: async (value) => { await transaction('readwrite', (store) => store.put(value, SESSION_KEY)) },
    remove: async () => { await transaction('readwrite', (store) => store.delete(SESSION_KEY)) },
  }
}

/**
 * FIFO writes and clear operations prevent an older asynchronous save from replacing
 * a newer edit. Rejections reach the UI; they do not poison future save attempts.
 */
export function createEditorSessionPersistence(storage: EditorSessionStorage = createIndexedDbEditorSessionStorage()) {
  let pending: Promise<void> = Promise.resolve()
  let revision = 0
  let loadedAt: number | null = null
  function enqueue(operation: () => Promise<void>): Promise<void> {
    const result = pending.then(operation, operation)
    pending = result.catch(() => undefined)
    return result
  }
  return {
    get revision(): number { return revision },
    get loadedAt(): number | null { return loadedAt },
    async load(): Promise<EditorDocument | null> {
      loadedAt = null
      await pending
      const value = await storage.read()
      if (value === undefined || value === null) return null
      if (typeof value !== 'object' || Array.isArray(value)
        || (value as { version?: unknown }).version !== SESSION_VERSION) {
        throw new EditorSessionError('The saved session is from an unsupported version. Your current project has not been changed.')
      }
      const session = value as { document?: unknown; savedAt?: unknown }
      try {
        const document = validateEditorDocument(session.document)
        loadedAt = typeof session.savedAt === 'number' && Number.isSafeInteger(session.savedAt) && session.savedAt > 0
          ? session.savedAt : null
        return document
      } catch {
        throw new EditorSessionError('The saved session is incomplete or damaged. Your current project has not been changed.')
      }
    },
    async save(document: EditorDocument): Promise<void> {
      // Settings are captured now, not after an earlier queued write completes.
      const snapshot = cloneEditorDocument(validateEditorDocument(document))
      const savedRevision = ++revision
      const savedAt = Date.now()
      return enqueue(() => storage.write({ version: SESSION_VERSION, revision: savedRevision, savedAt, document: snapshot }))
    },
    clear(): Promise<void> {
      revision += 1
      return enqueue(() => storage.remove())
    },
    flush(): Promise<void> { return pending },
  }
}
