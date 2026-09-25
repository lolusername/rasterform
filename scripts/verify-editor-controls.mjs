/**
 * Real-browser numeric-entry and first-camera-action regression.
 * Run against the Vite development server (Vue's development component metadata
 * lets this test read ThreePreview's existing public getCameraSnapshot handle).
 * TEST_URL=http://127.0.0.1:5187 PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
 *   node scripts/verify-editor-controls.mjs
 * Uses an isolated context; no existing browser data or project files are touched.
 */
import assert from 'node:assert/strict'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
const page = await context.newPage()
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
page.setDefaultTimeout(20_000)
let checks = 0

async function cameraSnapshot() {
  return page.locator('.three-preview-host').evaluate((host) => {
    const snapshot = host.__vueParentComponent?.exposed?.getCameraSnapshot?.()
    if (!snapshot) throw new Error('Run this check against the Vite development server.')
    return snapshot
  })
}
function assertCameraClose(actual, expected, label) {
  for (const key of ['position', 'quaternion', 'up', 'target']) {
    for (let index = 0; index < expected[key].length; index++) {
      assert.ok(Math.abs(actual[key][index] - expected[key][index]) < 1e-6, `${label}: ${key}[${index}] did not restore`)
    }
  }
  for (const key of ['fov', 'near', 'far', 'zoom', 'filmGauge', 'filmOffset']) {
    assert.equal(actual[key], expected[key], `${label}: ${key} did not restore`)
  }
}
async function readSession() {
  return page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('rasterform-editor-session', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      if (!database.objectStoreNames.contains('documents')) return null
      return await new Promise((resolve, reject) => {
        const request = database.transaction('documents').objectStore('documents').get('current')
        request.onsuccess = () => resolve(request.result?.document?.mesh ?? null)
        request.onerror = () => reject(request.error)
      })
    } finally { database.close() }
  })
}
async function waitForSavedResolution(expected) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const mesh = await readSession()
    if (mesh?.resolution === expected) return
    await page.waitForTimeout(100)
  }
  assert.fail(`Session did not save Mesh detail ${expected}`)
}
async function enterNumber(label, inputValue, expected) {
  const number = page.getByRole('spinbutton', { name: `${label} value`, exact: true })
  await number.fill(String(inputValue))
  await number.press('Tab')
  assert.equal(Number(await number.inputValue()), expected, `${label}: exact entry must normalize visibly`)
  assert.equal(Number(await page.getByRole('slider', { name: label, exact: true }).inputValue()), expected, `${label}: numeric and slider controls must agree`)
}

try {
  await page.goto(process.env.TEST_URL || 'http://127.0.0.1:5187')
  await page.locator('.three-preview').waitFor()
  const initial = await cameraSnapshot()
  assert.equal(await page.getByRole('button', { name: 'Undo', exact: true }).isEnabled(), false)
  const bounds = await page.locator('.three-preview').boundingBox()
  assert.ok(bounds)
  await page.mouse.move(bounds.x + bounds.width * 0.5, bounds.y + bounds.height * 0.5)
  await page.mouse.down()
  await page.mouse.move(bounds.x + bounds.width * 0.7, bounds.y + bounds.height * 0.6, { steps: 8 })
  await page.mouse.up()
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  assertCameraClose(await cameraSnapshot(), initial, 'First-action orbit Undo')
  await page.getByRole('button', { name: 'Redo', exact: true }).click()
  const redone = await cameraSnapshot()
  assert.ok(redone.position.some((value, index) => Math.abs(value - initial.position[index]) > 0.01), 'Redo must restore the authored orbit, not the startup camera')
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  assertCameraClose(await cameraSnapshot(), initial, 'First-action orbit Undo after Redo')
  checks++
  console.log('PASS: first-action orbit Undo/Redo preserves the startup and authored cameras')

  // A valid change establishes a persisted baseline. Fractional mesh detail
  // previously reached the authored state and disabled all subsequent saves.
  await enterNumber('Mesh detail', 92, 92)
  await waitForSavedResolution(92)
  await enterNumber('Mesh detail', 88.5, 88)
  await waitForSavedResolution(88)
  // Same-value normalization must still rewrite the visible numeric input.
  await enterNumber('Mesh detail', 88.5, 88)
  await enterNumber('Mesh detail', '', 88)
  await enterNumber('Mesh detail', 999, 180)
  await waitForSavedResolution(180)
  await enterNumber('Mesh detail', 999, 180)
  await enterNumber('Mesh detail', -50, 16)
  await waitForSavedResolution(16)
  await enterNumber('Mesh detail', 88, 88)
  await waitForSavedResolution(88)
  assert.equal(await page.locator('.editor-message').filter({ hasText: 'Invalid Rasterform project' }).count(), 0)
  checks++
  console.log('PASS: fractional, repeated, empty, and out-of-range Mesh detail entries stay synchronized and recoverable')

  await enterNumber('Depth', 0.61, 0.62)
  await enterNumber('Depth', 8, 1.4)
  await enterNumber('Depth', -2, 0.02)
  checks++
  console.log('PASS: decimal-step and bounded numeric controls agree with their sliders')
  assert.deepEqual(errors, [], 'Controls must not throw browser errors')
  console.log(`PASS: ${checks} editor-control browser checks`)
} finally {
  await context.close()
  await browser.close()
}
