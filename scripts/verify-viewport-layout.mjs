/**
 * Browser regression for the visible editor, not the offscreen export buffer.
 * Start the app, then run with Playwright available:
 *   TEST_URL=http://127.0.0.1:5178 node scripts/verify-viewport-layout.mjs
 * PLAYWRIGHT_MODULE may point to an existing Playwright ESM installation.
 * Uses fresh browser contexts for web and a desktop-capability fixture. Desktop
 * render-job events are simulated through the actual renderer bridge contract;
 * this verifies UI containment, NOT native rendering, quality, or file saving.
 * No existing app data or output settings are touched by this check.
 * QA_ARTIFACTS optionally selects a screenshot/report directory.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser = await chromium.launch({ headless: true })
const failures = []
const artifacts = process.env.QA_ARTIFACTS || await mkdtemp(join(tmpdir(), 'rasterform-viewport-qa-'))
await mkdir(artifacts, { recursive: true })
const results = []
const sizes = [
  [1600, 1000], [1280, 800], [1024, 620], [901, 600], [900, 600],
  [768, 1024], [600, 600], [390, 844], [320, 568], [844, 390],
  [600, 320], [1024, 320], [1440, 240],
]
let checks = 0

// The real UI receives protocol-valid preparation/progress/cancel events. No
// Electron processes, Blender instances, or expensive render jobs are started.
function installDesktopFixture() {
  const listeners = new Set()
  const jobId = 'viewport_fixture_final'
  const fixture = {
    snapshot: null,
    emit(phase) {
      for (const listener of listeners) listener({
        type: 'progress', jobId,
        progress: {
          phase, progress: phase === 'finishing' ? 1 : 0.5,
          tile: 1, tiles: 1,
          samples: phase === 'preparing' ? 0 : 3072,
          targetSamples: 6144,
        },
      })
    },
  }
  window.__viewportQa = fixture
  window.rasterformDesktop = {
    protocolVersion: 1,
    prepareFinalSave: async () => ({ cancelled: false, jobId }),
    submitFinalRender: async (_jobId, snapshot) => {
      fixture.snapshot = {
        width: snapshot.width, height: snapshot.height,
        camera: snapshot.camera, colorMode: snapshot.colorMode,
      }
      fixture.emit('preparing')
      return { accepted: true }
    },
    cancelFinalRender: async () => ({ state: 'cancelled' }),
    onFinalRenderEvent: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

async function checkEdition(desktop) {
  const edition = desktop ? 'desktop-fixture' : 'web'
  const context = await browser.newContext({ reducedMotion: 'reduce' })
  if (desktop) await context.addInitScript(installDesktopFixture)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.setDefaultTimeout(15_000)
  try {
  await page.goto(process.env.TEST_URL || 'http://127.0.0.1:5173')
  await page.locator('.three-preview').waitFor()
  const keepVersion = page.getByRole('button', { name: 'Keep version', exact: true })
  const hasComparison = await keepVersion.count() > 0
  if (hasComparison) await keepVersion.click()

  async function settle() {
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  }

  async function checkBounds(label) {
    await settle()
    const state = await page.evaluate(() => {
      const bounds = (selector) => {
        const element = document.querySelector(selector)
        if (!element) throw new Error(`Missing ${selector}`)
        const rect = element.getBoundingClientRect()
        return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, height: rect.height }
      }
      return {
        width: innerWidth, height: innerHeight,
        shell: bounds('.editor-app'), stage: bounds('.three-stage'),
        canvas: bounds('.three-preview'), header: bounds('.app-bar'),
        status: bounds('.status-bar'),
        documentWidth: document.documentElement.scrollWidth,
        documentHeight: document.documentElement.scrollHeight,
        bufferWidth: document.querySelector('.three-preview').width,
        bufferHeight: document.querySelector('.three-preview').height,
      }
    })
    const tolerance = 1
    for (const key of ['shell', 'stage', 'canvas', 'header', 'status']) {
      const rect = state[key]
      assert.ok(rect.width > 0 && rect.height > 0, `${label}: ${key} must have visible dimensions`)
      assert.ok(rect.left >= -tolerance && rect.right <= state.width + tolerance, `${label}: ${key} exceeds screen width: ${JSON.stringify(state)}`)
      assert.ok(rect.top >= -tolerance && rect.bottom <= state.height + tolerance, `${label}: ${key} exceeds screen height: ${JSON.stringify(state)}`)
    }
    assert.ok(state.canvas.left >= state.stage.left - tolerance && state.canvas.right <= state.stage.right + tolerance, `${label}: canvas exceeds stage width`)
    assert.ok(state.canvas.top >= state.stage.top - tolerance && state.canvas.bottom <= state.stage.bottom + tolerance, `${label}: canvas exceeds stage height`)
    assert.ok(state.documentWidth <= state.width + tolerance, `${label}: document scrolls horizontally`)
    assert.ok(state.documentHeight <= state.height + tolerance, `${label}: document scrolls vertically`)
    // CSS containment alone can hide an unnecessarily huge preview allocation.
    const devicePixelRatio = await page.evaluate(() => window.devicePixelRatio)
    assert.ok(state.bufferWidth <= Math.ceil(state.canvas.width * devicePixelRatio) + 1, `${label}: preview buffer follows output dimensions instead of its on-screen frame`)
    assert.ok(state.bufferHeight <= Math.ceil(state.canvas.height * devicePixelRatio) + 1, `${label}: preview buffer exceeds the on-screen frame`)
    checks += 1
    results.push({ edition, label, ...state })
    return state.stage
  }

  async function checkInspectorScroll(label) {
    const before = await checkBounds(label)
    const panels = await page.locator('.editor-panel:visible').all()
    assert.ok(panels.length > 0, `${label}: no inspector is available`)
    for (const panel of panels) {
      const scrolled = await panel.evaluate((element) => {
        element.scrollTop = element.scrollHeight
        return {
          top: element.scrollTop, needed: element.scrollHeight > element.clientHeight + 1,
          horizontalOverflow: element.scrollWidth > element.clientWidth + 1,
        }
      })
      assert.ok(!scrolled.needed || scrolled.top > 0, `${label}: inspector content cannot scroll`)
      assert.ok(!scrolled.horizontalOverflow, `${label}: inspector content overflows horizontally`)
      await panel.evaluate((element) => { element.scrollTop = 0 })
    }
    const after = await checkBounds(`${label} after inspector scroll`)
    assert.deepEqual(after, before, `${label}: scrolling controls moved or resized the viewport`)
  }

  for (const [width, height] of sizes) {
    const sizeLabel = `${edition} ${width}×${height}`
    try {
      await page.setViewportSize({ width, height })
      await checkInspectorScroll(`${sizeLabel} editing`)
      if (width <= 900) {
        await page.locator('.compact-panel-tabs button').nth(1).click()
        assert.ok(await page.locator('.style-panel').isVisible(), `${sizeLabel}: Properties panel is not reachable`)
        await checkInspectorScroll(`${sizeLabel} properties`)
      }
      await page.getByRole('button', { name: 'Export', exact: true }).first().click()
      await checkInspectorScroll(`${sizeLabel} exporting`)
      assert.equal(await page.getByRole('button', { name: '4K', exact: true }).count(), desktop ? 1 : 0, `${sizeLabel}: incorrect edition-specific 4K availability`)
      assert.equal(await page.getByRole('button', { name: /Portable model \(\.glb\)/ }).count(), desktop ? 1 : 0, `${sizeLabel}: incorrect edition-specific model export availability`)
      if (desktop) {
        const twoK = await page.locator('.three-preview').boundingBox()
        await page.getByRole('button', { name: '4K', exact: true }).click()
        await checkBounds(`${sizeLabel} 4K output`)
        assert.deepEqual(await page.locator('.three-preview').boundingBox(), twoK, `${sizeLabel}: 4K changed visible canvas size`)
        await page.getByRole('button', { name: '8K', exact: true }).click()
        await checkBounds(`${sizeLabel} 8K High output`)
        assert.deepEqual(await page.locator('.three-preview').boundingBox(), twoK, `${sizeLabel}: 8K changed visible canvas size`)
        await page.getByRole('button', { name: '2K', exact: true }).click()
      }
      if ((width === 1600 && height === 1000) || (width === 1440 && height === 240) || width === 320) {
        await page.screenshot({ path: join(artifacts, `${edition}-${width}x${height}-export.png`) })
      }
      const straightOn = page.getByRole('button', { name: /Straight on/ })
      if (await straightOn.count()) {
        await straightOn.click()
        await checkBounds(`${sizeLabel} straight-on output`)
        await page.getByRole('button', { name: /Current view/ }).click()
      }
      await page.getByRole('button', { name: 'Back to edit', exact: true }).click()
      if (width <= 900) {
        await page.locator('.compact-panel-tabs button').first().click()
        assert.ok(await page.locator('.build-panel').isVisible(), `${sizeLabel}: Build panel is not reachable`)
      }
      await checkBounds(`${sizeLabel} return to edit`)
      if (hasComparison) {
        await page.getByRole('button', { name: 'Compare', exact: true }).first().click()
        await checkBounds(`${sizeLabel} kept-version comparison`)
        const overlayInside = await page.locator('.comparison-toolbar').evaluate((element) => {
          const overlay = element.getBoundingClientRect()
          const stage = document.querySelector('.three-stage').getBoundingClientRect()
          return overlay.left >= stage.left && overlay.right <= stage.right
            && overlay.top >= stage.top && overlay.bottom <= stage.bottom
        })
        assert.ok(overlayInside, `${sizeLabel}: comparison controls exceed the viewport`)
        await page.getByRole('button', { name: 'Back to current', exact: true }).click()
      }
      console.log(`${sizeLabel}: editing and export fit; inspectors remain reachable`)
    } catch (error) {
      failures.push(`${sizeLabel}: ${error instanceof Error ? error.message : String(error)}`)
      console.error(failures.at(-1))
      // Recover the next iteration's mode after a failed assertion.
      const back = page.getByRole('button', { name: 'Back to edit', exact: true })
      if (await back.count()) await back.click().catch(() => {})
    }
  }

  // A real uploaded PNG exercises the portrait working raster and original-size
  // export dimensions. It is generated only in this fresh browser context.
  await page.setViewportSize({ width: 1280, height: 800 })
  const portraitData = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 3072
    canvas.height = 4096
    const context = canvas.getContext('2d')
    const gradient = context.createLinearGradient(0, 0, 3072, 4096)
    gradient.addColorStop(0, '#c5a2e8')
    gradient.addColorStop(1, '#48722c')
    context.fillStyle = gradient
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = '#f0b9da'
    context.beginPath()
    context.arc(1400, 1900, 650, 0, Math.PI * 2)
    context.fill()
    return canvas.toDataURL('image/png').split(',')[1]
  })
  await page.locator('input[type="file"][accept*="image/png"]').setInputFiles({
    name: 'viewport-portrait-3072x4096.png', mimeType: 'image/png',
    buffer: Buffer.from(portraitData, 'base64'),
  })
  await page.locator('.source-card strong').filter({ hasText: 'viewport-portrait-3072x4096.png' }).waitFor()
  await page.getByRole('button', { name: 'Export', exact: true }).first().click()
  await page.getByRole('button', { name: /Straight on/ }).click()
  const dimensions = await page.locator('.source-dimensions strong').innerText()
  assert.equal(dimensions.replace(/,/g, ''), desktop ? '3072 × 4096 px' : '1536 × 2048 px', `${edition}: portrait output dimensions changed`)
  for (const [width, height] of [[1280, 800], [768, 1024], [390, 844], [1440, 240]]) {
    await page.setViewportSize({ width, height })
    await checkInspectorScroll(`${edition} ${width}×${height} portrait straight-on`)
    const frame = await page.locator('.three-preview').boundingBox()
    assert.ok(Math.abs(frame.width / frame.height - 0.75) < 0.01, `${edition}: portrait composition ratio is not preserved`)
    await page.screenshot({ path: join(artifacts, `${edition}-${width}x${height}-portrait.png`) })
  }

  if (desktop) {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.getByRole('button', { name: 'Final Refined light', exact: true }).click()
    await page.locator('#export-inspector .render-button').click()
    await page.waitForFunction(() => Boolean(window.__viewportQa.snapshot))
    const captured = await page.evaluate(() => window.__viewportQa.snapshot)
    assert.deepEqual({ width: captured.width, height: captured.height }, { width: 3072, height: 4096 }, 'Fixture received incorrect portrait Final request')
    for (const phase of ['preparing', 'rendering', 'finishing']) {
      await page.evaluate((phase) => window.__viewportQa.emit(phase), phase)
      for (const [width, height] of [[1280, 800], [390, 844], [1440, 240]]) {
        await page.setViewportSize({ width, height })
        await page.locator('.render-job').waitFor()
        await checkInspectorScroll(`${edition} ${width}×${height} ${phase} job in Export`)
        await page.getByRole('button', { name: 'Back to edit', exact: true }).click()
        if (width <= 900) await page.locator('.compact-panel-tabs button').nth(1).click()
        await page.locator('.render-job').waitFor()
        await checkInspectorScroll(`${edition} ${width}×${height} ${phase} job in Edit`)
        if (phase === 'rendering') await page.screenshot({ path: join(artifacts, `${edition}-${width}x${height}-render-job.png`) })
        await page.getByRole('button', { name: 'Export', exact: true }).first().click()
      }
    }
    await page.getByRole('button', { name: 'Cancel render', exact: true }).click()
    await page.locator('.render-job').waitFor({ state: 'detached' })
    await checkBounds(`${edition} after fixture cancellation`)
    console.log('Desktop bridge fixture: 4K portrait job card fits through preparation, rendering, finishing, Edit/Export switching, and cancellation. No rendering or native saving was performed.')
  }
  assert.deepEqual(errors, [], `${edition}: uncaught browser exceptions`)
  } finally {
    await context.close()
  }
}

try {
  for (const desktop of [false, true]) {
    try { await checkEdition(desktop) }
    catch (error) {
      const message = `${desktop ? 'desktop-fixture' : 'web'}: ${error instanceof Error ? error.stack : String(error)}`
      failures.push(message)
      console.error(message)
    }
  }
  assert.deepEqual(failures, [], failures.join('\n'))
  console.log(`Viewport containment passed: ${checks} checks; ${sizes.length} window sizes in both web and desktop fixture; real portrait upload, edition-specific output sizes, inspector scrolling, comparison, and simulated job states. Artifacts: ${artifacts}`)
} finally {
  await writeFile(join(artifacts, 'viewport-results.json'), JSON.stringify({ checks, failures, results }, null, 2))
  await browser.close()
}
