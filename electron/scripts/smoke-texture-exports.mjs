/**
 * Real Chromium/Blender integration check for image-textured model exports.
 * Run after `npm run build`: node electron/scripts/smoke-texture-exports.mjs
 * UI checks use the production bundle; source imports only exercise the codec.
 * RASTERFORM_TEXTURE_QA_ARTIFACTS optionally retains the GLB and screenshots.
 */
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import electron from 'electron'

const script = fileURLToPath(import.meta.url)
const project = resolve(dirname(script), '../..')
const marker = 'RASTERFORM_TEXTURE_EXPORT_SMOKE '
const execFileAsync = promisify(execFile)

// Saturated asymmetric quadrants make both image flips and color shifts visible.
// A one-pixel marker beyond the working raster's 1280px edge detects downsampling.
const fixtureScript = `async function makeTextureFixture() {
  const canvas = document.createElement('canvas');
  canvas.width = 3200; canvas.height = 1600;
  const context = canvas.getContext('2d');
  context.fillStyle = '#ff0000'; context.fillRect(0, 0, 1184, 976);
  context.fillStyle = '#00ff00'; context.fillRect(1184, 0, 2016, 976);
  context.fillStyle = '#0000ff'; context.fillRect(0, 976, 1184, 624);
  context.fillStyle = '#ffff00'; context.fillRect(1184, 976, 2016, 624);
  context.fillStyle = '#ffffff'; context.fillRect(3001, 1303, 1, 1);
  return new File([await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))],
    'source-texture-3200x1600.png', { type: 'image/png' });
}`

const desktopPreload = `const { contextBridge } = require('electron');
const cancelled = async () => ({ cancelled: true });
const unsubscribe = () => () => {};
contextBridge.exposeInMainWorld('rasterformDesktop', Object.freeze({
  protocolVersion: 1, longExportProtocolVersion: 1, proRenderProtocolVersion: 1,
  blenderExportProtocolVersion: 2,
  prepareFinalSave: cancelled, submitFinalRender: cancelled, cancelFinalRender: cancelled,
  onFinalRenderEvent: unsubscribe, beginLongExport: cancelled, endLongExport: cancelled,
  probeProRenderer: async () => ({ available: true, blenderVersion: 'QA bridge', device: 'METAL', message: 'QA bridge' }),
  prepareProSave: cancelled, submitProRender: cancelled, cancelProRender: cancelled,
  onProRenderEvent: unsubscribe,
  prepareBlenderExport: cancelled, submitBlenderExport: cancelled,
  cancelBlenderExport: cancelled, onBlenderExportEvent: unsubscribe,
}));`

async function waitFor(window, expression, description, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(expression)) return
    await new Promise(resolve => setTimeout(resolve, 60))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

async function clickButton(window, text, scope = '#export-inspector') {
  await window.webContents.executeJavaScript(`(() => {
    const root = document.querySelector(${JSON.stringify(scope)});
    const button = [...root.querySelectorAll('button')].find(button =>
      button.textContent.trim() === ${JSON.stringify(text)} ||
      button.querySelector('strong')?.textContent.trim() === ${JSON.stringify(text)});
    if (!button || button.disabled) throw new Error('Missing/enabled button: ' + ${JSON.stringify(text)});
    button.click();
  })()`)
}

async function saveWebPng(window, temporaryRoot, background) {
  const output = join(temporaryRoot, `web-${background}.png`)
  const downloaded = new Promise((resolveDownload, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out saving ${background} High PNG`)), 120_000)
    window.webContents.session.once('will-download', (_event, item) => {
      item.setSavePath(output)
      item.once('done', (_event, state) => {
        clearTimeout(timeout)
        if (state === 'completed') resolveDownload()
        else reject(new Error(`PNG download ${state}`))
      })
    })
  })
  await window.webContents.executeJavaScript(`document.querySelector('#export-inspector .render-button').click()`)
  await downloaded
  const png = electron.nativeImage.createFromPath(output)
  assert.deepEqual(png.getSize(), { width: 2048, height: 1024 }, `${background}: actual PNG dimensions`)
  const bitmap = png.toBitmap()
  let nonOpaque = 0
  let opaque = 0
  for (let index = 3; index < bitmap.length; index += 4) {
    if (bitmap[index] < 255) nonOpaque += 1
    else opaque += 1
  }
  assert.ok(opaque > 0, `${background}: rendered foreground exists`)
  if (background === 'transparent') {
    assert.ok(nonOpaque > 0, 'Transparent image contains alpha pixels')
    assert.equal(bitmap[3], 0, 'Transparent image corner alpha')
  } else {
    assert.equal(nonOpaque, 0, 'Current background image is fully opaque')
  }
  const viewport = await window.webContents.executeJavaScript(`(() => {
    const rect = document.querySelector('canvas.three-preview').getBoundingClientRect();
    return { width: rect.width, height: rect.height, screenWidth: innerWidth, screenHeight: innerHeight,
      pageWidth: document.documentElement.scrollWidth };
  })()`)
  assert.ok(viewport.width <= viewport.screenWidth && viewport.height <= viewport.screenHeight, 'Viewport stays screen-bounded after export')
  assert.ok(viewport.pageWidth <= viewport.screenWidth, 'PNG export does not add horizontal page overflow')
  await waitFor(window, `!document.querySelector('#export-inspector .render-button')?.disabled && !document.querySelector('#export-inspector .render-progress')`, 'export controls restored')
  return { width: 2048, height: 1024, background, nonOpaquePixels: nonOpaque, opaquePixels: opaque, viewport }
}

async function testUi(BrowserWindow, url, temporaryRoot, desktop) {
  const name = desktop ? 'desktop' : 'web'
  const preload = join(temporaryRoot, 'qa-desktop-preload.cjs')
  const window = new BrowserWindow({
    show: false, width: 1440, height: 1000,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false,
      partition: `texture-qa-${name}`,
      ...(desktop ? { preload } : {}),
    },
  })
  const errors = []
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error') errors.push(event.message)
  })
  try {
    console.log(`Texture QA: loading ${name} production UI`)
    await window.loadURL(url)
    await waitFor(window, `!!document.querySelector('.top-export:not(:disabled)')`, `${name} app`)
    await window.webContents.executeJavaScript(`(async () => {
      ${fixtureScript}
      const files = new DataTransfer(); files.items.add(await makeTextureFixture());
      const input = document.querySelector('input[type="file"]');
      input.files = files.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`)
    await waitFor(window, `document.querySelector('.document-name')?.textContent.includes('source-texture-3200x1600')`, 'uploaded source')
    await window.webContents.executeJavaScript(`document.querySelector('.top-export').click()`)
    await waitFor(window, `!!document.querySelector('#export-inspector .export-summary')`, 'export inspector')
    const controls = await window.webContents.executeJavaScript(`({
      buttons: [...document.querySelectorAll('#export-inspector button')].map(b => b.textContent.trim()),
      text: document.querySelector('#export-inspector').textContent,
    })`)
    assert.equal(controls.buttons.includes('4K'), desktop, `${name}: 4K availability`)
    assert.equal(controls.buttons.includes('8K'), desktop, `${name}: 8K availability`)
    assert.equal(/\.glb|GLB/.test(controls.text), desktop, `${name}: GLB availability`)
    assert.equal(/\.blend/.test(controls.text), desktop, `${name}: Blender availability`)
    assert.equal(/STL/.test(controls.text), desktop, `${name}: STL availability`)
    assert.equal(/Recipe JSON/.test(controls.text), desktop, `${name}: recipe availability`)
    assert.ok(controls.text.includes('Height PNG'), `${name}: height-image export retained`)
    if (desktop) assert.match(controls.text, /Source image.*Embedded bitmap/s, 'desktop source material chooser')
    await clickButton(window, 'Straight on')
    const expected = desktop ? '3,200 × 1,600' : '2,048 × 1,024'
    await waitFor(window, `document.querySelector('.source-dimensions')?.textContent.includes(${JSON.stringify(expected)})`, `${name}: straight-on dimensions ${expected}`)
    await clickButton(window, 'Transparent')
    assert.equal(await window.webContents.executeJavaScript(`
      [...document.querySelectorAll('#export-inspector button')].find(b => b.textContent.trim() === 'Transparent')?.getAttribute('aria-pressed')`), 'true')
    await window.webContents.executeJavaScript(`(() => {
      const field = [...document.querySelectorAll('#export-inspector fieldset')].find(f => f.querySelector('legend')?.textContent === 'Background');
      field.querySelectorAll('button')[1].click();
    })()`)
    await waitFor(window, `[...document.querySelectorAll('#export-inspector button')].find(b => b.textContent.trim() === 'Transparent')?.getAttribute('aria-pressed') === 'false'`, 'opaque-background toggle')
    await clickButton(window, 'Living loop')
    const loopButtons = await window.webContents.executeJavaScript(`[...document.querySelectorAll('#export-inspector button')].map(b => b.textContent.trim())`)
    assert.equal(loopButtons.includes('4K'), desktop, `${name}: loop 4K availability`)
    assert.ok(loopButtons.includes('Transparent'), `${name}: loop alpha retained`)
    await clickButton(window, 'Still')
    const imageExports = []
    if (!desktop) {
      await clickButton(window, 'High')
      await clickButton(window, 'Transparent')
      console.log('Texture QA: saving real transparent 2K web PNG')
      imageExports.push(await saveWebPng(window, temporaryRoot, 'transparent'))
      await window.webContents.executeJavaScript(`(() => {
        const field = [...document.querySelectorAll('#export-inspector fieldset')].find(f => f.querySelector('legend')?.textContent === 'Background');
        field.querySelectorAll('button')[1].click();
      })()`)
      console.log('Texture QA: saving real opaque 2K web PNG')
      imageExports.push(await saveWebPng(window, temporaryRoot, 'current'))
    }
    await window.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
    await writeFile(join(temporaryRoot, `${name}-exports.png`), (await window.webContents.capturePage()).toPNG())
    assert.deepEqual(errors, [], `${name}: browser console errors`)
    return { platform: name, straightOn: expected, alpha: true, modelExports: desktop, fourK: desktop, imageExports }
  } finally {
    window.destroy()
  }
}

async function testGlb(BrowserWindow, url, temporaryRoot) {
  const window = new BrowserWindow({ show: false, webPreferences: {
    contextIsolation: true, nodeIntegration: false, sandbox: true, partition: 'texture-qa-codec',
  } })
  try {
    await window.loadURL(new URL('/__texture-qa-blank', url).href)
    const encoded = await window.webContents.executeJavaScript(`(async () => {
      ${fixtureScript}
      const [{ fileToPixelImage }, { encodeSourceTexture }, { buildMesh }, { encodeGlb }, { createDefaultAppearanceSettings }] = await Promise.all([
        import('/src/lib/image.ts'), import('/src/lib/source-texture.ts'), import('/src/lib/mesh.ts'),
        import('/src/lib/export.ts'), import('/src/lib/three.ts'),
      ]);
      const image = await fileToPixelImage(await makeTextureFixture());
      if (image.width !== 1280 || image.height !== 640) throw new Error('Working raster cap regressed');
      const texture = await encodeSourceTexture(image);
      if (texture.width !== 3200 || texture.height !== 1600) throw new Error('Original texture dimensions lost');
      const field = { width: 8, height: 4, values: new Float32Array(32).fill(0.6) };
      const mesh = buildMesh(field, image, { mode: 'solid', resolution: 16, depth: 0.4, midpoint: 0.5, baseThickness: 0.2 });
      const appearance = createDefaultAppearanceSettings(); appearance.clay.finish = 'metallic';
      const glb = new Uint8Array(await encodeGlb(mesh, 'clay', appearance, texture));
      const view = new DataView(glb.buffer); const jsonLength = view.getUint32(12, true);
      const json = JSON.parse(new TextDecoder().decode(glb.slice(20, 20 + jsonLength)));
      const binaryStart = 20 + jsonLength + 8;
      if (json.images?.length !== 1 || json.images[0].uri) throw new Error('Texture is not one embedded image');
      const imageView = json.bufferViews[json.images[0].bufferView];
      const png = glb.slice(binaryStart + (imageView.byteOffset || 0), binaryStart + (imageView.byteOffset || 0) + imageView.byteLength);
      const bitmap = await createImageBitmap(new Blob([png], { type: json.images[0].mimeType }));
      if (bitmap.width !== 3200 || bitmap.height !== 1600) throw new Error('Embedded texture resized');
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0); bitmap.close();
      const samples = [[100,100,[255,0,0,255]],[2000,100,[0,255,0,255]],[100,1400,[0,0,255,255]],
        [2000,1400,[255,255,0,255]],[3001,1303,[255,255,255,255]],[3002,1303,[255,255,0,255]]];
      for (const [x,y,expected] of samples) {
        const actual = [...ctx.getImageData(x,y,1,1).data];
        if (actual.some((value,i) => value !== expected[i])) throw new Error('Source pixel mismatch at '+x+','+y+': '+actual);
      }
      const primitives = json.meshes.flatMap(mesh => mesh.primitives);
      if (primitives.some(p => p.attributes.COLOR_0 !== undefined)) throw new Error('Vertex colors multiply source texture');
      const source = json.materials.findIndex(m => m.pbrMetallicRoughness?.baseColorTexture);
      const neutral = json.materials.findIndex(m => !m.pbrMetallicRoughness?.baseColorTexture);
      if (source < 0 || neutral < 0) throw new Error('Missing front or neutral material');
      for (const material of json.materials) {
        if (material.pbrMetallicRoughness.metallicFactor !== 1 || material.pbrMetallicRoughness.roughnessFactor !== 0.26)
          throw new Error('Metallic finish lost');
      }
      if (!primitives.some(p => p.material === source) || !primitives.some(p => p.material === neutral)) throw new Error('Material assignment missing');
      let binary = ''; for (let i = 0; i < glb.length; i += 8192) binary += String.fromCharCode(...glb.subarray(i, i + 8192));
      return { base64: btoa(binary), width: canvas.width, height: canvas.height, primitives: primitives.length,
        materials: json.materials.map(m => m.name), pixelSamples: samples.length, workingWidth: image.width };
    })()`)
    await writeFile(join(temporaryRoot, 'source-texture.glb'), Buffer.from(encoded.base64, 'base64'))
    delete encoded.base64
    return encoded
  } finally {
    window.destroy()
  }
}

async function testBlender(temporaryRoot) {
  const blender = process.env.RASTERFORM_BLENDER_PATH ?? '/Applications/Blender.app/Contents/MacOS/Blender'
  await access(blender)
  const python = `import bpy, json, math
from pathlib import Path
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=${JSON.stringify(join(temporaryRoot, 'source-texture.glb'))})
objects = [o for o in bpy.data.objects if o.type == 'MESH']
assert len(objects) == 1, 'Expected one imported relief object'
obj = objects[0]
image_nodes = [n for m in obj.data.materials for n in m.node_tree.nodes if n.type == 'TEX_IMAGE']
assert len(image_nodes) == 1, 'Expected one embedded base-color image'
image = image_nodes[0].image
assert list(image.size) == [3200, 1600], 'Blender texture dimensions changed'
assert image.colorspace_settings.name == 'sRGB', 'Base-color image must be sRGB'
for x,y,rgb in [(100,100,[1,0,0]),(2000,100,[0,1,0]),(100,1400,[0,0,1]),(2000,1400,[1,1,0]),(3001,1303,[1,1,1])]:
    offset = ((1600 - 1 - y) * 3200 + x) * 4
    actual = image.pixels[offset:offset+3]
    assert all(abs(actual[i]-rgb[i]) < 0.0001 for i in range(3)), (x,y,list(actual),rgb)
uv = obj.data.uv_layers.active
assert uv is not None, 'Source UV layer missing'
front = 0
neutral = 0
for face in obj.data.polygons:
    material = obj.data.materials[face.material_index]
    textured = any(n.type == 'TEX_IMAGE' for n in material.node_tree.nodes)
    coords = [obj.data.vertices[v].co for v in face.vertices]
    is_front = all(co.y < -0.05 for co in coords)
    assert textured == is_front, 'Texture applied to side/back or absent on front'
    if textured:
        front += 1
        for loop_index in face.loop_indices:
            co = obj.data.vertices[obj.data.loops[loop_index].vertex_index].co
            actual = uv.data[loop_index].uv
            assert abs(actual.x - (co.x / 2 + 0.5)) < 0.00001, 'Horizontal source UV mismatch'
            assert abs(actual.y - (co.z + 0.5)) < 0.00001, 'Vertical source UV flipped'
    else:
        neutral += 1
assert front > 0 and neutral > 0
for material in obj.data.materials:
    shader = next(n for n in material.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    assert abs(shader.inputs['Metallic'].default_value - 1) < 0.00001
    assert abs(shader.inputs['Roughness'].default_value - 0.26) < 0.00001
print('RASTERFORM_TEXTURE_BLENDER ' + json.dumps({'texture': list(image.size), 'frontFaces': front, 'neutralFaces': neutral, 'uvOrientation': 'correct', 'metallic': 1, 'roughness': 0.26}))
`
  const { stdout } = await execFileAsync(blender, ['--background', '--factory-startup', '--python-exit-code', '1', '--python-expr', python], {
    timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
  })
  const line = stdout.split('\n').find(line => line.startsWith('RASTERFORM_TEXTURE_BLENDER '))
  assert.ok(line, 'Blender import verification did not return a result')
  return JSON.parse(line.slice('RASTERFORM_TEXTURE_BLENDER '.length))
}

if (process.versions.electron) {
  const [, , , url, temporaryRoot] = process.argv
  const { app, BrowserWindow } = electron
  console.log('Texture QA: Electron main loaded')
  app.setPath('userData', join(temporaryRoot, 'electron-profile'))
  app.setPath('sessionData', join(temporaryRoot, 'electron-profile'))
  // Electron waits for the main ESM module before emitting ready; awaiting ready
  // at module scope would deadlock startup. Schedule the test after it instead.
  void app.whenReady().then(async () => {
    console.log('Texture QA: Electron ready')
    // The Electron CLI default app quits between isolated test windows unless
    // its default handler is replaced. The harness exits explicitly at the end.
    app.removeAllListeners('window-all-closed')
    app.on('window-all-closed', () => {})
    app.dock?.hide()
    try {
      const codecOnly = process.env.RASTERFORM_TEXTURE_QA_CODEC_ONLY === '1'
      const webUi = codecOnly ? null : await testUi(BrowserWindow, url, temporaryRoot, false)
      const desktopUi = codecOnly ? null : await testUi(BrowserWindow, url, temporaryRoot, true)
      const glb = await testGlb(BrowserWindow, url, temporaryRoot)
      const blender = await testBlender(temporaryRoot)
      console.log(marker + JSON.stringify({ passed: true, webUi, desktopUi, glb, blender }))
      app.exit(0)
    } catch (error) {
      console.error(marker + JSON.stringify({ passed: false, error: error.stack ?? String(error) }))
      app.exit(1)
    }
  })
} else {
  await access(join(project, 'dist/index.html'))
  const { createServer: createViteServer } = await import('vite')
  const retainArtifacts = process.env.RASTERFORM_TEXTURE_QA_ARTIFACTS
  const temporaryRoot = retainArtifacts ? resolve(retainArtifacts) : await mkdtemp(join(tmpdir(), 'rasterform-texture-qa-'))
  await mkdir(temporaryRoot, { recursive: true })
  await writeFile(join(temporaryRoot, 'qa-desktop-preload.cjs'), desktopPreload)
  const vite = await createViteServer({ root: project, server: { middlewareMode: true }, appType: 'custom' })
  const server = createHttpServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname
    if (pathname === '/__texture-qa-blank') {
      response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Texture codec QA</title>'); return
    }
    const builtPath = pathname === '/' ? join(project, 'dist/index.html')
      : pathname.startsWith('/assets/') ? resolve(project, 'dist', `.${pathname}`) : null
    if (builtPath && builtPath.startsWith(join(project, 'dist') + sep)) {
      try {
        const types = { js: 'text/javascript', css: 'text/css', html: 'text/html', woff2: 'font/woff2' }
        response.setHeader('Content-Type', types[basename(builtPath).split('.').at(-1)] ?? 'application/octet-stream')
        response.end(await readFile(builtPath)); return
      } catch {
        response.writeHead(404); response.end('Missing build asset'); return
      }
    }
    vite.middlewares(request, response, () => { response.writeHead(404); response.end('Not found') })
  })
  try {
    await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
    const url = `http://127.0.0.1:${server.address().port}/`
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS; delete env.NODE_EXTRA_CA_CERTS
    const child = spawn(electron, [script, '--electron-child', url, temporaryRoot], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const capture = chunk => { output += chunk; process.stdout.write(chunk) }
    child.stdout.on('data', capture); child.stderr.on('data', capture)
    const timeout = setTimeout(() => child.kill('SIGKILL'), 240_000)
    const code = await new Promise((resolveExit, reject) => { child.once('exit', resolveExit); child.once('error', reject) })
    clearTimeout(timeout)
    const line = output.split('\n').find(line => line.startsWith(marker))
    assert.ok(line, 'Texture smoke did not return a result')
    const result = JSON.parse(line.slice(marker.length))
    assert.equal(code, 0, result.error ?? 'Electron texture smoke failed')
    assert.equal(result.passed, true)
    console.log(`Texture export and platform UI smoke passed.${retainArtifacts ? ` Artifacts: ${temporaryRoot}` : ''}`)
  } finally {
    await vite.close()
    server.closeAllConnections()
    await new Promise(resolveClose => server.close(resolveClose))
    if (!retainArtifacts) await rm(temporaryRoot, { recursive: true, force: true })
  }
}
