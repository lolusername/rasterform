const ZIP_LOCAL_FILE_HEADER = 0x04034b50
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50
const ZIP64_END_OF_CENTRAL_DIRECTORY = 0x06064b50
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR = 0x07064b50
const ZIP64_EXTRA_FIELD = 0x0001
const ZIP_UTF8_FLAG = 0x0800
const ZIP_VERSION = 20
const ZIP64_VERSION = 45
const ZIP32_FIELD_MAX = 0xffffffff
const ZIP16_FIELD_MAX = 0xffff
const ZIP64_END_SIZE = 56
const ZIP64_LOCATOR_SIZE = 20
const ZIP_END_SIZE = 22
const DEFAULT_CHUNK_SIZE = 1024 * 1024
const DEFAULT_MEMORY_ARCHIVE_LIMIT = 512 * 1024 * 1024
const DEFAULT_STORAGE_HEADROOM = 0.9

export const TEMPORARY_ARCHIVE_PREFIX = 'rasterform-living-'
export const TEMPORARY_ARCHIVE_RETENTION_MS = 24 * 60 * 60 * 1000

export type ZipEntryData = Blob | Uint8Array | ArrayBuffer | string

export interface StoredZipEntry {
  name: string
  data: ZipEntryData
  modifiedAt?: Date
  /**
   * An exact byte snapshot already read by the caller for validation. When it
   * is present, CRC calculation and temporary-file writing reuse it instead of
   * reading the Blob a second time.
   */
  bytes?: Uint8Array
}

export interface StoredZipProjection {
  name: string
  size: number
}

export interface ZipWorkOptions {
  signal?: AbortSignal
  /** Primarily useful for deterministic cancellation tests. */
  chunkSizeBytes?: number
  /** Primarily useful for deterministic cancellation tests. */
  yieldToHost?: () => Promise<void>
}

interface ZipEntryRecord {
  name: Uint8Array
  crc: number
  size: number
  time: number
  date: number
  offset: number
  forceZip64: boolean
}

interface ZipDataSource {
  data: ZipEntryData
  bytes?: Uint8Array
  size: number
}

interface ZipEntryDraft {
  record: ZipEntryRecord
  source: ZipDataSource
}

interface ZipFooter {
  parts: ArrayBuffer[]
  centralSize: number
  zip64: boolean
}

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let value = 0; value < 256; value += 1) {
    let crc = value
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
    }
    table[value] = crc >>> 0
  }
  return table
})()

function updateCrc32(crc: number, bytes: Uint8Array): number {
  let next = crc
  for (const byte of bytes) next = (crcTable[(next ^ byte) & 0xff] ?? 0) ^ (next >>> 8)
  return next >>> 0
}

export function zipCrc32(bytes: Uint8Array): number {
  return (updateCrc32(0xffffffff, bytes) ^ 0xffffffff) >>> 0
}

/** ZIP32 reserves its maximum field value as the ZIP64 sentinel. */
export function zipValueNeedsZip64(value: number): boolean {
  assertArchiveNumber(value, 'ZIP value')
  return value >= ZIP32_FIELD_MAX
}

function zipCountNeedsZip64(value: number): boolean {
  return value >= ZIP16_FIELD_MAX
}

function assertArchiveNumber(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} exceeds the safe browser archive range.`)
  }
}

function addArchiveNumbers(left: number, right: number, label = 'ZIP archive'): number {
  const value = left + right
  assertArchiveNumber(value, label)
  return value
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const owned = new Uint8Array(bytes.byteLength)
  owned.set(bytes)
  return owned.buffer
}

function assertEntryName(name: string): void {
  if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')) {
    throw new Error(`Unsafe ZIP entry name: ${name || '(empty)'}.`)
  }
  if (name.includes('\0')) throw new Error('ZIP entry names cannot contain null bytes.')
}

function encodeEntryName(name: string): Uint8Array {
  assertEntryName(name)
  const encoded = new TextEncoder().encode(name)
  if (encoded.length > ZIP16_FIELD_MAX) throw new Error(`ZIP entry name is too long: ${name}.`)
  return encoded
}

function dosTimestamp(date: Date): { time: number; date: number } {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()))
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

function writeUint64(view: DataView, offset: number, value: number): void {
  assertArchiveNumber(value, 'ZIP64 value')
  view.setBigUint64(offset, BigInt(value), true)
}

function zip64Extra(values: readonly number[]): Uint8Array {
  const extra = new Uint8Array(4 + values.length * 8)
  const view = new DataView(extra.buffer)
  view.setUint16(0, ZIP64_EXTRA_FIELD, true)
  view.setUint16(2, values.length * 8, true)
  values.forEach((value, index) => writeUint64(view, 4 + index * 8, value))
  return extra
}

function entryUsesZip64Size(entry: ZipEntryRecord): boolean {
  return entry.forceZip64 || zipValueNeedsZip64(entry.size)
}

function entryUsesZip64Offset(entry: ZipEntryRecord): boolean {
  return entry.forceZip64 || zipValueNeedsZip64(entry.offset)
}

function localExtraLength(entry: ZipEntryRecord): number {
  return entryUsesZip64Size(entry) ? 20 : 0
}

function centralExtraLength(entry: ZipEntryRecord): number {
  const values = (entryUsesZip64Size(entry) ? 2 : 0) + (entryUsesZip64Offset(entry) ? 1 : 0)
  return values ? 4 + values * 8 : 0
}

function localHeaderLength(entry: ZipEntryRecord): number {
  return 30 + entry.name.byteLength + localExtraLength(entry)
}

function centralHeaderLength(entry: ZipEntryRecord): number {
  return 46 + entry.name.byteLength + centralExtraLength(entry)
}

function localHeader(entry: ZipEntryRecord): Uint8Array {
  const usesZip64 = entryUsesZip64Size(entry)
  const extra = usesZip64 ? zip64Extra([entry.size, entry.size]) : new Uint8Array()
  const header = new Uint8Array(30 + entry.name.length + extra.length)
  const view = new DataView(header.buffer)
  view.setUint32(0, ZIP_LOCAL_FILE_HEADER, true)
  view.setUint16(4, usesZip64 ? ZIP64_VERSION : ZIP_VERSION, true)
  view.setUint16(6, ZIP_UTF8_FLAG, true)
  view.setUint16(8, 0, true) // Stored: PNG payloads are already compressed.
  view.setUint16(10, entry.time, true)
  view.setUint16(12, entry.date, true)
  view.setUint32(14, entry.crc, true)
  view.setUint32(18, usesZip64 ? ZIP32_FIELD_MAX : entry.size, true)
  view.setUint32(22, usesZip64 ? ZIP32_FIELD_MAX : entry.size, true)
  view.setUint16(26, entry.name.length, true)
  view.setUint16(28, extra.length, true)
  header.set(entry.name, 30)
  header.set(extra, 30 + entry.name.length)
  return header
}

function centralHeader(entry: ZipEntryRecord): Uint8Array {
  const zip64Size = entryUsesZip64Size(entry)
  const zip64Offset = entryUsesZip64Offset(entry)
  const values: number[] = []
  if (zip64Size) values.push(entry.size, entry.size)
  if (zip64Offset) values.push(entry.offset)
  const extra = values.length ? zip64Extra(values) : new Uint8Array()
  const usesZip64 = values.length > 0
  const header = new Uint8Array(46 + entry.name.length + extra.length)
  const view = new DataView(header.buffer)
  view.setUint32(0, ZIP_CENTRAL_DIRECTORY_HEADER, true)
  view.setUint16(4, usesZip64 ? ZIP64_VERSION : ZIP_VERSION, true)
  view.setUint16(6, usesZip64 ? ZIP64_VERSION : ZIP_VERSION, true)
  view.setUint16(8, ZIP_UTF8_FLAG, true)
  view.setUint16(10, 0, true)
  view.setUint16(12, entry.time, true)
  view.setUint16(14, entry.date, true)
  view.setUint32(16, entry.crc, true)
  view.setUint32(20, zip64Size ? ZIP32_FIELD_MAX : entry.size, true)
  view.setUint32(24, zip64Size ? ZIP32_FIELD_MAX : entry.size, true)
  view.setUint16(28, entry.name.length, true)
  view.setUint16(30, extra.length, true)
  view.setUint16(32, 0, true)
  view.setUint16(34, 0, true)
  view.setUint16(36, 0, true)
  view.setUint32(38, 0, true)
  view.setUint32(42, zip64Offset ? ZIP32_FIELD_MAX : entry.offset, true)
  header.set(entry.name, 46)
  header.set(extra, 46 + entry.name.length)
  return header
}

function zip64EndOfCentralDirectory(entryCount: number, size: number, offset: number): Uint8Array {
  const footer = new Uint8Array(ZIP64_END_SIZE)
  const view = new DataView(footer.buffer)
  view.setUint32(0, ZIP64_END_OF_CENTRAL_DIRECTORY, true)
  writeUint64(view, 4, 44)
  view.setUint16(12, ZIP64_VERSION, true)
  view.setUint16(14, ZIP64_VERSION, true)
  view.setUint32(16, 0, true)
  view.setUint32(20, 0, true)
  writeUint64(view, 24, entryCount)
  writeUint64(view, 32, entryCount)
  writeUint64(view, 40, size)
  writeUint64(view, 48, offset)
  return footer
}

function zip64Locator(zip64EndOffset: number): Uint8Array {
  const locator = new Uint8Array(ZIP64_LOCATOR_SIZE)
  const view = new DataView(locator.buffer)
  view.setUint32(0, ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR, true)
  view.setUint32(4, 0, true)
  writeUint64(view, 8, zip64EndOffset)
  view.setUint32(16, 1, true)
  return locator
}

function endOfCentralDirectory(
  entryCount: number,
  size: number,
  offset: number,
  zip64: boolean,
): Uint8Array {
  const footer = new Uint8Array(ZIP_END_SIZE)
  const view = new DataView(footer.buffer)
  view.setUint32(0, ZIP_END_OF_CENTRAL_DIRECTORY, true)
  view.setUint16(4, 0, true)
  view.setUint16(6, 0, true)
  view.setUint16(8, zip64 ? ZIP16_FIELD_MAX : entryCount, true)
  view.setUint16(10, zip64 ? ZIP16_FIELD_MAX : entryCount, true)
  view.setUint32(12, zip64 ? ZIP32_FIELD_MAX : size, true)
  view.setUint32(16, zip64 ? ZIP32_FIELD_MAX : offset, true)
  view.setUint16(20, 0, true)
  return footer
}

function archiveUsesZip64(
  records: readonly ZipEntryRecord[],
  centralSize: number,
  centralOffset: number,
  forceZip64: boolean,
): boolean {
  return forceZip64
    || records.some((record) => entryUsesZip64Size(record) || entryUsesZip64Offset(record))
    || zipCountNeedsZip64(records.length)
    || zipValueNeedsZip64(centralSize)
    || zipValueNeedsZip64(centralOffset)
}

function footerOverhead(zip64: boolean): number {
  return zip64 ? ZIP64_END_SIZE + ZIP64_LOCATOR_SIZE + ZIP_END_SIZE : ZIP_END_SIZE
}

function archiveLayoutSize(
  records: readonly ZipEntryRecord[],
  centralOffset: number,
  forceZip64: boolean,
): number {
  const centralSize = records.reduce(
    (total, record) => addArchiveNumbers(total, centralHeaderLength(record), 'ZIP central directory'),
    0,
  )
  const zip64 = archiveUsesZip64(records, centralSize, centralOffset, forceZip64)
  return addArchiveNumbers(
    addArchiveNumbers(centralOffset, centralSize),
    footerOverhead(zip64),
  )
}

function dataSource(entry: StoredZipEntry): ZipDataSource {
  let source: ZipDataSource
  if (entry.data instanceof Blob) source = { data: entry.data, size: entry.data.size }
  else if (typeof entry.data === 'string') {
    const bytes = new TextEncoder().encode(entry.data)
    source = { data: entry.data, bytes, size: bytes.byteLength }
  } else if (entry.data instanceof ArrayBuffer) {
    source = { data: entry.data, bytes: new Uint8Array(entry.data), size: entry.data.byteLength }
  } else {
    source = { data: entry.data, bytes: entry.data, size: entry.data.byteLength }
  }
  assertArchiveNumber(source.size, `ZIP entry ${entry.name}`)
  if (entry.bytes) {
    if (entry.bytes.byteLength !== source.size) {
      throw new Error(`ZIP byte snapshot size does not match ${entry.name}.`)
    }
    source.bytes = entry.bytes
  }
  return source
}

function operationChunkSize(options?: ZipWorkOptions): number {
  const requested = options?.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE
  if (!Number.isFinite(requested)) return DEFAULT_CHUNK_SIZE
  return Math.max(1, Math.min(16 * 1024 * 1024, Math.floor(requested)))
}

function zipAbortError(): DOMException {
  return new DOMException('ZIP operation cancelled.', 'AbortError')
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw zipAbortError()
}

function defaultYieldToHost(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

async function yieldAndCheck(options?: ZipWorkOptions): Promise<void> {
  await (options?.yieldToHost ?? defaultYieldToHost)()
  throwIfAborted(options?.signal)
}

async function crc32ForSource(source: ZipDataSource, options?: ZipWorkOptions): Promise<number> {
  const chunkSize = operationChunkSize(options)
  let crc = 0xffffffff
  if (source.bytes) {
    for (let offset = 0; offset < source.bytes.byteLength; offset += chunkSize) {
      throwIfAborted(options?.signal)
      const end = Math.min(source.bytes.byteLength, offset + chunkSize)
      crc = updateCrc32(crc, source.bytes.subarray(offset, end))
      if (end < source.bytes.byteLength) await yieldAndCheck(options)
    }
    throwIfAborted(options?.signal)
    return (crc ^ 0xffffffff) >>> 0
  }

  const blob = source.data as Blob
  for (let offset = 0; offset < blob.size; offset += chunkSize) {
    throwIfAborted(options?.signal)
    const end = Math.min(blob.size, offset + chunkSize)
    const bytes = new Uint8Array(await blob.slice(offset, end).arrayBuffer())
    throwIfAborted(options?.signal)
    if (bytes.byteLength !== end - offset) throw new Error('The browser returned an incomplete ZIP data chunk.')
    crc = updateCrc32(crc, bytes)
    if (end < blob.size) await yieldAndCheck(options)
  }
  throwIfAborted(options?.signal)
  return (crc ^ 0xffffffff) >>> 0
}

function memoryPart(source: ZipDataSource): BlobPart {
  if (source.data instanceof Blob || typeof source.data === 'string' || source.data instanceof ArrayBuffer) {
    return source.data
  }
  return ownedArrayBuffer(source.data)
}

async function writeBytes(
  writable: FileSystemWritableFileStream,
  bytes: Uint8Array,
  options?: ZipWorkOptions,
): Promise<void> {
  const chunkSize = operationChunkSize(options)
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    throwIfAborted(options?.signal)
    const end = Math.min(bytes.byteLength, offset + chunkSize)
    await writable.write(ownedArrayBuffer(bytes.subarray(offset, end)))
    throwIfAborted(options?.signal)
    if (end < bytes.byteLength) await yieldAndCheck(options)
  }
}

async function writeSource(
  writable: FileSystemWritableFileStream,
  source: ZipDataSource,
  options?: ZipWorkOptions,
): Promise<void> {
  if (source.bytes) {
    await writeBytes(writable, source.bytes, options)
    return
  }
  const blob = source.data as Blob
  const chunkSize = operationChunkSize(options)
  for (let offset = 0; offset < blob.size; offset += chunkSize) {
    throwIfAborted(options?.signal)
    const end = Math.min(blob.size, offset + chunkSize)
    const buffer = await blob.slice(offset, end).arrayBuffer()
    throwIfAborted(options?.signal)
    if (buffer.byteLength !== end - offset) throw new Error('The browser returned an incomplete ZIP data chunk.')
    await writable.write(buffer)
    throwIfAborted(options?.signal)
    if (end < blob.size) await yieldAndCheck(options)
  }
}

export interface StoredZipArchive {
  readonly storage: 'temporary-file' | 'memory'
  /** Hard memory bound or a conservative available-storage estimate; null when unknown. */
  readonly capacityBytes: number | null
  readonly capacitySource: 'memory-limit' | 'storage-estimate' | null
  add(entry: StoredZipEntry, options?: ZipWorkOptions): Promise<void>
  complete(options?: ZipWorkOptions): Promise<Blob>
  abort(): Promise<void>
  /**
   * A projected finished size, including local headers, the central directory,
   * and ZIP64 metadata when needed.
   */
  projectedSize(entries: readonly StoredZipProjection[]): number
  /**
   * Remove a completed private archive after its consumer has confirmed that
   * the destination write or browser retention window is complete.
   */
  cleanup(): Promise<void>
}

export interface StoredZipArchiveOptions {
  preferTemporaryFile?: boolean
  /** Bounded fallback for browsers without origin-private file storage. */
  memoryLimitBytes?: number
  /** Emit a small standards-valid ZIP64 archive, primarily for compatibility tests. */
  forceZip64?: boolean
  /** Primarily for deterministic retention tests. */
  now?: () => number
}

abstract class BaseStoredZipArchive implements StoredZipArchive {
  abstract readonly storage: StoredZipArchive['storage']
  abstract readonly capacityBytes: number | null
  abstract readonly capacitySource: StoredZipArchive['capacitySource']
  protected readonly records: ZipEntryRecord[] = []
  protected readonly names = new Set<string>()
  protected offset = 0
  protected finished = false

  constructor(protected readonly forceZip64: boolean) {}

  protected ensureOpen(): void {
    if (this.finished) throw new Error('This ZIP archive is already closed.')
  }

  protected createDraft(entry: StoredZipEntry): ZipEntryDraft {
    this.ensureOpen()
    if (this.names.has(entry.name)) throw new Error(`Duplicate ZIP entry: ${entry.name}.`)
    const name = encodeEntryName(entry.name)
    const source = dataSource(entry)
    const timestamp = dosTimestamp(entry.modifiedAt ?? new Date())
    return {
      source,
      record: {
        name,
        crc: 0,
        size: source.size,
        time: timestamp.time,
        date: timestamp.date,
        offset: this.offset,
        forceZip64: this.forceZip64,
      },
    }
  }

  protected async finishDraft(draft: ZipEntryDraft, options?: ZipWorkOptions): Promise<ZipEntryDraft> {
    throwIfAborted(options?.signal)
    draft.record.crc = await crc32ForSource(draft.source, options)
    throwIfAborted(options?.signal)
    return draft
  }

  protected commit(entryName: string, record: ZipEntryRecord): void {
    const localEnd = addArchiveNumbers(record.offset, localHeaderLength(record))
    this.offset = addArchiveNumbers(localEnd, record.size)
    this.names.add(entryName)
    this.records.push(record)
  }

  projectedSize(entries: readonly StoredZipProjection[]): number {
    let projectedOffset = this.offset
    const projectedRecords = this.records.slice()
    const projectedNames = new Set(this.names)
    for (const entry of entries) {
      if (projectedNames.has(entry.name)) throw new Error(`Duplicate ZIP entry: ${entry.name}.`)
      const name = encodeEntryName(entry.name)
      assertArchiveNumber(entry.size, `ZIP entry ${entry.name}`)
      const record: ZipEntryRecord = {
        name,
        crc: 0,
        size: entry.size,
        time: 0,
        date: 0,
        offset: projectedOffset,
        forceZip64: this.forceZip64,
      }
      projectedOffset = addArchiveNumbers(
        addArchiveNumbers(projectedOffset, localHeaderLength(record)),
        record.size,
      )
      projectedRecords.push(record)
      projectedNames.add(entry.name)
    }
    return archiveLayoutSize(projectedRecords, projectedOffset, this.forceZip64)
  }

  protected async footerParts(options?: ZipWorkOptions): Promise<ZipFooter> {
    const parts: ArrayBuffer[] = []
    let centralSize = 0
    for (let index = 0; index < this.records.length; index += 1) {
      throwIfAborted(options?.signal)
      const header = centralHeader(this.records[index]!)
      centralSize = addArchiveNumbers(centralSize, header.byteLength, 'ZIP central directory')
      parts.push(ownedArrayBuffer(header))
      if ((index + 1) % 64 === 0 && index + 1 < this.records.length) await yieldAndCheck(options)
    }
    const zip64 = archiveUsesZip64(this.records, centralSize, this.offset, this.forceZip64)
    if (zip64) {
      const zip64EndOffset = addArchiveNumbers(this.offset, centralSize)
      parts.push(
        ownedArrayBuffer(zip64EndOfCentralDirectory(this.records.length, centralSize, this.offset)),
        ownedArrayBuffer(zip64Locator(zip64EndOffset)),
      )
    }
    parts.push(ownedArrayBuffer(endOfCentralDirectory(this.records.length, centralSize, this.offset, zip64)))
    throwIfAborted(options?.signal)
    return { parts, centralSize, zip64 }
  }

  abstract add(entry: StoredZipEntry, options?: ZipWorkOptions): Promise<void>
  abstract complete(options?: ZipWorkOptions): Promise<Blob>
  abstract abort(): Promise<void>
  abstract cleanup(): Promise<void>
}

class MemoryStoredZipArchive extends BaseStoredZipArchive {
  readonly storage = 'memory' as const
  readonly capacitySource = 'memory-limit' as const
  readonly capacityBytes: number
  private readonly parts: BlobPart[] = []

  constructor(limit: number, forceZip64: boolean) {
    super(forceZip64)
    this.capacityBytes = Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(limit)))
  }

  async add(entry: StoredZipEntry, options?: ZipWorkOptions): Promise<void> {
    const draft = this.createDraft(entry)
    // Reject before reading a Blob or calculating its CRC.
    const projected = this.projectedSize([{ name: entry.name, size: draft.record.size }])
    if (projected > this.capacityBytes) {
      throw new Error('This lossless loop is too large for this browser’s in-memory ZIP fallback.')
    }
    await this.finishDraft(draft, options)
    this.parts.push(ownedArrayBuffer(localHeader(draft.record)), memoryPart(draft.source))
    this.commit(entry.name, draft.record)
  }

  async complete(options?: ZipWorkOptions): Promise<Blob> {
    this.ensureOpen()
    if (!this.records.length) throw new Error('A ZIP archive needs at least one entry.')
    throwIfAborted(options?.signal)
    const footer = await this.footerParts(options)
    const finalSize = addArchiveNumbers(
      addArchiveNumbers(this.offset, footer.centralSize),
      footerOverhead(footer.zip64),
    )
    if (finalSize > this.capacityBytes) {
      throw new Error('This lossless loop is too large for this browser’s in-memory ZIP fallback.')
    }
    throwIfAborted(options?.signal)
    const blob = new Blob([...this.parts, ...footer.parts], { type: 'application/zip' })
    throwIfAborted(options?.signal)
    this.parts.length = 0
    this.finished = true
    return blob
  }

  async abort(): Promise<void> {
    this.finished = true
    this.parts.length = 0
  }

  async cleanup(): Promise<void> {
    this.parts.length = 0
  }
}

class TemporaryFileStoredZipArchive extends BaseStoredZipArchive {
  readonly storage = 'temporary-file' as const
  readonly capacitySource: StoredZipArchive['capacitySource']

  constructor(
    private readonly directory: FileSystemDirectoryHandle,
    private readonly fileName: string,
    private readonly handle: FileSystemFileHandle,
    private readonly writable: FileSystemWritableFileStream,
    readonly capacityBytes: number | null,
    forceZip64: boolean,
  ) {
    super(forceZip64)
    this.capacitySource = capacityBytes === null ? null : 'storage-estimate'
  }

  async add(entry: StoredZipEntry, options?: ZipWorkOptions): Promise<void> {
    try {
      const draft = this.createDraft(entry)
      await this.finishDraft(draft, options)
      await writeBytes(this.writable, localHeader(draft.record), options)
      await writeSource(this.writable, draft.source, options)
      this.commit(entry.name, draft.record)
    } catch (error) {
      await this.abort()
      throw error
    }
  }

  async complete(options?: ZipWorkOptions): Promise<Blob> {
    try {
      this.ensureOpen()
      if (!this.records.length) throw new Error('A ZIP archive needs at least one entry.')
      const footer = await this.footerParts(options)
      for (let index = 0; index < footer.parts.length; index += 1) {
        throwIfAborted(options?.signal)
        await this.writable.write(footer.parts[index]!)
        throwIfAborted(options?.signal)
        if ((index + 1) % 64 === 0 && index + 1 < footer.parts.length) await yieldAndCheck(options)
      }
      await this.writable.close()
      this.finished = true
      throwIfAborted(options?.signal)
      return await this.handle.getFile()
    } catch (error) {
      await this.abort()
      throw error
    }
  }

  private async removeImmediately(): Promise<void> {
    try {
      await this.directory.removeEntry(this.fileName)
    } catch {
      // Already removed, unavailable, or cleaned by browser storage eviction.
    }
  }

  async abort(): Promise<void> {
    if (!this.finished) {
      this.finished = true
      try {
        await this.writable.abort()
      } catch {
        // Removal below still clears a partially written private file.
      }
    }
    await this.removeImmediately()
  }

  async cleanup(): Promise<void> {
    await this.removeImmediately()
  }
}

type IterableDirectoryHandle = FileSystemDirectoryHandle & {
  entries?: () => AsyncIterableIterator<[string, FileSystemHandle]>
}

function temporaryArchiveTimestamp(name: string): number | null {
  if (!name.startsWith(TEMPORARY_ARCHIVE_PREFIX) || !name.endsWith('.zip')) return null
  const match = name.slice(TEMPORARY_ARCHIVE_PREFIX.length).match(/^(\d+)-[A-Za-z0-9-]+\.zip$/)
  if (!match) return null
  const timestamp = Number(match[1])
  return Number.isSafeInteger(timestamp) ? timestamp : null
}

function temporaryArchiveNonce(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    const words = new Uint32Array(4)
    globalThis.crypto.getRandomValues(words)
    return Array.from(words, (word) => word.toString(16).padStart(8, '0')).join('')
  }
  throw new Error('Secure random archive names are unavailable.')
}

async function removeStaleTemporaryArchives(
  directory: FileSystemDirectoryHandle,
  now: number,
): Promise<void> {
  const entries = (directory as IterableDirectoryHandle).entries
  if (typeof entries !== 'function') return
  try {
    for await (const [name] of entries.call(directory)) {
      const timestamp = temporaryArchiveTimestamp(name)
      if (timestamp === null || now - timestamp < TEMPORARY_ARCHIVE_RETENTION_MS) continue
      try {
        await directory.removeEntry(name)
      } catch {
        // Another tab, storage eviction, or permissions may win the race.
      }
    }
  } catch {
    // Enumeration is not uniformly available in every StorageManager implementation.
  }
}

/** Best-effort startup scavenging for completed private archives older than 24 hours. */
export async function cleanupStaleStoredZipArchives(
  options: Pick<StoredZipArchiveOptions, 'now'> = {},
): Promise<void> {
  if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') return
  try {
    const directory = await navigator.storage.getDirectory()
    await removeStaleTemporaryArchives(directory, (options.now ?? Date.now)())
  } catch {
    // Storage access is optional; export falls back to bounded memory without it.
  }
}

async function availableStorageCapacity(): Promise<number | null> {
  if (typeof navigator.storage?.estimate !== 'function') return null
  try {
    const estimate = await navigator.storage.estimate()
    const quota = estimate.quota
    const usage = estimate.usage
    if (!Number.isFinite(quota) || !Number.isFinite(usage) || quota === undefined || usage === undefined) return null
    const available = Math.max(0, quota - usage)
    if (!Number.isSafeInteger(Math.floor(available))) return null
    return Math.floor(available * DEFAULT_STORAGE_HEADROOM)
  } catch {
    return null
  }
}

async function temporaryFileArchive(options: StoredZipArchiveOptions): Promise<StoredZipArchive | null> {
  if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') return null
  let directory: FileSystemDirectoryHandle | null = null
  let fileName: string | null = null
  try {
    directory = await navigator.storage.getDirectory()
    const now = options.now ?? Date.now
    const createdAt = now()
    await removeStaleTemporaryArchives(directory, createdAt)
    const capacity = await availableStorageCapacity()
    fileName = `${TEMPORARY_ARCHIVE_PREFIX}${createdAt}-${temporaryArchiveNonce()}.zip`
    const handle = await directory.getFileHandle(fileName, { create: true })
    const writable = await handle.createWritable()
    return new TemporaryFileStoredZipArchive(
      directory,
      fileName,
      handle,
      writable,
      capacity,
      options.forceZip64 ?? false,
    )
  } catch {
    if (directory && fileName) {
      try {
        await directory.removeEntry(fileName)
      } catch {
        // The failed setup may not have created the entry yet.
      }
    }
    return null
  }
}

/** Prefer a private streaming file so completed frames can be released immediately. */
export async function createStoredZipArchive(
  options: StoredZipArchiveOptions = {},
): Promise<StoredZipArchive> {
  if (options.preferTemporaryFile !== false) {
    const temporary = await temporaryFileArchive(options)
    if (temporary) return temporary
  }
  return new MemoryStoredZipArchive(
    options.memoryLimitBytes ?? DEFAULT_MEMORY_ARCHIVE_LIMIT,
    options.forceZip64 ?? false,
  )
}

/** Build a standards-compatible store-mode ZIP without recompressing payloads. */
export async function createStoredZip(
  entries: readonly StoredZipEntry[],
  options: Omit<StoredZipArchiveOptions, 'preferTemporaryFile' | 'memoryLimitBytes'> = {},
): Promise<Blob> {
  if (!entries.length) throw new Error('A ZIP archive needs at least one entry.')
  const archive = new MemoryStoredZipArchive(Number.MAX_SAFE_INTEGER, options.forceZip64 ?? false)
  try {
    for (const entry of entries) await archive.add(entry)
    return await archive.complete()
  } catch (error) {
    await archive.abort()
    throw error
  }
}
