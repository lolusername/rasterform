import { createHash, randomUUID } from 'node:crypto'
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { constants as fileSystemConstants, createReadStream } from 'node:fs'
import { endianness, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { createGunzip } from 'node:zlib'
import {
  assertDesktopBlenderExportSnapshot,
  isDesktopBlenderExportPhase,
  isDesktopSavedBlenderExportResult,
  type DesktopBlenderExportPhase,
  type DesktopBlenderExportSnapshot,
  type DesktopSavedBlenderExportResult,
} from '../src/desktop/blender-export-contracts'
import {
  createBlenderIsolationDirectories,
  isolatedBlenderEnvironment,
  type BlenderInvocation,
  type BlenderIsolationDirectories,
} from './cycles-pro'

const JOB_PREFIX = 'rasterform-blender-export-'
const MIN_BLEND_BYTES = 64
const MAX_BLEND_BYTES = 4 * 1024 * 1024 * 1024
const NATIVE_LITTLE_ENDIAN = endianness() === 'LE'
const registeredBlenderExportJobs = new WeakMap<BlenderExportJob, string>()

export interface BlenderExportJob {
  readonly privateJobDirectory: true
  readonly id: string
  readonly root: string
  readonly manifestPath: string
  readonly scriptPath: string
  readonly outputPath: string
  readonly isolation: BlenderIsolationDirectories
  readonly snapshot: DesktopBlenderExportSnapshot
}

export interface BlenderExportJobAssets {
  scriptPath: string
  tempRoot?: string
}

export interface BlenderExportCompletion extends Omit<DesktopSavedBlenderExportResult, 'fileName'> {
  jobId: string
  file: 'outputs/rasterform.blend'
  outputBytes: number
  outputSha256: string
}

export interface BlenderExportOutputState {
  readonly expectedJobId: string
  readonly expectedTopology: DesktopBlenderExportSnapshot['settings']['topology']
  readonly expectedSourceVertices: number
  readonly expectedSourceFaces: number
  phase: DesktopBlenderExportPhase | null
  completion: BlenderExportCompletion | null
  error: { message: string; errorType: string } | null
}

export type BlenderExportParsedOutput =
  | { type: 'progress'; phase: DesktopBlenderExportPhase }
  | { type: 'complete'; completion: BlenderExportCompletion }
  | { type: 'error'; message: string; errorType: string }

export class BlenderExportProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BlenderExportProtocolError'
  }
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: UnknownRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

function littleEndianFloat32(values: Float32Array): Buffer {
  // Rasterform desktop currently ships on little-endian macOS. A Buffer view
  // lets writeFile stream the IPC-owned immutable snapshot without a second
  // element-by-element copy on Electron's main thread.
  if (NATIVE_LITTLE_ENDIAN) {
    return Buffer.from(values.buffer as ArrayBuffer, values.byteOffset, values.byteLength)
  }
  const bytes = Buffer.allocUnsafe(values.length * Float32Array.BYTES_PER_ELEMENT)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let index = 0; index < values.length; index += 1) {
    view.setFloat32(index * Float32Array.BYTES_PER_ELEMENT, values[index]!, true)
  }
  return bytes
}

function littleEndianUint32(values: Uint32Array): Buffer {
  if (NATIVE_LITTLE_ENDIAN) {
    return Buffer.from(values.buffer as ArrayBuffer, values.byteOffset, values.byteLength)
  }
  const bytes = Buffer.allocUnsafe(values.length * Uint32Array.BYTES_PER_ELEMENT)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let index = 0; index < values.length; index += 1) {
    view.setUint32(index * Uint32Array.BYTES_PER_ELEMENT, values[index]!, true)
  }
  return bytes
}

async function assertReadableRegularFile(path: string, description: string): Promise<void> {
  const details = await stat(path)
  if (!details.isFile() || details.size <= 0) throw new Error(`${description} is not a regular file.`)
  await access(path, fileSystemConstants.R_OK)
}

export async function createBlenderExportJob(
  snapshot: DesktopBlenderExportSnapshot,
  assets: BlenderExportJobAssets,
): Promise<BlenderExportJob> {
  assertDesktopBlenderExportSnapshot(snapshot)
  await assertReadableRegularFile(assets.scriptPath, 'The Blender project exporter script')
  const temporaryRoot = assets.tempRoot ? resolve(assets.tempRoot) : tmpdir()
  await mkdir(temporaryRoot, { recursive: true, mode: 0o700 })
  const root = await mkdtemp(join(temporaryRoot, JOB_PREFIX))
  const id = randomUUID()
  try {
    const meshDirectory = join(root, 'mesh')
    const rendererDirectory = join(root, 'renderer')
    const outputDirectory = join(root, 'outputs')
    await Promise.all([
      mkdir(meshDirectory, { mode: 0o700 }),
      mkdir(rendererDirectory, { mode: 0o700 }),
      mkdir(outputDirectory, { mode: 0o700 }),
    ])
    const isolation = await createBlenderIsolationDirectories(root)
    const positionsPath = join(meshDirectory, 'positions.f32')
    const indicesPath = join(meshDirectory, 'indices.u32')
    const colorsPath = join(meshDirectory, 'colors.f32')
    const uvsPath = join(meshDirectory, 'uvs.f32')
    const scriptPath = join(rendererDirectory, 'export_blend.py')
    const outputPath = join(outputDirectory, 'rasterform.blend')
    const manifestPath = join(root, 'manifest.json')

    await Promise.all([
      writeFile(positionsPath, littleEndianFloat32(snapshot.mesh.positions), { mode: 0o600 }),
      writeFile(indicesPath, littleEndianUint32(snapshot.mesh.indices), { mode: 0o600 }),
      writeFile(colorsPath, littleEndianFloat32(snapshot.mesh.colors), { mode: 0o600 }),
      writeFile(uvsPath, littleEndianFloat32(snapshot.mesh.uvs), { mode: 0o600 }),
      copyFile(assets.scriptPath, scriptPath),
    ])
    await chmod(scriptPath, 0o600)
    const manifest = {
      version: 1,
      jobId: id,
      mesh: {
        positions: 'mesh/positions.f32',
        indices: 'mesh/indices.u32',
        colors: 'mesh/colors.f32',
        uvs: 'mesh/uvs.f32',
        vertexCount: snapshot.mesh.positions.length / 3,
        indexCount: snapshot.mesh.indices.length,
        uvCount: snapshot.mesh.uvs.length / 2,
        width: snapshot.mesh.width,
        height: snapshot.mesh.height,
        mode: snapshot.mesh.mode,
      },
      colorMode: snapshot.colorMode,
      appearance: {
        heightGradient: { ...snapshot.appearance.heightGradient },
        clay: { ...snapshot.appearance.clay },
      },
      settings: { ...snapshot.settings },
      output: 'outputs/rasterform.blend',
    }
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { encoding: 'utf8', mode: 0o600 })
    const job: BlenderExportJob = {
      privateJobDirectory: true,
      id,
      root,
      manifestPath,
      scriptPath,
      outputPath,
      isolation,
      snapshot,
    }
    registeredBlenderExportJobs.set(job, resolve(root))
    return job
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

export function buildBlenderExportInvocation(
  job: BlenderExportJob,
  blenderPath: string,
): BlenderInvocation {
  return {
    command: blenderPath,
    args: [
      '--background',
      '--factory-startup',
      '--disable-autoexec',
      '--python-exit-code',
      '1',
      '--python',
      job.scriptPath,
      '--',
      job.manifestPath,
    ],
    cwd: job.root,
    env: isolatedBlenderEnvironment(job.isolation),
  }
}

export function createBlenderExportOutputState(job: BlenderExportJob): BlenderExportOutputState {
  return {
    expectedJobId: job.id,
    expectedTopology: job.snapshot.settings.topology,
    expectedSourceVertices: job.snapshot.mesh.positions.length / 3,
    expectedSourceFaces: job.snapshot.mesh.indices.length / 3,
    phase: null,
    completion: null,
    error: null,
  }
}

function parseStatusPayload(line: string): { kind: string; payload: unknown } | null {
  const normalized = line.replace(/\r$/, '')
  if (!normalized.startsWith('RASTERFORM_')) return null
  const separator = normalized.indexOf(' ')
  if (separator <= 'RASTERFORM_'.length || separator === normalized.length - 1) {
    throw new BlenderExportProtocolError('Blender export emitted a malformed status line.')
  }
  const kind = normalized.slice('RASTERFORM_'.length, separator)
  try {
    return { kind, payload: JSON.parse(normalized.slice(separator + 1)) }
  } catch {
    throw new BlenderExportProtocolError(`Blender export emitted invalid ${kind} JSON.`)
  }
}

function phaseRank(phase: DesktopBlenderExportPhase): number {
  if (phase === 'preparing') return 0
  if (phase === 'retopologizing') return 1
  if (phase === 'unwrapping') return 2
  return 3
}

export function parseBlenderExportOutput(
  line: string,
  state: BlenderExportOutputState,
): BlenderExportParsedOutput | null {
  const status = parseStatusPayload(line)
  if (!status) return null
  if (!isRecord(status.payload)) {
    throw new BlenderExportProtocolError(`Blender export emitted an invalid ${status.kind} payload.`)
  }
  const payload = status.payload

  if (status.kind === 'PROGRESS') {
    if (state.completion || state.error
      || !hasOnlyKeys(payload, ['jobId', 'phase'])
      || payload.jobId !== state.expectedJobId
      || !isDesktopBlenderExportPhase(payload.phase)
      || (state.phase !== null && phaseRank(payload.phase) <= phaseRank(state.phase))) {
      throw new BlenderExportProtocolError('Blender export emitted invalid progress metadata.')
    }
    state.phase = payload.phase
    return { type: 'progress', phase: payload.phase }
  }

  if (status.kind === 'COMPLETE') {
    if (state.completion || state.error || state.phase !== 'saving'
      || !hasOnlyKeys(payload, [
        'jobId',
        'file',
        'topology',
        'sourceVertices',
        'sourceFaces',
        'outputVertices',
        'outputFaces',
        'outputTriangleCount',
        'quads',
        'triangles',
        'ngons',
        'uvLayerName',
        'uvLoops',
        'colorAttributeName',
        'blenderVersion',
        'elapsedSeconds',
        'outputBytes',
        'outputSha256',
      ])
      || payload.jobId !== state.expectedJobId
      || payload.file !== 'outputs/rasterform.blend'
      || payload.topology !== state.expectedTopology
      || payload.sourceVertices !== state.expectedSourceVertices
      || payload.sourceFaces !== state.expectedSourceFaces
      || !Number.isInteger(payload.outputBytes)
      || Number(payload.outputBytes) < MIN_BLEND_BYTES
      || Number(payload.outputBytes) > MAX_BLEND_BYTES
      || typeof payload.outputSha256 !== 'string'
      || !/^[0-9a-f]{64}$/.test(payload.outputSha256)
      || !isDesktopSavedBlenderExportResult({
        fileName: 'rasterform.blend',
        topology: payload.topology,
        sourceVertices: payload.sourceVertices,
        sourceFaces: payload.sourceFaces,
        outputVertices: payload.outputVertices,
        outputFaces: payload.outputFaces,
        outputTriangleCount: payload.outputTriangleCount,
        quads: payload.quads,
        triangles: payload.triangles,
        ngons: payload.ngons,
        uvLayerName: payload.uvLayerName,
        uvLoops: payload.uvLoops,
        colorAttributeName: payload.colorAttributeName,
        blenderVersion: payload.blenderVersion,
        elapsedSeconds: payload.elapsedSeconds,
      })) {
      throw new BlenderExportProtocolError('Blender export emitted invalid completion metadata.')
    }
    const completion = payload as unknown as BlenderExportCompletion
    state.completion = completion
    return { type: 'complete', completion }
  }

  if (status.kind === 'ERROR') {
    if (state.completion || state.error
      || !hasOnlyKeys(payload, ['message', 'type'])
      || typeof payload.message !== 'string'
      || payload.message.length < 1
      || payload.message.length > 2_000
      || typeof payload.type !== 'string'
      || payload.type.length < 1
      || payload.type.length > 200) {
      throw new BlenderExportProtocolError('Blender export emitted invalid error metadata.')
    }
    state.error = { message: payload.message, errorType: payload.type }
    return { type: 'error', message: payload.message, errorType: payload.type }
  }

  throw new BlenderExportProtocolError(`Blender export emitted an unknown ${status.kind} status.`)
}

export async function validateBlenderExportOutput(job: BlenderExportJob): Promise<number> {
  return validateBlenderFile(job.outputPath)
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer)
  return digest.digest('hex')
}

async function validateBlenderFile(
  path: string,
  completion?: Pick<BlenderExportCompletion, 'outputBytes' | 'outputSha256'>,
): Promise<number> {
  const details = await stat(path)
  if (!details.isFile() || details.size < MIN_BLEND_BYTES || details.size > MAX_BLEND_BYTES) {
    throw new Error('Blender project output is missing or unexpectedly large.')
  }
  if (completion && details.size !== completion.outputBytes) {
    throw new Error('Blender project output size changed after Blender verified it.')
  }
  const handle = await open(path, 'r')
  const header = Buffer.alloc(12)
  try {
    const { bytesRead } = await handle.read(header, 0, header.byteLength, 0)
    if (bytesRead !== header.byteLength) throw new Error('Blender project header is incomplete.')
  } finally {
    await handle.close()
  }
  // Blender 5.2's compressed `.blend` writer uses a Zstandard frame. Node in
  // our minimum development runtime cannot decode Zstd yet, so require its
  // exact frame magic here; the owned Blender process has already reported a
  // successful save and the real-Blender integration test reopens the file.
  const isZstandard = header[0] === 0x28
    && header[1] === 0xb5
    && header[2] === 0x2f
    && header[3] === 0xfd
  let blendHeader = header
  if (!isZstandard && header[0] === 0x1f && header[1] === 0x8b) {
    let prefix = Buffer.alloc(0)
    let length = 0
    for await (const chunk of createReadStream(path).pipe(createGunzip())) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      length += bytes.byteLength
      if (length > MAX_BLEND_BYTES) throw new Error('Blender project expands beyond the safety limit.')
      if (prefix.byteLength < 12) {
        prefix = Buffer.concat([prefix, bytes.subarray(0, 12 - prefix.byteLength)])
      }
    }
    blendHeader = prefix
  }
  if (!isZstandard && (blendHeader.byteLength !== 12
    || blendHeader.subarray(0, 7).toString('ascii') !== 'BLENDER'
    || (blendHeader[7] !== 0x2d && blendHeader[7] !== 0x5f)
    || (blendHeader[8] !== 0x76 && blendHeader[8] !== 0x56)
    || !/^\d{3}$/.test(blendHeader.subarray(9, 12).toString('ascii')))) {
    throw new Error('Blender project output has an invalid file header.')
  }
  if (completion && await sha256File(path) !== completion.outputSha256) {
    throw new Error('Blender project output changed after Blender verified it.')
  }
  return details.size
}

async function fsyncFile(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function pathIsInside(root: string, candidate: string): boolean {
  const offset = relative(root, candidate)
  return offset === '' || (!offset.startsWith('..') && !isAbsolute(offset))
}

export async function commitBlenderExportAtomically(
  job: BlenderExportJob,
  destination: string,
  completion: BlenderExportCompletion,
): Promise<string> {
  if (registeredBlenderExportJobs.get(job) !== resolve(job.root)) {
    throw new Error('Refusing to commit an invalid Blender export job.')
  }
  await validateBlenderFile(job.outputPath, completion)
  const finalPath = resolve(destination)
  const directory = dirname(finalPath)
  const canonicalRoot = await realpath(job.root)
  const canonicalDirectory = await realpath(directory)
  const canonicalFinalPath = join(canonicalDirectory, basename(finalPath))
  if (pathIsInside(canonicalRoot, canonicalFinalPath)) {
    throw new Error('Blender project destination must be outside the private export job.')
  }
  try {
    const existing = await lstat(finalPath)
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error('Blender project destination must be a regular file.')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const nonce = randomUUID()
  const staged = join(directory, `.rasterform-blender-${nonce}.blend.tmp`)
  try {
    await copyFile(job.outputPath, staged, fileSystemConstants.COPYFILE_EXCL)
    await fsyncFile(staged)
    await validateBlenderFile(staged, completion)
    // POSIX rename replaces a regular file as one filesystem operation. There
    // is never a crash window where the user's previous project is missing.
    await rename(staged, finalPath)
    await fsyncDirectory(directory)
  } finally {
    await unlink(staged).catch(() => undefined)
  }
  return finalPath
}

export async function cleanupBlenderExportJob(job: BlenderExportJob): Promise<void> {
  const registeredRoot = registeredBlenderExportJobs.get(job)
  if (registeredRoot !== resolve(job.root)
    || job.privateJobDirectory !== true
    || !basename(job.root).startsWith(JOB_PREFIX)
    || dirname(job.manifestPath) !== job.root) {
    throw new Error('Refusing to remove an invalid Blender export job directory.')
  }
  await rm(job.root, { recursive: true, force: true })
  registeredBlenderExportJobs.delete(job)
}
