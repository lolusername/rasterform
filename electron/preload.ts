import { contextBridge, ipcRenderer } from 'electron'
import {
  DESKTOP_LONG_EXPORT_PROTOCOL_VERSION,
  DESKTOP_PROTOCOL_VERSION,
  type DesktopFinalRenderSnapshot,
  type DesktopLongExportOutcome,
  type DesktopLongExportStartRequest,
  type DesktopRenderEvent,
} from '../src/desktop/contracts'
import {
  DESKTOP_PRO_RENDER_PROTOCOL_VERSION,
  type DesktopProRenderEvent,
  type DesktopProRenderSnapshot,
} from '../src/desktop/pro-contracts'
import {
  DESKTOP_BLENDER_EXPORT_PROTOCOL_VERSION,
  type DesktopBlenderExportEvent,
  type DesktopBlenderExportSnapshot,
  type RasterformDesktopBlenderExportBridge,
} from '../src/desktop/blender-export-contracts'

const bridge: RasterformDesktopBlenderExportBridge = Object.freeze({
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
  proRenderProtocolVersion: DESKTOP_PRO_RENDER_PROTOCOL_VERSION,
  probeProRenderer: () => ipcRenderer.invoke('desktop:probe-pro-renderer'),
  prepareProSave: (suggestedName: string) => (
    ipcRenderer.invoke('desktop:prepare-pro-save', suggestedName)
  ),
  submitProRender: (jobId: string, snapshot: DesktopProRenderSnapshot) => (
    ipcRenderer.invoke('desktop:submit-pro-render', jobId, snapshot)
  ),
  cancelProRender: (jobId: string) => ipcRenderer.invoke('desktop:cancel-pro-render', jobId),
  onProRenderEvent: (listener: (event: DesktopProRenderEvent) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: DesktopProRenderEvent) => listener(payload)
    ipcRenderer.on('desktop:pro-render-event', wrapped)
    return () => ipcRenderer.removeListener('desktop:pro-render-event', wrapped)
  },
  blenderExportProtocolVersion: DESKTOP_BLENDER_EXPORT_PROTOCOL_VERSION,
  prepareBlenderExport: (suggestedName: string) => (
    ipcRenderer.invoke('desktop:prepare-blender-export', suggestedName)
  ),
  submitBlenderExport: (jobId: string, snapshot: DesktopBlenderExportSnapshot) => (
    ipcRenderer.invoke('desktop:submit-blender-export', jobId, snapshot)
  ),
  cancelBlenderExport: (jobId: string) => (
    ipcRenderer.invoke('desktop:cancel-blender-export', jobId)
  ),
  onBlenderExportEvent: (listener: (event: DesktopBlenderExportEvent) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: DesktopBlenderExportEvent) => (
      listener(payload)
    )
    ipcRenderer.on('desktop:blender-export-event', wrapped)
    return () => ipcRenderer.removeListener('desktop:blender-export-event', wrapped)
  },
})

contextBridge.exposeInMainWorld('rasterformDesktop', bridge)
