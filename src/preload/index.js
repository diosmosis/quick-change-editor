import { contextBridge, ipcRenderer } from 'electron'

// The only surface the renderer can touch. Everything is promise-based IPC.
const api = {
  // repository
  getRepo: () => ipcRenderer.invoke('repo:get'),
  openRepo: (dir = null) => ipcRenderer.invoke('repo:open', dir),
  status: () => ipcRenderer.invoke('repo:status'),
  // { files: [{ path, orig, kind }], message, amend } — commits those paths
  // only. Resolves to { ok: true, hash, count, amended, output } or
  // { ok: false, error, output }; `output` is what the hooks printed.
  commit: (args) => ipcRenderer.invoke('repo:commit', args),
  // { hash, subject, message } of HEAD, or null on an unborn branch.
  headCommit: () => ipcRenderer.invoke('repo:head'),

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
  },

  // plugins — see src/main/plugins.js. Settings are keyed by plugin id.
  plugins: {
    getSettings: () => ipcRenderer.invoke('plugins:settings:get'),
    setSettings: (id, values) => ipcRenderer.invoke('plugins:settings:set', id, values),
    // Calls a handler the plugin's main half registered with ctx.handle().
    invoke: (id, channel, args) => ipcRenderer.invoke('plugin:call', id, channel, args),
    // Hears what the plugin's main half sends with ctx.send(); returns an
    // unsubscribe function.
    subscribe: (id, channel, cb) => {
      const listener = (_e, event) => {
        if (event.id === id && event.channel === channel) cb(event.payload)
      }
      ipcRenderer.on('plugin:event', listener)
      return () => ipcRenderer.removeListener('plugin:event', listener)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
