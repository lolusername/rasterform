import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { sourceBitmapFixture } from './test-fixtures/source-bitmap'

const execFileAsync = promisify(execFile)
const blenderPath = process.env.RASTERFORM_BLENDER_PATH
  ?? '/Applications/Blender.app/Contents/MacOS/Blender'
const realBlenderAvailable = existsSync(blenderPath)
const exporterPath = resolve('electron/cycles/export_blend.py')
const temporaryRoots: string[] = []

interface Fixture {
  root: string
  manifestPath: string
  outputPath: string
  vertexCount: number
  faceCount: number
  indexCount: number
}

interface StatusLine {
  kind: string
  payload: Record<string, unknown>
}

function encodeFloat32(values: number[]): Buffer {
  const result = Buffer.alloc(values.length * 4)
  const view = new DataView(result.buffer, result.byteOffset, result.byteLength)
  values.forEach((value, index) => view.setFloat32(index * 4, value, true))
  return result
}

function encodeUint32(values: number[]): Buffer {
  const result = Buffer.alloc(values.length * 4)
  const view = new DataView(result.buffer, result.byteOffset, result.byteLength)
  values.forEach((value, index) => view.setUint32(index * 4, value, true))
  return result
}

async function createFixture(
  topology: 'exact' | 'balanced' | 'lightweight',
  kind: 'freeform' | 'structured-grid' = 'freeform',
  sharpFeature = false,
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'rasterform-blend-script-test-'))
  temporaryRoots.push(root)
  const meshDirectory = join(root, 'mesh')
  const outputDirectory = join(root, 'outputs')
  const isolationDirectories = [
    'home', 'temp', 'config', 'scripts', 'datafiles', 'extensions', 'cache',
  ].map((name) => join(root, name))
  await Promise.all([
    mkdir(meshDirectory, { mode: 0o700 }),
    mkdir(outputDirectory, { mode: 0o700 }),
    ...isolationDirectories.map((directory) => mkdir(directory, { mode: 0o700 })),
  ])

  const positions: number[] = []
  const colors: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  let meshWidth: number
  let meshHeight: number
  if (kind === 'freeform') {
    meshWidth = 24
    meshHeight = 12
    for (let major = 0; major < meshWidth; major += 1) {
      const u = (major / meshWidth) * Math.PI * 2
      for (let minor = 0; minor < meshHeight; minor += 1) {
        const v = (minor / meshHeight) * Math.PI * 2
        const radius = 1.25 + Math.cos(v) * 0.38
        positions.push(radius * Math.cos(u), Math.sin(v) * 0.38, radius * Math.sin(u))
        colors.push(
          0.25 + (major / meshWidth) * 0.65,
          0.2 + (minor / meshHeight) * 0.7,
          0.72,
        )
        uvs.push(major / meshWidth, minor / meshHeight)
      }
    }
    for (let major = 0; major < meshWidth; major += 1) {
      const nextMajor = (major + 1) % meshWidth
      for (let minor = 0; minor < meshHeight; minor += 1) {
        const nextMinor = (minor + 1) % meshHeight
        const a = major * meshHeight + minor
        const b = nextMajor * meshHeight + minor
        const c = nextMajor * meshHeight + nextMinor
        const d = major * meshHeight + nextMinor
        indices.push(a, b, c, a, c, d)
      }
    }
  } else {
    meshWidth = 16
    meshHeight = 12
    const gridVertexCount = (meshWidth + 1) * (meshHeight + 1)
    for (let layer = 0; layer < 2; layer += 1) {
      for (let y = 0; y <= meshHeight; y += 1) {
        const v = y / meshHeight
        for (let x = 0; x <= meshWidth; x += 1) {
          const u = x / meshWidth
          const relief = sharpFeature && x === 5 && y === 5
            ? 1.4
            : 0.18 + 0.28 * (
                0.5 + 0.5 * Math.sin(u * Math.PI * 4) * Math.cos(v * Math.PI * 3)
              )
          positions.push((u - 0.5) * 2, (0.5 - v) * 1.5, layer === 0 ? relief : 0)
          const colorScale = layer === 0 ? 1 : 0.62
          colors.push((0.2 + u * 0.7) * colorScale, (0.25 + v * 0.6) * colorScale, 0.7 * colorScale)
          uvs.push(u, 1 - v)
        }
      }
    }
    for (let y = 0; y < meshHeight; y += 1) {
      for (let x = 0; x < meshWidth; x += 1) {
        const a = y * (meshWidth + 1) + x
        const b = a + 1
        const c = a + meshWidth + 1
        const d = c + 1
        indices.push(a, c, b, b, c, d)
        indices.push(
          a + gridVertexCount, b + gridVertexCount, c + gridVertexCount,
          b + gridVertexCount, d + gridVertexCount, c + gridVertexCount,
        )
      }
    }
    const perimeter: number[] = []
    for (let x = 0; x <= meshWidth; x += 1) perimeter.push(x)
    for (let y = 1; y <= meshHeight; y += 1) perimeter.push(y * (meshWidth + 1) + meshWidth)
    for (let x = meshWidth - 1; x >= 0; x -= 1) perimeter.push(meshHeight * (meshWidth + 1) + x)
    for (let y = meshHeight - 1; y >= 1; y -= 1) perimeter.push(y * (meshWidth + 1))
    perimeter.forEach((current, edgeIndex) => {
      const next = perimeter[(edgeIndex + 1) % perimeter.length]!
      indices.push(
        current, next, next + gridVertexCount,
        current, next + gridVertexCount, current + gridVertexCount,
      )
    })
  }

  await Promise.all([
    writeFile(join(meshDirectory, 'positions.f32'), encodeFloat32(positions), { mode: 0o600 }),
    writeFile(join(meshDirectory, 'indices.u32'), encodeUint32(indices), { mode: 0o600 }),
    writeFile(join(meshDirectory, 'colors.f32'), encodeFloat32(colors), { mode: 0o600 }),
    writeFile(join(meshDirectory, 'uvs.f32'), encodeFloat32(uvs), { mode: 0o600 }),
  ])
  const manifestPath = join(root, 'manifest.json')
  const outputPath = join(outputDirectory, 'rasterform.blend')
  const manifest = {
    version: 2,
    jobId: kind === 'freeform' ? `test-${topology}` : `test-grid-${topology}`,
    mesh: {
      positions: 'mesh/positions.f32',
      indices: 'mesh/indices.u32',
      colors: 'mesh/colors.f32',
      uvs: 'mesh/uvs.f32',
      vertexCount: positions.length / 3,
      indexCount: indices.length,
      uvCount: uvs.length / 2,
      width: meshWidth,
      height: meshHeight,
      mode: 'solid',
    },
    colorMode: 'original',
    appearance: {
      heightGradient: { low: '#21194f', mid: '#32bf8a', high: '#f2c66d', midpoint: 0.5 },
      clay: { color: '#d7d0bf', finish: 'matte' },
    },
    settings: { topology },
    texture: null,
    output: 'outputs/rasterform.blend',
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 })
  return {
    root,
    manifestPath,
    outputPath,
    vertexCount: positions.length / 3,
    faceCount: indices.length / 3,
    indexCount: indices.length,
  }
}

function isolatedEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'en_US.UTF-8',
    LC_CTYPE: 'UTF-8',
    HOME: join(root, 'home'),
    TMPDIR: join(root, 'temp'),
    TMP: join(root, 'temp'),
    TEMP: join(root, 'temp'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_CONFIG_HOME: join(root, 'config'),
    BLENDER_USER_CONFIG: join(root, 'config'),
    BLENDER_USER_SCRIPTS: join(root, 'scripts'),
    BLENDER_USER_DATAFILES: join(root, 'datafiles'),
    BLENDER_USER_EXTENSIONS: join(root, 'extensions'),
    PYTHONNOUSERSITE: '1',
  }
}

function statusLines(output: string): StatusLine[] {
  return output.split(/\r?\n/u).flatMap((line) => {
    const match = /^RASTERFORM_([A-Z]+) (\{.*\})$/u.exec(line.trim())
    if (!match) return []
    return [{ kind: match[1]!, payload: JSON.parse(match[2]!) as Record<string, unknown> }]
  })
}

async function runExporter(fixture: Fixture): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(blenderPath, [
    '--background',
    '--factory-startup',
    '--disable-autoexec',
    '--python-exit-code',
    '1',
    '--python',
    exporterPath,
    '--',
    fixture.manifestPath,
  ], {
    cwd: fixture.root,
    env: isolatedEnvironment(fixture.root),
    maxBuffer: 8 * 1024 * 1024,
    timeout: 120_000,
  })
}

async function addBitmap(fixture: Fixture, finish: 'matte' | 'glossy' | 'metallic' = 'metallic') {
  // Larger than Rasterform's 1280px geometry working image: prove that the
  // source image survives independently at its actual original dimensions.
  const texture = sourceBitmapFixture(1536, 1024)
  await mkdir(join(fixture.root, 'texture'), { mode: 0o700 })
  const imagePath = join(fixture.root, 'texture/source.png')
  await writeFile(imagePath, texture.data, { mode: 0o600 })
  const manifest = JSON.parse(await readFile(fixture.manifestPath, 'utf8'))
  manifest.texture = {
    path: 'texture/source.png', mimeType: texture.mimeType, width: texture.width,
    height: texture.height, name: texture.name, bytes: texture.data.byteLength,
    sha256: createHash('sha256').update(texture.data).digest('hex'),
  }
  manifest.colorMode = 'clay'
  manifest.appearance.clay = { color: '#ff0033', finish }
  await writeFile(fixture.manifestPath, JSON.stringify(manifest), { mode: 0o600 })
  return { texture, imagePath, manifest }
}

async function inspectBlend(fixture: Fixture, inspectTexture = false): Promise<Record<string, unknown>> {
  const expression = [
    'import bpy,json',
    'objects=list(bpy.context.scene.objects)',
    'mesh_objects=[o for o in objects if o.type==\'MESH\']',
    'mesh=mesh_objects[0].data if len(mesh_objects)==1 else None',
    'uv=mesh.uv_layers.get(\'UVMap\') if mesh else None',
    'color=mesh.color_attributes.get(\'RasterformColor\') if mesh else None',
    'vertices=[tuple(v.co) for v in mesh.vertices] if mesh else []',
    'uv_values=[component for item in uv.uv for component in item.vector] if uv else []',
    'grid=any(getattr(s.overlay,\'show_floor\',False) or getattr(s.overlay,\'show_ortho_grid\',False) for screen in bpy.data.screens for area in screen.areas if area.type==\'VIEW_3D\' for s in area.spaces if s.type==\'VIEW_3D\')',
    'data={\'objects\':len(objects),\'meshes\':len(mesh_objects),\'cameras\':sum(o.type==\'CAMERA\' for o in objects),\'lights\':sum(o.type==\'LIGHT\' for o in objects),\'vertices\':len(mesh.vertices) if mesh else 0,\'faces\':len(mesh.polygons) if mesh else 0,\'quads\':sum(len(p.vertices)==4 for p in mesh.polygons) if mesh else 0,\'uvLoops\':len(uv.uv) if uv else 0,\'uvMin\':min(uv_values) if uv_values else None,\'uvMax\':max(uv_values) if uv_values else None,\'colorCount\':len(color.data) if color else 0,\'materials\':len(mesh.materials) if mesh else 0,\'gridVisible\':grid,\'method\':mesh_objects[0].get(\'rasterform_retopology_method\') if mesh_objects else None,\'xMin\':min(v[0] for v in vertices) if vertices else None,\'xMax\':max(v[0] for v in vertices) if vertices else None,\'yMin\':min(v[1] for v in vertices) if vertices else None,\'yMax\':max(v[1] for v in vertices) if vertices else None,\'zMin\':min(v[2] for v in vertices) if vertices else None,\'zMax\':max(v[2] for v in vertices) if vertices else None}',
    ...(inspectTexture ? [
      'import hashlib',
      'source_uv=mesh.uv_layers.get("SourceUV")',
      'image=next(i for i in bpy.data.images if i.packed_file is not None)',
      'front,side=mesh.materials',
      'image_node=next(n for n in front.node_tree.nodes if n.type=="TEX_IMAGE")',
      'shader=next(n for n in front.node_tree.nodes if n.type=="BSDF_PRINCIPLED")',
      'side_shader=next(n for n in side.node_tree.nodes if n.type=="BSDF_PRINCIPLED")',
      'uv_node=next(n for n in front.node_tree.nodes if n.type=="UVMAP")',
      'uv_error=max(max(abs(source_uv.uv[l.index].vector[0]-(mesh.vertices[l.vertex_index].co.x+1)/2),abs(source_uv.uv[l.index].vector[1]-(mesh.vertices[l.vertex_index].co.z+0.75)/1.5)) for l in mesh.loops)',
      'front_vertex_count=len(mesh.vertices)//2',
      'data.update({"packedBytes":image.packed_file.size,"packedSha256":hashlib.sha256(image.packed_file.data).hexdigest(),"imageDimensions":list(image.size),"imageColorspace":image.colorspace_settings.name,"imageData":image.has_data,"imagePath":image.filepath,"sourceUVLoops":len(source_uv.uv),"sourceUVError":uv_error,"uvNode":uv_node.uv_map,"bitmapLinks":any(l.from_node==image_node and l.to_node==shader and l.to_socket.name=="Base Color" for l in front.node_tree.links),"uvLink":any(l.from_node==uv_node and l.to_node==image_node and l.to_socket.name=="Vector" for l in front.node_tree.links),"vertexColorNodes":sum(n.type=="VERTEX_COLOR" for n in front.node_tree.nodes),"roughness":shader.inputs["Roughness"].default_value,"metallic":shader.inputs["Metallic"].default_value,"sideRoughness":side_shader.inputs["Roughness"].default_value,"sideMetallic":side_shader.inputs["Metallic"].default_value,"sideColor":list(side_shader.inputs["Base Color"].default_value),"sideImageNodes":sum(n.type=="TEX_IMAGE" for n in side.node_tree.nodes),"surfaceAssignments":all(p.material_index==(0 if all(v<front_vertex_count for v in p.vertices) else 1) for p in mesh.polygons),"frontFaces":sum(p.material_index==0 for p in mesh.polygons),"sideFaces":sum(p.material_index==1 for p in mesh.polygons),"pixelSamples":[list(image.pixels[(int(y*image.size[1])*image.size[0]+int(x*image.size[0]))*4:(int(y*image.size[1])*image.size[0]+int(x*image.size[0]))*4+4]) for x,y in [(0.25,0.25),(0.75,0.25),(0.25,0.75),(0.75,0.75)]]})',
    ] : []),
    'print(\'RASTERFORM_INSPECT \'+json.dumps(data,sort_keys=True))',
  ].join(';')
  const { stdout } = await execFileAsync(blenderPath, [
    '--background',
    '--factory-startup',
    '--disable-autoexec',
    fixture.outputPath,
    '--python-exit-code',
    '1',
    '--python-expr',
    expression,
  ], {
    cwd: fixture.root,
    env: isolatedEnvironment(fixture.root),
    maxBuffer: 4 * 1024 * 1024,
    timeout: 30_000,
  })
  const marker = stdout.split(/\r?\n/u).find((line) => line.startsWith('RASTERFORM_INSPECT '))
  if (!marker) throw new Error(`Blender inspection omitted its result:\n${stdout}`)
  return JSON.parse(marker.slice('RASTERFORM_INSPECT '.length)) as Record<string, unknown>
}

afterAll(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })))
})

describe.skipIf(!realBlenderAvailable)('isolated Blender project exporter', () => {
  it.each([
    ['exact', 'matte', 0.88, 0],
    ['balanced', 'glossy', 0.16, 0.02],
    ['lightweight', 'metallic', 0.26, 1],
  ] as const)('packs the full bitmap with preserved source UVs and finish for %s topology', async (topology, finish, roughness, metallic) => {
    const fixture = await createFixture(topology, 'structured-grid', true)
    const { texture, imagePath } = await addBitmap(fixture, finish)
    const { stdout } = await runExporter(fixture)
    expect(statusLines(stdout).some(({ kind }) => kind === 'COMPLETE')).toBe(true)
    // Reopen from a new Blender process after deleting the external image.
    // A dangling path or accidental unpacked texture cannot pass this check.
    await rm(imagePath)
    const inspection = await inspectBlend(fixture, true)
    expect(inspection).toMatchObject({
      objects: 1, meshes: 1, cameras: 0, lights: 0, gridVisible: false, materials: 2,
      packedBytes: texture.data.byteLength,
      packedSha256: createHash('sha256').update(texture.data).digest('hex'),
      imageDimensions: [1536, 1024], imageColorspace: 'sRGB', imageData: true,
      imagePath: '//source.png', uvNode: 'SourceUV', bitmapLinks: true, uvLink: true,
      vertexColorNodes: 0, sideImageNodes: 0, surfaceAssignments: true,
      pixelSamples: [[0, 0, 1, 1], [1, 1, 0, 1], [1, 0, 0, 1], [0, 1, 0, 1]],
    })
    expect(inspection.sourceUVLoops).toBe(inspection.uvLoops)
    expect(inspection.sourceUVError as number).toBeLessThan(1e-6)
    expect(inspection.roughness as number).toBeCloseTo(roughness)
    expect(inspection.metallic as number).toBeCloseTo(metallic)
    expect(inspection.sideRoughness as number).toBeCloseTo(roughness)
    expect(inspection.sideMetallic as number).toBeCloseTo(metallic)
    const sideColor = inspection.sideColor as number[]
    expect(sideColor[0]).toBeCloseTo(sideColor[1]!)
    expect(sideColor[1]).toBeCloseTo(sideColor[2]!)
    expect(inspection.frontFaces as number).toBeGreaterThan(0)
    expect(inspection.sideFaces as number).toBeGreaterThan(0)
    expect(inspection.yMin as number).toBeLessThan(-1.35)
    expect(inspection.uvMin as number).toBeGreaterThanOrEqual(-1e-5)
    expect(inspection.uvMax as number).toBeLessThanOrEqual(1.00001)
    if (topology === 'exact') {
      expect(inspection.vertices).toBe(fixture.vertexCount)
      expect(inspection.faces).toBe(fixture.faceCount)
    } else {
      expect(inspection.faces as number).toBeLessThan(fixture.faceCount)
      expect(inspection.quads).toBe(inspection.faces)
    }
  }, 120_000)

  it.each(['escaping-path', 'wrong-dimensions', 'corrupt-png', 'freeform'] as const)(
    'rejects an invalid textured job (%s) without saving a project', async (kind) => {
      const fixture = await createFixture('exact', kind === 'freeform' ? 'freeform' : 'structured-grid')
      const { texture, imagePath, manifest } = await addBitmap(fixture)
      if (kind === 'escaping-path') manifest.texture.path = '../source.png'
      if (kind === 'wrong-dimensions') manifest.texture.width += 1
      if (kind === 'corrupt-png') {
        texture.data[texture.data.length - 1]! ^= 1
        manifest.texture.sha256 = createHash('sha256').update(texture.data).digest('hex')
        await writeFile(imagePath, texture.data)
      }
      await writeFile(fixture.manifestPath, JSON.stringify(manifest))
      let failure: { code?: number; stdout?: string } | null = null
      try { await runExporter(fixture) } catch (error) { failure = error as { code?: number; stdout?: string } }
      expect(failure?.code).toBe(1)
      const statuses = statusLines(failure?.stdout ?? '')
      expect(statuses.at(-1)?.kind).toBe('ERROR')
      expect(statuses.at(-1)?.payload.message).toMatch(kind === 'freeform' ? /requires an image relief/ : /texture.path|dimensions|checksum/)
      expect(existsSync(fixture.outputPath)).toBe(false)
    }, 30_000,
  )

  it('preserves exact topology and source UVs in a clean, compressed .blend', async () => {
    const fixture = await createFixture('exact')
    const { stdout } = await runExporter(fixture)
    const statuses = statusLines(stdout)
    const progress = statuses.filter(({ kind }) => kind === 'PROGRESS')
    const complete = statuses.find(({ kind }) => kind === 'COMPLETE')?.payload

    expect(progress.map(({ payload }) => payload.phase)).toEqual(['preparing', 'saving'])
    expect(progress.every(({ payload }) => Object.keys(payload).sort().join(',') === 'jobId,phase')).toBe(true)
    expect(complete).toEqual({
      jobId: 'test-exact',
      file: 'outputs/rasterform.blend',
      topology: 'exact',
      sourceVertices: fixture.vertexCount,
      sourceFaces: fixture.faceCount,
      outputVertices: fixture.vertexCount,
      outputFaces: fixture.faceCount,
      outputTriangleCount: fixture.faceCount,
      quads: 0,
      triangles: fixture.faceCount,
      ngons: 0,
      uvLayerName: 'UVMap',
      uvLoops: fixture.indexCount,
      colorAttributeName: 'RasterformColor',
      blenderVersion: '5.2.0 LTS',
      elapsedSeconds: expect.any(Number),
      outputBytes: expect.any(Number),
      outputSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    expect(new Uint8Array(await readFile(fixture.outputPath)).slice(0, 4)).toEqual(
      new Uint8Array([0x28, 0xb5, 0x2f, 0xfd]),
    )
    await expect(inspectBlend(fixture)).resolves.toMatchObject({
      objects: 1,
      meshes: 1,
      cameras: 0,
      lights: 0,
      vertices: fixture.vertexCount,
      faces: fixture.faceCount,
      quads: 0,
      uvLoops: fixture.indexCount,
      colorCount: fixture.vertexCount,
      materials: 1,
      gridVisible: false,
    })
  }, 120_000)

  it('creates a lighter quad-dominant mesh with regenerated UVs and colors', async () => {
    const fixture = await createFixture('balanced')
    const { stdout } = await runExporter(fixture)
    const statuses = statusLines(stdout)
    const progress = statuses.filter(({ kind }) => kind === 'PROGRESS')
    const complete = statuses.find(({ kind }) => kind === 'COMPLETE')?.payload

    expect(progress.map(({ payload }) => payload.phase)).toEqual([
      'preparing',
      'retopologizing',
      'unwrapping',
      'saving',
    ])
    expect(complete).toMatchObject({
      jobId: 'test-balanced',
      file: 'outputs/rasterform.blend',
      topology: 'balanced',
      sourceVertices: fixture.vertexCount,
      sourceFaces: fixture.faceCount,
      uvLayerName: 'UVMap',
      colorAttributeName: 'RasterformColor',
      blenderVersion: '5.2.0 LTS',
      elapsedSeconds: expect.any(Number),
    })
    expect(complete?.outputFaces).toEqual(expect.any(Number))
    expect(complete?.outputFaces as number).toBeLessThan(fixture.faceCount)
    expect(complete?.quads as number).toBeGreaterThan(0)
    expect((complete?.quads as number) / (complete?.outputFaces as number)).toBeGreaterThan(0.9)
    expect(complete?.uvLoops as number).toBeGreaterThan(0)

    const inspection = await inspectBlend(fixture)
    expect(inspection).toMatchObject({
      objects: 1,
      meshes: 1,
      cameras: 0,
      lights: 0,
      materials: 1,
      gridVisible: false,
    })
    expect(inspection.faces as number).toBeLessThan(fixture.faceCount)
    expect(inspection.quads as number).toBeGreaterThan(0)
    expect(inspection.uvLoops as number).toBeGreaterThan(0)
    expect(inspection.colorCount).toBe(inspection.vertices)
  }, 120_000)

  it('resamples a recognized solid relief deterministically and rebuilds its border walls', async () => {
    const fixture = await createFixture('lightweight', 'structured-grid', true)
    const { stdout } = await runExporter(fixture)
    const statuses = statusLines(stdout)
    const complete = statuses.find(({ kind }) => kind === 'COMPLETE')?.payload

    expect(stdout).not.toContain('QuadriFlow:')
    expect(statuses.filter(({ kind }) => kind === 'PROGRESS').map(({ payload }) => payload.phase)).toEqual([
      'preparing',
      'retopologizing',
      'unwrapping',
      'saving',
    ])
    expect(complete).toMatchObject({
      jobId: 'test-grid-lightweight',
      topology: 'lightweight',
      sourceVertices: fixture.vertexCount,
      sourceFaces: fixture.faceCount,
      outputVertices: 126,
      outputFaces: 124,
      outputTriangleCount: 248,
      quads: 124,
      triangles: 0,
      ngons: 0,
      uvLayerName: 'UVMap',
      colorAttributeName: 'RasterformColor',
    })
    // Each output quad draws as two triangles; the preserved side walls add a
    // little overhead to the 25% surface target.
    expect(((complete?.outputFaces as number) * 2) / fixture.faceCount).toBeCloseTo(0.282, 2)

    const inspection = await inspectBlend(fixture)
    expect(inspection).toMatchObject({
      objects: 1,
      meshes: 1,
      cameras: 0,
      lights: 0,
      vertices: 126,
      faces: 124,
      quads: 124,
      colorCount: 126,
      gridVisible: false,
      method: 'structured_grid',
    })
    expect(inspection.xMin as number).toBeCloseTo(-1, 5)
    expect(inspection.xMax as number).toBeCloseTo(1, 5)
    expect(inspection.zMin as number).toBeCloseTo(-0.75, 5)
    expect(inspection.zMax as number).toBeCloseTo(0.75, 5)
    // The spike sits between all uniform lightweight sample coordinates. The
    // feature-aware rebuild must still preserve it on the visible surface.
    expect(inspection.yMin as number).toBeLessThan(-1.35)
    expect(inspection.uvMin as number).toBeGreaterThanOrEqual(-1e-5)
    expect(inspection.uvMax as number).toBeLessThanOrEqual(1.00001)
  }, 120_000)

  it('rejects an output path that escapes the private job', async () => {
    const fixture = await createFixture('exact')
    const escapeName = `${basename(fixture.root)}-escape.blend`
    const escapePath = join(fixture.root, '..', escapeName)
    const manifest = JSON.parse(await readFile(fixture.manifestPath, 'utf8')) as Record<string, unknown>
    manifest.output = `../${escapeName}`
    await writeFile(fixture.manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 })

    let failure: { code?: number; stdout?: string } | null = null
    try {
      await runExporter(fixture)
    } catch (error) {
      failure = error as { code?: number; stdout?: string }
    }
    expect(failure?.code).toBe(1)
    const statuses = statusLines(failure?.stdout ?? '')
    expect(statuses).toHaveLength(1)
    expect(statuses[0]).toEqual({
      kind: 'ERROR',
      payload: {
        message: 'output escapes the export job directory.',
        type: 'ManifestError',
      },
    })
    expect(existsSync(escapePath)).toBe(false)
    await rm(escapePath, { force: true })
  }, 30_000)
})
