// Registers every IPC handler the renderer can reach.
import fs from 'node:fs'
import path from 'node:path'
import { ipcMain, dialog, BrowserWindow } from 'electron'

import {
  findRepoRoot,
  currentBranch,
  changedFiles,
  commitFiles,
  headCommit,
  gitIsSettled,
  baseText,
  baseBuffer,
  resolveInRepo,
  looksBinary,
  looksBinaryOnDisk,
  decode,
  detectEol,
  normalizeEol
} from './git'

// Opening a multi-megabyte file would freeze the editor for no good reason;
// this is a tool for reviewing changes, not a general-purpose text editor.
const MAX_FILE_BYTES = 8 * 1024 * 1024

// The repository the window is currently pointed at. One at a time, which is
// what a "quick change" pass wants.
const state = { root: null, watcher: null }

function mb(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1)
}

function requireRepo() {
  if (!state.root) throw new Error('No repository is open.')
  return state.root
}

// How long after our own last git command a .git event is still assumed to be
// its wake, rather than something the user did elsewhere. Comfortably longer
// than the debounce below, so a refresh can't retrigger itself.
const SELF_SETTLE_MS = 1000

// Tells every window that git's view of the work tree may have moved (a commit,
// a stage, a checkout from another terminal). Debounced because a single git
// command touches .git several times.
function watchRepo(root) {
  state.watcher?.close()
  state.watcher = null

  const gitDir = path.join(root, '.git')
  // A linked work tree or submodule has a .git *file* pointing elsewhere; not
  // worth chasing, the focus refresh in the renderer covers those.
  if (!fs.existsSync(gitDir) || !fs.statSync(gitDir).isDirectory()) return

  let timer = null
  try {
    state.watcher = fs.watch(gitDir, (_event, name) => {
      // The lock file appearing and disappearing is not a state change; a real
      // one shows up as an event on the file the lock was protecting.
      if (name === 'index.lock') return
      clearTimeout(timer)
      timer = setTimeout(() => {
        // Reading the status refreshes (and rewrites) .git/index, so without
        // this the app's own refresh would ask for another one, forever.
        if (!gitIsSettled(SELF_SETTLE_MS)) return
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('repo:changed')
        }
      }, 300)
    })
  } catch {
    // Watching is a convenience; a platform that refuses just means manual
    // refreshes.
  }
}

async function setRepo(root, store) {
  state.root = root
  store.rememberRepo(root)
  watchRepo(root)
  return { root, branch: await currentBranch(root) }
}

// A tab for a file there is no text to show. It opens rather than erroring so
// the file can be looked at, ticked off and committed like any other; the
// renderer draws a placeholder instead of an editor.
function binaryEntry(relPath, name, { size, mtimeMs, exists, notice }) {
  return {
    path: relPath,
    name,
    content: '',
    base: '',
    eol: 'lf',
    size,
    mtimeMs,
    exists,
    binary: true,
    readOnly: true,
    notice
  }
}

// Reads a work-tree file plus the committed version it should be diffed
// against. `orig` is set for renames, where HEAD holds the content under the
// old path.
async function readFileEntry(root, relPath, orig) {
  const abs = resolveInRepo(root, relPath)
  const name = path.basename(relPath)

  if (!fs.existsSync(abs)) {
    // Deleted from the work tree: show what HEAD had, read-only, so the tab is
    // still useful for looking at what went away.
    const committed = await baseBuffer(root, relPath, orig)
    if (committed !== null && looksBinary(committed)) {
      return binaryEntry(relPath, name, {
        size: committed.length,
        mtimeMs: 0,
        exists: false,
        notice: 'Deleted in the work tree, and binary — showing the committed file’s size only.'
      })
    }
    const base = committed === null ? '' : normalizeEol(decode(committed))
    return {
      path: relPath,
      name,
      content: base,
      base,
      eol: 'lf',
      size: 0,
      mtimeMs: 0,
      exists: false,
      binary: false,
      readOnly: true,
      notice: 'Deleted in the work tree — showing the committed version.'
    }
  }

  const stat = fs.statSync(abs)
  // Ahead of the size check, and reading only the first block: a binary file is
  // most of what the limit is there to keep out, and its tab costs nothing.
  if (looksBinaryOnDisk(abs)) {
    return binaryEntry(relPath, name, {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      exists: true,
      notice: null
    })
  }

  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`${name} is ${mb(stat.size)} MB — too large to open.`)
  }

  const raw = decode(fs.readFileSync(abs))
  const base = await baseText(root, relPath, orig)
  return {
    path: relPath,
    name,
    content: normalizeEol(raw),
    base,
    eol: detectEol(raw),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    exists: true,
    binary: false,
    readOnly: false,
    notice: null
  }
}

export function registerIpc(app, store, requestedRepo = null) {
  app.on('will-quit', () => state.watcher?.close())

  // ---- Repository -------------------------------------------------------

  // Opens the repository named on the command line, or failing that the last
  // one used — if it is still a git work tree.
  ipcMain.handle('repo:get', async () => {
    const recent = store.recentRepos()
    if (!state.root) {
      // A command-line path that isn't a work tree falls back to the last
      // repository rather than leaving the window empty.
      const candidates = [requestedRepo, store.get('repo', null)].filter(Boolean)
      for (const candidate of candidates) {
        const root = await findRepoRoot(candidate)
        if (root) {
          await setRepo(root, store)
          break
        }
      }
    }
    if (!state.root) return { root: null, branch: null, recent }
    return { root: state.root, branch: await currentBranch(state.root), recent }
  })

  // With a path: open it. Without: ask for one.
  ipcMain.handle('repo:open', async (_e, dir = null) => {
    let chosen = dir
    if (!chosen) {
      const win = BrowserWindow.getFocusedWindow()
      const result = await dialog.showOpenDialog(win, {
        title: 'Open a git repository',
        properties: ['openDirectory'],
        defaultPath: state.root || undefined
      })
      if (result.canceled || result.filePaths.length === 0) return null
      chosen = result.filePaths[0]
    }

    const root = await findRepoRoot(chosen)
    if (!root) throw new Error(`Not a git work tree: ${chosen}`)
    return setRepo(root, store)
  })

  ipcMain.handle('repo:status', async () => {
    const root = requireRepo()
    const { files, skipped } = await changedFiles(root)
    return { root, branch: await currentBranch(root), files, skipped }
  })

  // Commits the files the renderer says have been approved, and only those.
  // The entries are rebuilt field by field rather than passed through: they
  // arrive as arbitrary renderer values and end up as git arguments.
  //
  // A rejected commit resolves rather than throws: an error crossing IPC keeps
  // only its message, and the hook output that explains it would be lost.
  ipcMain.handle('repo:commit', async (_e, { files = [], message = '', amend = false } = {}) => {
    const entries = files.map((file) => ({
      path: String(file?.path ?? ''),
      orig: file?.orig ? String(file.orig) : null,
      kind: String(file?.kind ?? '')
    }))
    if (entries.some((entry) => entry.path === '')) throw new Error('A file to commit had no path.')
    try {
      const result = await commitFiles(requireRepo(), entries, String(message), {
        amend: amend === true
      })
      return { ok: true, ...result }
    } catch (err) {
      return { ok: false, error: err.message, output: err.output ?? '' }
    }
  })

  // The commit an amend would rewrite, or null when there isn't one yet.
  ipcMain.handle('repo:head', async () => headCommit(requireRepo()))

  // ---- Files ------------------------------------------------------------

  ipcMain.handle('file:open', async (_e, { path: relPath, orig = null }) =>
    readFileEntry(requireRepo(), relPath, orig)
  )

  ipcMain.handle('file:save', async (_e, { path: relPath, content, eol = 'lf' }) => {
    const root = requireRepo()
    const abs = resolveInRepo(root, relPath)
    const text = eol === 'crlf' ? content.replace(/\n/g, '\r\n') : content
    fs.writeFileSync(abs, text, 'utf8')
    const stat = fs.statSync(abs)
    // The size comes back with the timestamp because together they are what the
    // renderer fingerprints a file by; a save of ours has to update both.
    return { path: relPath, mtimeMs: stat.mtimeMs, size: stat.size }
  })

  // Used to notice that something else (a generator, a checkout) rewrote a file
  // that is open in a tab.
  ipcMain.handle('file:stat', (_e, relPath) => {
    const abs = resolveInRepo(requireRepo(), relPath)
    if (!fs.existsSync(abs)) return { path: relPath, exists: false, mtimeMs: 0 }
    return { path: relPath, exists: true, mtimeMs: fs.statSync(abs).mtimeMs }
  })
}
