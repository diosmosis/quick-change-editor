import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Sidebar from './components/Sidebar'
import Tabs from './components/Tabs'
import Editor from './components/Editor'
import ConfirmDialog from './components/ConfirmDialog'

const api = window.api

// How long a refresh has to run before it's worth saying so in the UI.
const LOADING_DELAY = 250

// Whether two status results describe the same work tree, field by field —
// they arrive as fresh objects every time, so identity says nothing.
function sameFiles(a, b) {
  return (
    a.length === b.length &&
    a.every((file, index) => {
      const other = b[index]
      return (
        file.path === other.path &&
        file.kind === other.kind &&
        file.staged === other.staged &&
        file.exists === other.exists &&
        file.orig === other.orig
      )
    })
  )
}

// An IPC rejection reaches the renderer as "Error invoking remote method 'x':
// Error: the real message". Only the tail is worth showing.
function message(error) {
  const text = error?.message || String(error)
  const match = /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?([\s\S]*)$/.exec(text)
  return match ? match[1] : text
}

function EmptyState({ hasRepo, hasFiles }) {
  return (
    <div className="empty-state">
      <h1>Quick Change Editor</h1>
      {!hasRepo ? (
        <p>
          Open a git repository to see what its work tree has changed. <kbd>Ctrl</kbd>+<kbd>O</kbd>
        </p>
      ) : !hasFiles ? (
        <p>Nothing has changed in this work tree.</p>
      ) : (
        <p>Pick a changed file on the left to start editing.</p>
      )}
      <ul className="shortcuts">
        <li>
          <kbd>Ctrl</kbd>+<kbd>S</kbd> save
        </li>
        <li>
          <kbd>Ctrl</kbd>+<kbd>W</kbd> close tab
        </li>
        <li>
          <kbd>Ctrl</kbd>+<kbd>Tab</kbd> next tab
        </li>
        <li>
          <kbd>Ctrl</kbd>+<kbd>F</kbd> find
        </li>
        <li>
          <kbd>F5</kbd> refresh
        </li>
      </ul>
    </div>
  )
}

export default function App() {
  const [repo, setRepo] = useState({ root: null, branch: null, recent: [] })
  const [files, setFiles] = useState([])
  const [loading, setLoading] = useState(false)
  const [tabs, setTabs] = useState([])
  const [activePath, setActivePath] = useState(null)
  const [error, setError] = useState(null)
  const [confirm, setConfirm] = useState(null)
  // Per-tab, updated straight from the editor: gutter counts and the caret.
  const [stats, setStats] = useState({})
  const [cursors, setCursors] = useState({})

  // Imperative handles onto the mounted CodeMirror instances, by path.
  const editors = useRef(new Map())
  const editorRefCallbacks = useRef(new Map())
  // Latest state for the window-level key handler, which is registered once.
  const tabsRef = useRef(tabs)
  const activePathRef = useRef(activePath)
  tabsRef.current = tabs
  activePathRef.current = activePath

  const editorRef = (path) => {
    if (!editorRefCallbacks.current.has(path)) {
      editorRefCallbacks.current.set(path, (handle) => {
        if (handle) editors.current.set(path, handle)
        else editors.current.delete(path)
      })
    }
    return editorRefCallbacks.current.get(path)
  }

  // ---- repository + file list -------------------------------------------

  const refresh = useCallback(async () => {
    // Only advertise a refresh slow enough to be worth showing. Most take a few
    // milliseconds, and flashing the button for those is just noise.
    const slow = setTimeout(() => setLoading(true), LOADING_DELAY)
    try {
      const result = await api.status()
      // Refreshing happens on every window focus and every git change, so a
      // result identical to the last one must not re-render anything.
      setFiles((prev) => (sameFiles(prev, result.files) ? prev : result.files))
      setRepo((prev) =>
        prev.root === result.root && prev.branch === result.branch
          ? prev
          : { ...prev, root: result.root, branch: result.branch }
      )
      // A tab's badge follows the file's status, which moves when the file is
      // staged or committed from elsewhere.
      setTabs((prev) => {
        let changed = false
        const next = prev.map((tab) => {
          const entry = result.files.find((file) => file.path === tab.path)
          if (!entry || entry.kind === tab.kind) return tab
          changed = true
          return { ...tab, kind: entry.kind }
        })
        return changed ? next : prev
      })
    } catch (err) {
      setError(message(err))
    } finally {
      clearTimeout(slow)
      setLoading(false)
    }
  }, [])

  const pickRepo = useCallback(async () => {
    try {
      const result = await api.openRepo()
      if (!result) return
      setRepo((prev) => ({ ...prev, ...result }))
      // Tabs belong to the repository that was open; a new one starts clean.
      setTabs([])
      setActivePath(null)
      editors.current.clear()
      await refresh()
    } catch (err) {
      setError(message(err))
    }
  }, [refresh])

  useEffect(() => {
    let cancelled = false
    api
      .getRepo()
      .then((result) => {
        if (cancelled) return
        setRepo(result)
        if (result.root) refresh()
      })
      .catch((err) => setError(message(err)))
    return () => {
      cancelled = true
    }
  }, [refresh])

  // ---- tabs --------------------------------------------------------------

  // Updates one tab's fields, and — since this runs on every focus and every
  // git change — leaves the state object alone when nothing actually moved.
  const patchTab = useCallback((path, patch) => {
    setTabs((prev) => {
      let changed = false
      const next = prev.map((tab) => {
        if (tab.path !== path) return tab
        if (Object.keys(patch).every((key) => tab[key] === patch[key])) return tab
        changed = true
        return { ...tab, ...patch }
      })
      return changed ? next : prev
    })
  }, [])

  const openFile = useCallback(async (entry) => {
    if (tabsRef.current.some((tab) => tab.path === entry.path)) {
      setActivePath(entry.path)
      editors.current.get(entry.path)?.focus()
      return
    }
    try {
      const file = await api.openFile({ path: entry.path, orig: entry.orig ?? null })
      setTabs((prev) =>
        prev.some((tab) => tab.path === file.path)
          ? prev
          : [...prev, { ...file, kind: entry.kind, orig: entry.orig ?? null, dirty: false, stale: false }]
      )
      setActivePath(file.path)
    } catch (err) {
      setError(message(err))
    }
  }, [])

  const saveTab = useCallback(async (path) => {
    const tab = tabsRef.current.find((candidate) => candidate.path === path)
    const editor = editors.current.get(path)
    if (!tab || !editor) return false
    if (tab.readOnly) {
      setError(`${tab.name} is read-only.`)
      return false
    }
    try {
      const result = await api.saveFile({ path, content: editor.content(), eol: tab.eol })
      editor.markSaved()
      patchTab(path, { mtimeMs: result.mtimeMs, stale: false })
      // A save can change the work tree's shape — a file edited back to its
      // committed state drops out of git status entirely.
      refresh()
      return true
    } catch (err) {
      setError(message(err))
      return false
    }
  }, [refresh, patchTab])

  const removeTab = useCallback((path) => {
    const index = tabsRef.current.findIndex((tab) => tab.path === path)
    if (index < 0) return
    const remaining = tabsRef.current.filter((tab) => tab.path !== path)
    setTabs(remaining)
    editors.current.delete(path)
    editorRefCallbacks.current.delete(path)
    if (activePathRef.current === path) {
      // Fall to the tab that slid into this one's place, or the new last one.
      const next = remaining[Math.min(index, remaining.length - 1)]
      setActivePath(next?.path ?? null)
    }
  }, [])

  const closeTab = useCallback(
    (path) => {
      const tab = tabsRef.current.find((candidate) => candidate.path === path)
      if (!tab) return
      if (!tab.dirty) {
        removeTab(path)
        return
      }
      setConfirm({
        title: 'Unsaved changes',
        message: `${tab.path} has unsaved changes.`,
        confirmLabel: 'Save and close',
        extraLabel: 'Discard',
        onCancel: () => setConfirm(null),
        onExtra: () => {
          setConfirm(null)
          removeTab(path)
        },
        onConfirm: async () => {
          setConfirm(null)
          if (await saveTab(path)) removeTab(path)
        }
      })
    },
    [removeTab, saveTab]
  )

  const cycleTab = useCallback((delta) => {
    const list = tabsRef.current
    if (list.length < 2) return
    const index = list.findIndex((tab) => tab.path === activePathRef.current)
    const next = (index + delta + list.length) % list.length
    setActivePath(list[next].path)
  }, [])

  // ---- staying in step with the work tree --------------------------------

  // Files change under the app all the time — that's the whole point of it —
  // so open tabs are re-read whenever git or the window suggests they might
  // have. A tab with unsaved edits is never overwritten; it's flagged instead.
  const syncOpenTabs = useCallback(async () => {
    for (const tab of tabsRef.current) {
      const editor = editors.current.get(tab.path)
      if (!editor) continue
      try {
        const stat = await api.statFile(tab.path)
        const changedOnDisk = stat.exists && stat.mtimeMs !== tab.mtimeMs
        const fresh = await api.openFile({ path: tab.path, orig: tab.orig })
        if (tab.dirty) {
          // Keep the edits; only the committed side of the gutter is refreshed,
          // which matters after a commit or a stage.
          editor.setBase(fresh.base)
          if (changedOnDisk) patchTab(tab.path, { stale: true })
          continue
        }
        editor.replaceContent(fresh.content, fresh.base)
        editor.setReadOnly(fresh.readOnly)
        patchTab(tab.path, {
          mtimeMs: fresh.mtimeMs,
          readOnly: fresh.readOnly,
          notice: fresh.notice,
          stale: false
        })
      } catch {
        // The file may have been deleted or become unreadable since; the status
        // refresh alongside this will show that.
      }
    }
  }, [patchTab])

  useEffect(() => {
    const unsubscribe = api.onRepoChanged(() => {
      refresh()
      syncOpenTabs()
    })
    const onFocus = () => {
      if (!repo.root) return
      refresh()
      syncOpenTabs()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      unsubscribe()
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh, syncOpenTabs, repo.root])

  // ---- editor callbacks (stable, so editors don't re-render) -------------

  const onDirtyChange = useCallback(
    (path, dirty) => patchTab(path, { dirty }),
    [patchTab]
  )

  const onStats = useCallback((path, next) => {
    setStats((prev) => {
      const current = prev[path]
      const same =
        current &&
        current.added === next.added &&
        current.modified === next.modified &&
        current.removed === next.removed
      return same ? prev : { ...prev, [path]: next }
    })
  }, [])

  const onCursor = useCallback((path, position) => {
    setCursors((prev) => ({ ...prev, [path]: position }))
  }, [])

  const dirtyCount = useMemo(() => tabs.filter((tab) => tab.dirty).length, [tabs])
  useEffect(() => {
    api.setDirtyCount(dirtyCount)
  }, [dirtyCount])

  // ---- keyboard ----------------------------------------------------------

  // One capture-phase listener owns every app shortcut. CodeMirror's own keymap
  // never sees these, and the application menu (which would otherwise take
  // Ctrl+W for itself) has been removed in the main process.
  const actions = useRef({})
  actions.current = { saveTab, closeTab, cycleTab, refresh, pickRepo }

  useEffect(() => {
    const onKeyDown = (event) => {
      const { saveTab, closeTab, cycleTab, refresh, pickRepo } = actions.current
      const mod = event.ctrlKey || event.metaKey
      const active = activePathRef.current

      if (mod && !event.shiftKey && event.key.toLowerCase() === 's') {
        event.preventDefault()
        if (active) saveTab(active)
      } else if (mod && event.shiftKey && event.key.toLowerCase() === 's') {
        event.preventDefault()
        for (const tab of tabsRef.current) if (tab.dirty) saveTab(tab.path)
      } else if (mod && event.key.toLowerCase() === 'w') {
        event.preventDefault()
        if (active) closeTab(active)
      } else if (mod && event.key.toLowerCase() === 'o') {
        event.preventDefault()
        pickRepo()
      } else if (mod && event.key === 'Tab') {
        event.preventDefault()
        cycleTab(event.shiftKey ? -1 : 1)
      } else if (event.key === 'F5') {
        event.preventDefault()
        refresh()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  // ---- render ------------------------------------------------------------

  const openPaths = useMemo(() => new Set(tabs.map((tab) => tab.path)), [tabs])
  const dirtyPaths = useMemo(
    () => new Set(tabs.filter((tab) => tab.dirty).map((tab) => tab.path)),
    [tabs]
  )
  const activeTab = tabs.find((tab) => tab.path === activePath) || null
  const activeStats = activePath ? stats[activePath] : null
  const activeCursor = activePath ? cursors[activePath] : null

  return (
    <div className="app">
      <Sidebar
        repo={repo}
        files={files}
        activePath={activePath}
        openPaths={openPaths}
        dirtyPaths={dirtyPaths}
        loading={loading}
        onOpen={openFile}
        onRefresh={refresh}
        onPickRepo={pickRepo}
      />

      <main className="main">
        <Tabs tabs={tabs} activePath={activePath} onSelect={setActivePath} onClose={closeTab} />

        <div className="editors">
          {tabs.length === 0 && <EmptyState hasRepo={Boolean(repo.root)} hasFiles={files.length > 0} />}
          {tabs.map((tab) => (
            <div
              key={tab.path}
              className={`editor-pane ${tab.path === activePath ? 'active' : ''}`}
            >
              {tab.notice && <div className="notice">{tab.notice}</div>}
              {tab.stale && (
                <div className="notice warn">
                  This file changed on disk after you started editing it. Saving overwrites the
                  version on disk.
                </div>
              )}
              <Editor
                ref={editorRef(tab.path)}
                path={tab.path}
                name={tab.name}
                initialContent={tab.content}
                initialBase={tab.base}
                readOnly={tab.readOnly}
                active={tab.path === activePath}
                onDirtyChange={onDirtyChange}
                onStats={onStats}
                onCursor={onCursor}
              />
            </div>
          ))}
        </div>

        <footer className="status-bar">
          <span className="status-path">{activeTab ? activeTab.path : repo.root || ''}</span>
          <span className="status-spacer" />
          {activeStats && (
            <span className="status-diff" title="Lines added, changed and removed since HEAD">
              <span className="st-added">+{activeStats.added}</span>
              <span className="st-modified">~{activeStats.modified}</span>
              <span className="st-deleted">−{activeStats.removed}</span>
            </span>
          )}
          {activeCursor && (
            <span>
              Ln {activeCursor.line}, Col {activeCursor.column}
            </span>
          )}
          {activeTab && <span>{activeTab.eol === 'crlf' ? 'CRLF' : 'LF'}</span>}
          {activeTab?.readOnly && <span className="status-readonly">read-only</span>}
          {activeTab?.dirty && <span className="status-dirty">unsaved</span>}
        </footer>
      </main>

      {error && (
        <div className="error-toast" role="alert">
          <span>{error}</span>
          <button className="icon-button" onClick={() => setError(null)} title="Dismiss">
            ×
          </button>
        </div>
      )}

      {confirm && <ConfirmDialog {...confirm} />}
    </div>
  )
}
