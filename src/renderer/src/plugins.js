// The renderer half of the plugin system: runs every plugin's setup(host) once,
// and keeps what they contributed for the app to draw. See src/main/plugins.js
// for the main-process half, and the README for the API as a whole.
import Modal from './components/Modal'
import ConfirmDialog from './components/ConfirmDialog'
import CommandOutput from './components/CommandOutput'

const manifests = import.meta.glob('@plugins/*/plugin.js', { eager: true, import: 'default' })
const renderers = import.meta.glob('@plugins/*/renderer.jsx', { eager: true, import: 'default' })

const api = window.api

// Pieces of the app's own UI a plugin can build with, so its dialogs look and
// behave like the rest.
const ui = { Modal, ConfirmDialog, CommandOutput }

// "Ctrl+Shift+P" → a test for a keydown event. Ctrl also matches Cmd, as it
// does for the app's own shortcuts.
function shortcutMatcher(shortcut) {
  if (!shortcut) return null
  const parts = shortcut.split('+').map((part) => part.trim().toLowerCase())
  const key = parts.pop()
  const mod = parts.includes('ctrl') || parts.includes('cmd')
  const shift = parts.includes('shift')
  const alt = parts.includes('alt')
  return (event) =>
    (event.ctrlKey || event.metaKey) === mod &&
    event.shiftKey === shift &&
    event.altKey === alt &&
    event.key.toLowerCase() === key
}

function createPlugin(manifest, setup) {
  const listeners = new Map()
  const plugin = { manifest, commands: [], overlays: [] }

  const host = {
    id: manifest.id,
    manifest,
    ui,

    // A button in the sidebar's plugin bar, and optionally a shortcut:
    // { id, label, title?, shortcut?, run }.
    addCommand: (command) => {
      plugin.commands.push({ ...command, matches: shortcutMatcher(command.shortcut) })
    },

    // A component mounted for as long as the window is open, whether or not it
    // draws anything. It gets { repo } — { root, branch } — as props. Being
    // always mounted is what lets a plugin keep state between one use and the
    // next, or carry on with something while its dialog is closed.
    addOverlay: (Component) => {
      plugin.overlays.push(Component)
    },

    // The plugin's own events, plus the app's: 'repo:changed' ({ root, branch }).
    // Returns an unsubscribe function.
    on: (event, fn) => {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(fn)
      return () => listeners.get(event)?.delete(fn)
    },
    emit: (event, payload) => {
      for (const fn of listeners.get(event) ?? []) fn(payload)
    },

    // The main-process half: ctx.handle() and ctx.send() on the other side.
    invoke: (channel, ...args) => api.plugins.invoke(manifest.id, channel, args),
    subscribe: (channel, fn) => api.plugins.subscribe(manifest.id, channel, fn),

    getSettings: async () => (await api.plugins.getSettings())[manifest.id] ?? {}
  }

  if (typeof setup === 'function') {
    try {
      setup(host)
    } catch (err) {
      console.error(`[plugins] ${manifest.id} failed to set up:`, err)
    }
  }
  plugin.host = host
  return plugin
}

// Sorted by name so the plugin bar and the settings dialog don't depend on the
// order the bundler happened to find the directories in.
export const plugins = Object.entries(manifests)
  .filter(([, manifest]) => manifest?.id)
  .map(([file, manifest]) => createPlugin(manifest, renderers[file.replace(/plugin\.js$/, 'renderer.jsx')]))
  .sort((a, b) => (a.manifest.name ?? a.manifest.id).localeCompare(b.manifest.name ?? b.manifest.id))

export const commands = plugins.flatMap((plugin) =>
  plugin.commands.map((command) => ({ ...command, key: `${plugin.manifest.id}:${command.id}` }))
)

export const overlays = plugins.flatMap((plugin) =>
  plugin.overlays.map((Component, index) => ({ Component, key: `${plugin.manifest.id}:${index}` }))
)

// Passes an app event to every plugin.
export function broadcast(event, payload) {
  for (const plugin of plugins) plugin.host.emit(event, payload)
}
