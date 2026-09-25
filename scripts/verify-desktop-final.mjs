/**
 * Actual staged native Final renderer and PNG artifact verification.
 * Run after the desktop build with PLAYWRIGHT_MODULE available. Only native
 * dialog destinations/Finder reveal use the isolated fixture launcher; main,
 * preload, snapshot transport, path tracing, denoising, and file writes are real.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const repository = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(import.meta.url)
const { _electron } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const directory = await mkdtemp(join(tmpdir(), 'rasterform-native-final-qa-'))
const stage = join(directory, 'stage')
await cp(join(repository, 'electron/.stage'), stage, { recursive: true })
const fileName = 'final-photo-2k-transparent.png'
const artifact = join(directory, fileName)
const environment = {
  ...process.env,
  RASTERFORM_PROJECT_QA_DIR: directory,
  RASTERFORM_PROJECT_QA_STAGE: stage,
}
delete environment.ELECTRON_RUN_AS_NODE
delete environment.RASTERFORM_DESKTOP_SMOKE
delete environment.NODE_OPTIONS
console.log(`Native Final QA artifacts: ${directory}`)
const application = await _electron.launch({
  executablePath: require(join(repository, 'electron/node_modules/electron')),
  args: [join(repository, 'electron/scripts/project-files-harness.cjs')],
  env: environment,
})
console.log(`Native Final QA process: ${application.process().pid}`)
let finished = false

try {
  const page = await application.firstWindow()
  page.setDefaultTimeout(20_000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.locator('.three-preview').waitFor()
  await application.evaluate(({ BrowserWindow }) => {
    globalThis.rasterformProjectQa.saveName = 'final-photo-2k-transparent.png'
    BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('rasterform://app/')).setSize(1100, 620)
  })
  await page.evaluate(() => {
    window.rasterformFinalQa = { lastEvent: null, lastEventAt: Date.now(), terminal: null, progressEvents: 0 }
    window.rasterformDesktop.onFinalRenderEvent(event => {
      window.rasterformFinalQa.lastEvent = event
      window.rasterformFinalQa.lastEventAt = Date.now()
      if (event.type === 'progress') window.rasterformFinalQa.progressEvents++
      else window.rasterformFinalQa.terminal = event
    })
  })
  assert.equal(await page.getByRole('button', { name: 'Photo', exact: true }).getAttribute('aria-pressed'), 'true')
  await page.locator('.top-export').click()
  await page.getByRole('button', { name: '2K', exact: true }).click()
  await page.getByRole('button', { name: 'Final Refined light', exact: true }).click()
  await page.getByRole('button', { name: 'Transparent', exact: true }).click()
  assert.match(await page.locator('#export-inspector .inline-note').allTextContents().then(notes => notes.join(' ')), /6144 samples/)
  await page.locator('#export-inspector .render-button').click()
  await page.locator('.render-job').waitFor()
  const captured = await page.locator('.render-job').evaluate(element => ({
    thumbnail: element.querySelector('img')?.src,
    summary: element.querySelector('small')?.textContent,
  }))
  assert.ok(captured.thumbnail?.startsWith('data:image/png;base64,'), 'Captured job thumbnail is missing')
  assert.match(captured.summary, /Final.*2,048 × 1,536.*transparent/)

  // Edit a visibly different current design after the real render starts.
  // The resulting artifact must still depict the originally captured Photo.
  await page.locator('.top-export').click()
  await page.getByRole('button', { name: 'Clay', exact: true }).click()
  const depth = page.getByRole('spinbutton', { name: 'Depth value', exact: true })
  await depth.fill('0.12')
  await depth.press('Tab')
  await page.locator('#style-inspector input[type="color"]').evaluate(input => {
    input.value = '#ff0000'
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  assert.equal(await depth.inputValue(), '0.12')
  assert.equal(await page.getByRole('button', { name: 'Clay', exact: true }).getAttribute('aria-pressed'), 'true')
  assert.deepEqual(await page.locator('.render-job').evaluate(element => ({
    thumbnail: element.querySelector('img')?.src,
    summary: element.querySelector('small')?.textContent,
  })), captured, 'Current edits must not rewrite the captured job identity')
  await page.locator('#style-inspector').evaluate(element => { element.scrollTop = 0 })
  const bounds = await page.evaluate(() => {
    const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON()
    return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight, stage: rect('.three-stage'),
      canvas: rect('.three-preview'), job: rect('.render-job') }
  })
  for (const element of [bounds.stage, bounds.canvas, bounds.job]) {
    assert.ok(element.width > 0 && element.height > 0)
    assert.ok(element.left >= -1 && element.top >= -1 && element.right <= bounds.width + 1 && element.bottom <= bounds.height + 1, 'Native render UI exceeds the short window')
  }
  assert.ok(bounds.documentWidth <= bounds.width + 1 && bounds.documentHeight <= bounds.height + 1)
  await page.screenshot({ path: join(directory, 'native-final-job-current-red-clay.png') })
  console.log('Captured real Final Photo job; current editor is now shallow red Clay. Thumbnail/summary unchanged, short native viewport bounded.')

  const started = Date.now()
  let lastReport = 0
  let terminal
  while (!terminal) {
    const state = await page.evaluate(() => window.rasterformFinalQa)
    terminal = state.terminal
    if (Date.now() - lastReport >= 20_000 || terminal) {
      console.log(`Native Final +${Math.round((Date.now() - started) / 1000)}s: ${JSON.stringify(state.lastEvent)}`)
      lastReport = Date.now()
    }
    // No total render deadline: continued progress always gets more time.
    assert.ok(Date.now() - state.lastEventAt < 10 * 60_000, 'Native Final emitted no event for ten minutes')
    if (!terminal) await new Promise(resolve => setTimeout(resolve, 5_000))
  }
  assert.equal(terminal.type, 'saved', JSON.stringify(terminal))
  assert.deepEqual(terminal.result, { fileName, width: 2048, height: 1536, dpi: 300, samples: 6144, tiles: 4 })
  const bytes = await readFile(artifact)
  assert.equal(bytes.toString('hex', 0, 8), '89504e470d0a1a0a')
  assert.equal(bytes.readUInt32BE(16), 2048)
  assert.equal(bytes.readUInt32BE(20), 1536)
  const pixels = await application.evaluate(({ nativeImage }, filePath) => {
    const image = nativeImage.createFromPath(filePath)
    const data = image.toBitmap()
    let transparent = 0, opaque = 0, partial = 0, colored = 0
    const dominantChannels = [0, 0, 0]
    for (let offset = 0; offset < data.length; offset += 4) {
      const alpha = data[offset + 3]
      if (alpha === 0) transparent++
      else if (alpha === 255) opaque++
      else partial++
      if (alpha < 128) continue
      const channels = [data[offset], data[offset + 1], data[offset + 2]]
      const maximum = Math.max(...channels), minimum = Math.min(...channels)
      if (maximum - minimum > 25) {
        colored++
        dominantChannels[channels.indexOf(maximum)]++
      }
    }
    const center = ((Math.floor(image.getSize().height / 2) * image.getSize().width) + Math.floor(image.getSize().width / 2)) * 4
    return { size: image.getSize(), transparent, opaque, partial, colored, dominantChannels,
      cornerAlpha: data[3], centerAlpha: data[center + 3] }
  }, artifact)
  assert.equal(pixels.cornerAlpha, 0)
  assert.ok(pixels.transparent > 100_000 && pixels.opaque > 100_000 && pixels.colored > 10_000, 'PNG must contain substantial transparent background and rendered colored content')
  assert.ok(pixels.dominantChannels.filter(count => count > 10_000).length >= 2, 'Export must retain the multicolor Photo snapshot, not the current solid red Clay')
  assert.deepEqual(errors, [], 'Editor emitted an uncaught error during the background render')
  const result = { artifact, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    metadata: terminal.result, pixels, bounds,
    capturedThumbnailSha256: createHash('sha256').update(captured.thumbnail).digest('hex'),
    snapshotEdit: { capturedMode: 'Photo', currentMode: 'Clay', currentClay: '#ff0000', currentDepth: 0.12 },
    elapsedSeconds: Math.round((Date.now() - started) / 1000) }
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2))
  console.log(`PASS native full-quality Final: ${JSON.stringify(result)}`)
  finished = true
} finally {
  if (!finished) {
    // Only this isolated QA app is owned by this process. Ask its real bridge
    // to cancel before closing, so a failed assertion cannot strand a render.
    const page = application.windows().find(candidate => candidate.url().startsWith('rasterform://app/'))
    await page?.evaluate(async () => {
      const jobId = window.rasterformFinalQa?.lastEvent?.jobId
      if (jobId) await window.rasterformDesktop.cancelFinalRender(jobId)
    }).catch(() => undefined)
  }
  await application.close()
}
