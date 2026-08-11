import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopFinalRenderSnapshot } from '../src/desktop/contracts'
import type { FinalExportProgress } from '../src/lib/final-image-export'

interface RenderStartMessage {
  jobId: string
  snapshot: DesktopFinalRenderSnapshot
}

const renderHost = Object.freeze({
  onStart(listener: (message: RenderStartMessage) => void) {
    const wrapped = (_event: Electron.IpcRendererEvent, message: RenderStartMessage) => listener(message)
    ipcRenderer.on('desktop:render-start', wrapped)
    return () => ipcRenderer.removeListener('desktop:render-start', wrapped)
  },
  onCancel(listener: (jobId: string) => void) {
    const wrapped = (_event: Electron.IpcRendererEvent, jobId: string) => listener(jobId)
    ipcRenderer.on('desktop:render-cancel', wrapped)
    return () => ipcRenderer.removeListener('desktop:render-cancel', wrapped)
  },
  progress(jobId: string, progress: FinalExportProgress) {
    ipcRenderer.send('desktop:render-progress', jobId, progress)
  },
  complete(
    jobId: string,
    result: { width: number; height: number; dpi: number; samples: number; tiles: number },
    png: Uint8Array,
  ) {
    ipcRenderer.send('desktop:render-complete', jobId, result, png)
  },
  cancelled(jobId: string) {
    ipcRenderer.send('desktop:render-cancelled', jobId)
  },
  failed(jobId: string, message: string) {
    ipcRenderer.send('desktop:render-failed', jobId, message)
  },
})

contextBridge.exposeInMainWorld('rasterformRenderHost', renderHost)
