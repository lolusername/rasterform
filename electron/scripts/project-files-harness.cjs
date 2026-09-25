// Test-only launcher. Uses staged main/preload unchanged and an isolated profile.
// Native dialogs select fixture paths instead of asking the person running QA.
const { app, dialog, shell, session } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const directory = process.env.RASTERFORM_PROJECT_QA_DIR
const stage = process.env.RASTERFORM_PROJECT_QA_STAGE
if (!directory || !stage || !fs.statSync(directory).isDirectory()) throw new Error('QA paths are required.')
app.setPath('userData', path.join(directory, 'profile'))
app.setAppPath(stage)
app.setName('Rasterform Project QA')

const state = { saveName: 'roundtrip.rasterform', openName: 'roundtrip.rasterform', cancelSave: false, cancelOpen: false, holdSave: false, waitingSave: false, releaseSave: null, revealed: [], dialogs: [], downloads: [] }
globalThis.rasterformProjectQa = state
const fixture = (name) => {
  if (path.basename(name) !== name) throw new Error('Only QA fixture names are allowed.')
  return path.join(directory, name)
}
dialog.showSaveDialog = async (_window, options) => {
  state.dialogs.push({ kind: 'save', title: options.title })
  if (state.holdSave) {
    await new Promise(resolve => {
      state.waitingSave = true
      state.releaseSave = () => {
        state.waitingSave = false
        state.holdSave = false
        state.releaseSave = null
        resolve()
      }
    })
  }
  return state.cancelSave ? { canceled: true } : { canceled: false, filePath: fixture(state.saveName) }
}
dialog.showOpenDialog = async (_window, options) => {
  state.dialogs.push({ kind: 'open', title: options.title })
  return state.cancelOpen ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [fixture(state.openName)] }
}
shell.showItemInFolder = (filePath) => { state.revealed.push(filePath) }
require(path.join(stage, 'main.cjs'))
app.whenReady().then(() => {
  session.defaultSession.on('will-download', (_event, item) => {
    if (!item.getURL().startsWith('blob:rasterform://app/')) return
    item.setSavePath(fixture(item.getFilename()))
    item.once('done', (_event, status) => { state.downloads.push({ name: item.getFilename(), status }) })
  })
})
