import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_BLENDER_EXPORT_PROTOCOL_VERSION,
  type DesktopBlenderExportSnapshot,
  type DesktopBlenderTopology,
} from '../src/desktop/blender-export-contracts'
import {
  BlenderExportProtocolError,
  buildBlenderExportInvocation,
  cleanupBlenderExportJob,
  commitBlenderExportAtomically,
  createBlenderExportJob,
  createBlenderExportOutputState,
  parseBlenderExportOutput,
  validateBlenderExportOutput,
  type BlenderExportCompletion,
  type BlenderExportJob,
} from './blender-export'

const renameFault = vi.hoisted(() => ({
  destination: null as string | null,
  failNextInstall: false,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (oldPath: string, newPath: string) => {
      if (renameFault.failNextInstall
        && renameFault.destination === String(newPath)
        && String(oldPath).endsWith('.blend.tmp')) {
        renameFault.failNextInstall = false
        throw Object.assign(new Error('injected install failure'), { code: 'EIO' })
      }
      return actual.rename(oldPath, newPath)
    },
  }
})

const temporaryDirectories: string[] = []

afterEach(async () => {
  renameFault.destination = null
  renameFault.failNextInstall = false
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )))
})

function snapshotFixture(
  topology: DesktopBlenderTopology = 'balanced',
): DesktopBlenderExportSnapshot {
  return {
    protocolVersion: DESKTOP_BLENDER_EXPORT_PROTOCOL_VERSION,
    mesh: {
      positions: new Float32Array([
        1.25, -2.5, 3.75,
        4.5, 5.25, -6.5,
        -7.75, 8.125, 9.5,
        10.75, -11.5, 12.25,
      ]),
      indices: new Uint32Array([2, 0, 1, 3, 0, 2]),
      colors: new Float32Array([
        1, 0.25, 0,
        0.5, 1, 0.75,
        0.125, 0.375, 1,
        0.875, 0.625, 0.25,
      ]),
      uvs: new Float32Array([
        0, 0,
        1, 0,
        1, 1,
        0, 1,
      ]),
      width: 2,
      height: 2,
      mode: 'solid',
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
    settings: { topology },
  }
}

interface JobFixture {
  fixtureRoot: string
  job: BlenderExportJob
  scriptSource: string
  snapshot: DesktopBlenderExportSnapshot
}

async function createJobFixture(
  topology: DesktopBlenderTopology = 'balanced',
): Promise<JobFixture> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'rasterform-export-helper-test-'))
  temporaryDirectories.push(fixtureRoot)
  const assets = join(fixtureRoot, 'assets')
  await mkdir(assets)
  const scriptPath = join(assets, 'export_blend.py')
  const scriptSource = 'print("isolated Blender export fixture")\n'
  await writeFile(scriptPath, scriptSource)
  const snapshot = snapshotFixture(topology)
  const job = await createBlenderExportJob(snapshot, {
    scriptPath,
    tempRoot: join(fixtureRoot, 'jobs'),
  })
  return { fixtureRoot, job, scriptSource, snapshot }
}

function readFloat32LittleEndian(bytes: Buffer): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return Array.from({ length: bytes.byteLength / 4 }, (_value, index) => (
    view.getFloat32(index * 4, true)
  ))
}

function readUint32LittleEndian(bytes: Buffer): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return Array.from({ length: bytes.byteLength / 4 }, (_value, index) => (
    view.getUint32(index * 4, true)
  ))
}

function statusLine(kind: string, payload: unknown): string {
  return `RASTERFORM_${kind} ${JSON.stringify(payload)}`
}

function balancedCompletion(job: BlenderExportJob): BlenderExportCompletion {
  return {
    jobId: job.id,
    file: 'outputs/rasterform.blend',
    topology: 'balanced',
    sourceVertices: 4,
    sourceFaces: 2,
    outputVertices: 3,
    outputFaces: 1,
    outputTriangleCount: 2,
    quads: 1,
    triangles: 0,
    ngons: 0,
    uvLayerName: 'UVMap',
    uvLoops: 4,
    colorAttributeName: 'RasterformColor',
    blenderVersion: '5.2.0 LTS',
    elapsedSeconds: 3.25,
    outputBytes: 128,
    outputSha256: 'a'.repeat(64),
  }
}

function rawBlendBytes(payload = 'native fixture'): Buffer {
  const body = Buffer.alloc(64, 0)
  body.write(payload)
  return Buffer.concat([Buffer.from('BLENDER-v520', 'ascii'), body])
}

function zstdBlendBytes(): Buffer {
  return Buffer.concat([Buffer.from([
    0x28, 0xb5, 0x2f, 0xfd,
    0x00, 0x48, 0x2a, 0x4d,
    0x18, 0x00, 0x00, 0x00,
  ]), Buffer.alloc(64)])
}

function completionForOutput(job: BlenderExportJob, output: Buffer): BlenderExportCompletion {
  return {
    ...balancedCompletion(job),
    outputBytes: output.byteLength,
    outputSha256: createHash('sha256').update(output).digest('hex'),
  }
}

describe('Blender project export native boundary', () => {
  it('serializes a private relative manifest and exact little-endian mesh buffers', async () => {
    const { job, scriptSource, snapshot } = await createJobFixture()
    const manifestText = await readFile(job.manifestPath, 'utf8')
    const manifest = JSON.parse(manifestText) as Record<string, unknown>

    expect(manifestText.endsWith('\n')).toBe(true)
    expect(manifest).toEqual({
      version: 1,
      jobId: job.id,
      mesh: {
        positions: 'mesh/positions.f32',
        indices: 'mesh/indices.u32',
        colors: 'mesh/colors.f32',
        uvs: 'mesh/uvs.f32',
        vertexCount: 4,
        indexCount: 6,
        uvCount: 4,
        width: 2,
        height: 2,
        mode: 'solid',
      },
      colorMode: 'clay',
      appearance: snapshot.appearance,
      settings: { topology: 'balanced' },
      output: 'outputs/rasterform.blend',
    })
    expect(manifestText).not.toContain(job.root)
    expect(await readFile(job.scriptPath, 'utf8')).toBe(scriptSource)

    expect(readFloat32LittleEndian(await readFile(join(job.root, 'mesh/positions.f32'))))
      .toEqual(Array.from(snapshot.mesh.positions))
    expect(readUint32LittleEndian(await readFile(join(job.root, 'mesh/indices.u32'))))
      .toEqual(Array.from(snapshot.mesh.indices))
    expect(readFloat32LittleEndian(await readFile(join(job.root, 'mesh/colors.f32'))))
      .toEqual(Array.from(snapshot.mesh.colors))
    expect(readFloat32LittleEndian(await readFile(join(job.root, 'mesh/uvs.f32'))))
      .toEqual(Array.from(snapshot.mesh.uvs))

    expect((await stat(job.root)).mode & 0o777).toBe(0o700)
    expect((await stat(job.manifestPath)).mode & 0o777).toBe(0o600)
    expect((await stat(job.scriptPath)).mode & 0o777).toBe(0o600)
    for (const directory of Object.values(job.isolation)) {
      expect(resolve(directory).startsWith(`${resolve(job.root)}/`)).toBe(true)
      expect((await stat(directory)).mode & 0o777).toBe(0o700)
    }
  })

  it('invokes only the copied script under factory startup and private Blender state', async () => {
    const { job } = await createJobFixture()
    const blenderPath = '/Applications/Blender.app/Contents/MacOS/Blender'
    const invocation = buildBlenderExportInvocation(job, blenderPath)

    expect(invocation).toEqual({
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
      env: {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        LANG: 'en_US.UTF-8',
        LC_CTYPE: 'UTF-8',
        HOME: job.isolation.home,
        TMPDIR: job.isolation.temp,
        TMP: job.isolation.temp,
        TEMP: job.isolation.temp,
        XDG_CACHE_HOME: job.isolation.cache,
        XDG_CONFIG_HOME: job.isolation.config,
        BLENDER_USER_CONFIG: job.isolation.config,
        BLENDER_USER_SCRIPTS: job.isolation.scripts,
        BLENDER_USER_DATAFILES: job.isolation.dataFiles,
        BLENDER_USER_EXTENSIONS: job.isolation.extensions,
        PYTHONNOUSERSITE: '1',
      },
    })
    expect(invocation.env.HOME).not.toBe(process.env.HOME)
    expect(invocation.env).not.toHaveProperty('NODE_OPTIONS')
    expect(invocation.env).not.toHaveProperty('PYTHONPATH')
  })

  it('accepts the complete monotonic progress protocol and exact completion metadata', async () => {
    const { job } = await createJobFixture()
    const state = createBlenderExportOutputState(job)
    const completion = balancedCompletion(job)

    expect(parseBlenderExportOutput('Blender 5.2.0 LTS', state)).toBeNull()
    for (const phase of ['preparing', 'retopologizing', 'unwrapping', 'saving'] as const) {
      expect(parseBlenderExportOutput(statusLine('PROGRESS', {
        jobId: job.id,
        phase,
      }), state)).toEqual({ type: 'progress', phase })
    }
    expect(parseBlenderExportOutput(statusLine('COMPLETE', completion), state)).toEqual({
      type: 'complete',
      completion,
    })
    expect(state).toEqual({
      expectedJobId: job.id,
      expectedTopology: 'balanced',
      expectedSourceVertices: 4,
      expectedSourceFaces: 2,
      phase: 'saving',
      completion,
      error: null,
    })
  })

  it('rejects malformed, mismatched, repeated, backwards, and out-of-order status data', async () => {
    const { job } = await createJobFixture()
    const freshState = () => createBlenderExportOutputState(job)

    expect(() => parseBlenderExportOutput('RASTERFORM_PROGRESS not-json', freshState()))
      .toThrow(BlenderExportProtocolError)
    expect(() => parseBlenderExportOutput(statusLine('PROGRESS', {
      jobId: `${job.id}-other`,
      phase: 'preparing',
    }), freshState())).toThrow(/invalid progress metadata/i)
    expect(() => parseBlenderExportOutput(statusLine('PROGRESS', {
      jobId: job.id,
      phase: 'preparing',
      extra: true,
    }), freshState())).toThrow(/invalid progress metadata/i)
    expect(() => parseBlenderExportOutput(statusLine('COMPLETE', balancedCompletion(job)), freshState()))
      .toThrow(/invalid completion metadata/i)
    expect(() => parseBlenderExportOutput(statusLine('UNKNOWN', {}), freshState()))
      .toThrow(/unknown UNKNOWN status/i)

    const repeated = freshState()
    parseBlenderExportOutput(statusLine('PROGRESS', {
      jobId: job.id,
      phase: 'preparing',
    }), repeated)
    expect(() => parseBlenderExportOutput(statusLine('PROGRESS', {
      jobId: job.id,
      phase: 'preparing',
    }), repeated)).toThrow(/invalid progress metadata/i)

    const backwards = freshState()
    parseBlenderExportOutput(statusLine('PROGRESS', {
      jobId: job.id,
      phase: 'retopologizing',
    }), backwards)
    expect(() => parseBlenderExportOutput(statusLine('PROGRESS', {
      jobId: job.id,
      phase: 'preparing',
    }), backwards)).toThrow(/invalid progress metadata/i)

    const mismatchedCompletion = freshState()
    for (const phase of ['preparing', 'saving'] as const) {
      parseBlenderExportOutput(statusLine('PROGRESS', { jobId: job.id, phase }), mismatchedCompletion)
    }
    expect(() => parseBlenderExportOutput(statusLine('COMPLETE', {
      ...balancedCompletion(job),
      topology: 'lightweight',
    }), mismatchedCompletion)).toThrow(/invalid completion metadata/i)

    const failed = freshState()
    expect(parseBlenderExportOutput(statusLine('ERROR', {
      message: 'Quadriflow failed cleanly.',
      type: 'RuntimeError',
    }), failed)).toEqual({
      type: 'error',
      message: 'Quadriflow failed cleanly.',
      errorType: 'RuntimeError',
    })
    expect(() => parseBlenderExportOutput(statusLine('PROGRESS', {
      jobId: job.id,
      phase: 'preparing',
    }), failed)).toThrow(/invalid progress metadata/i)
  })

  it('accepts raw Blender and Blender 5.2 Zstandard headers but rejects invalid output', async () => {
    const { job } = await createJobFixture()
    const raw = rawBlendBytes()
    await writeFile(job.outputPath, raw)
    await expect(validateBlenderExportOutput(job)).resolves.toBe(raw.byteLength)

    const zstd = zstdBlendBytes()
    await writeFile(job.outputPath, zstd)
    await expect(validateBlenderExportOutput(job)).resolves.toBe(zstd.byteLength)

    await writeFile(job.outputPath, Buffer.from([
      0x28, 0xb5, 0x2f, 0xfc,
      0x00, 0x48, 0x2a, 0x4d,
      0x18, 0x00, 0x00, 0x00,
    ]))
    await expect(validateBlenderExportOutput(job)).rejects.toThrow(/missing|invalid file header/i)
    await writeFile(job.outputPath, Buffer.from('BLENDER-v52', 'ascii'))
    await expect(validateBlenderExportOutput(job)).rejects.toThrow(/missing|header/i)
  })

  it('atomically replaces an existing project without leaving staging files', async () => {
    const { fixtureRoot, job } = await createJobFixture()
    const output = rawBlendBytes('new project')
    await writeFile(job.outputPath, output)
    const destinationDirectory = join(fixtureRoot, 'destination')
    await mkdir(destinationDirectory)
    const destination = join(destinationDirectory, 'finished.blend')
    await writeFile(destination, 'existing project')

    await expect(commitBlenderExportAtomically(job, destination, completionForOutput(job, output)))
      .resolves.toBe(resolve(destination))
    expect(await readFile(destination)).toEqual(output)
    expect(await readdir(destinationDirectory)).toEqual(['finished.blend'])
  })

  it('rolls back the prior project when the staged install fails', async () => {
    const { fixtureRoot, job } = await createJobFixture()
    const output = rawBlendBytes('new project')
    await writeFile(job.outputPath, output)
    const destinationDirectory = join(fixtureRoot, 'destination')
    await mkdir(destinationDirectory)
    const destination = join(destinationDirectory, 'finished.blend')
    const priorProject = Buffer.from('existing project that must survive')
    await writeFile(destination, priorProject)
    renameFault.destination = resolve(destination)
    renameFault.failNextInstall = true

    await expect(commitBlenderExportAtomically(job, destination, completionForOutput(job, output)))
      .rejects.toThrow(/injected install failure/i)
    expect(await readFile(destination)).toEqual(priorProject)
    expect(await readdir(destinationDirectory)).toEqual(['finished.blend'])
  })

  it('preserves the prior project when source validation fails', async () => {
    const { fixtureRoot, job } = await createJobFixture()
    await writeFile(job.outputPath, Buffer.from('not-a-blend-file'))
    const destinationDirectory = join(fixtureRoot, 'destination')
    await mkdir(destinationDirectory)
    const destination = join(destinationDirectory, 'finished.blend')
    const priorProject = Buffer.from('existing project')
    await writeFile(destination, priorProject)

    const invalidCompletion = completionForOutput(job, Buffer.from('not-a-blend-file'))
    await expect(commitBlenderExportAtomically(job, destination, invalidCompletion))
      .rejects.toThrow(/missing|invalid file header/i)
    expect(await readFile(destination)).toEqual(priorProject)
    expect(await readdir(destinationDirectory)).toEqual(['finished.blend'])
  })

  it('rejects private-job, directory, symlink, and hash-mismatched destinations', async () => {
    const { fixtureRoot, job } = await createJobFixture()
    const output = rawBlendBytes('validated project')
    await writeFile(job.outputPath, output)
    const completion = completionForOutput(job, output)

    await expect(commitBlenderExportAtomically(job, join(job.root, 'inside.blend'), completion))
      .rejects.toThrow(/outside the private export job/i)

    const destinationDirectory = join(fixtureRoot, 'destination')
    await mkdir(destinationDirectory)
    const directoryDestination = join(destinationDirectory, 'folder.blend')
    await mkdir(directoryDestination)
    await expect(commitBlenderExportAtomically(job, directoryDestination, completion))
      .rejects.toThrow(/regular file/i)

    const realDestination = join(destinationDirectory, 'real.blend')
    const symlinkDestination = join(destinationDirectory, 'link.blend')
    await writeFile(realDestination, 'existing project')
    await symlink(realDestination, symlinkDestination)
    await expect(commitBlenderExportAtomically(job, symlinkDestination, completion))
      .rejects.toThrow(/regular file/i)

    await expect(commitBlenderExportAtomically(job, realDestination, {
      ...completion,
      outputSha256: '0'.repeat(64),
    })).rejects.toThrow(/changed after Blender verified/i)
    expect(await readFile(realDestination, 'utf8')).toBe('existing project')
  })

  it('refuses forged cleanup targets and removes only a helper-created private job', async () => {
    const { fixtureRoot, job } = await createJobFixture()
    const marker = join(fixtureRoot, 'must-survive.txt')
    await writeFile(marker, 'keep')

    await expect(cleanupBlenderExportJob({
      ...job,
      privateJobDirectory: false,
    } as unknown as BlenderExportJob)).rejects.toThrow(/refusing to remove/i)
    await expect(cleanupBlenderExportJob({
      ...job,
      root: fixtureRoot,
      manifestPath: join(fixtureRoot, 'manifest.json'),
    })).rejects.toThrow(/refusing to remove/i)
    await expect(cleanupBlenderExportJob({
      ...job,
      manifestPath: join(fixtureRoot, 'manifest.json'),
    })).rejects.toThrow(/refusing to remove/i)

    expect(await readFile(marker, 'utf8')).toBe('keep')
    await expect(stat(job.root)).resolves.toBeDefined()
    await cleanupBlenderExportJob(job)
    await expect(stat(job.root)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(marker, 'utf8')).toBe('keep')
  })
})
