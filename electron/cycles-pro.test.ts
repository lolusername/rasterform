import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_DESKTOP_PRO_RENDER_SETTINGS,
  DESKTOP_PRO_RENDER_PROTOCOL_VERSION,
  type DesktopProRenderSnapshot,
} from '../src/desktop/pro-contracts'
import {
  CyclesProProtocolError,
  buildBlenderInvocation,
  cleanupCyclesProJob,
  commitCyclesProOutputsAtomically,
  createCyclesProJob,
  createCyclesProOutputState,
  findBlenderExecutable,
  parseCyclesProOutput,
  validateCyclesProOutputs,
  type CyclesProJob,
} from './cycles-pro'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )))
})

function snapshotFixture(): DesktopProRenderSnapshot {
  return {
    protocolVersion: DESKTOP_PRO_RENDER_PROTOCOL_VERSION,
    mesh: {
      positions: new Float32Array([
        1.25, -2.5, 3.75,
        4.5, 5.25, -6.5,
        -7.75, 8.125, 9.5,
      ]),
      indices: new Uint32Array([2, 0, 1]),
      colors: new Float32Array([
        1, 0.25, 0,
        0.5, 1, 0.75,
        0.125, 0.375, 1,
      ]),
      uvs: new Float32Array([0, 0, 1, 0, 0.5, 1]),
      heights: new Float32Array([0.125, 0.5, 1]),
      width: 3,
      height: 1,
      mode: 'solid',
    },
    camera: {
      fov: 38,
      near: 0.01,
      far: 100,
      zoom: 1.25,
      filmGauge: 35,
      filmOffset: 0.5,
      position: [0, 0, 4],
      quaternion: [0, 0, 0, 1],
      up: [0, 1, 0],
    },
    colorMode: 'clay',
    appearance: {
      heightGradient: {
        low: '#21194f',
        mid: '#32bf8a',
        high: '#f2c66d',
        midpoint: 0.5,
      },
      clay: { color: '#d7d0bf', finish: 'glossy' },
    },
    width: 1,
    height: 1,
    background: 'transparent',
    studioBackground: 'dark-gray',
    settings: { ...DEFAULT_DESKTOP_PRO_RENDER_SETTINGS },
  }
}

interface JobFixture {
  job: CyclesProJob
  snapshot: DesktopProRenderSnapshot
  scriptSource: string
  hdrSource: Uint8Array
}

async function createJobFixture(): Promise<JobFixture> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'rasterform-cycles-test-'))
  temporaryDirectories.push(fixtureRoot)
  const assets = join(fixtureRoot, 'assets')
  await mkdir(assets)
  const scriptPath = join(assets, 'render.py')
  const hdrPath = join(assets, 'studio.hdr')
  const scriptSource = 'print("isolated renderer fixture")\n'
  const hdrSource = new Uint8Array([35, 63, 82, 65, 68, 73, 65, 78, 67, 69, 10])
  await Promise.all([
    writeFile(scriptPath, scriptSource),
    writeFile(hdrPath, hdrSource),
  ])
  const snapshot = snapshotFixture()
  const job = await createCyclesProJob(snapshot, {
    scriptPath,
    hdrPath,
    tempRoot: join(fixtureRoot, 'jobs'),
  })
  return { job, snapshot, scriptSource, hdrSource }
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const chunk = Buffer.alloc(data.byteLength + 12)
  chunk.writeUInt32BE(data.byteLength, 0)
  chunk.write(type, 4, 4, 'ascii')
  Buffer.from(data).copy(chunk, 8)
  chunk.writeUInt32BE(crc32(chunk.subarray(4, data.byteLength + 8)), data.byteLength + 8)
  return chunk
}

function onePixelRgbaPng(): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1, 0)
  header.writeUInt32BE(1, 4)
  header[8] = 8
  header[9] = 6
  const scanLine = new Uint8Array([0, 255, 96, 24, 0])
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(scanLine)),
    pngChunk('IEND', new Uint8Array()),
  ])
}

function cString(value: string): Buffer {
  return Buffer.concat([Buffer.from(value, 'utf8'), Buffer.from([0])])
}

function int32(value: number): Buffer {
  const bytes = Buffer.alloc(4)
  bytes.writeInt32LE(value)
  return bytes
}

function uint32(value: number): Buffer {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32LE(value)
  return bytes
}

function exrAttribute(name: string, type: string, data: Uint8Array): Buffer {
  return Buffer.concat([cString(name), cString(type), uint32(data.byteLength), Buffer.from(data)])
}

interface ExrPartFixture {
  name: string
  channels: Array<{ component: string; pixelType: 1 | 2 }>
}

function exrChannelList(part: ExrPartFixture): Buffer {
  const channels = part.channels.map(({ component, pixelType }) => {
    const metadata = Buffer.alloc(16)
    metadata.writeInt32LE(pixelType, 0)
    metadata[4] = 0
    metadata.writeInt32LE(1, 8)
    metadata.writeInt32LE(1, 12)
    return Buffer.concat([cString(`${part.name}.${component}`), metadata])
  })
  return Buffer.concat([...channels, Buffer.from([0])])
}

function exrPartHeader(part: ExrPartFixture): Buffer {
  const dataWindow = Buffer.alloc(16)
  dataWindow.writeInt32LE(0, 0)
  dataWindow.writeInt32LE(0, 4)
  dataWindow.writeInt32LE(0, 8)
  dataWindow.writeInt32LE(0, 12)
  return Buffer.concat([
    exrAttribute('channels', 'chlist', exrChannelList(part)),
    exrAttribute('chunkCount', 'int', int32(1)),
    exrAttribute('compression', 'compression', Buffer.from([4])),
    exrAttribute('dataWindow', 'box2i', dataWindow),
    exrAttribute('lineOrder', 'lineOrder', Buffer.from([0])),
    exrAttribute('name', 'string', Buffer.from(part.name)),
    exrAttribute('type', 'string', Buffer.from('scanlineimage')),
    Buffer.from([0]),
  ])
}

function validMultipartExr(): Buffer {
  const parts: ExrPartFixture[] = [
    {
      name: 'ViewLayer.Combined',
      channels: ['R', 'G', 'B', 'A'].map((component) => ({ component, pixelType: 1 })),
    },
    {
      name: 'ViewLayer.Normal',
      channels: ['X', 'Y', 'Z'].map((component) => ({ component, pixelType: 2 })),
    },
    {
      name: 'ViewLayer.Diffuse Color',
      channels: ['R', 'G', 'B'].map((component) => ({ component, pixelType: 1 })),
    },
    {
      name: 'ViewLayer.Noisy Image',
      channels: ['R', 'G', 'B', 'A'].map((component) => ({ component, pixelType: 1 })),
    },
    {
      name: 'ViewLayer.Denoising Albedo',
      channels: ['R', 'G', 'B'].map((component) => ({ component, pixelType: 1 })),
    },
    {
      name: 'ViewLayer.Denoising Normal',
      channels: ['X', 'Y', 'Z'].map((component) => ({ component, pixelType: 2 })),
    },
  ]
  const fileHeader = Buffer.alloc(8)
  fileHeader.writeUInt32LE(0x01312f76, 0)
  fileHeader.writeUInt32LE(2 | 0x00001000, 4)
  const multipartHeaders = Buffer.concat([
    ...parts.map(exrPartHeader),
    Buffer.from([0]),
  ])
  const tableOffset = fileHeader.byteLength + multipartHeaders.byteLength
  const table = Buffer.alloc(parts.length * 8)
  const chunks: Buffer[] = []
  let chunkOffset = tableOffset + table.byteLength
  for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
    table.writeBigUInt64LE(BigInt(chunkOffset), partIndex * 8)
    const chunk = Buffer.alloc(13)
    chunk.writeInt32LE(partIndex, 0)
    chunk.writeInt32LE(0, 4)
    chunk.writeUInt32LE(1, 8)
    chunk[12] = partIndex + 1
    chunks.push(chunk)
    chunkOffset += chunk.byteLength
  }
  return Buffer.concat([fileHeader, multipartHeaders, table, ...chunks])
}

async function writeValidOutputs(job: CyclesProJob): Promise<{ png: Buffer; exr: Buffer }> {
  const png = onePixelRgbaPng()
  const exr = validMultipartExr()
  await Promise.all([
    writeFile(job.pngPath, png),
    writeFile(job.exrPath, exr),
  ])
  return { png, exr }
}

function statusLine(kind: string, payload: unknown): string {
  return `RASTERFORM_${kind} ${JSON.stringify(payload)}`
}

describe('Cycles Pro native process boundary', () => {
  it('serializes an exact relative manifest and little-endian mesh buffers', async () => {
    const { job, snapshot, scriptSource, hdrSource } = await createJobFixture()
    const manifestText = await readFile(job.manifestPath, 'utf8')
    const manifest = JSON.parse(manifestText) as Record<string, unknown>
    const mesh = manifest.mesh as Record<string, unknown>

    expect(manifestText.endsWith('\n')).toBe(true)
    expect(manifest).toMatchObject({
      version: 1,
      jobId: job.id,
      colorMode: 'clay',
      width: 1,
      height: 1,
      background: 'transparent',
      studioBackground: 'dark-gray',
      environment: 'environment/studio.hdr',
      outputs: { png: 'outputs/render.png', exr: 'outputs/render.exr' },
      settings: DEFAULT_DESKTOP_PRO_RENDER_SETTINGS,
    })
    expect(mesh).toEqual({
      positions: 'mesh/positions.f32',
      indices: 'mesh/indices.u32',
      colors: 'mesh/colors.f32',
      heights: 'mesh/heights.f32',
      vertexCount: 3,
      indexCount: 3,
      mode: 'solid',
    })
    expect(manifestText).not.toContain(job.root)
    expect(await readFile(job.scriptPath, 'utf8')).toBe(scriptSource)
    expect(new Uint8Array(await readFile(job.environmentPath))).toEqual(hdrSource)

    const positions = await readFile(join(job.root, 'mesh/positions.f32'))
    const indices = await readFile(join(job.root, 'mesh/indices.u32'))
    const colors = await readFile(join(job.root, 'mesh/colors.f32'))
    const heights = await readFile(join(job.root, 'mesh/heights.f32'))
    const positionView = new DataView(positions.buffer, positions.byteOffset, positions.byteLength)
    const indexView = new DataView(indices.buffer, indices.byteOffset, indices.byteLength)
    const colorView = new DataView(colors.buffer, colors.byteOffset, colors.byteLength)
    const heightView = new DataView(heights.buffer, heights.byteOffset, heights.byteLength)

    expect(Array.from(snapshot.mesh.positions, (_value, index) => (
      positionView.getFloat32(index * 4, true)
    ))).toEqual(Array.from(snapshot.mesh.positions))
    expect(Array.from(snapshot.mesh.indices, (_value, index) => (
      indexView.getUint32(index * 4, true)
    ))).toEqual(Array.from(snapshot.mesh.indices))
    expect(Array.from(snapshot.mesh.colors, (_value, index) => (
      colorView.getFloat32(index * 4, true)
    ))).toEqual(Array.from(snapshot.mesh.colors))
    expect(Array.from(snapshot.mesh.heights, (_value, index) => (
      heightView.getFloat32(index * 4, true)
    ))).toEqual(Array.from(snapshot.mesh.heights))
    expect((await stat(job.manifestPath)).mode & 0o777).toBe(0o600)
    expect((await stat(job.scriptPath)).mode & 0o777).toBe(0o600)
  })

  it('uses factory startup, disables auto-exec, and supplies only private Blender state', async () => {
    const { job } = await createJobFixture()
    const blenderPath = '/Applications/Blender.app/Contents/MacOS/Blender'
    const invocation = buildBlenderInvocation(job, blenderPath)

    expect(invocation.command).toBe(blenderPath)
    expect(invocation.cwd).toBe(job.root)
    expect(invocation.args).toEqual([
      '--background',
      '--factory-startup',
      '--disable-autoexec',
      '--python-exit-code',
      '1',
      '--python',
      job.scriptPath,
      '--',
      job.manifestPath,
    ])
    expect(invocation.env).toEqual({
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      LANG: 'en_US.UTF-8',
      LC_CTYPE: 'UTF-8',
      HOME: job.homeDirectory,
      TMPDIR: job.tempDirectory,
      TMP: job.tempDirectory,
      TEMP: job.tempDirectory,
      XDG_CACHE_HOME: job.cacheDirectory,
      XDG_CONFIG_HOME: job.configDirectory,
      BLENDER_USER_CONFIG: job.configDirectory,
      BLENDER_USER_SCRIPTS: job.scriptsDirectory,
      BLENDER_USER_DATAFILES: job.dataFilesDirectory,
      BLENDER_USER_EXTENSIONS: job.extensionsDirectory,
      PYTHONNOUSERSITE: '1',
    })
    expect(invocation.env.HOME).not.toBe(process.env.HOME)
    expect(invocation.env).not.toHaveProperty('NODE_OPTIONS')
  })

  it('finds an explicitly supplied executable without requiring Blender', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'rasterform-blender-path-test-'))
    temporaryDirectories.push(fixtureRoot)
    const executable = join(fixtureRoot, 'blender-fixture')
    await writeFile(executable, '#!/bin/sh\nexit 0\n')
    await chmod(executable, 0o700)

    await expect(findBlenderExecutable([executable])).resolves.toBe(await realpath(executable))
  })

  it('accepts the renderer status sequence while ignoring ordinary Blender output', async () => {
    const { job } = await createJobFixture()
    const state = createCyclesProOutputState(job)
    const targetSamples = job.snapshot.settings.maxSamples

    expect(parseCyclesProOutput('Blender 5.2.0 LTS', state)).toBeNull()
    expect(parseCyclesProOutput(statusLine('VERSION', {
      version: '5.2.0 LTS',
      versionTuple: [5, 2, 0],
    }), state)).toEqual({
      type: 'version',
      blenderVersion: '5.2.0 LTS',
      versionTuple: [5, 2, 0],
    })
    expect(parseCyclesProOutput(statusLine('PROGRESS', {
      phase: 'preparing',
      progress: 0.35,
      tile: 0,
      tiles: 1,
      samples: 0,
      targetSamples,
    }), state)?.type).toBe('progress')
    expect(parseCyclesProOutput(statusLine('DEVICE', {
      device: 'METAL',
      name: 'Apple M3 Max',
    }), state)).toEqual({ type: 'device', device: 'METAL', name: 'Apple M3 Max' })
    expect(parseCyclesProOutput(statusLine('PROGRESS', {
      phase: 'rendering',
      progress: 0.5,
      tile: 0,
      tiles: 1,
      samples: targetSamples / 2,
      targetSamples,
    }), state)?.type).toBe('progress')
    expect(parseCyclesProOutput(statusLine('PROGRESS', {
      phase: 'finishing',
      progress: 1,
      tile: 1,
      tiles: 1,
      samples: targetSamples,
      targetSamples,
    }), state)?.type).toBe('progress')

    const completed = parseCyclesProOutput(statusLine('COMPLETE', {
      device: 'METAL',
      elapsedSeconds: 427.25,
      exr: 'outputs/render.exr',
      height: 1,
      jobId: job.id,
      maxSamples: targetSamples,
      noiseThreshold: job.snapshot.settings.noiseThreshold,
      png: 'outputs/render.png',
      width: 1,
    }), state)

    expect(completed?.type).toBe('complete')
    expect(state).toMatchObject({
      blenderVersion: '5.2.0 LTS',
      versionTuple: [5, 2, 0],
      device: 'METAL',
      deviceName: 'Apple M3 Max',
      progress: { phase: 'finishing', progress: 1, samples: targetSamples },
      completion: { jobId: job.id, maxSamples: targetSamples },
      error: null,
    })
  })

  it('rejects malformed, out-of-order, backwards, and mismatched status metadata', async () => {
    const { job } = await createJobFixture()
    const freshState = () => createCyclesProOutputState(job)

    expect(() => parseCyclesProOutput('RASTERFORM_VERSION not-json', freshState()))
      .toThrow(CyclesProProtocolError)
    expect(() => parseCyclesProOutput(statusLine('DEVICE', {
      device: 'METAL',
      name: 'Apple M3 Max',
    }), freshState())).toThrow(/device metadata/i)
    expect(() => parseCyclesProOutput(statusLine('VERSION', {
      version: '5.2.0 LTS',
      versionTuple: [5, 2, 0],
      unexpected: true,
    }), freshState())).toThrow(/version metadata/i)
    expect(() => parseCyclesProOutput(statusLine('UNKNOWN', {}), freshState()))
      .toThrow(/unknown UNKNOWN status/i)

    const backwards = freshState()
    parseCyclesProOutput(statusLine('VERSION', {
      version: '5.2.0 LTS',
      versionTuple: [5, 2, 0],
    }), backwards)
    parseCyclesProOutput(statusLine('PROGRESS', {
      phase: 'preparing',
      progress: 0.6,
      tile: 0,
      tiles: 1,
      samples: 0,
      targetSamples: job.snapshot.settings.maxSamples,
    }), backwards)
    expect(() => parseCyclesProOutput(statusLine('PROGRESS', {
      phase: 'preparing',
      progress: 0.5,
      tile: 0,
      tiles: 1,
      samples: 0,
      targetSamples: job.snapshot.settings.maxSamples,
    }), backwards)).toThrow(/moved backwards/i)
    expect(() => parseCyclesProOutput(statusLine('PROGRESS', {
      phase: 'rendering',
      progress: 0.75,
      tile: 0,
      tiles: 1,
      samples: job.snapshot.settings.maxSamples / 2,
      targetSamples: job.snapshot.settings.maxSamples,
    }), backwards)).toThrow(/invalid render progress/i)

    const completion = freshState()
    parseCyclesProOutput(statusLine('VERSION', {
      version: '5.2.0 LTS',
      versionTuple: [5, 2, 0],
    }), completion)
    parseCyclesProOutput(statusLine('DEVICE', {
      device: 'METAL',
      name: 'Apple M3 Max',
    }), completion)
    expect(() => parseCyclesProOutput(statusLine('COMPLETE', {
      device: 'METAL',
      elapsedSeconds: 1,
      exr: '../escaped.exr',
      height: 1,
      jobId: 'different-job',
      maxSamples: job.snapshot.settings.maxSamples,
      noiseThreshold: job.snapshot.settings.noiseThreshold,
      png: 'outputs/render.png',
      width: 1,
    }), completion)).toThrow(/completion metadata/i)
  })

  it('validates the RGBA PNG and required multipart PIZ EXR passes structurally', async () => {
    const { job } = await createJobFixture()
    const { png, exr } = await writeValidOutputs(job)

    await expect(validateCyclesProOutputs(job)).resolves.toMatchObject({
      pngPath: job.pngPath,
      exrPath: job.exrPath,
      pngBytes: png.byteLength,
      exrBytes: exr.byteLength,
      exrChannels: expect.arrayContaining([
        'ViewLayer.Combined.R',
        'ViewLayer.Combined.A',
        'ViewLayer.Normal.X',
        'ViewLayer.Diffuse Color.B',
        'ViewLayer.Noisy Image.R',
        'ViewLayer.Denoising Albedo.G',
        'ViewLayer.Denoising Normal.Z',
      ]),
    })

    await writeFile(job.exrPath, Buffer.concat([exr, Buffer.from([0])]))
    await expect(validateCyclesProOutputs(job)).rejects.toThrow(/trailing|incomplete/i)
    await writeFile(job.exrPath, exr)
    await writeFile(job.pngPath, png.subarray(0, png.byteLength - 12))
    await expect(validateCyclesProOutputs(job)).rejects.toThrow(/invalid RGBA PNG/i)
  })

  it('replaces an existing PNG/EXR as one validated pair without leaving staging files', async () => {
    const { job } = await createJobFixture()
    const rendered = await writeValidOutputs(job)
    const destinationDirectory = join(job.root, 'destination')
    await mkdir(destinationDirectory)
    const pngDestination = join(destinationDirectory, 'finished.PNG')
    const exrDestination = join(destinationDirectory, 'finished.exr')
    await Promise.all([
      writeFile(pngDestination, 'old-png'),
      writeFile(exrDestination, 'old-exr'),
    ])

    await expect(commitCyclesProOutputsAtomically(job, pngDestination)).resolves.toEqual({
      pngPath: resolve(pngDestination),
      exrPath: resolve(exrDestination),
    })
    expect(await readFile(pngDestination)).toEqual(rendered.png)
    expect(await readFile(exrDestination)).toEqual(rendered.exr)
    expect(await readdir(destinationDirectory)).toEqual(['finished.PNG', 'finished.exr'])
  })

  it('preserves the prior destination pair when source validation fails', async () => {
    const { job } = await createJobFixture()
    const { exr } = await writeValidOutputs(job)
    const destinationDirectory = join(job.root, 'destination')
    await mkdir(destinationDirectory)
    const pngDestination = join(destinationDirectory, 'finished.png')
    const exrDestination = join(destinationDirectory, 'finished.exr')
    const oldPng = Buffer.from('existing-png')
    const oldExr = Buffer.from('existing-exr')
    await Promise.all([
      writeFile(pngDestination, oldPng),
      writeFile(exrDestination, oldExr),
      writeFile(job.exrPath, Buffer.concat([exr, Buffer.from([0])])),
    ])

    await expect(commitCyclesProOutputsAtomically(job, pngDestination))
      .rejects.toThrow(/trailing|incomplete/i)
    expect(await readFile(pngDestination)).toEqual(oldPng)
    expect(await readFile(exrDestination)).toEqual(oldExr)
    expect(await readdir(destinationDirectory)).toEqual(['finished.exr', 'finished.png'])
  })

  it('cleans up only a helper-created private job directory', async () => {
    const { job } = await createJobFixture()
    const forged = { ...job, privateJobDirectory: false as const }

    await expect(cleanupCyclesProJob(forged as unknown as CyclesProJob))
      .rejects.toThrow(/refusing to remove/i)
    await expect(stat(job.root)).resolves.toBeDefined()
    await cleanupCyclesProJob(job)
    await expect(stat(job.root)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
