import { randomUUID } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  Notification,
  powerSaveBlocker,
  protocol,
  session,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from 'electron'
import {
  assertDesktopFinalRenderSnapshot,
  DESKTOP_LONG_EXPORT_PROTOCOL_VERSION,
  DESKTOP_MAX_PNG_BYTES,
  DESKTOP_PROTOCOL_VERSION,
  isDesktopJobId,
  isDesktopLongExportOutcome,
  isDesktopLongExportStartRequest,
  isDesktopFinalRenderResultMetadata,
  isFinalExportProgress,
  type DesktopFinalCancelResult,
  type DesktopFinalRenderResultMetadata,
  type DesktopFinalRenderSubmission,
  type DesktopFinalRenderSnapshot,
  type DesktopLongExportEndResult,
  type DesktopLongExportErrorCode,
  type DesktopLongExportStartResult,
  type DesktopRenderErrorCode,
  type DesktopRenderEvent,
  type DesktopSavedFinalResult,
} from '../src/desktop/contracts'
import type { FinalExportProgress } from '../src/lib/final-image-export'
import { finalSampleTarget, finalTileCount } from '../src/lib/final-quality'
import {
  DESKTOP_SMOKE_HEARTBEAT_MAX_ATTEMPTS,
  DESKTOP_SMOKE_HEARTBEAT_REQUIRED_BEATS,
  desktopSmokeHeartbeatBeatsDuringBlock,
  ensurePngPath,
  finalRenderCancellationAction,
  finalRenderCompletionAction,
  isPngBytes,
  isLivingLoopDownload,
  isDesktopSmokeHeartbeatResponsive,
  resolveProtocolFile,
  safeFileSystemErrorMessage,
  sanitizePngFileName,
  shouldCancelFinalJobOnEditorClose,
  writePngAtomically,
  type DesktopJobState,
} from './main-helpers'
import { NativeLongExportLifecycle } from './long-export-lifecycle'

const SCHEME = 'rasterform'
const APP_URL = `${SCHEME}://app/index.html`
const RENDER_URL = `${SCHEME}://render/index.html`
const CANCEL_GRACE_MS = 1_500
const PREPARED_JOB_TTL_MS = 2 * 60_000
const TERMINAL_JOB_TTL_MS = 5 * 60_000
const PREFERENCES_FILE = 'desktop-preferences.json'
const SMOKE_MODE = process.env.RASTERFORM_DESKTOP_SMOKE === '1'

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    codeCache: true,
    stream: true,
  },
}])

interface PreparedJob {
  id: string
  ownerWebContentsId: number
  destination: string
  snapshot: DesktopFinalRenderSnapshot | null
  state: DesktopJobState
  renderWindow: BrowserWindow | null
  sleepBlockerId: number | null
  cancelTimer: ReturnType<typeof setTimeout> | null
  preparedTimer: ReturnType<typeof setTimeout> | null
}

interface TerminalJob {
  ownerWebContentsId: number
  result: Exclude<DesktopFinalCancelResult, { state: 'cancelling' } | { state: 'saving' }>
  expiryTimer: ReturnType<typeof setTimeout>
}

let mainWindow: BrowserWindow | null = null
let lastExportPath: string | null = null
let lastExportDirectory: string | null = null
let saveDialogOpen = false
let quitting = false
const jobs = new Map<string, PreparedJob>()
const terminalJobs = new Map<string, TerminalJob>()
const pendingWrites = new Set<Promise<void>>()
const longExports = new NativeLongExportLifecycle(powerSaveBlocker, {
  setBackgroundThrottling: (allowed) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      if (!allowed) throw new Error('The editor renderer is unavailable.')
      return
    }
    mainWindow.webContents.setBackgroundThrottling(allowed)
  },
})

function appRoot(): string {
  return app.getAppPath()
}

function isTrustedAppSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return Boolean(
    mainWindow
    && !mainWindow.isDestroyed()
    && event.sender.id === mainWindow.webContents.id
    && event.senderFrame?.url.startsWith(`${SCHEME}://app/`),
  )
}

function isTrustedRenderSender(event: IpcMainEvent, job: PreparedJob): boolean {
  return Boolean(
    job.renderWindow
    && !job.renderWindow.isDestroyed()
    && event.sender.id === job.renderWindow.webContents.id
    && event.senderFrame?.url.startsWith(`${SCHEME}://render/`),
  )
}

function emitToEditor(event: DesktopRenderEvent): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  try {
    mainWindow.webContents.send('desktop:final-render-event', event)
  } catch {
    // The visible window can close between the liveness check and IPC send.
  }
}

function stopJobResources(job: PreparedJob, clearDockProgress = true): void {
  if (job.preparedTimer) {
    clearTimeout(job.preparedTimer)
    job.preparedTimer = null
  }
  if (job.cancelTimer) {
    clearTimeout(job.cancelTimer)
    job.cancelTimer = null
  }
  if (job.sleepBlockerId !== null) {
    try {
      if (powerSaveBlocker.isStarted(job.sleepBlockerId)) powerSaveBlocker.stop(job.sleepBlockerId)
    } catch {
      // Cleanup is best-effort after a renderer or app-process failure.
    }
  }
  job.sleepBlockerId = null
  if (clearDockProgress && mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(-1)
  const renderWindow = job.renderWindow
  job.renderWindow = null
  if (renderWindow && !renderWindow.isDestroyed()) {
    try {
      renderWindow.destroy()
    } catch {
      // The renderer may already be tearing down after a process failure.
    }
  }
}

function rememberTerminalJob(
  job: PreparedJob,
  result: TerminalJob['result'],
): void {
  const previous = terminalJobs.get(job.id)
  if (previous) clearTimeout(previous.expiryTimer)
  const expiryTimer = setTimeout(() => terminalJobs.delete(job.id), TERMINAL_JOB_TTL_MS)
  expiryTimer.unref()
  terminalJobs.set(job.id, {
    ownerWebContentsId: job.ownerWebContentsId,
    result,
    expiryTimer,
  })
}

function takeJob(jobId: string): PreparedJob | null {
  const job = jobs.get(jobId)
  if (!job) return null
  jobs.delete(jobId)
  stopJobResources(job)
  installApplicationMenu()
  return job
}

function failJob(
  jobId: string,
  code: DesktopRenderErrorCode,
  message: string,
): void {
  const job = takeJob(jobId)
  if (!job) return
  rememberTerminalJob(job, { state: 'error', error: { code, message } })
  emitToEditor({ type: 'error', jobId, code, message })
  showCompletionNotification('Rasterform render failed', message)
}

function cancelJob(jobId: string): void {
  const job = takeJob(jobId)
  if (!job) return
  rememberTerminalJob(job, { state: 'cancelled' })
  emitToEditor({ type: 'cancelled', jobId })
}

function showCompletionNotification(title: string, body: string): void {
  if (mainWindow?.isFocused() || !Notification.isSupported()) return
  try {
    new Notification({ title, body, silent: false }).show()
  } catch {
    // Unsigned development builds cannot show macOS notifications.
  }
}

function dockProgress(progress: FinalExportProgress): number {
  const value = Math.max(0, Math.min(1, progress.progress))
  if (progress.phase === 'preparing') return 0.02 + value * 0.08
  if (progress.phase === 'finishing') return 0.96 + value * 0.04
  return 0.1 + value * 0.86
}

function isExpectedRenderProgress(
  progress: FinalExportProgress,
  snapshot: DesktopFinalRenderSnapshot,
): boolean {
  const targetSamples = finalSampleTarget(snapshot.colorMode, snapshot.appearance)
  const tiles = finalTileCount(snapshot.width, snapshot.height)
  if (progress.targetSamples !== targetSamples) return false
  if (progress.phase === 'preparing') {
    return progress.tile === 0
      && progress.samples === 0
      && (progress.tiles === 0 || progress.tiles === tiles)
  }
  if (progress.phase === 'finishing') {
    return progress.tile === tiles
      && progress.tiles === tiles
      && progress.samples === targetSamples
  }
  if (progress.tiles !== tiles || progress.tile < 1) return false
  const expectedProgress = (
    (progress.tile - 1) * targetSamples + progress.samples
  ) / (tiles * targetSamples)
  return progress.progress === expectedProgress
}

function isExpectedRenderResult(
  value: unknown,
  snapshot: DesktopFinalRenderSnapshot,
): value is DesktopFinalRenderResultMetadata {
  return isDesktopFinalRenderResultMetadata(value)
    && value.width === snapshot.width
    && value.height === snapshot.height
    && value.dpi === 300
    && value.samples === finalSampleTarget(snapshot.colorMode, snapshot.appearance)
    && value.tiles === finalTileCount(snapshot.width, snapshot.height)
}

function configureWindowSecurity(window: BrowserWindow, allowedPrefix: string): void {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(allowedPrefix)) event.preventDefault()
  })
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 980,
    minHeight: 680,
    show: false,
    backgroundColor: '#1f1f1f',
    title: 'Rasterform',
    webPreferences: {
      preload: join(appRoot(), 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false,
      spellcheck: true,
    },
  })
  const ownerWebContentsId = window.webContents.id
  configureWindowSecurity(window, `${SCHEME}://app/`)
  window.once('ready-to-show', () => window.show())
  window.on('close', (event) => {
    const active = longExports.active
    if (!active || active.ownerWebContentsId !== ownerWebContentsId) return
    const choice = dialog.showMessageBoxSync(window, {
      type: 'warning',
      title: 'Living Loop export in progress',
      message: 'Keep Rasterform open until the Living Loop finishes?',
      detail: 'Closing now stops Rasterform’s active export. Any ZIP still being written will be cancelled.',
      buttons: ['Keep Exporting', 'Stop Export and Close'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    if (choice === 0) {
      event.preventDefault()
      // A deferred quit may have set this while waiting for a Final atomic write.
      quitting = false
      return
    }
    longExports.releaseActive(true)
  })
  window.on('closed', () => {
    longExports.releaseOwner(ownerWebContentsId)
    if (mainWindow === window) mainWindow = null
    for (const job of [...jobs.values()]) {
      // Once the atomic write starts, closing the editor must not turn a file
      // that may successfully land on disk into a reported cancellation.
      if (shouldCancelFinalJobOnEditorClose(job.state)) cancelJob(job.id)
    }
  })
  window.webContents.on('render-process-gone', () => {
    longExports.releaseOwner(ownerWebContentsId)
    for (const job of [...jobs.values()]) {
      if (shouldCancelFinalJobOnEditorClose(job.state)) {
        failJob(job.id, 'process-gone', 'The editor process stopped unexpectedly. Your design is safe.')
      }
    }
  })
  void window.loadURL(APP_URL).catch(() => {
    if (!window.isDestroyed()) window.destroy()
    dialog.showErrorBox(
      'Rasterform could not open',
      'The editor interface could not be loaded. Quit Rasterform and try again.',
    )
    app.quit()
  })
  return window
}

function createRenderWindow(job: PreparedJob): BrowserWindow {
  const window = new BrowserWindow({
    width: 640,
    height: 480,
    show: false,
    paintWhenInitiallyHidden: true,
    skipTaskbar: true,
    focusable: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(appRoot(), 'render-preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  })
  configureWindowSecurity(window, `${SCHEME}://render/`)
  window.webContents.on('render-process-gone', (_event, details) => {
    // Intentional completion/cancellation clears job.renderWindow before
    // destroying it. Only a still-owned renderer can fail the active job.
    if (!jobs.has(job.id) || job.renderWindow !== window) return
    if (job.state === 'cancelling') cancelJob(job.id)
    else failJob(job.id, 'process-gone', `The Final render process stopped (${details.reason}). Your design is safe.`)
  })
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    if (jobs.has(job.id) && job.renderWindow === window) {
      if (job.state === 'cancelling') cancelJob(job.id)
      else failJob(job.id, 'render-failed', 'The separate Final renderer could not load. Your design is safe.')
    }
  })
  // A legitimate first path-traced sample can spend a long time compiling. Do
  // not impose an invented timeout; hard cancellation remains available by
  // destroying this isolated window from the main process.
  window.on('unresponsive', () => undefined)
  return window
}

async function runDesktopSmokeProbe(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error('The editor window is unavailable.')
  const editor = mainWindow
  const editorBounds = editor.getBounds()
  const probe = new BrowserWindow({
    width: 320,
    height: 240,
    show: false,
    paintWhenInitiallyHidden: true,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      preload: join(appRoot(), 'render-preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  })
  configureWindowSecurity(probe, `${SCHEME}://render/`)
  try {
    await probe.loadURL(RENDER_URL)
    const [editorCapabilities, hdr, assetNames] = await Promise.all([
      editor.webContents.executeJavaScript(`(async () => {
        const bridge = window.rasterformDesktop;
        const result = {
          protocolVersion: bridge?.protocolVersion ?? null,
          longExportProtocolVersion: bridge?.longExportProtocolVersion ?? null,
          longExportLifecycleAvailable: (
            typeof bridge?.beginLongExport === 'function'
            && typeof bridge?.endLongExport === 'function'
          ),
          longExportLifecycleHandshake: false,
          localFontApiAvailable: typeof window.queryLocalFonts === 'function',
        };
        if (!result.longExportLifecycleAvailable) return result;
        try {
          const started = await bridge.beginLongExport({
            protocolVersion: ${DESKTOP_LONG_EXPORT_PROTOCOL_VERSION},
            kind: 'living-loop',
            frames: 12,
          });
          if (!started?.accepted) return result;
          const ended = await bridge.endLongExport(started.jobId, 'cancelled');
          result.longExportLifecycleHandshake = ended?.ended === true;
        } catch {}
        return result;
      })()`),
      probe.webContents.executeJavaScript(`fetch('/hdri/studio_small_08_1k.hdr').then(async response => ({ ok: response.ok, bytes: (await response.arrayBuffer()).byteLength }))`),
      readdir(join(appRoot(), 'render', 'assets')),
    ])
    const bvhWorker = assetNames.find((name) => /^generateMeshBVH\.worker-.*\.js$/.test(name))
    if (!bvhWorker) throw new Error('The packaged BVH worker is missing.')
    const workerHandshake = await probe.webContents.executeJavaScript(`new Promise((resolve) => {
      const worker = new Worker(${JSON.stringify(`/assets/${bvhWorker}`)}, { type: 'module' });
      let settled = false;
      const timeout = setTimeout(() => finish(false), 5_000);
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        worker.terminate();
        resolve(value);
      };
      worker.onerror = () => finish(false);
      worker.onmessage = ({ data }) => {
        if (data?.error) return finish(false);
        if (!data?.serialized) return;
        const roots = Array.isArray(data.serialized.roots) ? data.serialized.roots : [];
        const rootBytes = roots.reduce((total, root) => total + (root?.byteLength ?? 0), 0);
        finish(
          data.progress === 1
          && rootBytes > 0
          && data.position instanceof Float32Array
          && data.position.length === 9
          && data.serialized.index?.length === 3
        );
      };
      const position = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
      const index = new Uint16Array([0, 1, 2]);
      worker.postMessage({
        index,
        position,
        options: { groups: [], includedProgressCallback: false, targetLeafSize: 1 },
      }, [position.buffer, index.buffer]);
    })`)

    let blockedFor = 0
    let beats = 0
    let heartbeatAttempts = 0
    for (let attempt = 1; attempt <= DESKTOP_SMOKE_HEARTBEAT_MAX_ATTEMPTS; attempt += 1) {
      heartbeatAttempts = attempt
      const heartbeatReady = await editor.webContents.executeJavaScript(`new Promise((resolve) => {
        const key = '__rasterformDesktopSmokeHeartbeat';
        const previous = window[key];
        if (previous?.interval) clearInterval(previous.interval);
        const state = { ticks: [], interval: null };
        window[key] = state;
        state.interval = setInterval(() => { state.ticks.push(Date.now()) }, 40);
        const deadline = Date.now() + 600;
        const check = () => {
          if (state.ticks.length > 0 || Date.now() >= deadline) resolve(state.ticks.length > 0);
          else setTimeout(check, 20);
        };
        check();
      })`)
      if (!heartbeatReady) {
        await editor.webContents.executeJavaScript(`(() => {
          const state = window.__rasterformDesktopSmokeHeartbeat;
          if (state?.interval) clearInterval(state.interval);
          delete window.__rasterformDesktopSmokeHeartbeat;
        })()`)
        continue
      }

      const blockWindow = await probe.webContents.executeJavaScript(`(() => {
        const startedAt = Date.now();
        const start = performance.now();
        while (performance.now() - start < 1_000) {}
        return {
          startedAt,
          endedAt: Date.now(),
          blockedMilliseconds: performance.now() - start,
        };
      })()`)
      const tickTimestamps = await editor.webContents.executeJavaScript(`(() => {
        const state = window.__rasterformDesktopSmokeHeartbeat;
        if (!state) return [];
        clearInterval(state.interval);
        delete window.__rasterformDesktopSmokeHeartbeat;
        return state.ticks;
      })()`)
      blockedFor = Number(blockWindow?.blockedMilliseconds)
      beats = desktopSmokeHeartbeatBeatsDuringBlock(
        tickTimestamps,
        blockWindow?.startedAt,
        blockWindow?.endedAt,
      )
      if (blockedFor >= 900 && isDesktopSmokeHeartbeatResponsive(
        tickTimestamps,
        blockWindow?.startedAt,
        blockWindow?.endedAt,
      )) break
    }
    const result = {
      protocolVersion: editorCapabilities.protocolVersion,
      longExportProtocolVersion: editorCapabilities.longExportProtocolVersion,
      longExportLifecycleAvailable: editorCapabilities.longExportLifecycleAvailable === true,
      longExportLifecycleHandshake: editorCapabilities.longExportLifecycleHandshake === true,
      localFontApiAvailable: editorCapabilities.localFontApiAvailable === true,
      editorPid: editor.webContents.getOSProcessId(),
      renderPid: probe.webContents.getOSProcessId(),
      renderHidden: !probe.isVisible(),
      editorBoundsUnchanged: JSON.stringify(editor.getBounds()) === JSON.stringify(editorBounds),
      hdrLoaded: Boolean(hdr?.ok && hdr.bytes > 1_000),
      bvhWorkerLoaded: workerHandshake === true,
      hiddenBlockedMilliseconds: Math.round(Number(blockedFor)),
      editorHeartbeatBeats: Number(beats),
      heartbeatAttempts,
    }
    const passed = result.protocolVersion === DESKTOP_PROTOCOL_VERSION
      && result.longExportProtocolVersion === DESKTOP_LONG_EXPORT_PROTOCOL_VERSION
      && result.longExportLifecycleAvailable
      && result.longExportLifecycleHandshake
      && result.editorPid > 0
      && result.renderPid > 0
      && result.editorPid !== result.renderPid
      && result.renderHidden
      && result.editorBoundsUnchanged
      && result.hdrLoaded
      && result.bvhWorkerLoaded
      && result.hiddenBlockedMilliseconds >= 900
      && result.editorHeartbeatBeats >= DESKTOP_SMOKE_HEARTBEAT_REQUIRED_BEATS
    console.log(`RASTERFORM_DESKTOP_SMOKE ${JSON.stringify({ passed, ...result })}`)
    if (!passed) throw new Error('The desktop runtime smoke probe failed.')
  } finally {
    if (!probe.isDestroyed()) probe.destroy()
  }
}

async function loadPreferences(): Promise<void> {
  try {
    const source = await readFile(join(app.getPath('userData'), PREFERENCES_FILE), 'utf8')
    const parsed = JSON.parse(source) as { lastExportDirectory?: unknown }
    if (typeof parsed.lastExportDirectory === 'string') lastExportDirectory = parsed.lastExportDirectory
  } catch {
    // First launch and damaged optional preferences both fall back to Downloads.
  }
}

async function savePreferences(): Promise<void> {
  try {
    await writeFile(
      join(app.getPath('userData'), PREFERENCES_FILE),
      `${JSON.stringify({ version: 1, lastExportDirectory }, null, 2)}\n`,
      'utf8',
    )
  } catch {
    // Remembering a folder must never turn a successful render into a failure.
  }
}

async function prepareFinalSave(event: IpcMainInvokeEvent, suggestedName: unknown) {
  if (!isTrustedAppSender(event)) throw new Error('Untrusted Final render request.')
  if (saveDialogOpen || jobs.size > 0 || longExports.active) {
    throw new Error('Another export is already active.')
  }
  const fileName = sanitizePngFileName(suggestedName)
  const defaultPath = join(lastExportDirectory ?? app.getPath('downloads'), fileName)
  saveDialogOpen = true
  try {
    let result: Awaited<ReturnType<typeof dialog.showSaveDialog>>
    try {
      result = await dialog.showSaveDialog(mainWindow!, {
        title: 'Save Final PNG',
        buttonLabel: 'Render and Save',
        defaultPath,
        filters: [{ name: 'PNG image', extensions: ['png'] }],
        properties: ['createDirectory', 'showOverwriteConfirmation'],
      })
    } catch {
      throw new Error('The macOS Save dialog could not be opened.')
    }
    if (result.canceled || !result.filePath) return { cancelled: true as const }
    const destination = ensurePngPath(result.filePath)
    const job: PreparedJob = {
      id: randomUUID(),
      ownerWebContentsId: event.sender.id,
      destination,
      snapshot: null,
      state: 'prepared',
      renderWindow: null,
      sleepBlockerId: null,
      cancelTimer: null,
      preparedTimer: null,
    }
    job.preparedTimer = setTimeout(() => {
      const current = jobs.get(job.id)
      if (current === job && current.state === 'prepared') {
        failJob(
          job.id,
          'request-expired',
          'The Final save reservation expired before rendering started. Try Final again.',
        )
      }
    }, PREPARED_JOB_TTL_MS)
    job.preparedTimer.unref()
    jobs.set(job.id, job)
    installApplicationMenu()
    return { cancelled: false as const, jobId: job.id }
  } finally {
    saveDialogOpen = false
  }
}

function rejectedSubmission(
  code: DesktopRenderErrorCode,
  message: string,
): Extract<DesktopFinalRenderSubmission, { accepted: false }> {
  return { accepted: false, error: { code, message } }
}

function rejectedLongExport(
  code: DesktopLongExportErrorCode,
  message: string,
): Extract<DesktopLongExportStartResult, { accepted: false }> {
  return { accepted: false, error: { code, message } }
}

function beginLongExport(
  event: IpcMainInvokeEvent,
  request: unknown,
): DesktopLongExportStartResult {
  if (!isTrustedAppSender(event) || !isDesktopLongExportStartRequest(request)) {
    return rejectedLongExport('invalid-request', 'The long export lifecycle request was invalid.')
  }
  if (saveDialogOpen || jobs.size > 0) {
    return rejectedLongExport('busy', 'Another export is already active.')
  }
  return longExports.begin(event.sender.id, request, randomUUID)
}

async function endLongExport(
  event: IpcMainInvokeEvent,
  jobId: unknown,
  outcome: unknown,
): Promise<DesktopLongExportEndResult> {
  if (!isTrustedAppSender(event)
    || !isDesktopJobId(jobId)
    || !isDesktopLongExportOutcome(outcome)) return { ended: false }
  return { ended: await longExports.end(event.sender.id, jobId, outcome) }
}

async function submitFinalRender(
  event: IpcMainInvokeEvent,
  jobId: unknown,
  snapshot: unknown,
): Promise<DesktopFinalRenderSubmission> {
  const unavailable = rejectedSubmission(
    'request-expired',
    'The Final save reservation is no longer available. Open Final and choose the destination again.',
  )
  if (!isTrustedAppSender(event) || typeof jobId !== 'string') return unavailable
  const job = jobs.get(jobId)
  if (!job || job.ownerWebContentsId !== event.sender.id || job.state !== 'prepared') {
    const terminal = terminalJobs.get(jobId)
    if (terminal?.ownerWebContentsId === event.sender.id && terminal.result.state === 'error') {
      return { accepted: false, error: terminal.result.error }
    }
    return unavailable
  }
  try {
    assertDesktopFinalRenderSnapshot(snapshot)
  } catch {
    const failure = rejectedSubmission('render-failed', 'The Final render request was invalid.')
    failJob(job.id, failure.error.code, failure.error.message)
    return failure
  }
  job.snapshot = snapshot
  job.state = 'rendering'
  if (job.preparedTimer) {
    clearTimeout(job.preparedTimer)
    job.preparedTimer = null
  }
  try {
    job.sleepBlockerId = powerSaveBlocker.start('prevent-app-suspension')
  } catch {
    const failure = rejectedSubmission(
      'render-failed',
      'Rasterform could not protect the Final render from system sleep. Your design is safe.',
    )
    failJob(job.id, failure.error.code, failure.error.message)
    return failure
  }
  mainWindow?.setProgressBar(0)
  let renderWindow: BrowserWindow
  try {
    renderWindow = createRenderWindow(job)
  } catch {
    const failure = rejectedSubmission(
      'render-failed',
      'The separate Final renderer could not start. Your design is safe.',
    )
    failJob(job.id, failure.error.code, failure.error.message)
    return failure
  }
  job.renderWindow = renderWindow
  let loading: Promise<void>
  try {
    loading = renderWindow.loadURL(RENDER_URL)
  } catch {
    const failure = rejectedSubmission(
      'render-failed',
      'The separate Final renderer could not load. Your design is safe.',
    )
    failJob(job.id, failure.error.code, failure.error.message)
    return failure
  }
  void loading.then(() => {
    if (jobs.get(job.id) !== job) return
    if (job.state === 'rendering') {
      try {
        renderWindow.webContents.send('desktop:render-start', { jobId: job.id, snapshot })
      } catch {
        failJob(
          job.id,
          'render-failed',
          'The separate Final renderer could not receive the render request. Your design is safe.',
        )
      }
    } else if (job.state === 'cancelling') {
      // Cancellation can arrive while the isolated page is loading. The hard
      // grace timer owns termination, so the client still receives cancellation.
      try {
        renderWindow.webContents.send('desktop:render-cancel', job.id)
      } catch {
        cancelJob(job.id)
      }
    }
  }).catch(() => {
    if (jobs.get(job.id) === job) {
      if (job.state === 'cancelling') cancelJob(job.id)
      else {
        failJob(
          job.id,
          'render-failed',
          'The separate Final renderer could not load. Your design is safe.',
        )
      }
    }
  })
  installApplicationMenu()
  return { accepted: true }
}

function cancellationError(message: string): DesktopFinalCancelResult {
  return { state: 'error', error: { code: 'request-expired', message } }
}

function requestCancel(event: IpcMainInvokeEvent, jobId: unknown): DesktopFinalCancelResult {
  const unavailable = cancellationError(
    'The Final render is no longer active. Open Final to start another render.',
  )
  if (!isTrustedAppSender(event) || typeof jobId !== 'string') return unavailable
  const job = jobs.get(jobId)
  if (!job || job.ownerWebContentsId !== event.sender.id) {
    const terminal = terminalJobs.get(jobId)
    return terminal?.ownerWebContentsId === event.sender.id ? terminal.result : unavailable
  }
  const action = finalRenderCancellationAction(job.state)
  if (action === 'cancel-now') {
    cancelJob(job.id)
    return { state: 'cancelled' }
  }
  if (action === 'finish-save') return { state: 'saving' }
  if (action === 'await-cancel') return { state: 'cancelling' }
  job.state = 'cancelling'
  try {
    job.renderWindow?.webContents.send('desktop:render-cancel', job.id)
  } catch {
    cancelJob(job.id)
    return { state: 'cancelled' }
  }
  job.cancelTimer = setTimeout(() => cancelJob(job.id), CANCEL_GRACE_MS)
  installApplicationMenu()
  return { state: 'cancelling' }
}

function handleRenderProgress(event: IpcMainEvent, jobId: unknown, progress: unknown): void {
  if (typeof jobId !== 'string') return
  const job = jobs.get(jobId)
  if (!job
    || job.state !== 'rendering'
    || !job.snapshot
    || !isTrustedRenderSender(event, job)
    || !isFinalExportProgress(progress)
    || !isExpectedRenderProgress(progress, job.snapshot)) return
  const acceptedProgress: FinalExportProgress = {
    phase: progress.phase,
    progress: progress.progress,
    tile: progress.tile,
    tiles: progress.tiles,
    samples: progress.samples,
    targetSamples: progress.targetSamples,
  }
  mainWindow?.setProgressBar(dockProgress(acceptedProgress))
  emitToEditor({ type: 'progress', jobId, progress: acceptedProgress })
}

function handleRenderCancelled(event: IpcMainEvent, jobId: unknown): void {
  if (typeof jobId !== 'string') return
  const job = jobs.get(jobId)
  if (!job || !isTrustedRenderSender(event, job) || job.state !== 'cancelling') return
  cancelJob(job.id)
}

function handleRenderFailed(event: IpcMainEvent, jobId: unknown, _message: unknown): void {
  if (typeof jobId !== 'string') return
  const job = jobs.get(jobId)
  if (!job || !isTrustedRenderSender(event, job)) return
  const action = finalRenderCompletionAction(job.state)
  if (action === 'cancel') {
    cancelJob(job.id)
    return
  }
  if (action !== 'accept') return
  failJob(
    job.id,
    'render-failed',
    'The separate Final renderer could not finish. Your design is safe.',
  )
}

function handleRenderComplete(
  event: IpcMainEvent,
  jobId: unknown,
  metadata: unknown,
  png: unknown,
): void {
  if (typeof jobId !== 'string') return
  const job = jobs.get(jobId)
  if (!job || !isTrustedRenderSender(event, job)) return
  const action = finalRenderCompletionAction(job.state)
  if (action === 'cancel') {
    // Cancellation wins even if the renderer posts completion before it sees
    // the abort. No bytes are written after the user was promised cancellation.
    cancelJob(job.id)
    return
  }
  if (action !== 'accept') return
  if (
    !job.snapshot
    || !isExpectedRenderResult(metadata, job.snapshot)
    || !isPngBytes(png, {
      width: job.snapshot.width,
      height: job.snapshot.height,
      transparent: job.snapshot.background === 'transparent',
      dpi: 300,
    }, DESKTOP_MAX_PNG_BYTES)
  ) {
    failJob(job.id, 'render-failed', 'The Final renderer returned an invalid PNG.')
    return
  }

  job.state = 'writing'
  stopJobResources(job, false)
  mainWindow?.setProgressBar(1)
  const bytes = new Uint8Array(png)
  const acceptedMetadata = {
    width: metadata.width,
    height: metadata.height,
    dpi: metadata.dpi,
    samples: metadata.samples,
    tiles: metadata.tiles,
  }
  const write = (async () => {
    try {
      await writePngAtomically(job.destination, bytes)
      if (!jobs.has(job.id)) return
      const result: DesktopSavedFinalResult = {
        width: acceptedMetadata.width,
        height: acceptedMetadata.height,
        dpi: acceptedMetadata.dpi,
        samples: acceptedMetadata.samples,
        tiles: acceptedMetadata.tiles,
        fileName: sanitizePngFileName(job.destination),
      }
      rememberTerminalJob(job, { state: 'saved', result })
      jobs.delete(job.id)
      mainWindow?.setProgressBar(-1)
      lastExportPath = job.destination
      lastExportDirectory = dirname(job.destination)
      void savePreferences()
      emitToEditor({ type: 'saved', jobId: job.id, result })
      installApplicationMenu()
      showCompletionNotification(
        'Rasterform Final saved',
        `${result.width.toLocaleString()} × ${result.height.toLocaleString()} · ${result.samples.toLocaleString()} samples`,
      )
    } catch (error) {
      if (jobs.has(job.id)) {
        const message = safeFileSystemErrorMessage(error)
        rememberTerminalJob(job, {
          state: 'error',
          error: { code: 'save-failed', message },
        })
        jobs.delete(job.id)
        mainWindow?.setProgressBar(-1)
        emitToEditor({
          type: 'error',
          jobId: job.id,
          code: 'save-failed',
          message,
        })
        installApplicationMenu()
        showCompletionNotification('Rasterform could not save Final', message)
      }
    }
  })()
  pendingWrites.add(write)
  void write.finally(() => pendingWrites.delete(write))
}

function cancelActiveFromMenu(): void {
  const job = [...jobs.values()].find((candidate) => candidate.state === 'rendering')
  if (!job) return
  job.state = 'cancelling'
  try {
    job.renderWindow?.webContents.send('desktop:render-cancel', job.id)
  } catch {
    cancelJob(job.id)
    return
  }
  job.cancelTimer = setTimeout(() => cancelJob(job.id), CANCEL_GRACE_MS)
  installApplicationMenu()
}

function installApplicationMenu(): void {
  const active = [...jobs.values()].some((job) => job.state === 'rendering' || job.state === 'cancelling')
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'Reveal Last Export in Finder',
          enabled: Boolean(lastExportPath),
          click: () => { if (lastExportPath) shell.showItemInFolder(lastExportPath) },
        },
        {
          label: 'Cancel Final Render',
          accelerator: 'CommandOrControl+.',
          enabled: active,
          click: cancelActiveFromMenu,
        },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function installProtocol(): void {
  protocol.handle(SCHEME, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } })
    }
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response('Bad request', { status: 400 })
    }
    const root = url.hostname === 'app'
      ? join(appRoot(), 'web')
      : url.hostname === 'render'
        ? join(appRoot(), 'render')
        : null
    if (!root || url.username || url.password || url.port) return new Response('Not found', { status: 404 })
    const file = resolveProtocolFile(root, url.pathname)
    if (!file) return new Response('Not found', { status: 404 })
    try {
      const response = await net.fetch(pathToFileURL(file).toString())
      const headers = new Headers(response.headers)
      headers.set('Content-Security-Policy', [
        "default-src 'self'",
        "script-src 'self'",
        "worker-src 'self' blob:",
        "connect-src 'self'",
        "img-src 'self' data: blob:",
        "style-src 'self' 'unsafe-inline'",
        "font-src 'self' data: blob:",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; '))
      headers.set('Permissions-Policy', 'local-fonts=(self)')
      return new Response(request.method === 'HEAD' ? null : response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

function installIpc(): void {
  ipcMain.handle('desktop:prepare-final-save', prepareFinalSave)
  ipcMain.handle('desktop:submit-final-render', submitFinalRender)
  ipcMain.handle('desktop:cancel-final-render', requestCancel)
  ipcMain.handle('desktop:begin-long-export', beginLongExport)
  ipcMain.handle('desktop:end-long-export', endLongExport)
  ipcMain.on('desktop:render-progress', handleRenderProgress)
  ipcMain.on('desktop:render-cancelled', handleRenderCancelled)
  ipcMain.on('desktop:render-failed', handleRenderFailed)
  ipcMain.on('desktop:render-complete', handleRenderComplete)
}

function installPermissionPolicy(): void {
  const mayReadLocalFonts = (
    webContents: Electron.WebContents | null,
    permission: string,
    requestingUrl: string | undefined,
    isMainFrame: boolean,
  ) => Boolean(
    permission === 'local-fonts'
    && isMainFrame
    && mainWindow
    && webContents?.id === mainWindow.webContents.id
    && requestingUrl?.startsWith(`${SCHEME}://app/`),
  )
  // Native Save As, notifications, filesystem access, and sleep protection all
  // live in main. Local Font Access is the sole renderer permission, restricted
  // to the visible app's main frame; Electron's generated type union currently
  // omits Chromium's runtime `local-fonts` string.
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => (
    mayReadLocalFonts(webContents, permission as string, details.requestingUrl ?? requestingOrigin, details.isMainFrame)
  ))
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(mayReadLocalFonts(
      webContents,
      permission as string,
      'requestingUrl' in details ? details.requestingUrl : undefined,
      'isMainFrame' in details ? details.isMainFrame : false,
    ))
  })
}

function installLongExportDownloadLifecycle(): void {
  session.defaultSession.on('will-download', (_event, item, webContents) => {
    const job = longExports.active
    if (!job
      || !webContents
      || webContents.id !== job.ownerWebContentsId
      || !isLivingLoopDownload(item.getURL(), item.getFilename())) return

    const attached = longExports.attachDownload(
      webContents.id,
      job.id,
      () => item.cancel(),
    )
    if (!attached) return
    item.once('done', (_downloadEvent, state) => {
      if (state === 'completed') {
        const savePath = item.getSavePath()
        if (savePath) {
          lastExportPath = savePath
          lastExportDirectory = dirname(savePath)
          try {
            app.addRecentDocument(savePath)
          } catch {
            // Recent Documents is optional; the completed ZIP remains valid.
          }
          void savePreferences()
          installApplicationMenu()
          showCompletionNotification(
            'Rasterform Living Loop saved',
            `${job.request.frames.toLocaleString()} lossless frames · ${item.getFilename()}`,
          )
        }
      }
      longExports.finishDownload(job.id, state)
    })
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.setName('Rasterform')
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.on('before-quit', (event) => {
    if (quitting || pendingWrites.size === 0) return
    event.preventDefault()
    quitting = true
    void Promise.allSettled([...pendingWrites]).then(() => app.quit())
  })

  app.whenReady().then(async () => {
    installProtocol()
    installIpc()
    installPermissionPolicy()
    installLongExportDownloadLifecycle()
    await loadPreferences()
    installApplicationMenu()
    mainWindow = createMainWindow()
    if (SMOKE_MODE) {
      mainWindow.webContents.once('did-finish-load', () => {
        void runDesktopSmokeProbe().then(
          () => app.quit(),
          (error) => {
            console.error(`RASTERFORM_DESKTOP_SMOKE_ERROR ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
            process.exitCode = 1
            app.quit()
          },
        )
      })
    }
    app.on('activate', () => {
      if (!mainWindow) {
        try {
          mainWindow = createMainWindow()
        } catch {
          dialog.showErrorBox(
            'Rasterform could not open',
            'macOS could not create the Rasterform editor window. Quit Rasterform and try again.',
          )
        }
      } else mainWindow.show()
    })
  }).catch((error) => {
    void dialog.showErrorBox('Rasterform could not start', error instanceof Error ? error.message : String(error))
    app.quit()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

export const desktopProtocolVersion = DESKTOP_PROTOCOL_VERSION
