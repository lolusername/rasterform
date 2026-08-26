import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TEMPORARY_ARCHIVE_PREFIX,
  TEMPORARY_ARCHIVE_RETENTION_MS,
  cleanupStaleStoredZipArchives,
  createStoredZip,
  createStoredZipArchive,
  zipCrc32,
  zipValueNeedsZip64,
} from './zip-writer'

const LOCAL_SIGNATURE = 0x04034b50
const CENTRAL_SIGNATURE = 0x02014b50
const END_SIGNATURE = 0x06054b50
const ZIP64_END_SIGNATURE = 0x06064b50
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50
const FIELD32_MAX = 0xffffffff

function signature(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true)
}

function uint64(view: DataView, offset: number): number {
  const value = Number(view.getBigUint64(offset, true))
  if (!Number.isSafeInteger(value)) throw new Error('Test ZIP exceeds the safe numeric range.')
  return value
}

interface ParsedStoredEntry {
  name: string
  bytes: Uint8Array
  crc: number
  localOffset: number
  localUsesZip64: boolean
}

function parseStoredZip(bytes: Uint8Array): { zip64: boolean; entries: ParsedStoredEntry[] } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const endOffset = bytes.byteLength - 22
  expect(signature(bytes, endOffset)).toBe(END_SIGNATURE)
  const legacyCount = view.getUint16(endOffset + 10, true)
  const legacyCentralOffset = view.getUint32(endOffset + 16, true)
  const zip64 = legacyCount === 0xffff || legacyCentralOffset === FIELD32_MAX
  let entryCount = legacyCount
  let centralOffset = legacyCentralOffset

  if (zip64) {
    const locatorOffset = endOffset - 20
    expect(signature(bytes, locatorOffset)).toBe(ZIP64_LOCATOR_SIGNATURE)
    const zip64EndOffset = uint64(view, locatorOffset + 8)
    expect(signature(bytes, zip64EndOffset)).toBe(ZIP64_END_SIGNATURE)
    entryCount = uint64(view, zip64EndOffset + 32)
    centralOffset = uint64(view, zip64EndOffset + 48)
  }

  const decoder = new TextDecoder()
  const entries: ParsedStoredEntry[] = []
  let cursor = centralOffset
  for (let index = 0; index < entryCount; index += 1) {
    expect(signature(bytes, cursor)).toBe(CENTRAL_SIGNATURE)
    const crc = view.getUint32(cursor + 16, true)
    const compressed32 = view.getUint32(cursor + 20, true)
    const uncompressed32 = view.getUint32(cursor + 24, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const localOffset32 = view.getUint32(cursor + 42, true)
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength))

    let compressed = compressed32
    let uncompressed = uncompressed32
    let localOffset = localOffset32
    let extraCursor = cursor + 46 + nameLength
    const extraEnd = extraCursor + extraLength
    while (extraCursor + 4 <= extraEnd) {
      const id = view.getUint16(extraCursor, true)
      const size = view.getUint16(extraCursor + 2, true)
      const dataStart = extraCursor + 4
      if (id === 0x0001) {
        let valueCursor = dataStart
        if (uncompressed32 === FIELD32_MAX) {
          uncompressed = uint64(view, valueCursor)
          valueCursor += 8
        }
        if (compressed32 === FIELD32_MAX) {
          compressed = uint64(view, valueCursor)
          valueCursor += 8
        }
        if (localOffset32 === FIELD32_MAX) localOffset = uint64(view, valueCursor)
      }
      extraCursor = dataStart + size
    }

    expect(compressed).toBe(uncompressed)
    expect(signature(bytes, localOffset)).toBe(LOCAL_SIGNATURE)
    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength
    const data = bytes.slice(dataOffset, dataOffset + compressed)
    expect(zipCrc32(data)).toBe(crc)
    entries.push({
      name,
      bytes: data,
      crc,
      localOffset,
      localUsesZip64: view.getUint32(localOffset + 18, true) === FIELD32_MAX,
    })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return { zip64, entries }
}

class FakeWritable {
  readonly parts: BlobPart[] = []
  aborted = false
  closed = false

  constructor(private readonly handle: FakeFileHandle) {}

  async write(value: unknown): Promise<void> {
    if (this.aborted || this.closed) throw new Error('Fake writable is closed.')
    if (value instanceof ArrayBuffer || value instanceof Blob || typeof value === 'string') {
      this.parts.push(value)
      return
    }
    if (ArrayBuffer.isView(value)) {
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      const owned = new Uint8Array(bytes.byteLength)
      owned.set(bytes)
      this.parts.push(owned.buffer)
      return
    }
    throw new Error('Unsupported fake write payload.')
  }

  async close(): Promise<void> {
    this.closed = true
    this.handle.file = new Blob(this.parts, { type: 'application/zip' })
  }

  async abort(): Promise<void> {
    this.aborted = true
    this.parts.length = 0
  }
}

class FakeFileHandle {
  file = new Blob()
  writable: FakeWritable | null = null

  async createWritable(): Promise<FileSystemWritableFileStream> {
    this.writable = new FakeWritable(this)
    return this.writable as unknown as FileSystemWritableFileStream
  }

  async getFile(): Promise<File> {
    return this.file as File
  }
}

class FakeDirectoryHandle {
  readonly handles = new Map<string, FakeFileHandle>()
  readonly removed: string[] = []
  readonly created: string[] = []

  seed(name: string): void {
    this.handles.set(name, new FakeFileHandle())
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle> {
    let handle = this.handles.get(name)
    if (!handle && options?.create) {
      handle = new FakeFileHandle()
      this.handles.set(name, handle)
      this.created.push(name)
    }
    if (!handle) throw new DOMException('Missing.', 'NotFoundError')
    return handle as unknown as FileSystemFileHandle
  }

  async removeEntry(name: string): Promise<void> {
    this.removed.push(name)
    this.handles.delete(name)
  }

  async *entries(): AsyncIterableIterator<[string, FileSystemHandle]> {
    for (const [name, handle] of [...this.handles]) {
      yield [name, handle as unknown as FileSystemHandle]
    }
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('store-mode ZIP writer', () => {
  it('matches the standard CRC-32 check vector', () => {
    expect(zipCrc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })

  it('writes archives whose central directory, offsets, payloads, and CRCs parse cleanly', async () => {
    const zip = await createStoredZip([
      { name: 'manifest.json', data: '{"seamless":true}', modifiedAt: new Date(2026, 0, 2, 3, 4, 6) },
      { name: 'frames/främe-0001.png', data: new Uint8Array([137, 80, 78, 71]), modifiedAt: new Date(2026, 0, 2) },
    ])
    const parsed = parseStoredZip(new Uint8Array(await zip.arrayBuffer()))

    expect(zip.type).toBe('application/zip')
    expect(parsed.zip64).toBe(false)
    expect(parsed.entries.map((entry) => entry.name)).toEqual([
      'manifest.json',
      'frames/främe-0001.png',
    ])
    expect(new TextDecoder().decode(parsed.entries[0]!.bytes)).toBe('{"seamless":true}')
    expect([...parsed.entries[1]!.bytes]).toEqual([137, 80, 78, 71])
  })

  it('emits a complete standards-valid ZIP64 layout and switches at reserved field boundaries', async () => {
    expect(zipValueNeedsZip64(0xfffffffe)).toBe(false)
    expect(zipValueNeedsZip64(0xffffffff)).toBe(true)
    const zip = await createStoredZip([
      { name: 'large-compatible.bin', data: new Uint8Array([1, 2, 3, 4]) },
    ], { forceZip64: true })
    const bytes = new Uint8Array(await zip.arrayBuffer())
    const parsed = parseStoredZip(bytes)

    expect(parsed.zip64).toBe(true)
    expect(parsed.entries).toHaveLength(1)
    expect(parsed.entries[0]!.localUsesZip64).toBe(true)
    expect([...parsed.entries[0]!.bytes]).toEqual([1, 2, 3, 4])
  })

  it('rejects traversal, duplicate names, and empty archives', async () => {
    await expect(createStoredZip([])).rejects.toThrow(/at least one/)
    await expect(createStoredZip([{ name: '../escape', data: 'x' }])).rejects.toThrow(/Unsafe/)
    await expect(createStoredZip([
      { name: 'same', data: 'a' },
      { name: 'same', data: 'b' },
    ])).rejects.toThrow(/Duplicate/)
  })

  it('exposes exact capacity projections and rejects memory overflow before reading a Blob', async () => {
    const archive = await createStoredZipArchive({
      preferTemporaryFile: false,
      memoryLimitBytes: 512,
    })
    expect(archive.storage).toBe('memory')
    expect(archive.capacityBytes).toBe(512)
    expect(archive.capacitySource).toBe('memory-limit')
    expect(archive.projectedSize([{ name: 'one.txt', size: 3 }])).toBeLessThan(512)

    const blob = new Blob([new Uint8Array(500)])
    const slice = vi.spyOn(blob, 'slice')
    await expect(archive.add({ name: 'large.bin', data: blob })).rejects.toThrow(/in-memory/)
    expect(slice).not.toHaveBeenCalled()
    await archive.abort()
  })

  it('checks cancellation between CRC chunks without committing a partial entry', async () => {
    const archive = await createStoredZipArchive({
      preferTemporaryFile: false,
      memoryLimitBytes: 4096,
    })
    const controller = new AbortController()
    await expect(archive.add({
      name: 'cancel.bin',
      data: new Uint8Array(64),
    }, {
      signal: controller.signal,
      chunkSizeBytes: 8,
      yieldToHost: async () => controller.abort(),
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(archive.projectedSize([{ name: 'cancel.bin', size: 64 }])).toBeLessThan(4096)
    await archive.abort()
  })

  it('checks cancellation while assembling a large central directory', async () => {
    const archive = await createStoredZipArchive({
      preferTemporaryFile: false,
      memoryLimitBytes: 128 * 1024,
    })
    for (let index = 0; index < 70; index += 1) {
      await archive.add({ name: `entry-${index}.txt`, data: '' })
    }
    const controller = new AbortController()
    await expect(archive.complete({
      signal: controller.signal,
      yieldToHost: async () => controller.abort(),
    })).rejects.toMatchObject({ name: 'AbortError' })
    await archive.abort()
  })

  it('streams through OPFS, reports conservative quota, removes confirmed files, and scavenges abandoned stale files', async () => {
    const directory = new FakeDirectoryHandle()
    let now = Date.UTC(2026, 7, 10, 12)
    const staleName = `${TEMPORARY_ARCHIVE_PREFIX}${now - TEMPORARY_ARCHIVE_RETENTION_MS - 1}-1.zip`
    const freshName = `${TEMPORARY_ARCHIVE_PREFIX}${now - TEMPORARY_ARCHIVE_RETENTION_MS + 1}-2.zip`
    directory.seed(staleName)
    directory.seed(freshName)
    directory.seed('unrelated.zip')
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: async () => directory as unknown as FileSystemDirectoryHandle,
        estimate: async () => ({ quota: 1_000_000, usage: 100_000 }),
      },
    })

    const archive = await createStoredZipArchive({ now: () => now })
    expect(archive.storage).toBe('temporary-file')
    expect(archive.capacitySource).toBe('storage-estimate')
    expect(archive.capacityBytes).toBe(810_000)
    expect(directory.removed).toContain(staleName)
    expect(directory.handles.has(freshName)).toBe(true)
    expect(directory.handles.has('unrelated.zip')).toBe(true)

    await archive.add({ name: 'one.txt', data: 'one' }, { chunkSizeBytes: 2 })
    const result = await archive.complete({ chunkSizeBytes: 2 })
    expect(parseStoredZip(new Uint8Array(await result.arrayBuffer())).entries[0]!.name).toBe('one.txt')
    const completedName = directory.created.at(-1)!
    await archive.cleanup()
    expect(directory.handles.has(completedName)).toBe(false)

    now += TEMPORARY_ARCHIVE_RETENTION_MS
    const startupStale = `${TEMPORARY_ARCHIVE_PREFIX}${now - TEMPORARY_ARCHIVE_RETENTION_MS}-99.zip`
    directory.seed(startupStale)
    await cleanupStaleStoredZipArchives({ now: () => now })
    expect(directory.handles.has(startupStale)).toBe(false)

    const aborted = await createStoredZipArchive({ now: () => now })
    const abortedName = directory.created.at(-1)!
    await aborted.add({ name: 'partial.bin', data: new Uint8Array(32) })
    await aborted.abort()
    expect(directory.handles.has(abortedName)).toBe(false)

    const sameTimestampA = await createStoredZipArchive({ now: () => now })
    const sameTimestampAName = directory.created.at(-1)!
    const sameTimestampB = await createStoredZipArchive({ now: () => now })
    const sameTimestampBName = directory.created.at(-1)!
    expect(sameTimestampAName).not.toBe(sameTimestampBName)
    expect(sameTimestampAName).toMatch(new RegExp(`^${TEMPORARY_ARCHIVE_PREFIX}${now}-[A-Za-z0-9-]+\\.zip$`))
    await sameTimestampA.abort()
    await sameTimestampB.abort()

    const cancelled = await createStoredZipArchive({ now: () => now })
    const cancelledName = directory.created.at(-1)!
    const controller = new AbortController()
    let yields = 0
    await expect(cancelled.add({ name: 'cancelled.bin', data: new Uint8Array(64) }, {
      signal: controller.signal,
      chunkSizeBytes: 8,
      yieldToHost: async () => {
        yields += 1
        // Seven yields finish CRC; the eighth interrupts chunked file writing.
        if (yields === 8) controller.abort()
      },
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(directory.handles.has(cancelledName)).toBe(false)
  })
})
