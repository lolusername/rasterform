/**
 * Complements verify-viewport-layout.mjs with Text, Living Loop, and DPR 2.
 * TEST_URL=http://127.0.0.1:5197 PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
 *   node scripts/verify-viewport-additional.mjs
 * Desktop capability discovery is a fixture; no native/render jobs are run.
 * Fresh contexts isolate all app/session state. QA_ARTIFACTS retains evidence.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser = await chromium.launch({ headless: true })
const artifacts = process.env.QA_ARTIFACTS || await mkdtemp(join(tmpdir(), 'rasterform-viewport-additional-'))
await mkdir(artifacts, { recursive: true })
const results = []
const failures = []

function installDesktopCapabilityFixture() {
  window.rasterformDesktop = {
    protocolVersion: 1,
    prepareFinalSave: async () => ({ cancelled: true }),
    submitFinalRender: async () => { throw new Error('Layout QA must not render') },
    cancelFinalRender: async () => ({ state: 'cancelled' }),
    onFinalRenderEvent: () => () => {},
  }
}

async function runCase(desktop, dpr) {
  const edition = desktop ? 'desktop-fixture' : 'web'
  const context = await browser.newContext({ reducedMotion: 'reduce', deviceScaleFactor: dpr })
  if (desktop) await context.addInitScript(installDesktopCapabilityFixture)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.setDefaultTimeout(15_000)
  const sizes = dpr === 2 ? [[390, 844], [844, 390]] : [[1280, 800], [390, 844], [1440, 240]]

  async function bounds(label) {
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const state = await page.evaluate(() => {
      const rect = (selector) => document.querySelector(selector).getBoundingClientRect().toJSON()
      const canvas = document.querySelector('.three-preview')
      return {
        width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
        documentWidth: document.documentElement.scrollWidth,
        documentHeight: document.documentElement.scrollHeight,
        shell: rect('.editor-app'), stage: rect('.three-stage'), canvas: rect('.three-preview'),
        bufferWidth: canvas.width, bufferHeight: canvas.height,
      }
    })
    for (const key of ['shell', 'stage', 'canvas']) {
      const rect = state[key]
      assert.ok(rect.width > 0 && rect.height > 0, `${label}: ${key} disappeared`)
      assert.ok(rect.left >= -1 && rect.right <= state.width + 1, `${label}: ${key} exceeds width`)
      assert.ok(rect.top >= -1 && rect.bottom <= state.height + 1, `${label}: ${key} exceeds height`)
    }
    assert.ok(state.canvas.left >= state.stage.left - 1 && state.canvas.right <= state.stage.right + 1, `${label}: canvas exceeds stage width`)
    assert.ok(state.canvas.top >= state.stage.top - 1 && state.canvas.bottom <= state.stage.bottom + 1, `${label}: canvas exceeds stage height`)
    assert.ok(state.documentWidth <= state.width + 1 && state.documentHeight <= state.height + 1, `${label}: document overflow`)
    assert.ok(state.bufferWidth <= Math.ceil(state.canvas.width * dpr) + 1, `${label}: drawing buffer exceeds display scale`)
    assert.ok(state.bufferHeight <= Math.ceil(state.canvas.height * dpr) + 1, `${label}: drawing buffer exceeds display scale`)
    assert.equal(state.dpr, dpr)
    results.push({ edition, label, ...state })
    return state.stage
  }

  async function scrollCheck(label) {
    const before = await bounds(label)
    const panels = await page.locator('.editor-panel:visible').all()
    assert.ok(panels.length > 0, `${label}: no reachable inspector`)
    for (const panel of panels) {
      const state = await panel.evaluate((element) => {
        element.scrollTop = element.scrollHeight
        return {
          top: element.scrollTop,
          overflow: element.scrollHeight > element.clientHeight + 1,
          horizontal: element.scrollWidth > element.clientWidth + 1,
        }
      })
      assert.ok(!state.overflow || state.top > 0, `${label}: inspector cannot scroll`)
      assert.equal(state.horizontal, false, `${label}: inspector horizontal overflow`)
      await panel.evaluate((element) => { element.scrollTop = 0 })
    }
    assert.deepEqual(await bounds(`${label} after scrolling`), before, `${label}: scrolling moved preview`)
  }

  async function properties(width) {
    if (width <= 900) await page.locator('.compact-panel-tabs button').nth(1).click()
  }

  async function enableLivingForm(width) {
    await properties(width)
    const detail = page.locator('details.inspector-section').filter({ has: page.locator('summary').filter({ hasText: /^Living Form/ }) })
    if (!(await detail.evaluate((element) => element.open))) await detail.locator('summary').click()
    await page.getByRole('checkbox', { name: 'Enable kinetic form', exact: true }).check()
    const pause = page.getByRole('button', { name: 'Pause', exact: true })
    if (await pause.count()) await pause.click()
  }

  async function loopControls(label) {
    await page.getByRole('button', { name: 'Living loop PNG sequence', exact: true }).click()
    const inspector = page.locator('#export-inspector')
    assert.equal(await inspector.getByRole('button', { name: '2K', exact: true }).count(), 1)
    assert.equal(await inspector.getByRole('button', { name: '4K', exact: true }).count(), desktop ? 1 : 0)
    for (const fps of [12, 24, 30]) {
      const button = inspector.getByRole('button', { name: `${fps} fps`, exact: true })
      await button.click()
      assert.equal(await button.getAttribute('aria-pressed'), 'true', `${label}: ${fps} fps cannot be selected`)
    }
    const timing = page.getByRole('slider', { name: 'Living Loop duration', exact: true })
    assert.equal(await timing.getAttribute('min'), '1')
    assert.equal(await timing.getAttribute('max'), '12')
    assert.equal(await inspector.getByRole('button', { name: 'High 2× Lossless frames', exact: true }).count(), 1)
    const background = inspector.getByRole('group', { name: 'Background', exact: true })
    await background.getByRole('button', { name: /^Current/ }).click()
    await background.getByRole('button', { name: 'Transparent', exact: true }).click()
    if (desktop) await inspector.getByRole('button', { name: '4K', exact: true }).click()
    await page.waitForFunction(() => Boolean(document.querySelector('#export-inspector .render-button:not(:disabled)')))
    assert.equal(await page.getByRole('button', { name: 'Export lossless loop ZIP', exact: true }).isEnabled(), true)
    await scrollCheck(label)
  }

  try {
    await page.goto(process.env.TEST_URL || 'http://127.0.0.1:5197')
    await page.locator('.three-preview').waitFor()
    for (const [width, height] of sizes) {
      const label = `${edition} DPR${dpr} ${width}×${height}`
      await page.setViewportSize({ width, height })
      await page.getByRole('tab', { name: 'Text', exact: true }).click()
      if (width <= 900) await page.locator('.compact-panel-tabs button').first().click()
      await page.locator('#text-content').waitFor()
      await scrollCheck(`${label} Text build`)
      await properties(width)
      await scrollCheck(`${label} Text properties`)
      await enableLivingForm(width)
      await page.getByRole('button', { name: 'Export', exact: true }).first().click()
      await page.getByRole('button', { name: 'Still PNG image', exact: true }).click()
      await scrollCheck(`${label} Text still`)
      assert.equal(await page.getByRole('button', { name: /Straight on/ }).count(), 0, 'Text must not expose image-only original-size view')
      await loopControls(`${label} Text Living Loop`)
      await page.screenshot({ path: join(artifacts, `${edition}-dpr${dpr}-${width}x${height}-text-loop.png`) })
      await page.getByRole('button', { name: 'Back to edit', exact: true }).click()
      await page.getByRole('tab', { name: 'Image', exact: true }).click()
      await enableLivingForm(width)
      await page.getByRole('button', { name: 'Export', exact: true }).first().click()
      await loopControls(`${label} Image Living Loop`)
      await page.screenshot({ path: join(artifacts, `${edition}-dpr${dpr}-${width}x${height}-image-loop.png`) })
      await page.getByRole('button', { name: 'Still PNG image', exact: true }).click()
      await scrollCheck(`${label} return to Image still`)
      await page.getByRole('button', { name: 'Back to edit', exact: true }).click()
      await bounds(`${label} return to Image edit`)
      console.log(`${label}: Text build/properties/still/loop, Image loop, and return transitions passed`)
    }
    assert.deepEqual(errors, [], `${edition} DPR${dpr}: uncaught browser exceptions`)
  } finally {
    await context.close()
  }
}

try {
  for (const desktop of [false, true]) {
    for (const dpr of [1, 2]) {
      try { await runCase(desktop, dpr) }
      catch (error) {
        const message = `${desktop ? 'desktop-fixture' : 'web'} DPR${dpr}: ${error.stack || error}`
        failures.push(message)
        console.error(message)
      }
    }
  }
  assert.deepEqual(failures, [], failures.join('\n'))
  console.log(`Additional viewport QA passed: ${results.length} bounds checks; Text and Living Loop, web/desktop fixture, DPR1/DPR2. No loop renders performed. Artifacts: ${artifacts}`)
} finally {
  await writeFile(join(artifacts, 'additional-viewport-results.json'), JSON.stringify({ checks: results.length, failures, results }, null, 2))
  await browser.close()
}
