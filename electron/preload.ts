import { contextBridge, ipcRenderer } from 'electron'
import {
  DESKTOP_PROTOCOL_VERSION,
  type DesktopFinalRenderSnapshot,
  type DesktopRenderEvent,
  type RasterformDesktopBridge,
} from '../src/desktop/contracts'

const bridge: RasterformDesktopBridge = Object.freeze({
  protocolVersion: DESKTOP_PROTOCOL_VERSION,
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
})

contextBridge.exposeInMainWorld('rasterformDesktop', bridge)
