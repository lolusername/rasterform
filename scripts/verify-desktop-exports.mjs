// Build with npm run desktop:build first. PLAYWRIGHT_MODULE can supply Playwright.
// Uses the real staged app and native downloads with temporary dialog destinations.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cp, mkdtemp, readFile, copyFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(import.meta.url)
const { _electron } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const directory = await mkdtemp(join(tmpdir(), 'rasterform-native-export-qa-'))
const stage = join(directory, 'stage')
await cp(join(repository, 'electron/.stage'), stage, { recursive: true })
const environment = { ...process.env, RASTERFORM_PROJECT_QA_DIR: directory, RASTERFORM_PROJECT_QA_STAGE: stage }
delete environment.ELECTRON_RUN_AS_NODE
delete environment.RASTERFORM_DESKTOP_SMOKE
delete environment.NODE_OPTIONS

// Decode saved GLB accessors independently of the Three.js encoder.
function readGlb(bytes) {
  assert.equal(bytes.readUInt32LE(0), 0x46546c67)
  assert.equal(bytes.readUInt32LE(4), 2)
  assert.equal(bytes.readUInt32LE(8), bytes.length)
  const jsonLength = bytes.readUInt32LE(12)
  const document = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength))
  function values(index, components) {
    const accessor = document.accessors[index]
    const view = document.bufferViews[accessor.bufferView]
    const offset = 28 + jsonLength + (accessor.byteOffset ?? 0) + (view.byteOffset ?? 0)
    const readers = { 5121: ['readUInt8', 1], 5123: ['readUInt16LE', 2], 5125: ['readUInt32LE', 4], 5126: ['readFloatLE', 4] }
    const [read, size] = readers[accessor.componentType]
    const stride = view.byteStride ?? size * components
    return Array.from({ length: accessor.count }, (_, vertex) =>
      Array.from({ length: components }, (_, component) => bytes[read](offset + vertex * stride + component * size)))
  }
  const primitive = document.meshes[0].primitives[0]
  const positions = values(primitive.attributes.POSITION, 3)
  const indices = primitive.indices === undefined
    ? positions.map((_, index) => index)
    : values(primitive.indices, 1).flat()
  return { primitive, positions, indices, values }
}

const application = await _electron.launch({
  executablePath: require(join(repository, 'electron/node_modules/electron')),
  args: [join(repository, 'electron/scripts/project-files-harness.cjs')], env: environment,
})
try {
  const page = await application.firstWindow()
  page.setDefaultTimeout(25_000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.locator('.three-preview').waitFor()
  const button = name => page.getByRole('button', { name, exact: typeof name === 'string' })

  async function importImage(name, width, height, gradient = false) {
    const base64 = await page.evaluate(({ width, height, gradient }) => {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      let fill = '#808080'
      if (gradient) {
        fill = context.createLinearGradient(0, 0, width, 0)
        fill.addColorStop(0, 'black')
        fill.addColorStop(1, 'white')
      }
      context.fillStyle = fill
      context.fillRect(0, 0, width, height)
      return canvas.toDataURL('image/png').split(',')[1]
    }, { width, height, gradient })
    await page.locator('input[accept*="image/png"]').setInputFiles({ name, mimeType: 'image/png', buffer: Buffer.from(base64, 'base64') })
    await page.locator('.source-card strong').filter({ hasText: name }).waitFor()
  }

  async function downloadGlb(expectedCount, savedName) {
    await button('Portable model (.glb)').click()
    for (let attempt = 0; attempt < 150; attempt++) {
      const count = await application.evaluate(() => globalThis.rasterformProjectQa.downloads
        .filter(item => item.status === 'completed' && item.name.endsWith('.glb')).length)
      if (count >= expectedCount) {
        const path = join(directory, 'rasterform.glb')
        await copyFile(path, join(directory, savedName))
        return readGlb(await readFile(path))
      }
      await page.waitForTimeout(100)
    }
    assert.fail('Native GLB download did not finish')
  }

  await importImage('middle-gray.png', 32, 32)
  await page.getByRole('group', { name: 'Geometry mode' }).getByRole('button', { name: /Raised relief/ }).click()
  await page.locator('.top-export').click()
  await button(/^Current appearance/).click()
  const photo = await downloadGlb(1, 'photo.glb')
  for (const color of photo.values(photo.primitive.attributes.COLOR_0, 3)) {
    for (const channel of color) assert.ok(Math.abs(channel - 0.2158605) < 1e-6)
  }

  await button('Wireframe').click()
  const wire = await downloadGlb(2, 'wire.glb')
  assert.equal(wire.primitive.mode, 1)
  const edgeKey = (a, b) => [a.join(','), b.join(',')].sort().join('|')
  const expected = new Set()
  for (let offset = 0; offset < photo.indices.length; offset += 3) {
    const [a, b, c] = photo.indices.slice(offset, offset + 3).map(index => photo.positions[index])
    expected.add(edgeKey(a, b))
    expected.add(edgeKey(b, c))
    expected.add(edgeKey(c, a))
  }
  const actual = new Set()
  for (let offset = 0; offset < wire.indices.length; offset += 2) {
    const a = wire.positions[wire.indices[offset]]
    const b = wire.positions[wire.indices[offset + 1]]
    assert.notDeepEqual(a, b, 'Wireframe exported a collapsed segment')
    actual.add(edgeKey(a, b))
  }
  assert.deepEqual(actual, expected, 'Saved wireframe must retain all triangle edges')
  console.log(`PASS: native GLBs preserve linear mid-gray and all ${expected.size} wireframe edges`)

  await page.locator('.top-export').click()
  await button('Photo').click()
  await importImage('ramp.png', 256, 4, true)
  await page.getByRole('group', { name: 'Geometry mode' }).getByRole('button', { name: /Strata/ }).click()
  const living = page.locator('summary').filter({ hasText: 'Living Form' })
  if (!(await living.locator('..').evaluate(element => element.open))) await living.click()
  await page.getByRole('checkbox', { name: 'Enable kinetic form' }).check()
  await button('Expand').click()
  await page.locator('.top-export').click()
  await button(/^Living loop/i).click()
  await button('2K').click()
  await button('12 fps').click()
  const duration = page.getByRole('spinbutton', { name: 'Living Loop duration value' })
  await duration.fill('1')
  await duration.press('Tab')
  await button('Export lossless loop ZIP').click()
  await page.locator('#export-inspector .export-message').filter({ hasText: 'Living Form ZIP saved' }).waitFor({ timeout: 95_000 })
  const zipName = 'rasterform-living-expand-2048x32-12fps-transparent.zip'
  const downloads = await application.evaluate(() => globalThis.rasterformProjectQa.downloads)
  assert.ok(downloads.some(item => item.name === zipName && item.status === 'completed'))
  const zipPath = join(directory, zipName)
  execFileSync('unzip', ['-t', zipPath])
  const manifest = JSON.parse(execFileSync('unzip', ['-p', zipPath, 'manifest.json'], { encoding: 'utf8' }))
  assert.equal(manifest.timing.frameCount, 12)
  assert.equal(manifest.livingForm.behavior, 'expand')
  const entries = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' }).trim().split('\n')
  assert.equal(entries.filter(name => name.startsWith('frames/') && name.endsWith('.png')).length, 12)
  assert.deepEqual(errors, [])
  console.log(`PASS: Expand reports a saved ZIP with 12 CRC-checked frames. Artifacts: ${directory}`)
} finally {
  await application.close()
}
