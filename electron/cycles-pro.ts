import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { constants as fileSystemConstants } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  basename,
  dirname,
  extname,
  join,
  resolve,
} from 'node:path'
import { isFinalExportProgress } from '../src/desktop/contracts'
import type { FinalExportProgress } from '../src/lib/final-image-export'
import {
  assertDesktopProRenderSnapshot,
  type DesktopProRenderSnapshot,
} from '../src/desktop/pro-contracts'
import { DESKTOP_MAX_PNG_BYTES } from '../src/desktop/contracts'
import { isPngBytes } from './main-helpers'

const JOB_PREFIX = 'rasterform-cycles-'
const PROBE_PREFIX = 'rasterform-cycles-probe-'
const MAX_EXR_BYTES = 4 * 1024 * 1024 * 1024
const MAX_EXR_HEADER_BYTES = 4 * 1024 * 1024
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024
const MINIMUM_BLENDER_VERSION = [5, 2, 0] as const
const OPEN_EXR_MAGIC = 0x01312f76
const OPEN_EXR_TILED_FLAG = 0x00000200
const OPEN_EXR_LONG_NAMES_FLAG = 0x00000400
const OPEN_EXR_DEEP_FLAG = 0x00000800
const OPEN_EXR_MULTIPART_FLAG = 0x00001000
const PIZ_COMPRESSION = 4
const PIZ_SCAN_LINES_PER_BLOCK = 32

export interface BlenderProbeResult {
  available: boolean
  executablePath: string | null
  blenderVersion: string | null
  versionTuple: readonly [number, number, number] | null
  device: 'METAL' | 'CPU' | null
  message: string
}

export interface CyclesProJob {
  readonly privateJobDirectory: true
  readonly id: string
  readonly root: string
  readonly manifestPath: string
  readonly scriptPath: string
  readonly environmentPath: string
  readonly pngPath: string
  readonly exrPath: string
  readonly configDirectory: string
  readonly scriptsDirectory: string
  readonly dataFilesDirectory: string
  readonly extensionsDirectory: string
  readonly cacheDirectory: string
  readonly homeDirectory: string
  readonly tempDirectory: string
  readonly snapshot: DesktopProRenderSnapshot
}

export interface CyclesProJobAssets {
  scriptPath: string
  hdrPath: string
  tempRoot?: string
}

export interface BlenderInvocation {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

export interface CyclesProCompletion {
  device: 'METAL' | 'CPU'
  elapsedSeconds: number
  exr: string
  height: number
  jobId: string
  maxSamples: number
  noiseThreshold: number
  png: string
  width: number
}

export interface CyclesProOutputState {
  readonly expectedJobId: string
  readonly expectedWidth: number
  readonly expectedHeight: number
  readonly expectedMaxSamples: number
  readonly expectedNoiseThreshold: number
  blenderVersion: string | null
  versionTuple: readonly [number, number, number] | null
  device: 'METAL' | 'CPU' | null
  deviceName: string | null
  progress: FinalExportProgress | null
  completion: CyclesProCompletion | null
  error: { message: string; errorType: string } | null
}

export type CyclesProParsedOutput =
  | {
      type: 'version'
      blenderVersion: string
      versionTuple: readonly [number, number, number]
    }
  | { type: 'device'; device: 'METAL' | 'CPU'; name: string }
  | { type: 'progress'; progress: FinalExportProgress }
  | { type: 'complete'; completion: CyclesProCompletion }
  | { type: 'error'; message: string; errorType: string }

export interface ValidatedCyclesProOutputs {
  pngPath: string
  exrPath: string
  pngBytes: number
  exrBytes: number
  exrChannels: readonly string[]
}

export interface CommittedCyclesProOutputs {
  pngPath: string
  exrPath: string
}

export class CyclesProProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CyclesProProtocolError'
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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isVersionTuple(value: unknown): value is [number, number, number] {
  return Array.isArray(value)
    && value.length === 3
    && value.every((part) => Number.isInteger(part) && part >= 0 && part <= 1_000)
}

function compareVersions(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const details = await stat(path)
    if (!details.isFile()) return false
    await access(path, fileSystemConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Finds Blender without invoking a shell or consulting the user's open Blender process. */
export async function findBlenderExecutable(
  additionalCandidates: readonly string[] = [],
): Promise<string | null> {
  const candidates: string[] = [...additionalCandidates]
  const applicationsDirectory = '/Applications'
  candidates.push(join(applicationsDirectory, 'Blender.app', 'Contents', 'MacOS', 'Blender'))
  try {
    const entries = await readdir(applicationsDirectory, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^Blender(?: [^/]+)?\.app$/i.test(entry.name)) continue
      candidates.push(join(applicationsDirectory, entry.name, 'Contents', 'MacOS', 'Blender'))
    }
  } catch {
    // Blender may still be supplied explicitly for development and testing.
  }
  candidates.push('/opt/homebrew/bin/blender', '/usr/local/bin/blender')

  const seen = new Set<string>()
  for (const candidate of candidates) {
    const absolute = resolve(candidate)
    if (seen.has(absolute)) continue
    seen.add(absolute)
    if (!await isExecutableFile(absolute)) continue
    try {
      return await realpath(absolute)
    } catch {
      return absolute
    }
  }
  return null
}

export interface BlenderIsolationDirectories {
  config: string
  scripts: string
  dataFiles: string
  extensions: string
  cache: string
  home: string
  temp: string
}

export function isolatedBlenderEnvironment(
  directories: BlenderIsolationDirectories,
): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'en_US.UTF-8',
    LC_CTYPE: 'UTF-8',
    HOME: directories.home,
    TMPDIR: directories.temp,
    TMP: directories.temp,
    TEMP: directories.temp,
    XDG_CACHE_HOME: directories.cache,
    XDG_CONFIG_HOME: directories.config,
    BLENDER_USER_CONFIG: directories.config,
    BLENDER_USER_SCRIPTS: directories.scripts,
    BLENDER_USER_DATAFILES: directories.dataFiles,
    BLENDER_USER_EXTENSIONS: directories.extensions,
    PYTHONNOUSERSITE: '1',
  }
}

export async function createBlenderIsolationDirectories(
  root: string,
): Promise<BlenderIsolationDirectories> {
  const directories = {
    config: join(root, 'private', 'config'),
    scripts: join(root, 'private', 'scripts'),
    dataFiles: join(root, 'private', 'datafiles'),
    extensions: join(root, 'private', 'extensions'),
    cache: join(root, 'private', 'cache'),
    home: join(root, 'private', 'home'),
    temp: join(root, 'private', 'temp'),
  }
  await Promise.all(Object.values(directories).map((directory) => (
    mkdir(directory, { recursive: true, mode: 0o700 })
  )))
  return directories
}

const BLENDER_PROBE_SCRIPT = `
import bpy, json
device = "CPU"
try:
    preferences = bpy.context.preferences.addons["cycles"].preferences
    preferences.compute_device_type = "METAL"
    preferences.refresh_devices()
    if any(candidate.type == "METAL" for candidate in preferences.devices):
        device = "METAL"
except Exception:
    pass
print("RASTERFORM_PROBE " + json.dumps({
    "version": bpy.app.version_string,
    "versionTuple": list(bpy.app.version),
    "device": device,
}, separators=(",", ":"), sort_keys=True), flush=True)
`

function processOutputAppend(current: string, chunk: Buffer): string {
  if (Buffer.byteLength(current) + chunk.byteLength > MAX_PROCESS_OUTPUT_BYTES) {
    throw new Error('Blender produced unexpectedly large probe output.')
  }
  return current + chunk.toString('utf8')
}

export async function probeBlender(
  blenderPath?: string | null,
  options: { timeoutMs?: number } = {},
): Promise<BlenderProbeResult> {
  const executablePath = blenderPath ?? await findBlenderExecutable()
  if (!executablePath || !await isExecutableFile(executablePath)) {
    return {
      available: false,
      executablePath: null,
      blenderVersion: null,
      versionTuple: null,
      device: null,
      message: 'Install Blender 5.2 LTS or newer in Applications to use Cycles Pro.',
    }
  }

  const probeRoot = await mkdtemp(join(tmpdir(), PROBE_PREFIX))
  const directories = await createBlenderIsolationDirectories(probeRoot)
  const timeoutMs = Math.max(1_000, Math.min(120_000, options.timeoutMs ?? 30_000))
  try {
    const result = await new Promise<{
      code: number | null
      signal: NodeJS.Signals | null
      stdout: string
      stderr: string
      timedOut: boolean
    }>((resolvePromise) => {
      const child = spawn(executablePath, [
        '--background',
        '--factory-startup',
        '--disable-autoexec',
        '--python-exit-code',
        '1',
        '--python-expr',
        `exec(${JSON.stringify(BLENDER_PROBE_SCRIPT)})`,
      ], {
        cwd: probeRoot,
        env: isolatedBlenderEnvironment(directories),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        windowsHide: true,
      })
      let stdout = ''
      let stderr = ''
      let settled = false
      let timedOut = false
      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        resolvePromise({ code, signal, stdout, stderr, timedOut })
      }
      child.stdout.on('data', (chunk: Buffer) => {
        try {
          stdout = processOutputAppend(stdout, chunk)
        } catch {
          timedOut = true
          child.kill('SIGTERM')
        }
      })
      child.stderr.on('data', (chunk: Buffer) => {
        try {
          stderr = processOutputAppend(stderr, chunk)
        } catch {
          timedOut = true
          child.kill('SIGTERM')
        }
      })
      child.once('error', () => finish(null, null))
      child.once('close', finish)
      const timeout = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
        const force = setTimeout(() => {
          if (!settled) child.kill('SIGKILL')
        }, 2_000)
        force.unref()
      }, timeoutMs)
      timeout.unref()
    })
    if (result.timedOut || result.code !== 0) {
      return {
        available: false,
        executablePath,
        blenderVersion: null,
        versionTuple: null,
        device: null,
        message: result.timedOut
          ? 'Blender did not finish its isolated compatibility check.'
          : 'Blender could not start the isolated Cycles Pro renderer.',
      }
    }

    const marker = result.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith('RASTERFORM_PROBE '))
    if (!marker) throw new CyclesProProtocolError('Blender omitted its compatibility result.')
    const payload: unknown = JSON.parse(marker.slice('RASTERFORM_PROBE '.length))
    if (!isRecord(payload)
      || !hasOnlyKeys(payload, ['device', 'version', 'versionTuple'])
      || (payload.device !== 'METAL' && payload.device !== 'CPU')
      || typeof payload.version !== 'string'
      || !isVersionTuple(payload.versionTuple)) {
      throw new CyclesProProtocolError('Blender returned an invalid compatibility result.')
    }
    const supported = compareVersions(payload.versionTuple, MINIMUM_BLENDER_VERSION) >= 0
    return {
      available: supported,
      executablePath,
      blenderVersion: payload.version,
      versionTuple: payload.versionTuple,
      device: payload.device,
      message: supported
        ? `Blender ${payload.version} is ready for isolated Cycles Pro rendering.`
        : `Blender ${payload.version} is installed, but Cycles Pro requires Blender 5.2 LTS or newer.`,
    }
  } catch {
    return {
      available: false,
      executablePath,
      blenderVersion: null,
      versionTuple: null,
      device: null,
      message: 'Blender could not complete the isolated Cycles Pro compatibility check.',
    }
  } finally {
    await rm(probeRoot, { recursive: true, force: true })
  }
}

function littleEndianFloat32(values: Float32Array): Buffer {
  const bytes = Buffer.allocUnsafe(values.length * Float32Array.BYTES_PER_ELEMENT)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let index = 0; index < values.length; index += 1) {
    view.setFloat32(index * Float32Array.BYTES_PER_ELEMENT, values[index]!, true)
  }
  return bytes
}

function littleEndianUint32(values: Uint32Array): Buffer {
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

export async function createCyclesProJob(
  snapshot: DesktopProRenderSnapshot,
  assets: CyclesProJobAssets,
): Promise<CyclesProJob> {
  assertDesktopProRenderSnapshot(snapshot)
  await Promise.all([
    assertReadableRegularFile(assets.scriptPath, 'The Cycles renderer script'),
    assertReadableRegularFile(assets.hdrPath, 'The studio environment'),
  ])
  const temporaryRoot = assets.tempRoot ? resolve(assets.tempRoot) : tmpdir()
  await mkdir(temporaryRoot, { recursive: true, mode: 0o700 })
  const root = await mkdtemp(join(temporaryRoot, JOB_PREFIX))
  const id = randomUUID()
  try {
    const meshDirectory = join(root, 'mesh')
    const rendererDirectory = join(root, 'renderer')
    const environmentDirectory = join(root, 'environment')
    const outputDirectory = join(root, 'outputs')
    await Promise.all([
      mkdir(meshDirectory, { mode: 0o700 }),
      mkdir(rendererDirectory, { mode: 0o700 }),
      mkdir(environmentDirectory, { mode: 0o700 }),
      mkdir(outputDirectory, { mode: 0o700 }),
    ])
    const isolation = await createBlenderIsolationDirectories(root)
    const positionsPath = join(meshDirectory, 'positions.f32')
    const indicesPath = join(meshDirectory, 'indices.u32')
    const colorsPath = join(meshDirectory, 'colors.f32')
    const heightsPath = join(meshDirectory, 'heights.f32')
    const scriptPath = join(rendererDirectory, 'render.py')
    const environmentPath = join(environmentDirectory, 'studio.hdr')
    const pngPath = join(outputDirectory, 'render.png')
    const exrPath = join(outputDirectory, 'render.exr')
    const manifestPath = join(root, 'manifest.json')

    await Promise.all([
      writeFile(positionsPath, littleEndianFloat32(snapshot.mesh.positions), { mode: 0o600 }),
      writeFile(indicesPath, littleEndianUint32(snapshot.mesh.indices), { mode: 0o600 }),
      writeFile(colorsPath, littleEndianFloat32(snapshot.mesh.colors), { mode: 0o600 }),
      writeFile(heightsPath, littleEndianFloat32(snapshot.mesh.heights), { mode: 0o600 }),
      copyFile(assets.scriptPath, scriptPath),
      copyFile(assets.hdrPath, environmentPath),
    ])
    await Promise.all([chmod(scriptPath, 0o600), chmod(environmentPath, 0o600)])

    const manifest = {
      version: 1,
      jobId: id,
      mesh: {
        positions: 'mesh/positions.f32',
        indices: 'mesh/indices.u32',
        colors: 'mesh/colors.f32',
        heights: 'mesh/heights.f32',
        vertexCount: snapshot.mesh.positions.length / 3,
        indexCount: snapshot.mesh.indices.length,
        mode: snapshot.mesh.mode,
      },
      camera: {
        fov: snapshot.camera.fov,
        near: snapshot.camera.near,
        far: snapshot.camera.far,
        zoom: snapshot.camera.zoom,
        filmGauge: snapshot.camera.filmGauge,
        filmOffset: snapshot.camera.filmOffset,
        position: [...snapshot.camera.position],
        quaternion: [...snapshot.camera.quaternion],
        up: [...snapshot.camera.up],
      },
      colorMode: snapshot.colorMode,
      appearance: {
        heightGradient: { ...snapshot.appearance.heightGradient },
        clay: { ...snapshot.appearance.clay },
      },
      width: snapshot.width,
      height: snapshot.height,
      background: snapshot.background,
      studioBackground: snapshot.studioBackground,
      settings: { ...snapshot.settings },
      environment: 'environment/studio.hdr',
      outputs: { png: 'outputs/render.png', exr: 'outputs/render.exr' },
    }
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { encoding: 'utf8', mode: 0o600 })
    return {
      privateJobDirectory: true,
      id,
      root,
      manifestPath,
      scriptPath,
      environmentPath,
      pngPath,
      exrPath,
      configDirectory: isolation.config,
      scriptsDirectory: isolation.scripts,
      dataFilesDirectory: isolation.dataFiles,
      extensionsDirectory: isolation.extensions,
      cacheDirectory: isolation.cache,
      homeDirectory: isolation.home,
      tempDirectory: isolation.temp,
      snapshot,
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

export function buildBlenderInvocation(job: CyclesProJob, blenderPath: string): BlenderInvocation {
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
    env: isolatedBlenderEnvironment({
      config: job.configDirectory,
      scripts: job.scriptsDirectory,
      dataFiles: job.dataFilesDirectory,
      extensions: job.extensionsDirectory,
      cache: job.cacheDirectory,
      home: job.homeDirectory,
      temp: job.tempDirectory,
    }),
  }
}

export function createCyclesProOutputState(job: CyclesProJob): CyclesProOutputState {
  return {
    expectedJobId: job.id,
    expectedWidth: job.snapshot.width,
    expectedHeight: job.snapshot.height,
    expectedMaxSamples: job.snapshot.settings.maxSamples,
    expectedNoiseThreshold: job.snapshot.settings.noiseThreshold,
    blenderVersion: null,
    versionTuple: null,
    device: null,
    deviceName: null,
    progress: null,
    completion: null,
    error: null,
  }
}

function parseStatusPayload(line: string): { kind: string; payload: unknown } | null {
  const normalized = line.replace(/\r$/, '')
  if (!normalized.startsWith('RASTERFORM_')) return null
  const separator = normalized.indexOf(' ')
  if (separator <= 'RASTERFORM_'.length || separator === normalized.length - 1) {
    throw new CyclesProProtocolError('Cycles Pro emitted a malformed status line.')
  }
  const kind = normalized.slice('RASTERFORM_'.length, separator)
  try {
    return { kind, payload: JSON.parse(normalized.slice(separator + 1)) }
  } catch {
    throw new CyclesProProtocolError(`Cycles Pro emitted invalid ${kind} JSON.`)
  }
}

function progressRank(phase: FinalExportProgress['phase']): number {
  if (phase === 'preparing') return 0
  if (phase === 'rendering') return 1
  return 2
}

export function parseCyclesProOutput(
  line: string,
  state: CyclesProOutputState,
): CyclesProParsedOutput | null {
  const status = parseStatusPayload(line)
  if (!status) return null
  if (!isRecord(status.payload)) {
    throw new CyclesProProtocolError(`Cycles Pro emitted an invalid ${status.kind} payload.`)
  }
  const payload = status.payload

  if (status.kind === 'VERSION') {
    if (state.blenderVersion !== null
      || !hasOnlyKeys(payload, ['version', 'versionTuple'])
      || typeof payload.version !== 'string'
      || payload.version.length < 1
      || payload.version.length > 200
      || !isVersionTuple(payload.versionTuple)) {
      throw new CyclesProProtocolError('Cycles Pro emitted invalid Blender version metadata.')
    }
    state.blenderVersion = payload.version
    state.versionTuple = payload.versionTuple
    return {
      type: 'version',
      blenderVersion: payload.version,
      versionTuple: payload.versionTuple,
    }
  }

  if (status.kind === 'DEVICE') {
    if (state.blenderVersion === null
      || state.device !== null
      || !hasOnlyKeys(payload, ['device', 'name'])
      || (payload.device !== 'METAL' && payload.device !== 'CPU')
      || typeof payload.name !== 'string'
      || payload.name.length < 1
      || payload.name.length > 1_000) {
      throw new CyclesProProtocolError('Cycles Pro emitted invalid device metadata.')
    }
    state.device = payload.device
    state.deviceName = payload.name
    return { type: 'device', device: payload.device, name: payload.name }
  }

  if (status.kind === 'PROGRESS') {
    if (state.blenderVersion === null
      || state.completion !== null
      || state.error !== null
      || !isFinalExportProgress(payload)
      || payload.targetSamples !== state.expectedMaxSamples
      || payload.tiles !== 1
      || (payload.phase === 'finishing' ? payload.tile !== 1 : payload.tile !== 0)
      || (payload.phase !== 'finishing'
        && Math.abs(payload.progress - payload.samples / payload.targetSamples) > 1e-9
        && payload.phase === 'rendering')) {
      throw new CyclesProProtocolError('Cycles Pro emitted invalid render progress.')
    }
    if (state.progress) {
      const previousRank = progressRank(state.progress.phase)
      const nextRank = progressRank(payload.phase)
      if (nextRank < previousRank
        || (nextRank === previousRank && payload.progress < state.progress.progress)
        || payload.samples < state.progress.samples) {
        throw new CyclesProProtocolError('Cycles Pro render progress moved backwards.')
      }
    }
    const progress: FinalExportProgress = {
      phase: payload.phase,
      progress: payload.progress,
      tile: payload.tile,
      tiles: payload.tiles,
      samples: payload.samples,
      targetSamples: payload.targetSamples,
    }
    state.progress = progress
    return { type: 'progress', progress }
  }

  if (status.kind === 'COMPLETE') {
    if (state.blenderVersion === null
      || state.device === null
      || state.completion !== null
      || state.error !== null
      || !hasOnlyKeys(payload, [
        'device',
        'elapsedSeconds',
        'exr',
        'height',
        'jobId',
        'maxSamples',
        'noiseThreshold',
        'png',
        'width',
      ])
      || payload.device !== state.device
      || !isFiniteNumber(payload.elapsedSeconds)
      || payload.elapsedSeconds < 0
      || payload.elapsedSeconds > 30 * 24 * 60 * 60
      || payload.exr !== 'outputs/render.exr'
      || payload.height !== state.expectedHeight
      || payload.jobId !== state.expectedJobId
      || payload.maxSamples !== state.expectedMaxSamples
      || payload.noiseThreshold !== state.expectedNoiseThreshold
      || payload.png !== 'outputs/render.png'
      || payload.width !== state.expectedWidth) {
      throw new CyclesProProtocolError('Cycles Pro emitted invalid completion metadata.')
    }
    const completion: CyclesProCompletion = {
      device: payload.device as 'METAL' | 'CPU',
      elapsedSeconds: payload.elapsedSeconds,
      exr: payload.exr as string,
      height: payload.height as number,
      jobId: payload.jobId as string,
      maxSamples: payload.maxSamples as number,
      noiseThreshold: payload.noiseThreshold as number,
      png: payload.png as string,
      width: payload.width as number,
    }
    state.completion = completion
    return { type: 'complete', completion }
  }

  if (status.kind === 'ERROR') {
    if (state.completion !== null
      || state.error !== null
      || !hasOnlyKeys(payload, ['message', 'type'])
      || typeof payload.message !== 'string'
      || payload.message.length < 1
      || payload.message.length > 2_000
      || typeof payload.type !== 'string'
      || payload.type.length < 1
      || payload.type.length > 200) {
      throw new CyclesProProtocolError('Cycles Pro emitted invalid error metadata.')
    }
    state.error = { message: payload.message, errorType: payload.type }
    return { type: 'error', message: payload.message, errorType: payload.type }
  }

  throw new CyclesProProtocolError(`Cycles Pro emitted an unknown ${status.kind} status.`)
}

interface ExrChannel {
  name: string
  pixelType: number
  xSampling: number
  ySampling: number
}

interface ExrPartHeader {
  name: string
  type: 'scanlineimage'
  chunkCount: number
  compression: number
  lineOrder: number
  dataWindow: { xMin: number; yMin: number; xMax: number; yMax: number }
  channels: ExrChannel[]
}

interface ExrMultipartHeaders {
  tableOffset: number
  parts: ExrPartHeader[]
}

function readCString(bytes: Uint8Array, offset: number, limit: number): { value: string; next: number } {
  let end = offset
  while (end < limit && bytes[end] !== 0) end += 1
  if (end >= limit) throw new Error('The EXR header contains an unterminated string.')
  const value = Buffer.from(bytes.subarray(offset, end)).toString('utf8')
  if (value.includes('\ufffd')) throw new Error('The EXR header contains invalid UTF-8.')
  return { value, next: end + 1 }
}

function parseExrChannels(bytes: Uint8Array): ExrChannel[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const channels: ExrChannel[] = []
  const names = new Set<string>()
  let offset = 0
  while (offset < bytes.byteLength) {
    const nameResult = readCString(bytes, offset, bytes.byteLength)
    offset = nameResult.next
    if (nameResult.value === '') {
      if (offset !== bytes.byteLength) throw new Error('The EXR channel list has trailing data.')
      return channels
    }
    if (nameResult.value.length > 255 || names.has(nameResult.value) || offset + 16 > bytes.byteLength) {
      throw new Error('The EXR channel list is malformed.')
    }
    const pixelType = view.getInt32(offset, true)
    const reserved = bytes.subarray(offset + 5, offset + 8)
    const xSampling = view.getInt32(offset + 8, true)
    const ySampling = view.getInt32(offset + 12, true)
    if ((pixelType !== 0 && pixelType !== 1 && pixelType !== 2)
      || reserved.some((value) => value !== 0)
      || xSampling < 1
      || ySampling < 1) {
      throw new Error('The EXR channel list contains invalid channel metadata.')
    }
    names.add(nameResult.value)
    channels.push({ name: nameResult.value, pixelType, xSampling, ySampling })
    offset += 16
  }
  throw new Error('The EXR channel list is missing its terminator.')
}

function decodeExrString(data: Uint8Array, description: string): string {
  const value = Buffer.from(data).toString('utf8')
  if (!value || value.includes('\u0000') || value.includes('\ufffd') || value.length > 255) {
    throw new Error(`The EXR ${description} is invalid.`)
  }
  return value
}

function parseExrPartHeader(bytes: Uint8Array, start: number): {
  part: ExrPartHeader
  next: number
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const attributes = new Map<string, { type: string; data: Uint8Array }>()
  let offset = start
  while (offset < bytes.byteLength) {
    const nameResult = readCString(bytes, offset, bytes.byteLength)
    offset = nameResult.next
    if (nameResult.value === '') {
      const channels = attributes.get('channels')
      const chunkCount = attributes.get('chunkCount')
      const compression = attributes.get('compression')
      const dataWindow = attributes.get('dataWindow')
      const lineOrder = attributes.get('lineOrder')
      const name = attributes.get('name')
      const type = attributes.get('type')
      if (!channels || channels.type !== 'chlist'
        || !chunkCount || chunkCount.type !== 'int' || chunkCount.data.byteLength !== 4
        || !compression || compression.type !== 'compression' || compression.data.byteLength !== 1
        || !dataWindow || dataWindow.type !== 'box2i' || dataWindow.data.byteLength !== 16
        || !lineOrder || lineOrder.type !== 'lineOrder' || lineOrder.data.byteLength !== 1
        || !name || name.type !== 'string'
        || !type || type.type !== 'string') {
        throw new Error('An EXR part is missing required multipart image attributes.')
      }
      const windowView = new DataView(
        dataWindow.data.buffer,
        dataWindow.data.byteOffset,
        dataWindow.data.byteLength,
      )
      return {
        next: offset,
        part: {
          name: decodeExrString(name.data, 'part name'),
          type: decodeExrString(type.data, 'part type') as 'scanlineimage',
          chunkCount: new DataView(
            chunkCount.data.buffer,
            chunkCount.data.byteOffset,
            chunkCount.data.byteLength,
          ).getInt32(0, true),
          compression: compression.data[0]!,
          lineOrder: lineOrder.data[0]!,
          dataWindow: {
            xMin: windowView.getInt32(0, true),
            yMin: windowView.getInt32(4, true),
            xMax: windowView.getInt32(8, true),
            yMax: windowView.getInt32(12, true),
          },
          channels: parseExrChannels(channels.data),
        },
      }
    }
    const typeResult = readCString(bytes, offset, bytes.byteLength)
    offset = typeResult.next
    if (!nameResult.value || nameResult.value.length > 255
      || !typeResult.value || typeResult.value.length > 255
      || attributes.has(nameResult.value)
      || offset + 4 > bytes.byteLength) {
      throw new Error('The EXR header is malformed.')
    }
    const size = view.getUint32(offset, true)
    offset += 4
    if (size > MAX_EXR_HEADER_BYTES || offset + size > bytes.byteLength) {
      throw new Error('The EXR attribute is truncated or unexpectedly large.')
    }
    attributes.set(nameResult.value, {
      type: typeResult.value,
      data: bytes.subarray(offset, offset + size),
    })
    offset += size
  }
  throw new Error('The EXR header terminator is missing.')
}

function parseExrMultipartHeaders(bytes: Uint8Array): ExrMultipartHeaders {
  if (bytes.byteLength < 10) throw new Error('The EXR is truncated.')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0, true) !== OPEN_EXR_MAGIC) throw new Error('The EXR signature is invalid.')
  const versionField = view.getUint32(4, true)
  const version = versionField & 0xff
  const allowedFlags = OPEN_EXR_LONG_NAMES_FLAG | OPEN_EXR_MULTIPART_FLAG
  if ((version !== 2 && version !== 3)
    || (versionField & OPEN_EXR_MULTIPART_FLAG) === 0
    || (versionField & (OPEN_EXR_TILED_FLAG | OPEN_EXR_DEEP_FLAG)) !== 0
    || (versionField & ~(0xff | allowedFlags)) !== 0) {
    throw new Error('The EXR is not a supported multipart scan-line image.')
  }
  const parts: ExrPartHeader[] = []
  let offset = 8
  while (offset < bytes.byteLength && bytes[offset] !== 0) {
    const parsed = parseExrPartHeader(bytes, offset)
    parts.push(parsed.part)
    offset = parsed.next
    if (parts.length > 128) throw new Error('The EXR contains unexpectedly many parts.')
  }
  if (parts.length < 2 || offset >= bytes.byteLength || bytes[offset] !== 0) {
    throw new Error('The EXR multipart header list is incomplete.')
  }
  return { tableOffset: offset + 1, parts }
}

function passPart(parts: readonly ExrPartHeader[], suffix: string): ExrPartHeader | undefined {
  return parts.find((part) => part.name === suffix || part.name.endsWith(`.${suffix}`))
}

function hasExactPartChannels(
  part: ExrPartHeader | undefined,
  components: readonly string[],
  pixelType: number,
): boolean {
  if (!part || part.channels.length !== components.length) return false
  return components.every((component) => part.channels.some((channel) => (
    channel.name === `${part.name}.${component}` && channel.pixelType === pixelType
  )))
}

async function validateExr(
  path: string,
  width: number,
  height: number,
  denoise: boolean,
): Promise<{ bytes: number; channels: string[] }> {
  const details = await stat(path)
  if (!details.isFile() || details.size <= 0 || details.size > MAX_EXR_BYTES) {
    throw new Error('Cycles Pro returned an invalid EXR file size.')
  }
  const handle = await open(path, 'r')
  try {
    const headerBuffer = Buffer.alloc(Math.min(details.size, MAX_EXR_HEADER_BYTES))
    const headerRead = await handle.read(headerBuffer, 0, headerBuffer.byteLength, 0)
    const multipart = parseExrMultipartHeaders(headerBuffer.subarray(0, headerRead.bytesRead))
    const partNames = new Set<string>()
    const expectedChunksPerPart = Math.ceil(height / PIZ_SCAN_LINES_PER_BLOCK)
    for (const part of multipart.parts) {
      const actualWidth = part.dataWindow.xMax - part.dataWindow.xMin + 1
      const actualHeight = part.dataWindow.yMax - part.dataWindow.yMin + 1
      if (partNames.has(part.name)
        || part.type !== 'scanlineimage'
        || part.dataWindow.xMin !== 0
        || part.dataWindow.yMin !== 0
        || actualWidth !== width
        || actualHeight !== height
        || part.compression !== PIZ_COMPRESSION
        || part.lineOrder !== 0
        || part.chunkCount !== expectedChunksPerPart
        || part.channels.length < 1
        || part.channels.some((channel) => (
          !channel.name.startsWith(`${part.name}.`)
            || channel.xSampling !== 1
            || channel.ySampling !== 1
        ))) {
        throw new Error('Cycles Pro returned an EXR with invalid multipart image metadata.')
      }
      partNames.add(part.name)
    }
    const combined = passPart(multipart.parts, 'Combined')
    const normal = passPart(multipart.parts, 'Normal')
    const diffuseColor = passPart(multipart.parts, 'Diffuse Color')
    if (!hasExactPartChannels(combined, ['R', 'G', 'B', 'A'], 1)
      || !hasExactPartChannels(normal, ['X', 'Y', 'Z'], 2)
      || !hasExactPartChannels(diffuseColor, ['R', 'G', 'B'], 1)
      || (denoise && (
        !hasExactPartChannels(passPart(multipart.parts, 'Noisy Image'), ['R', 'G', 'B', 'A'], 1)
        || !hasExactPartChannels(passPart(multipart.parts, 'Denoising Albedo'), ['R', 'G', 'B'], 1)
        || !hasExactPartChannels(passPart(multipart.parts, 'Denoising Normal'), ['X', 'Y', 'Z'], 2)
      ))) {
      throw new Error('Cycles Pro returned an EXR without the required multipart color and data passes.')
    }

    const tableEntries = multipart.parts.reduce((sum, part) => sum + part.chunkCount, 0)
    const tableBytes = tableEntries * 8
    const tableEnd = multipart.tableOffset + tableBytes
    if (!Number.isSafeInteger(tableEnd) || tableEnd > details.size) {
      throw new Error('The EXR scan-line table is truncated.')
    }
    const table = Buffer.alloc(tableBytes)
    const tableRead = await handle.read(table, 0, table.byteLength, multipart.tableOffset)
    if (tableRead.bytesRead !== table.byteLength) throw new Error('The EXR scan-line table is truncated.')
    const tableView = new DataView(table.buffer, table.byteOffset, table.byteLength)
    const offsets = new Set<number>()
    const chunkRanges: Array<{ start: number; end: number }> = []
    let tableIndex = 0
    for (let partIndex = 0; partIndex < multipart.parts.length; partIndex += 1) {
      const part = multipart.parts[partIndex]!
      const scanLines = new Set<number>()
      for (let block = 0; block < part.chunkCount; block += 1) {
        const rawOffset = tableView.getBigUint64(tableIndex * 8, true)
        tableIndex += 1
        if (rawOffset > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('The EXR chunk offset is invalid.')
        const chunkOffset = Number(rawOffset)
        if (chunkOffset < tableEnd || chunkOffset + 12 > details.size || offsets.has(chunkOffset)) {
          throw new Error('The EXR chunk table is invalid.')
        }
        offsets.add(chunkOffset)
        const chunkHeader = Buffer.alloc(12)
        const chunkRead = await handle.read(chunkHeader, 0, 12, chunkOffset)
        if (chunkRead.bytesRead !== 12) throw new Error('The EXR image data is truncated.')
        const chunkView = new DataView(chunkHeader.buffer, chunkHeader.byteOffset, 12)
        const chunkPart = chunkView.getInt32(0, true)
        const scanLine = chunkView.getInt32(4, true)
        const packedBytes = chunkView.getUint32(8, true)
        const expectedScanLine = part.dataWindow.yMin + block * PIZ_SCAN_LINES_PER_BLOCK
        const chunkEnd = chunkOffset + 12 + packedBytes
        if (chunkPart !== partIndex
          || scanLine !== expectedScanLine
          || scanLines.has(scanLine)
          || packedBytes <= 0
          || chunkEnd > details.size) {
          throw new Error('The EXR multipart image chunk is invalid.')
        }
        scanLines.add(scanLine)
        chunkRanges.push({ start: chunkOffset, end: chunkEnd })
      }
    }
    chunkRanges.sort((left, right) => left.start - right.start)
    for (let index = 1; index < chunkRanges.length; index += 1) {
      if (chunkRanges[index]!.start < chunkRanges[index - 1]!.end) {
        throw new Error('The EXR multipart chunks overlap.')
      }
    }
    if (chunkRanges.at(-1)?.end !== details.size) {
      throw new Error('The EXR contains trailing or incomplete image data.')
    }
    return {
      bytes: details.size,
      channels: multipart.parts.flatMap((part) => part.channels.map(({ name }) => name)),
    }
  } finally {
    await handle.close()
  }
}

export async function validateCyclesProOutputs(job: CyclesProJob): Promise<ValidatedCyclesProOutputs> {
  const pngDetails = await stat(job.pngPath)
  if (!pngDetails.isFile()
    || pngDetails.size <= 0
    || pngDetails.size > DESKTOP_MAX_PNG_BYTES) {
    throw new Error('Cycles Pro returned an invalid RGBA PNG.')
  }
  // Enforce the byte ceiling before reading renderer-controlled output into
  // memory. The EXR validator likewise reads only its bounded header/table data.
  const [png, exr] = await Promise.all([
    readFile(job.pngPath),
    validateExr(
      job.exrPath,
      job.snapshot.width,
      job.snapshot.height,
      job.snapshot.settings.denoise,
    ),
  ])
  if (!isPngBytes(png, {
      width: job.snapshot.width,
      height: job.snapshot.height,
      transparent: job.snapshot.background === 'transparent',
    }, DESKTOP_MAX_PNG_BYTES)) {
    throw new Error('Cycles Pro returned an invalid RGBA PNG.')
  }
  return {
    pngPath: job.pngPath,
    exrPath: job.exrPath,
    pngBytes: pngDetails.size,
    exrBytes: exr.bytes,
    exrChannels: exr.channels,
  }
}

function derivedExrDestination(pngDestination: string): string {
  if (extname(pngDestination).toLowerCase() !== '.png') {
    throw new Error('Cycles Pro output must use a PNG destination.')
  }
  return pngDestination.slice(0, -extname(pngDestination).length) + '.exr'
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function fsyncFile(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function commitCyclesProOutputsAtomically(
  job: CyclesProJob,
  pngDestination: string,
): Promise<CommittedCyclesProOutputs> {
  await validateCyclesProOutputs(job)
  const finalPng = resolve(pngDestination)
  const finalExr = resolve(derivedExrDestination(pngDestination))
  if (finalPng === finalExr
    || finalPng === resolve(job.pngPath)
    || finalExr === resolve(job.exrPath)) {
    throw new Error('Cycles Pro output destinations must be separate from the private render job.')
  }
  const destinationDirectory = dirname(finalPng)
  if (dirname(finalExr) !== destinationDirectory) {
    throw new Error('Cycles Pro outputs must be saved together.')
  }
  const nonce = randomUUID()
  const stagePng = join(destinationDirectory, `.rasterform-pro-${nonce}.png.tmp`)
  const stageExr = join(destinationDirectory, `.rasterform-pro-${nonce}.exr.tmp`)
  const backupPng = join(destinationDirectory, `.rasterform-pro-${nonce}.png.backup`)
  const backupExr = join(destinationDirectory, `.rasterform-pro-${nonce}.exr.backup`)
  let backedUpPng = false
  let backedUpExr = false
  let installedPng = false
  let installedExr = false
  let committed = false
  try {
    await copyFile(job.pngPath, stagePng, fileSystemConstants.COPYFILE_EXCL)
    await copyFile(job.exrPath, stageExr, fileSystemConstants.COPYFILE_EXCL)
    await Promise.all([fsyncFile(stagePng), fsyncFile(stageExr)])
    if (await pathExists(finalPng)) {
      await rename(finalPng, backupPng)
      backedUpPng = true
    }
    if (await pathExists(finalExr)) {
      await rename(finalExr, backupExr)
      backedUpExr = true
    }
    await rename(stagePng, finalPng)
    installedPng = true
    await rename(stageExr, finalExr)
    installedExr = true
    committed = true
  } finally {
    if (!committed) {
      if (installedExr) await unlink(finalExr).catch(() => undefined)
      if (installedPng) await unlink(finalPng).catch(() => undefined)
      if (backedUpPng) await rename(backupPng, finalPng).catch(() => undefined)
      if (backedUpExr) await rename(backupExr, finalExr).catch(() => undefined)
    }
    await Promise.all([
      unlink(stagePng).catch(() => undefined),
      unlink(stageExr).catch(() => undefined),
      ...(committed ? [
        unlink(backupPng).catch(() => undefined),
        unlink(backupExr).catch(() => undefined),
      ] : []),
    ])
  }
  return { pngPath: finalPng, exrPath: finalExr }
}

export async function cleanupCyclesProJob(job: CyclesProJob): Promise<void> {
  if (job.privateJobDirectory !== true
    || !basename(job.root).startsWith(JOB_PREFIX)
    || dirname(job.manifestPath) !== job.root) {
    throw new Error('Refusing to remove an invalid Cycles Pro job directory.')
  }
  await rm(job.root, { recursive: true, force: true })
}
