import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const repository = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(import.meta.url)
const { _electron } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const directory = await mkdtemp(join(tmpdir(), 'rasterform-native-project-qa-'))
console.log(`Isolated native QA artifacts: ${directory}`)
// Keep the running test independent of another agent's subsequent staged build.
const stage = join(directory, 'stage')
await cp(process.env.RASTERFORM_PROJECT_QA_STAGE || join(repository, 'electron/.stage'), stage, { recursive: true })
const environment = { ...process.env, RASTERFORM_PROJECT_QA_DIR: directory, RASTERFORM_PROJECT_QA_STAGE: stage }
delete environment.ELECTRON_RUN_AS_NODE
delete environment.RASTERFORM_DESKTOP_SMOKE
delete environment.NODE_OPTIONS
const application = await _electron.launch({
  executablePath: require(join(repository, 'electron/node_modules/electron')),
  args: [join(repository, 'electron/scripts/project-files-harness.cjs')],
  env: environment,
})

async function readSession(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('rasterform-editor-session', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      if (!db.objectStoreNames.contains('documents')) return null
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction('documents')
        const request = transaction.objectStore('documents').get('current')
        transaction.oncomplete = () => {
          const row = request.result
          resolve(row ? { name: row.document.image.name, depth: row.document.mesh.depth } : null)
        }
        transaction.onerror = () => reject(transaction.error ?? request.error)
        transaction.onabort = () => reject(transaction.error)
      })
    } finally { db.close() }
  })
}
async function waitForSession(page, expected) {
  // This Playwright version treats a Promise as immediately truthy in
  // waitForFunction. Poll resolved values here, and assert before reloading.
  let actual = null
  for (let attempt = 0; attempt < 50; attempt += 1) {
    actual = await readSession(page)
    if (actual?.name === expected.name && actual.depth === expected.depth) return actual
    await page.waitForTimeout(100)
  }
  assert.deepEqual(actual, expected, 'Native recovery snapshot never reached the expected authored state')
}
async function invokeMenu(menuLabel, itemLabel) {
  await application.evaluate(({ Menu, BrowserWindow }, labels) => {
    const menu = Menu.getApplicationMenu()?.items.find(item => item.label === labels[0])
    const item = menu?.submenu?.items.find(item => item.label === labels[1])
    if (!item?.enabled || typeof item.click !== 'function') throw new Error(`Missing native menu command ${labels.join(' → ')}`)
    const editor = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('rasterform://app/'))
    // Exercise the callback installed on the real native menu, not a synthetic
    // renderer keyboard event (which bypasses native accelerator routing).
    item.click(item, editor, {})
  }, [menuLabel, itemLabel])
}
function assertSameCameraPose(actual, expected, message) {
  for (const [key, value] of Object.entries(expected)) {
    if (Array.isArray(value)) {
      // The recorded gesture now clears residual inertia. Allow only numerical
      // roundoff from restoring the spherical camera pose, not continued drift.
      assert.ok(value.every((entry, index) => Math.abs(actual[key][index] - entry) < 1e-9), `${message}: ${key}`)
    } else assert.equal(actual[key], value, `${message}: ${key}`)
  }
}

try {
  const page = await application.firstWindow()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.setDefaultTimeout(15_000)
  await page.locator('.three-preview').waitFor()
  const capabilities = await page.evaluate(() => ({
    version: window.rasterformDesktop?.projectFilesProtocolVersion,
    save: typeof window.rasterformDesktop?.saveProject,
    open: typeof window.rasterformDesktop?.openProject,
    reveal: typeof window.rasterformDesktop?.revealLastExport,
    commandVersion: window.rasterformDesktop?.editorCommandsProtocolVersion,
    commands: typeof window.rasterformDesktop?.onEditorCommand,
    editText: typeof window.rasterformDesktop?.editText,
  }))
  assert.deepEqual(capabilities, { version: 1, save: 'function', open: 'function', reveal: 'function', commandVersion: 1, commands: 'function', editText: 'function' })
  const initialBounds = await application.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows()[0]
    const bounds = window.getBounds()
    const work = screen.getDisplayMatching(bounds).workArea
    return { bounds, work }
  })
  assert.ok(initialBounds.bounds.height <= initialBounds.work.height, 'Native startup height exceeds work area')
  assert.ok(initialBounds.bounds.width <= initialBounds.work.width, 'Native startup width exceeds work area')

  // Saving must capture the mounted pose; the first camera gesture must have a
  // real baseline in history, not the camera-less setup-time document.
  await application.evaluate(() => { globalThis.rasterformProjectQa.saveName = 'camera-baseline.rasterform' })
  await page.getByRole('button', { name: 'Save project', exact: true }).click()
  await page.locator('.editor-message').filter({ hasText: 'camera-baseline.rasterform saved' }).waitFor()
  const baselineCamera = JSON.parse(await readFile(join(directory, 'camera-baseline.rasterform'), 'utf8')).document.camera
  assert.ok(baselineCamera?.target, 'Startup project snapshot is missing its camera')
  const cameraBounds = await page.locator('.three-preview').boundingBox()
  await page.mouse.move(cameraBounds.x + cameraBounds.width * 0.45, cameraBounds.y + cameraBounds.height * 0.5)
  await page.mouse.down()
  await page.mouse.move(cameraBounds.x + cameraBounds.width * 0.60, cameraBounds.y + cameraBounds.height * 0.55, { steps: 6 })
  await page.mouse.up()
  // OrbitControls records the gesture after damping settles, not on the first
  // pointerup frame. Wait for that authored action before asking to Undo it.
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Undo' && !button.disabled))
  await application.evaluate(() => { globalThis.rasterformProjectQa.saveName = 'camera-orbited.rasterform' })
  await page.getByRole('button', { name: 'Save project', exact: true }).click()
  await page.locator('.editor-message').filter({ hasText: 'camera-orbited.rasterform saved' }).waitFor()
  const orbitedCamera = JSON.parse(await readFile(join(directory, 'camera-orbited.rasterform'), 'utf8')).document.camera
  assert.notDeepEqual(orbitedCamera, baselineCamera, 'Camera drag did not alter the authored pose')
  await invokeMenu('Edit', 'Undo')
  await page.locator('.editor-message').filter({ hasText: 'Undone' }).waitFor()
  await application.evaluate(() => { globalThis.rasterformProjectQa.saveName = 'camera-undone.rasterform' })
  await page.getByRole('button', { name: 'Save project', exact: true }).click()
  await page.locator('.editor-message').filter({ hasText: 'camera-undone.rasterform saved' }).waitFor()
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'camera-undone.rasterform'), 'utf8')).document.camera, baselineCamera, 'The first orbit gesture must Undo to the actual startup camera')
  await invokeMenu('Edit', 'Redo')
  await page.locator('.editor-message').filter({ hasText: 'Redone' }).waitFor()
  await application.evaluate(() => { globalThis.rasterformProjectQa.saveName = 'camera-redone.rasterform' })
  await page.getByRole('button', { name: 'Save project', exact: true }).click()
  await page.locator('.editor-message').filter({ hasText: 'camera-redone.rasterform saved' }).waitFor()
  assertSameCameraPose(JSON.parse(await readFile(join(directory, 'camera-redone.rasterform'), 'utf8')).document.camera, orbitedCamera, 'Native Redo must restore the orbited pose')
  await invokeMenu('Edit', 'Undo')
  await page.locator('.editor-message').filter({ hasText: 'Undone' }).waitFor()

  // Undo-to-initial has canUndo=false but still needs recovery persisted after
  // a long file dialog; retry must not depend on having another Undo available.
  const baselineDepthInput = page.getByRole('spinbutton', { name: 'Depth value', exact: true })
  await baselineDepthInput.fill('0.7')
  await baselineDepthInput.press('Tab')
  await waitForSession(page, { name: 'Demo image', depth: 0.7 })
  await invokeMenu('Edit', 'Undo')
  await page.locator('.editor-message').filter({ hasText: 'Undone' }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Undo', exact: true }).isDisabled(), true)
  await application.evaluate(() => {
    globalThis.rasterformProjectQa.saveName = 'held-initial-baseline.rasterform'
    globalThis.rasterformProjectQa.holdSave = true
  })
  await page.getByRole('button', { name: 'Save project', exact: true }).click()
  await page.waitForTimeout(900)
  assert.equal(await application.evaluate(() => globalThis.rasterformProjectQa.waitingSave), true)
  assert.equal((await readSession(page)).depth, 0.7)
  await application.evaluate(() => globalThis.rasterformProjectQa.releaseSave())
  await page.locator('.editor-message').filter({ hasText: 'held-initial-baseline.rasterform saved' }).waitFor()
  await waitForSession(page, { name: 'Demo image', depth: 0.58 })

  await page.getByRole('tab', { name: 'Text', exact: true }).click()
  const textInput = page.locator('#text-content')
  const originalText = await textInput.inputValue()
  await textInput.focus()
  await textInput.press('End')
  await textInput.pressSequentially('X')
  const typedText = await textInput.inputValue()
  assert.notEqual(typedText, originalText)
  await invokeMenu('Edit', 'Undo')
  await page.waitForFunction(expected => document.querySelector('#text-content')?.value === expected, originalText)
  assert.equal(await page.getByRole('tab', { name: 'Text', exact: true }).getAttribute('aria-selected'), 'true', 'Native text Undo must not undo switching workspaces')
  await invokeMenu('Edit', 'Redo')
  await page.waitForFunction(expected => document.querySelector('#text-content')?.value === expected, typedText)
  await invokeMenu('Edit', 'Undo')
  await page.waitForFunction(expected => document.querySelector('#text-content')?.value === expected, originalText)
  await page.getByRole('tab', { name: 'Image', exact: true }).click()

  // Native menu Save does not naturally blur the number field; the application
  // must commit a typed draft before capturing the project.
  const exactDepth = page.getByRole('spinbutton', { name: 'Depth value', exact: true })
  await exactDepth.fill('0.86')
  await invokeMenu('Edit', 'Undo')
  await page.waitForFunction(() => document.querySelector('[aria-label="Depth value"]')?.value === '0.58')
  await invokeMenu('Edit', 'Redo')
  await page.waitForFunction(() => document.querySelector('[aria-label="Depth value"]')?.value === '0.86')
  await application.evaluate(() => { globalThis.rasterformProjectQa.saveName = 'menu-typed-depth.rasterform' })
  await invokeMenu('File', 'Save Project As…')
  await page.locator('.editor-message').filter({ hasText: 'menu-typed-depth.rasterform saved' }).waitFor()
  assert.equal(JSON.parse(await readFile(join(directory, 'menu-typed-depth.rasterform'), 'utf8')).document.mesh.depth, 0.86, 'Native Save must commit the focused numeric draft')
  await exactDepth.fill('0.58')
  await exactDepth.press('Tab')
  await application.evaluate(() => { globalThis.rasterformProjectQa.saveName = 'roundtrip.rasterform' })

  const fixtureBase64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 16
    canvas.height = 12
    const context = canvas.getContext('2d')
    context.fillStyle = '#c382e1'
    context.fillRect(0, 0, 16, 12)
    context.clearRect(0, 0, 8, 12)
    context.fillStyle = 'rgba(100,240,160,0.5)'
    context.fillRect(0, 0, 8, 12)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  await page.locator('input[type=file][accept*="image/png"]').setInputFiles({
    name: 'native-project-fixture.png', mimeType: 'image/png', buffer: Buffer.from(fixtureBase64, 'base64'),
  })
  await page.waitForFunction(() => document.querySelector('.document-name')?.textContent === 'native-project-fixture.png')
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await page.getByRole('button', { name: 'Save project', exact: true }).click()
  await page.locator('.editor-message').filter({ hasText: 'roundtrip.rasterform saved' }).waitFor()
  const firstContents = await readFile(join(directory, 'roundtrip.rasterform'), 'utf8')
  const original = JSON.parse(firstContents)
  assert.equal(original.format, 'Rasterform project')
  assert.ok(original.document.image.rgba.length > 0)
  assert.equal(original.document.image.source.base64, fixtureBase64, 'Native project must preserve original uploaded PNG bytes')
  assert.equal(original.document.image.sourceWidth, 16)
  assert.equal(original.document.image.sourceHeight, 12)
  assert.equal(original.document.camera.target.length, 3, 'Native project must include the real mounted camera and orbit target')
  await page.getByRole('button', { name: 'Tonal detail', exact: true }).click()
  await invokeMenu('File', 'Open Project…')
  await page.locator('.editor-message').filter({ hasText: 'opened' }).waitFor()
  await application.evaluate(() => { globalThis.rasterformProjectQa.saveName = 'reopened.rasterform' })
  await page.getByRole('button', { name: 'Save project', exact: true }).click()
  await page.locator('.editor-message').filter({ hasText: 'reopened.rasterform saved' }).waitFor()
  const reopened = JSON.parse(await readFile(join(directory, 'reopened.rasterform'), 'utf8'))
  assert.deepEqual(reopened.document, original.document, 'Native save/open must preserve exact document and image bytes')

  await application.evaluate(() => {
    globalThis.rasterformProjectQa.cancelSave = true
    globalThis.rasterformProjectQa.saveName = 'must-not-exist.rasterform'
  })
  await page.getByRole('button', { name: 'Save project', exact: true }).click()
  await page.locator('.editor-message').filter({ hasText: 'save cancelled' }).waitFor()
  await assert.rejects(readFile(join(directory, 'must-not-exist.rasterform')), error => error.code === 'ENOENT')
  await application.evaluate(() => {
    globalThis.rasterformProjectQa.cancelSave = false
    globalThis.rasterformProjectQa.cancelOpen = true
    globalThis.rasterformProjectQa.openName = 'must-not-exist.rasterform'
  })
  await page.getByRole('button', { name: 'Open project', exact: true }).click()
  await page.waitForFunction(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'Open project')?.disabled === false)
  await application.evaluate(() => {
    globalThis.rasterformProjectQa.cancelOpen = false
    globalThis.rasterformProjectQa.saveName = 'after-cancel.rasterform'
  })
  await page.getByRole('button', { name: 'Save project', exact: true }).click()
  await page.locator('.editor-message').filter({ hasText: 'after-cancel.rasterform saved' }).waitFor()
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'after-cancel.rasterform'), 'utf8')).document, original.document, 'Cancelled native dialogs changed the document')

  await writeFile(join(directory, 'malformed.rasterform'), JSON.stringify({ format: 'Rasterform project', version: 1, document: {} }))
  await application.evaluate(() => { globalThis.rasterformProjectQa.openName = 'malformed.rasterform' })
  await page.getByRole('button', { name: 'Open project', exact: true }).click()
  await page.locator('.editor-message').filter({ hasText: /Invalid Rasterform project/ }).waitFor()
  await application.evaluate(() => { globalThis.rasterformProjectQa.saveName = 'after-invalid.rasterform' })
  await page.getByRole('button', { name: 'Save project', exact: true }).click()
  await page.locator('.editor-message').filter({ hasText: 'after-invalid.rasterform saved' }).waitFor()
  const afterInvalid = JSON.parse(await readFile(join(directory, 'after-invalid.rasterform'), 'utf8'))
  assert.deepEqual(afterInvalid.document, original.document, 'Malformed import changed the current document')
  await page.getByRole('button', { name: 'Reveal last save', exact: true }).click()
  const revealed = await application.evaluate(() => globalThis.rasterformProjectQa.revealed)
  assert.equal(revealed.at(-1), join(directory, 'after-invalid.rasterform'))

  // Exercise real native-origin IndexedDB recovery, not only the web origin.
  await waitForSession(page, { name: 'native-project-fixture.png', depth: original.document.mesh.depth })
  await page.reload()
  try {
    await page.getByRole('button', { name: 'Recover session', exact: true }).waitFor()
  } catch (error) {
    await page.screenshot({ path: join(directory, 'recovery-failure.png') })
    console.error('Desktop recovery failure state:', await page.locator('body').innerText())
    console.error('Desktop recovery storage:', await page.evaluate(async () => {
      const request = indexedDB.open('rasterform-editor-session', 1)
      const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
      try {
        if (!db.objectStoreNames.contains('documents')) return { url: location.href, origin: location.origin, stores: [...db.objectStoreNames] }
        const result = db.transaction('documents').objectStore('documents').get('current')
        const row = await new Promise((resolve, reject) => { result.onsuccess = () => resolve(result.result); result.onerror = () => reject(result.error) })
        return { url: location.href, origin: location.origin, name: row?.document.image.name, depth: row?.document.mesh.depth, version: row?.version }
      } finally { db.close() }
    }))
    console.error('Desktop renderer errors:', errors)
    throw error
  }
  assert.equal(await page.locator('.document-name').innerText(), 'Demo image', 'Desktop recovery must ask before restoring')
  await page.getByRole('button', { name: 'Recover session', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.document-name')?.textContent === 'native-project-fixture.png')
  await application.evaluate(() => { globalThis.rasterformProjectQa.saveName = 'recovered.rasterform' })
  await page.getByRole('button', { name: 'Save project', exact: true }).click()
  await page.locator('.editor-message').filter({ hasText: 'recovered.rasterform saved' }).waitFor()
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'recovered.rasterform'), 'utf8')).document, original.document, 'Desktop recovery did not retain the exact design, camera, and original PNG')

  const invalidSave = await page.evaluate(async () => {
    try { await window.rasterformDesktop.saveProject({ suggestedName: 'invalid', contents: 'not JSON' }); return false }
    catch { return true }
  })
  assert.equal(invalidSave, true, 'Main admitted a malformed save request')

  // The 700ms recovery timer must not be lost if a native Save dialog stays
  // open beyond it. Completion/cancellation must allow the captured edit to save.
  await waitForSession(page, { name: 'native-project-fixture.png', depth: original.document.mesh.depth })
  await application.evaluate(() => {
    globalThis.rasterformProjectQa.saveName = 'delayed-save.rasterform'
    globalThis.rasterformProjectQa.holdSave = true
  })
  const depthInput = page.getByRole('spinbutton', { name: 'Depth value', exact: true })
  await depthInput.fill('0.82')
  await depthInput.press('Tab')
  await page.getByRole('button', { name: 'Save project', exact: true }).click()
  let saveIsHeld = false
  for (let attempt = 0; attempt < 30; attempt += 1) {
    saveIsHeld = await application.evaluate(() => globalThis.rasterformProjectQa.waitingSave)
    if (saveIsHeld) break
    await page.waitForTimeout(50)
  }
  assert.equal(saveIsHeld, true, 'Native Save dialog gate was never reached')
  await page.waitForTimeout(900)
  assert.equal((await readSession(page)).depth, original.document.mesh.depth, 'Test must hold the Save dialog before the new edit autosaves')
  await application.evaluate(() => globalThis.rasterformProjectQa.releaseSave())
  await page.locator('.editor-message').filter({ hasText: 'delayed-save.rasterform saved' }).waitFor()
  await waitForSession(page, { name: 'native-project-fixture.png', depth: 0.82 })
  await page.reload()
  await page.getByRole('button', { name: 'Recover session', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Recover session', exact: true }).click()
  assert.equal(await page.getByRole('slider', { name: 'Depth', exact: true }).inputValue(), '0.82', 'A long native Save dialog must not drop the recovery edit')

  await page.getByRole('button', { name: 'Export', exact: true }).click()
  await page.getByRole('button', { name: '4K', exact: true }).waitFor()
  await page.getByRole('button', { name: '8K', exact: true }).waitFor()
  assert.ok(await page.getByRole('button', { name: /glb/i }).count(), 'Desktop GLB output is missing')
  await page.getByRole('button', { name: 'Recipe JSON', exact: true }).click()
  // The app's real completion handler records the native DownloadItem's saved
  // path. Only the test launcher substitutes the Save As destination.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const completed = await application.evaluate(() => globalThis.rasterformProjectQa.downloads.some((item) => item.name === 'rasterform-recipe.json' && item.status === 'completed'))
    if (completed) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.ok(JSON.parse(await readFile(join(directory, 'rasterform-recipe.json'), 'utf8')))
  await page.getByRole('button', { name: 'Reveal last completed export in Finder', exact: true }).click()
  const exportReveals = await application.evaluate(() => globalThis.rasterformProjectQa.revealed)
  assert.equal(exportReveals.at(-1), join(directory, 'rasterform-recipe.json'), 'Completed generic downloads must update Reveal')
  for (const [width, height] of [[1100, 700], [800, 500], [600, 360]]) {
    await application.evaluate(({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0].setSize(size[0], size[1])
    }, [width, height])
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const state = await page.evaluate(() => {
      const stage = document.querySelector('.three-stage').getBoundingClientRect()
      const canvas = document.querySelector('.three-preview').getBoundingClientRect()
      return { width: innerWidth, height: innerHeight, stage: stage.toJSON(), canvas: canvas.toJSON(), documentHeight: document.documentElement.scrollHeight }
    })
    assert.ok(state.stage.right <= state.width + 1 && state.stage.bottom <= state.height + 1, `Desktop viewport exceeds ${width}×${height}`)
    assert.ok(state.canvas.right <= state.width + 1 && state.canvas.bottom <= state.height + 1, `Desktop canvas exceeds ${width}×${height}`)
    assert.ok(state.documentHeight <= state.height + 1, `Desktop document exceeds ${width}×${height}`)
  }
  await page.screenshot({ path: join(directory, 'desktop-export-small.png') })
  assert.deepEqual(errors, [], `Unhandled desktop renderer errors: ${errors.join('\n')}`)
  console.log(`Native project QA passed: isolated copied stage + real main/preload/UI Save/Open, native menu authored/text Undo/Redo and Open/Save, first-orbit camera baseline, numeric-draft commit, original PNG byte-exact document/camera roundtrip, cancelled-dialog and malformed-import protection, native-origin IndexedDB recovery including a held Save dialog, generic recipe download completion/Reveal, preserved 4K/8K/GLB options, and 3 resized export viewports. Native dialog selections and Finder reveal were stubbed to temporary fixtures. Artifacts: ${directory}`)
} finally {
  await application.close()
}
