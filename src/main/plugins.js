// Loads the plugins in ./plugins and gives each one a context to hook into the
// main process with. See the Plugins section of the README for the whole API.
//
// A plugin is a directory holding up to three modules:
//
//   plugin.js     the manifest — { id, name, description, settings } — read by
//                 both processes, so the settings dialog and the plugin's own
//                 code agree on what the settings are
//   main.js       default-exports activate(ctx), run once at startup here
//   renderer.jsx  default-exports setup(host), run once in the window
//
// They are bundled with the app rather than loaded off disk at runtime, so a
// new plugin needs a rebuild — the same as any other change to the app.
import { EventEmitter } from 'node:events'
import { BrowserWindow, ipcMain } from 'electron'

const manifests = import.meta.glob('@plugins/*/plugin.js', { eager: true, import: 'default' })
const mains = import.meta.glob('@plugins/*/main.js', { eager: true, import: 'default' })

// Every setting has a type; anything the dialog can't draw falls back to a
// single-line text field, so that is what its value is coerced to as well.
function coerce(setting, value) {
  switch (setting.type) {
    case 'boolean':
      return value === true
    case 'number': {
      const number = Number(value)
      return Number.isFinite(number) ? number : setting.default ?? 0
    }
    default:
      return value == null ? '' : String(value)
  }
}

export class PluginManager extends EventEmitter {
  constructor(store) {
    super()
    this.store = store
    this.root = null
    // id → { manifest, handlers: Map<channel, fn>, events: EventEmitter }
    this.plugins = new Map()
  }

  // Imports every plugin and activates the ones that have a main-process half.
  // One that throws while activating is reported and left out; it shouldn't be
  // able to keep the editor from starting.
  load() {
    for (const [file, manifest] of Object.entries(manifests)) {
      if (!manifest?.id) {
        console.error(`[plugins] ${file} has no id; skipped.`)
        continue
      }
      const plugin = { manifest, handlers: new Map(), events: new EventEmitter() }
      this.plugins.set(manifest.id, plugin)

      const activate = mains[file.replace(/plugin\.js$/, 'main.js')]
      if (typeof activate !== 'function') continue
      try {
        activate(this._context(plugin))
      } catch (err) {
        console.error(`[plugins] ${manifest.id} failed to activate:`, err)
      }
    }
  }

  // What a plugin's activate() gets. Everything is scoped to the one plugin:
  // its handlers, its events and its settings are not visible to the others.
  _context(plugin) {
    const { id } = plugin.manifest
    return {
      id,
      // Answers host.invoke(channel, ...args) from the plugin's renderer half.
      handle: (channel, fn) => plugin.handlers.set(channel, fn),
      // Reaches host.subscribe(channel, fn) in every window.
      send: (channel, payload) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('plugin:event', { id, channel, payload })
        }
      },
      // 'repo:opened' ({ root }), 'settings:changed' (values), 'quit' ()
      on: (event, fn) => plugin.events.on(event, fn),
      getRepo: () => ({ root: this.root }),
      getSettings: () => this.settings(id)
    }
  }

  // A plugin's settings as stored, with every declared one present: a value
  // never saved reads as the manifest's default.
  settings(id) {
    const plugin = this.plugins.get(id)
    if (!plugin) throw new Error(`No plugin called ${id}.`)
    const saved = this.store.get('plugins', {})[id] ?? {}
    const values = {}
    for (const setting of plugin.manifest.settings ?? []) {
      values[setting.key] =
        setting.key in saved ? coerce(setting, saved[setting.key]) : setting.default ?? coerce(setting, null)
    }
    return values
  }

  // Only declared keys are kept, each as its declared type — the values come
  // from the renderer, and a plugin reading its settings back should get
  // exactly the shape its manifest describes.
  saveSettings(id, values) {
    const plugin = this.plugins.get(id)
    if (!plugin) throw new Error(`No plugin called ${id}.`)
    const clean = {}
    for (const setting of plugin.manifest.settings ?? []) {
      if (values && setting.key in values) clean[setting.key] = coerce(setting, values[setting.key])
    }
    this.store.set({ plugins: { ...this.store.get('plugins', {}), [id]: clean } })
    const settings = this.settings(id)
    plugin.events.emit('settings:changed', settings)
    return settings
  }

  // ---- app events -------------------------------------------------------

  repoOpened(root) {
    this.root = root
    this._broadcast('repo:opened', { root })
  }

  quit() {
    this._broadcast('quit')
  }

  _broadcast(event, ...args) {
    for (const plugin of this.plugins.values()) {
      try {
        plugin.events.emit(event, ...args)
      } catch (err) {
        console.error(`[plugins] ${plugin.manifest.id} failed handling ${event}:`, err)
      }
    }
  }

  // ---- IPC ---------------------------------------------------------------

  registerIpc() {
    ipcMain.handle('plugins:settings:get', () => {
      const all = {}
      for (const id of this.plugins.keys()) all[id] = this.settings(id)
      return all
    })

    ipcMain.handle('plugins:settings:set', (_e, id, values) => this.saveSettings(String(id), values))

    ipcMain.handle('plugin:call', async (_e, id, channel, args = []) => {
      const handler = this.plugins.get(String(id))?.handlers.get(String(channel))
      if (!handler) throw new Error(`Plugin ${id} has no handler for ${channel}.`)
      return handler(...args)
    })
  }
}
