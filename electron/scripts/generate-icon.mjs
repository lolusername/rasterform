import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsDirectory = dirname(fileURLToPath(import.meta.url))
const electronRoot = join(scriptsDirectory, '..')
const repositoryRoot = join(electronRoot, '..')
const sourceSvg = join(repositoryRoot, 'public', 'favicon.svg')
const outputIcon = join(electronRoot, 'assets', 'Rasterform.icns')

// PNG-backed ICNS chunks supported by every macOS version Rasterform targets.
// Retina chunks intentionally repeat the matching pixel-size PNG with a
// density-specific type, as specified by the ICNS container format.
const iconChunks = [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
  ['ic11', 32],
  ['ic12', 64],
  ['ic13', 256],
  ['ic14', 512],
]

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.once('error', (error) => {
      reject(new Error(
        `${command} could not run. Install librsvg to regenerate the committed icon. ${error.message}`,
      ))
    })
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with ${code}: ${stderr.trim()}`))
    })
  })
}

function icnsChunk(type, png) {
  const header = Buffer.alloc(8)
  header.write(type, 0, 4, 'ascii')
  header.writeUInt32BE(header.byteLength + png.byteLength, 4)
  return Buffer.concat([header, png])
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'rasterform-icon-'))
try {
  const pngs = new Map()
  for (const size of new Set(iconChunks.map(([, chunkSize]) => chunkSize))) {
    const pngPath = join(temporaryDirectory, `${size}.png`)
    await run('rsvg-convert', [
      '--width', String(size),
      '--height', String(size),
      '--output', pngPath,
      sourceSvg,
    ])
    pngs.set(size, await readFile(pngPath))
  }

  const chunks = iconChunks.map(([type, size]) => icnsChunk(type, pngs.get(size)))
  const containerSize = 8 + chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const containerHeader = Buffer.alloc(8)
  containerHeader.write('icns', 0, 4, 'ascii')
  containerHeader.writeUInt32BE(containerSize, 4)

  await mkdir(dirname(outputIcon), { recursive: true })
  await writeFile(outputIcon, Buffer.concat([containerHeader, ...chunks], containerSize))
  console.log(`Generated ${outputIcon} from ${sourceSvg}`)
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true })
}
