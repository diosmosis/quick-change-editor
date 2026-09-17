import { contextBridge, ipcRenderer } from 'electron'

// The only surface the renderer can touch. Everything is promise-based IPC.
const api = {
  // repository
  getRepo: () => ipcRenderer.invoke('repo:get'),
  openRepo: (dir = null) => ipcRenderer.invoke('repo:open', dir),
  status: () => ipcRenderer.invoke('repo:status'),
  // { files: [{ path, orig, kind }], message } — commits those paths only.
  commit: (args) => ipcRenderer.invoke('repo:commit', args),

  // files
  openFile: (file) => ipcRenderer.invoke('file:open', file),
  saveFile: (args) => ipcRenderer.invoke('file:save', args),
  statFile: (relPath) => ipcRenderer.invoke('file:stat', relPath),

  // Lets the main process warn about unsaved work when the window is closed.
  setDirtyCount: (count) => ipcRenderer.send('window:dirty', count),

  // Fires when git's own state changed underneath us (a commit or stage from
  // another terminal); returns an unsubscribe function.
  onRepoChanged: (cb) => {
    const listener = () => cb()
    ipcRenderer.on('repo:changed', listener)
    return () => ipcRenderer.removeListener('repo:changed', listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
