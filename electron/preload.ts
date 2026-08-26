import { contextBridge, ipcRenderer } from 'electron'
import {
  DESKTOP_LONG_EXPORT_PROTOCOL_VERSION,
  DESKTOP_PROTOCOL_VERSION,
  type DesktopFinalRenderSnapshot,
  type DesktopLongExportOutcome,
  type DesktopLongExportStartRequest,
  type DesktopRenderEvent,
  type RasterformDesktopLongExportBridge,
} from '../src/desktop/contracts'

const bridge: RasterformDesktopLongExportBridge = Object.freeze({
  protocolVersion: DESKTOP_PROTOCOL_VERSION,
  longExportProtocolVersion: DESKTOP_LONG_EXPORT_PROTOCOL_VERSION,
  prepareFinalSave: (suggestedName: string) => ipcRenderer.invoke('desktop:prepare-final-save', suggestedName),
  submitFinalRender: (jobId: string, snapshot: DesktopFinalRenderSnapshot) => (
    ipcRenderer.invoke('desktop:submit-final-render', jobId, snapshot)
  ),
  cancelFinalRender: (jobId: string) => ipcRenderer.invoke('desktop:cancel-final-render', jobId),
  onFinalRenderEvent: (listener: (event: DesktopRenderEvent) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: DesktopRenderEvent) => listener(payload)
    ipcRenderer.on('desktop:final-render-event', wrapped)
    return () => ipcRenderer.removeListener('desktop:final-render-event', wrapped)
  },
  beginLongExport: (request: DesktopLongExportStartRequest) => (
    ipcRenderer.invoke('desktop:begin-long-export', request)
  ),
  endLongExport: (jobId: string, outcome: DesktopLongExportOutcome) => (
    ipcRenderer.invoke('desktop:end-long-export', jobId, outcome)
  ),
})

contextBridge.exposeInMainWorld('rasterformDesktop', bridge)
