/**
 * Real-browser authored-state regression, in an isolated browser context.
 * TEST_URL=http://127.0.0.1:5187 PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
 *   node scripts/verify-editor-recovery.mjs
 * Exercises slider undo, named comparison, animation-time edits, IndexedDB
 * recovery, and Reference-map remounting without changing user browser data.
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

async function settle(targetPage = page) {
  await targetPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}
async function value(label, targetPage = page) { return Number(await targetPage.getByRole('slider', { name: label, exact: true }).inputValue()) }
async function setValue(label, next, targetPage = page) {
  const input = targetPage.getByRole('spinbutton', { name: `${label} value`, exact: true })
  await input.fill(String(next))
  await input.press('Tab')
  await settle(targetPage)
  assert.equal(await value(label, targetPage), next)
}
async function readSession(targetPage = page) {
  return targetPage.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('rasterform-editor-session', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      if (!db.objectStoreNames.contains('documents')) return null
      return await new Promise((resolve, reject) => {
        const request = db.transaction('documents').objectStore('documents').get('current')
        request.onsuccess = async () => {
          const document = request.result?.document
          const original = document?.image.sourceBlob
          resolve(document ? {
            mesh: document.mesh,
            image: {
              name: document.image.name, byteLength: document.image.data.length,
              sourceWidth: document.image.sourceWidth, sourceHeight: document.image.sourceHeight,
              originalBase64: original ? btoa(String.fromCharCode(...new Uint8Array(await original.arrayBuffer()))) : null,
            },
          } : null)
        }
        request.onerror = () => reject(request.error)
      })
    } finally { db.close() }
  })
}
async function waitForSavedDepth(expected, targetPage = page) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const document = await readSession(targetPage)
    if (document?.mesh.depth === expected) return document
    await targetPage.waitForTimeout(100)
  }
  assert.fail(`Session did not save expected depth ${expected}`)
}

// Hold only the first session database's success callback. The native request,
// upgrade/error events, database, transactions and data remain real; the proxy
// forwards native accessors/methods with their required receiver intact.
async function delayFirstSessionOpen(targetPage) {
  await targetPage.addInitScript(() => {
    if (sessionStorage.getItem('rasterform-qa-idb-gate-released')) return
    const open = indexedDB.open.bind(indexedDB)
    let captured = false
    let released = false
    let successHandler = null
    let successEvent = null
    let heldRequest = null
    window.__rasterformIdbGate = {
      get pending() { return successEvent !== null },
      release() {
        released = true
        sessionStorage.setItem('rasterform-qa-idb-gate-released', '1')
        if (successEvent && successHandler) successHandler.call(heldRequest, successEvent)
      },
    }
    indexedDB.open = function (...args) {
      const request = open(...args)
      if (captured || args[0] !== 'rasterform-editor-session') return request
      captured = true
      heldRequest = request
      request.addEventListener('success', event => {
        successEvent = event
        if (released && successHandler) successHandler.call(request, event)
      })
      return new Proxy(request, {
        get(target, key) {
          if (key === 'onsuccess') return successHandler
          const result = Reflect.get(target, key, target)
          return typeof result === 'function' ? result.bind(target) : result
        },
        set(target, key, next) {
          if (key === 'onsuccess') { successHandler = next; return true }
          return Reflect.set(target, key, next, target)
        },
      })
    }
  })
}

async function verifyDelayedSessionOpen(hasExistingSession) {
  const delayedContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
  try {
    const delayedPage = await delayedContext.newPage()
    delayedPage.setDefaultTimeout(20_000)
    delayedPage.on('pageerror', error => errors.push(error.message))
    const url = process.env.TEST_URL || 'http://127.0.0.1:5187'
    if (hasExistingSession) {
      await delayedPage.goto(url)
      await delayedPage.locator('.three-preview').waitFor()
      await setValue('Depth', 0.66, delayedPage)
      await waitForSavedDepth(0.66, delayedPage)
    }
    await delayFirstSessionOpen(delayedPage)
    await delayedPage.goto(url)
    await delayedPage.locator('.three-preview').waitFor()
    await delayedPage.waitForFunction(() => window.__rasterformIdbGate?.pending)
    await setValue('Depth', 0.82, delayedPage)
    await delayedPage.waitForTimeout(900)
    const beforeRelease = await readSession(delayedPage)
    assert.equal(beforeRelease?.mesh.depth ?? null, hasExistingSession ? 0.66 : null, 'An early edit must not write before the previous session is inspected')
    await delayedPage.evaluate(() => window.__rasterformIdbGate.release())
    if (hasExistingSession) {
      await delayedPage.getByRole('button', { name: 'Recover session', exact: true }).waitFor()
      assert.equal(await value('Depth', delayedPage), 0.82, 'An offered prior session must not silently replace current work')
      await delayedPage.waitForTimeout(900)
      assert.equal((await readSession(delayedPage)).mesh.depth, 0.66, 'An offered prior session must not be overwritten by an early edit')
    } else {
      await waitForSavedDepth(0.82, delayedPage)
      await delayedPage.reload()
      await delayedPage.getByRole('button', { name: 'Recover session', exact: true }).waitFor()
      assert.equal(await value('Depth', delayedPage), 0.58)
    }
    await delayedPage.getByRole('button', { name: 'Recover session', exact: true }).click()
    assert.equal(await value('Depth', delayedPage), hasExistingSession ? 0.66 : 0.82)
    if (hasExistingSession) {
      await delayedPage.getByRole('button', { name: 'Undo', exact: true }).click()
      assert.equal(await value('Depth', delayedPage), 0.82, 'Recovery after delayed load must preserve the early edit in history')
    }
    checks += 1
    console.log(`PASS: delayed IndexedDB open (${hasExistingSession ? 'prior session protected and recovery undoable' : 'early edit saved and recovered'})`)
  } finally {
    await delayedContext.close()
  }
}
async function referencePixels() {
  const summary = page.locator('summary').filter({ hasText: 'Reference maps' })
  if (!(await summary.locator('..').evaluate(element => element.open))) await summary.click()
  await settle()
  return summary.locator('..').locator('canvas').evaluateAll(canvases => canvases.map(canvas => {
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    let opaque = 0
    let varied = 0
    for (let i = 3; i < pixels.length; i += 4) {
      if (pixels[i] > 0) opaque++
      if (pixels[i - 3] > 0 || pixels[i - 2] > 0 || pixels[i - 1] > 0) varied++
    }
    return { width: canvas.width, height: canvas.height, opaque, varied }
  }))
}

try {
  await page.goto(process.env.TEST_URL || 'http://127.0.0.1:5187')
  await page.locator('.three-preview').waitFor()
  await settle()
  const initialDepth = await value('Depth')
  assert.equal(initialDepth, 0.58)

  // One held keyboard gesture, including repeated keydowns, is one undo step.
  const depth = page.getByRole('slider', { name: 'Depth', exact: true })
  await depth.focus()
  for (let index = 0; index < 6; index++) await page.keyboard.down('ArrowRight')
  await page.keyboard.up('ArrowRight')
  await settle()
  const changedDepth = await value('Depth')
  assert.ok(changedDepth > initialDepth)
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  assert.equal(await value('Depth'), initialDepth, 'One Undo must reverse the entire held-arrow slider gesture')
  await page.getByRole('button', { name: 'Redo', exact: true }).click()
  assert.equal(await value('Depth'), changedDepth)
  checks += 1
  console.log('PASS: held-key slider undo/redo')

  await page.getByRole('button', { name: 'Keep version', exact: true }).click()
  await setValue('Depth', 1.1)
  await waitForSavedDepth(1.1)
  await page.getByRole('button', { name: 'Compare', exact: true }).click()
  assert.equal(await value('Depth'), changedDepth)
  assert.equal(await page.getByRole('tab', { name: 'Text', exact: true }).isDisabled(), true)
  await page.locator('.three-stage').click({ button: 'right' })
  assert.equal(await page.locator('#viewport-background-menu').count(), 0, 'Read-only comparison must not open the background menu')
  await page.evaluate(() => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['invalid PNG'], 'must-not-replace-source.png', { type: 'image/png' }))
    document.querySelector('.editor-app').dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }))
  })
  assert.equal(await page.locator('.document-name').innerText(), 'Demo image', 'Comparison must ignore file drops')
  await page.waitForTimeout(900)
  assert.equal((await readSession()).mesh.depth, 1.1, 'Temporary comparison must not overwrite recovery')
  await page.getByRole('button', { name: 'Current', exact: true }).click()
  assert.equal(await value('Depth'), 1.1)
  await page.getByRole('button', { name: 'Version 1', exact: true }).click()
  await page.getByRole('button', { name: 'Back to current', exact: true }).click()
  assert.equal(await value('Depth'), 1.1)
  await page.getByRole('button', { name: 'Compare', exact: true }).click()
  await page.getByRole('button', { name: 'Use Version 1', exact: true }).click()
  assert.equal(await value('Depth'), changedDepth)
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  assert.equal(await value('Depth'), 1.1, 'Adopting a kept version must remain undoable')
  checks += 1
  console.log('PASS: kept-version comparison and undoable adoption')

  // Authoring while playback is running is still history-worthy; frame ticks are not.
  const livingSummary = page.locator('summary').filter({ hasText: 'Living Form' })
  if (!(await livingSummary.locator('..').evaluate(element => element.open))) await livingSummary.click()
  await page.getByRole('checkbox', { name: 'Enable kinetic form' }).check()
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await page.waitForTimeout(250)
  await setValue('Depth', 0.9)
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  assert.equal(await value('Depth'), 1.1, 'An edit made during animation must undo normally')
  checks += 1
  console.log('PASS: editing during Living Form playback')

  const before = await referencePixels()
  assert.equal(before.length, 2)
  for (const canvas of before) assert.ok(canvas.opaque > 0 && canvas.varied > 0, 'Initial reference map must contain pixels')
  await page.getByRole('button', { name: 'Export', exact: true }).first().click()
  await page.getByRole('button', { name: 'Back to edit', exact: true }).click()
  const after = await referencePixels()
  assert.deepEqual(after, before, 'Reference maps must retain pixels after Export → Edit')
  checks += 1
  console.log('PASS: reference maps after Export → Edit')

  const fixtureBase64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 16
    canvas.height = 12
    const context = canvas.getContext('2d')
    context.fillStyle = '#c382e1'
    context.fillRect(0, 0, 16, 12)
    context.fillStyle = 'rgba(100,240,160,0.5)'
    context.clearRect(0, 0, 8, 12)
    context.fillRect(0, 0, 8, 12)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  await page.locator('input[type=file][accept*="image/png"]').setInputFiles({
    name: 'recovery-fixture.png', mimeType: 'image/png', buffer: Buffer.from(fixtureBase64, 'base64'),
  })
  await page.waitForFunction(() => document.querySelector('.document-name')?.textContent === 'recovery-fixture.png')
  await setValue('Depth', 0.82)
  const saved = await waitForSavedDepth(0.82)
  assert.ok(saved.image.byteLength > 0)
  assert.equal(saved.image.name, 'recovery-fixture.png')
  assert.equal(saved.image.sourceWidth, 16)
  assert.equal(saved.image.sourceHeight, 12)
  assert.equal(saved.image.originalBase64, fixtureBase64, 'Session must retain uploaded original bytes exactly')
  await page.reload()
  await page.getByRole('button', { name: 'Recover session', exact: true }).waitFor()
  assert.equal(await value('Depth'), initialDepth, 'Recovery should ask before replacing the current design')
  await page.getByRole('button', { name: 'Recover session', exact: true }).click()
  assert.equal(await value('Depth'), 0.82)
  assert.equal(await page.locator('.document-name').innerText(), 'recovery-fixture.png')
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  assert.equal(await value('Depth'), initialDepth, 'Session recovery must itself be undoable')
  checks += 1

  async function injectBadFont(embedded) {
    await page.evaluate(async (embedded) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('rasterform-editor-session', 1)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      try {
        await new Promise((resolve, reject) => {
          const transaction = db.transaction('documents', 'readwrite')
          const store = transaction.objectStore('documents')
          const read = store.get('current')
          read.onsuccess = () => {
            const session = read.result
            session.document.workspace = 'text'
            session.document.mesh.depth = 1.2
            session.document.font = {
              id: 'local:nonexistent-test-font', label: 'Missing Recovery Test Font', family: 'Missing Recovery Test Font',
              style: 'Regular', source: 'local', cssFamily: '"Missing Recovery Test Font"',
            }
            session.document.fontBlob = embedded ? new Blob(['not a valid font'], { type: 'font/otf' }) : undefined
            store.put(session, 'current')
          }
          transaction.oncomplete = resolve
          transaction.onerror = () => reject(transaction.error)
        })
      } finally { db.close() }
    }, embedded)
    await page.reload()
    await page.getByRole('button', { name: 'Recover session', exact: true }).waitFor()
    const undoBefore = await page.getByRole('button', { name: 'Undo', exact: true }).isEnabled()
    await page.getByRole('button', { name: 'Recover session', exact: true }).click()
    await settle()
    assert.equal(await value('Depth'), initialDepth, 'A failed font restore must not partially apply settings')
    assert.equal(await page.getByRole('tab', { name: 'Image', exact: true }).getAttribute('aria-selected'), 'true')
    assert.equal(await page.getByRole('button', { name: 'Undo', exact: true }).isEnabled(), undoBefore)
    assert.ok(await page.locator('.editor-message').innerText(), 'Missing/invalid fonts need an explicit message')
  }
  // Let any prior normal autosave finish before placing the isolated invalid fixture.
  await waitForSavedDepth(initialDepth)
  await injectBadFont(false)
  await injectBadFont(true)
  checks += 1

  await verifyDelayedSessionOpen(false)
  await verifyDelayedSessionOpen(true)

  assert.deepEqual(errors, [], `Unhandled browser errors: ${errors.join('\n')}`)
  console.log(`PASS: ${checks} editor recovery groups (slider gesture, read-only A/B, live edits, reference maps, lossless IndexedDB reload, font failures, delayed empty/prior session reads)`)
} finally {
  await context.close()
  await browser.close()
}
