/**
 * Browser regression for temporary form candidates and inspector continuity.
 * Run against Vite dev: this reads Vue development metadata, without mutating it,
 * to compare the existing document/history and public camera snapshot.
 * TEST_URL=http://127.0.0.1:5187 PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
 *   node scripts/verify-editor-comparison.mjs
 * An isolated browser context owns all recovery data. No Electron or user files.
 */
import assert from 'node:assert/strict'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
const page = await context.newPage()
const errors = []
const downloads = []
page.on('pageerror', error => errors.push(error.message))
page.on('download', download => downloads.push(download.suggestedFilename()))
page.setDefaultTimeout(20_000)
const url = process.env.TEST_URL || 'http://127.0.0.1:5187'
let checks = 0

async function settle() {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

// Install a read-only serializer in this isolated page, also after reload.
await page.addInitScript(() => {
  const fingerprint = data => {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    let hash = 2166136261
    for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619) >>> 0
    return `${bytes.length}:${hash}`
  }
  window.__comparisonQaDocument = document => {
    if (!document) return null
    const { image, fontBlob, ...state } = document
    return JSON.parse(JSON.stringify({
      ...state,
      image: {
        ...image, data: fingerprint(image.data),
        sourceBlob: image.sourceBlob ? { size: image.sourceBlob.size, type: image.sourceBlob.type } : null,
      },
      fontBlob: fontBlob ? { size: fontBlob.size, type: fontBlob.type } : null,
    }))
  }
  window.__comparisonQaFingerprint = fingerprint
})

async function state() {
  return page.locator('.editor-app').evaluate(element => {
    const app = element.__vueParentComponent?.setupState
    if (!app?.captureDocument || !app.editorHistory) throw new Error('Use the Vite development server for read-only document/history inspection.')
    return {
      document: window.__comparisonQaDocument(app.captureDocument()),
      history: { undo: app.editorHistory.undoCount, redo: app.editorHistory.redoCount },
      comparison: Boolean(app.comparison),
      exporting: Boolean(app.exportingImage || app.exportingBlenderProject || app.exporting),
      geometry: window.__comparisonQaFingerprint(app.mesh.positions),
    }
  })
}

function assertDocument(actual, expected, label) {
  const { camera: actualCamera, ...actualOther } = actual
  const { camera: expectedCamera, ...expectedOther } = expected
  assert.deepEqual(actualOther, expectedOther, `${label}: authored values differ`)
  assert.ok(actualCamera && expectedCamera, `${label}: camera must be present`)
  for (const key of ['position', 'quaternion', 'up', 'target']) {
    actualCamera[key].forEach((value, index) => {
      assert.ok(Math.abs(value - expectedCamera[key][index]) < 1e-6, `${label}: ${key}[${index}] drifted`)
    })
  }
  for (const key of ['fov', 'near', 'far', 'zoom', 'filmGauge', 'filmOffset']) {
    assert.equal(actualCamera[key], expectedCamera[key], `${label}: ${key} changed`)
  }
}

async function session() {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('rasterform-editor-session', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      if (!db.objectStoreNames.contains('documents')) return null
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction('documents', 'readonly')
        const request = transaction.objectStore('documents').get('current')
        const timeout = setTimeout(() => reject(new Error('Recovery read did not finish within five seconds')), 5000)
        transaction.oncomplete = () => {
          clearTimeout(timeout)
          try {
            resolve(request.result ? {
              revision: request.result.revision,
              document: window.__comparisonQaDocument(request.result.document),
            } : null)
          } catch (error) { reject(error) }
        }
        transaction.onerror = () => reject(transaction.error || request.error)
        transaction.onabort = () => reject(transaction.error || new Error('Recovery read aborted'))
      })
    } finally { db.close() }
  })
}

async function waitSaved(expected) {
  let lastError
  for (let attempt = 0; attempt < 60; attempt++) {
    const saved = await session()
    if (saved) {
      try { assertDocument(saved.document, expected, 'Saved design'); return saved } catch (error) { lastError = error }
    }
    await page.waitForTimeout(100)
  }
  if (lastError) throw lastError
  assert.fail(`The baseline design was not saved to real IndexedDB: ${await page.locator('.recovery-status').textContent()}`)
}

async function enterNumber(label, value) {
  const input = page.getByRole('spinbutton', { name: `${label} value`, exact: true })
  await input.fill(String(value))
  await input.press('Tab')
  await settle()
  assert.equal(Number(await input.inputValue()), value)
}

async function preview() {
  const details = page.locator('.field-variations')
  if (!await details.evaluate(element => element.open)) await details.locator('summary').click()
  await details.getByRole('button', { name: 'Preview Base smoothing 2 on the form', exact: true }).click()
  await page.getByRole('group', { name: 'Compare setting on the form', exact: true }).waitFor()
  await settle()
}

async function toolbarAction(name) {
  await page.locator('.comparison-toolbar').getByRole('button', { name, exact: true }).click()
  await settle()
}

async function paneState() {
  return page.evaluate(() => ({
    details: [...document.querySelectorAll('#build-inspector details, #style-inspector details')].map(element => ({
      title: element.querySelector(':scope > summary')?.textContent?.trim(), open: element.open,
    })),
    selectedChannel: document.querySelector('.layer-name[aria-pressed=true]')?.textContent,
    scrollTop: document.querySelector('#style-inspector').scrollTop,
  }))
}

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.locator('.three-preview').waitFor()
  await page.getByRole('button', { name: 'Clay', exact: true }).click()
  await page.getByRole('button', { name: 'Glossy', exact: true }).click()
  await enterNumber('Base smoothing', 4)
  await enterNumber('Depth', 0.82)
  console.log('SETUP: material and field values entered')
  const bounds = await page.locator('.three-preview').boundingBox()
  assert.ok(bounds)
  await page.mouse.move(bounds.x + bounds.width * 0.45, bounds.y + bounds.height * 0.4)
  await page.mouse.down()
  await page.mouse.move(bounds.x + bounds.width * 0.57, bounds.y + bounds.height * 0.46, { steps: 6 })
  await page.mouse.up()
  // Wait for the authored gesture, not an arbitrary interval that might capture
  // a mid-damping pose while a concurrent build slows the browser animation.
  await page.waitForFunction(() => {
    const app = document.querySelector('.editor-app').__vueParentComponent.setupState
    const live = app.captureDocument().camera
    const recorded = app.editorHistory.current.camera
    return live && recorded && !app.editorHistory.inGesture
      && ['position', 'quaternion', 'up', 'target'].every(key =>
        live[key].every((value, index) => Math.abs(value - recorded[key][index]) < 1e-10))
  })
  const baseline = await state()
  console.log('SETUP: authored camera captured; checking real recovery transaction')
  await waitSaved(baseline.document)
  await page.locator('.recovery-status').filter({ hasText: 'Recovery saved on this device' }).waitFor()
  const baselineSaved = await session()

  await preview()
  const candidate = await state()
  const expectedCandidate = structuredClone(baseline.document)
  expectedCandidate.field.blur = 2
  assertDocument(candidate.document, expectedCandidate, 'Candidate changes only the chosen field')
  assert.notEqual(candidate.geometry, baseline.geometry, 'Preview must change the actual 3D geometry')
  assert.deepEqual(candidate.history, baseline.history, 'Preview must not create an authored history action')
  assert.equal(await page.locator('#build-inspector').evaluate(element => element.inert), true)
  assert.equal(await page.locator('#style-inspector').evaluate(element => element.inert), true)
  assert.equal(await page.locator('.top-export').isDisabled(), true, 'An unadopted candidate cannot open Export')
  await page.locator('.top-export').evaluate(button => button.click())
  await page.waitForTimeout(950)
  assert.deepEqual(await session(), baselineSaved, 'Temporary candidate must never replace the recoverable baseline')
  assert.equal((await state()).exporting, false)
  assert.deepEqual(downloads, [], 'No unadopted candidate can start a file download')
  await toolbarAction('Current')
  assertDocument((await state()).document, baseline.document, 'Current side of temporary comparison')
  await toolbarAction('Base smoothing 2 px')
  assertDocument((await state()).document, expectedCandidate, 'Candidate side of temporary comparison')
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 240 }]) {
    await page.setViewportSize(viewport)
    await settle()
    const contained = await page.locator('.comparison-toolbar').evaluate(element => {
      const overlay = element.getBoundingClientRect()
      const stage = document.querySelector('.three-stage').getBoundingClientRect()
      return overlay.left >= stage.left - 1 && overlay.right <= stage.right + 1
        && overlay.top >= stage.top - 1 && overlay.bottom <= stage.bottom + 1
    })
    assert.ok(contained, `Candidate comparison must remain bounded at ${viewport.width}×${viewport.height}`)
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  await toolbarAction('Back to current')
  const cancelled = await state()
  assertDocument(cancelled.document, baseline.document, 'Cancel restores the exact authored design')
  assert.deepEqual(cancelled.history, baseline.history, 'Cancel must not add Undo or discard Redo')
  assert.equal(cancelled.geometry, baseline.geometry)
  checks++
  console.log('PASS: temporary 3D candidate preserves camera/material, history, recovery, export authority and bounded layout; Cancel restores exactly')

  await preview()
  await toolbarAction('Use Base smoothing 2 px')
  const applied = await state()
  assertDocument(applied.document, expectedCandidate, 'Apply adopts the exact preview')
  assert.equal(applied.history.undo, baseline.history.undo + 1, 'Apply must create exactly one Undo action')
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  assertDocument((await state()).document, baseline.document, 'One Undo restores the pre-candidate design')
  await page.getByRole('button', { name: 'Redo', exact: true }).click()
  assertDocument((await state()).document, expectedCandidate, 'One Redo restores the adopted candidate')
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await waitSaved(baseline.document)
  checks++
  console.log('PASS: Apply is one Undo/Redo step with exact settings and camera restoration')

  await preview()
  await page.waitForTimeout(950)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Recover session', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Recover session', exact: true }).click()
  await settle()
  assertDocument((await state()).document, baseline.document, 'Reload during preview recovers only the authored baseline')
  assert.equal((await state()).comparison, false)
  checks++
  console.log('PASS: reloading during an unadopted preview recovers the baseline, never the temporary candidate')

  const channels = page.locator('.layer-name')
  if (await channels.count() > 1) await channels.nth(1).click()
  // These are ordinary disclosure/scroll properties, never authored state.
  await page.evaluate(() => {
    const open = new Set(['Channels', 'Surface', 'Reference maps', 'Mesh health', 'Inspect transformation'])
    for (const element of document.querySelectorAll('#build-inspector details.inspector-section, #style-inspector details.inspector-section')) {
      const label = element.querySelector(':scope > summary > span')?.textContent?.trim()
      element.open = open.has(label)
    }
  })
  await settle()
  await page.locator('#style-inspector').evaluate(element => { element.scrollTop = Math.min(177, element.scrollHeight - element.clientHeight) })
  const beforeExport = await paneState()
  assert.ok(beforeExport.scrollTop > 0, 'Continuity check must start at a nonzero inspector scroll position')
  assert.ok(beforeExport.details.some(item => item.open) && beforeExport.details.some(item => !item.open))
  const beforeExportDocument = (await state()).document
  await page.locator('.top-export').click()
  await page.locator('#style-inspector').evaluate(element => { element.scrollTop = Math.min(299, element.scrollHeight - element.clientHeight) })
  await page.getByRole('button', { name: 'Back to edit', exact: true }).click()
  await settle()
  const afterExport = await paneState()
  assert.deepEqual(afterExport.details, beforeExport.details, 'Every accordion must preserve its open/closed state')
  assert.equal(afterExport.selectedChannel, beforeExport.selectedChannel, 'Selected channel must survive Export → Edit')
  assert.ok(Math.abs(afterExport.scrollTop - beforeExport.scrollTop) <= 1, 'Editing inspector must restore its own scroll offset')
  assertDocument((await state()).document, beforeExportDocument, 'Export inspection must not mutate the design or camera')
  checks++
  console.log('PASS: open/closed accordions, selected channel, scroll position, design and camera survive Export → Edit')

  const living = page.locator('details.inspector-section').filter({ has: page.locator('summary > span', { hasText: /^Living Form$/ }) })
  await living.evaluate(element => { element.open = true })
  await living.getByRole('checkbox', { name: 'Enable kinetic form', exact: true }).check()
  await living.getByRole('button', { name: 'Play', exact: true }).click()
  await page.locator('details.inspector-section').filter({ has: page.locator('summary > span', { hasText: /^Geometry$/ }) }).evaluate(element => { element.open = true })
  await enterNumber('Depth', 0.9)
  let animatedSaved = false
  for (let attempt = 0; attempt < 60; attempt++) {
    if ((await session())?.document.mesh.depth === 0.9) { animatedSaved = true; break }
    await page.waitForTimeout(100)
  }
  assert.ok(animatedSaved, 'A real edit while motion plays must reach IndexedDB')
  await page.locator('.recovery-status').filter({ hasText: 'Recovery saved on this device' }).waitFor()
  assert.equal(await living.getByRole('button', { name: 'Pause', exact: true }).isVisible(), true, 'Saving status must settle without stopping playback')
  await living.getByRole('button', { name: 'Pause', exact: true }).click()
  checks++
  console.log('PASS: recovery status confirms the real saved edit while procedural playback continues')

  assert.deepEqual(errors, [], 'Comparison and continuity must not throw browser errors')
  console.log(`PASS: ${checks} editor-comparison browser groups`)
} finally {
  await context.close()
  await browser.close()
}
