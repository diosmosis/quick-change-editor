import { app, BrowserWindow, Menu, dialog, ipcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { Store } from './store'
import { registerIpc } from './ipc'
import { PluginManager } from './plugins'

// Number of tabs with unsaved edits, kept up to date by the renderer so closing
// the window can warn before throwing work away.
let dirtyCount = 0

// `quick-change-editor /path/to/repo` opens that repository instead of the one
// from last time. Electron's own arguments (the app path, its switches) are not
// directories the user asked for, so anything that isn't an existing directory
// is ignored rather than reported.
function repoFromArgv() {
  const args = process.argv.slice(1).filter((arg) => !arg.startsWith('-'))
  for (const arg of args.reverse()) {
    const candidate = path.resolve(arg)
    if (candidate === app.getAppPath()) continue
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate
  }
  return null
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'Quick Change Editor',
    backgroundColor: '#16171c',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // Start maximized. Wait for the first paint so the window doesn't flash at
  // its default size before expanding.
  win.once('ready-to-show', () => {
    win.maximize()
    win.show()
  })

  // The default menu binds Ctrl+W to "close window", which would swallow the
  // shortcut the spec wants for closing a *tab*. There's no menu to keep, so
  // the whole thing goes and the renderer owns every shortcut.
  Menu.setApplicationMenu(null)

  // ...which also takes the dev tools shortcut with it.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const devTools = input.key === 'F12' || (input.control && input.shift && input.key === 'I')
    if (devTools) {
      win.webContents.toggleDevTools()
      event.preventDefault()
    }
  })

  let forceClose = false
  win.on('close', (event) => {
    if (forceClose || dirtyCount === 0) return
    event.preventDefault()
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Cancel', 'Discard and close'],
      defaultId: 0,
      cancelId: 0,
      title: 'Unsaved changes',
      message: `${dirtyCount} file${dirtyCount === 1 ? ' has' : 's have'} unsaved changes.`,
      detail: 'Closing now discards them.'
    })
    if (choice === 1) {
      forceClose = true
      win.close()
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return win
}

app.whenReady().then(() => {
  const store = new Store(app)
  const plugins = new PluginManager(store)
  plugins.load()
  plugins.registerIpc()
  app.on('will-quit', () => plugins.quit())
  registerIpc(app, store, plugins, repoFromArgv())
  ipcMain.on('window:dirty', (_e, count) => {
    dirtyCount = Number(count) || 0
  })
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
