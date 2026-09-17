import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Sidebar from './components/Sidebar'
import Tabs from './components/Tabs'
import Editor from './components/Editor'
import ConfirmDialog from './components/ConfirmDialog'
import CommitDialog from './components/CommitDialog'
import { describeIndentation } from './lib/indentation'

const api = window.api

// How long a refresh has to run before it's worth saying so in the UI.
const LOADING_DELAY = 250

// How long the "committed" toast stays up. Long enough to read the hash off it.
const NOTICE_MS = 6000

// Whether two status results describe the same work tree, field by field —
// they arrive as fresh objects every time, so identity says nothing.
//
// mtime and size are in the comparison even though nothing draws them: an
// approval is remembered against the file it was given to, and it would be read
// off a stale entry here if the list stopped following a rewrite.
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
        file.orig === other.orig &&
        file.mtimeMs === other.mtimeMs &&
        file.size === other.size
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
          <kbd>F7</kbd> next change
        </li>
        <li>
          <kbd>Ctrl</kbd>+<kbd>F</kbd> find
        </li>
        <li>
          <kbd>F5</kbd> refresh
        </li>
        <li>
          <kbd>Ctrl</kbd>+<kbd>Enter</kbd> commit approved
        </li>
      </ul>
    </div>
  )
}

// The status bar's change navigator: which of the file's changed blocks the
// cursor is sitting in, and a pair of arrows to step between them. The position
// reads as "–" while the cursor is on unchanged lines.
function ChangeNav({ hunks, line, onGoto }) {
  if (hunks.length === 0) return null
  const index = hunks.findIndex((hunk) => line >= hunk.from && line <= hunk.to)
  return (
    <span className="status-nav" title="Changed blocks in this file">
      <button
        type="button"
        className="nav-button"
        onClick={() => onGoto(-1)}
        title="Previous change (Shift+F7)"
      >
        ‹
      </button>
      <span className="nav-count">
        {index >= 0 ? index + 1 : '–'} / {hunks.length}
      </span>
      <button
        type="button"
        className="nav-button"
        onClick={() => onGoto(1)}
        title="Next change (F7)"
      >
        ›
      </button>
    </span>
  )
}

export default function App() {
  const [repo, setRepo] = useState({ root: null, branch: null, recent: [] })
  const [files, setFiles] = useState([])
  // Changed paths left out of the list because there's nothing to edit behind
  // them — submodules and binary files.
  const [skipped, setSkipped] = useState(0)
  const [loading, setLoading] = useState(false)
  const [tabs, setTabs] = useState([])
  const [activePath, setActivePath] = useState(null)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [confirm, setConfirm] = useState(null)
  // The commit dialog, and whether git is currently running on its behalf.
  const [committing, setCommitting] = useState(false)
  const [commitOpen, setCommitOpen] = useState(false)
  // Per-tab, updated straight from the editor: gutter counts, the caret, and
  // the indentation style read out of the file.
  const [stats, setStats] = useState({})
  const [cursors, setCursors] = useState({})
  const [indents, setIndents] = useState({})
  // Files whose changes have been ticked off, each held against the mtime and
  // size it was ticked off at. Nothing else reads this — it is a place to keep
  // your own count during a review pass.
  const [approved, setApproved] = useState(() => new Map())

  // Counts the files this app has written. Only used to tell a status read that
  // predates a save of ours from one that reflects it.
  const writes = useRef(0)
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
    const writesBefore = writes.current
    try {
      const result = await api.status()
      // Refreshing happens on every window focus and every git change, so a
      // result identical to the last one must not re-render anything.
      setFiles((prev) => (sameFiles(prev, result.files) ? prev : result.files))
      setSkipped(result.skipped ?? 0)
      // An approval is of the file as it stood. One that something else has
      // rewritten since — a generator, a checkout — or that has stopped being a
      // changed file at all, loses it. Saving here doesn't count: `saveTab`
      // moves the tick onto what it just wrote, and a status read that started
      // before that save is describing a file that no longer exists, so it is
      // left to the refresh the save itself asks for.
      if (writes.current === writesBefore) {
        setApproved((prev) => {
          if (prev.size === 0) return prev
          const next = new Map()
          for (const file of result.files) {
            const mark = prev.get(file.path)
            if (mark && mark.mtimeMs === file.mtimeMs && mark.size === file.size) {
              next.set(file.path, mark)
            }
          }
          return next.size === prev.size ? prev : next
        })
      }
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
      setApproved(new Map())
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
      writes.current++
      editor.markSaved()
      patchTab(path, { mtimeMs: result.mtimeMs, stale: false })
      // An approval carries over what you just wrote. Whoever is editing here is
      // the one doing the reviewing, so their own edit is approved by the making
      // of it — it's the changes arriving from elsewhere that need another look.
      setApproved((prev) => {
        if (!prev.has(path)) return prev
        const next = new Map(prev)
        next.set(path, { mtimeMs: result.mtimeMs, size: result.size })
        return next
      })
      // A save can change the work tree's shape — a file edited back to its
      // committed state drops out of git status entirely.
      refresh()
      return true
    } catch (err) {
      setError(message(err))
      return false
    }
  }, [refresh, patchTab])

  // Drops several tabs in one go. Doing it through `removeTab` one at a time
  // would pick a new active tab at every step on the way past.
  const removeTabs = useCallback((paths) => {
    const gone = new Set(paths)
    if (gone.size === 0) return
    const remaining = tabsRef.current.filter((tab) => !gone.has(tab.path))
    setTabs(remaining)
    for (const path of gone) {
      editors.current.delete(path)
      editorRefCallbacks.current.delete(path)
    }
    if (gone.has(activePathRef.current)) setActivePath(remaining[0]?.path ?? null)
  }, [])

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

  // Closes the lot. Unsaved tabs are asked about together rather than one
  // dialog after another — at the end of a review pass the answer is the same
  // for all of them.
  const closeAllTabs = useCallback(() => {
    const open = tabsRef.current
    if (open.length === 0) return
    const dirty = open.filter((tab) => tab.dirty)
    const paths = open.map((tab) => tab.path)
    if (dirty.length === 0) {
      removeTabs(paths)
      return
    }
    setConfirm({
      title: 'Unsaved changes',
      message:
        dirty.length === 1
          ? `${dirty[0].path} has unsaved changes.`
          : `${dirty.length} of these ${open.length} files have unsaved changes.`,
      confirmLabel: 'Save all and close',
      extraLabel: 'Discard',
      onCancel: () => setConfirm(null),
      onExtra: () => {
        setConfirm(null)
        removeTabs(paths)
      },
      onConfirm: async () => {
        setConfirm(null)
        // A file that won't save — read-only, or a write that failed — keeps
        // its tab and its edits; the error says why. Everything else closes.
        const kept = new Set()
        for (const tab of dirty) {
          if (!(await saveTab(tab.path))) kept.add(tab.path)
        }
        removeTabs(paths.filter((path) => !kept.has(path)))
      }
    })
  }, [removeTabs, saveTab])

  // Steps the active editor's cursor to the change before or after it. Lives
  // here rather than in the editor's keymap so the status bar's arrows and the
  // shortcut are the same action.
  const gotoChange = useCallback((direction) => {
    const path = activePathRef.current
    if (path) editors.current.get(path)?.gotoChange(direction)
  }, [])

  const cycleTab = useCallback((delta) => {
    const list = tabsRef.current
    if (list.length < 2) return
    const index = list.findIndex((tab) => tab.path === activePathRef.current)
    const next = (index + delta + list.length) % list.length
    setActivePath(list[next].path)
  }, [])

  // ---- approvals ---------------------------------------------------------

  // Ticks a file off, or takes the tick back. The fingerprint comes from the
  // list entry, which the refresh above keeps in step with the file on disk.
  const toggleApproved = useCallback((file) => {
    setApproved((prev) => {
      const next = new Map(prev)
      if (!next.delete(file.path)) {
        next.set(file.path, { mtimeMs: file.mtimeMs, size: file.size })
      }
      return next
    })
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

  // ---- committing --------------------------------------------------------

  // The rows the tick marks point at, in the order the sidebar shows them.
  const approvedFiles = useMemo(
    () => files.filter((file) => approved.has(file.path)),
    [files, approved]
  )

  const openCommit = useCallback(() => {
    if (approvedFiles.length > 0) setCommitOpen(true)
  }, [approvedFiles])

  const commit = useCallback(
    async (text) => {
      if (approvedFiles.length === 0) return
      setCommitting(true)
      // A rejected commit leaves its error up so it can be read and acted on;
      // a second attempt is not the moment to still be showing the first one.
      setError(null)
      try {
        // A tick was given to what was on screen, and an unsaved tab holds a
        // newer version than the one git would pick up off the disk. Writing
        // them out first is the only reading of "commit what I approved" that
        // isn't a lie. One that won't save stops the commit, with its own error
        // already on screen — committing the rest silently would be worse.
        for (const tab of tabsRef.current) {
          if (!tab.dirty || !approved.has(tab.path)) continue
          if (!(await saveTab(tab.path))) return
        }
        const result = await api.commit({
          files: approvedFiles.map((file) => ({
            path: file.path,
            orig: file.orig ?? null,
            kind: file.kind
          })),
          message: text
        })
        setCommitOpen(false)
        // Everything that was ticked off is now in a commit, so the pass is
        // over; the refresh below would drop these anyway as they leave the
        // changed-file list, but not until it comes back.
        setApproved(new Map())
        setNotice(
          `Committed ${result.count} file${result.count === 1 ? '' : 's'}` +
            (result.hash ? ` as ${result.hash}` : '')
        )
        // Our own git commands suppress the .git watcher — it can't tell them
        // from someone else's — so the refresh has to be asked for here. The
        // tab sync goes with it to move every open gutter onto the new HEAD.
        await refresh()
        await syncOpenTabs()
      } catch (err) {
        setError(message(err))
      } finally {
        setCommitting(false)
      }
    },
    [approvedFiles, approved, saveTab, refresh, syncOpenTabs]
  )

  // An approval is dropped the moment something rewrites the file it was given
  // to, and a refresh runs on every window focus — so the list behind the open
  // dialog can empty out under it. There is nothing left to commit at that
  // point, and a dialog offering to commit nothing is worse than none.
  useEffect(() => {
    if (commitOpen && !committing && approvedFiles.length === 0) setCommitOpen(false)
  }, [commitOpen, committing, approvedFiles])

  // Nothing has to be dismissed by hand: a commit's confirmation is worth a
  // glance, not a click.
  useEffect(() => {
    if (!notice) return undefined
    const timer = setTimeout(() => setNotice(null), NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])

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
        current.removed === next.removed &&
        current.hunks.length === next.hunks.length &&
        current.hunks.every(
          (hunk, index) => hunk.from === next.hunks[index].from && hunk.to === next.hunks[index].to
        )
      return same ? prev : { ...prev, [path]: next }
    })
  }, [])

  const onCursor = useCallback((path, position) => {
    setCursors((prev) => ({ ...prev, [path]: position }))
  }, [])

  // Re-reported every time a tab's contents are replaced, which happens on every
  // window focus — so an unchanged answer must not re-render the status bar.
  const onIndent = useCallback((path, indent) => {
    setIndents((prev) => {
      const current = prev[path]
      const same = current && current.useTabs === indent.useTabs && current.size === indent.size
      return same ? prev : { ...prev, [path]: indent }
    })
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
  actions.current = {
    saveTab,
    closeTab,
    closeAllTabs,
    cycleTab,
    refresh,
    pickRepo,
    gotoChange,
    openCommit
  }
  // The commit dialog owns the keyboard while it's up: it has a text field in
  // it, and Ctrl+S saving a file behind it — or Ctrl+Enter firing twice — is
  // not what typing a message should do.
  const commitOpenRef = useRef(commitOpen)
  commitOpenRef.current = commitOpen

  useEffect(() => {
    const onKeyDown = (event) => {
      const {
        saveTab,
        closeTab,
        closeAllTabs,
        cycleTab,
        refresh,
        pickRepo,
        gotoChange,
        openCommit
      } = actions.current
      const mod = event.ctrlKey || event.metaKey
      const active = activePathRef.current

      if (commitOpenRef.current) return

      if (mod && event.key === 'Enter') {
        event.preventDefault()
        openCommit()
      } else if (mod && !event.shiftKey && event.key.toLowerCase() === 's') {
        event.preventDefault()
        if (active) saveTab(active)
      } else if (mod && event.shiftKey && event.key.toLowerCase() === 's') {
        event.preventDefault()
        for (const tab of tabsRef.current) if (tab.dirty) saveTab(tab.path)
      } else if (mod && event.shiftKey && event.key.toLowerCase() === 'w') {
        event.preventDefault()
        closeAllTabs()
      } else if (mod && !event.shiftKey && event.key.toLowerCase() === 'w') {
        event.preventDefault()
        if (active) closeTab(active)
      } else if (mod && event.key.toLowerCase() === 'o') {
        event.preventDefault()
        pickRepo()
      } else if (mod && event.key === 'Tab') {
        event.preventDefault()
        cycleTab(event.shiftKey ? -1 : 1)
      } else if (event.key === 'F7') {
        event.preventDefault()
        gotoChange(event.shiftKey ? -1 : 1)
      } else if (
        mod &&
        !event.altKey &&
        !event.shiftKey &&
        (event.key === 'ArrowDown' || event.key === 'ArrowUp')
      ) {
        // Ctrl and nothing else: Alt is the editor's move-line-up/down,
        // Ctrl+Alt its add-cursor-above/below (and a workspace switch to most
        // Linux desktops, which take it before the app ever sees it).
        event.preventDefault()
        gotoChange(event.key === 'ArrowDown' ? 1 : -1)
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
  const activeIndent = activePath ? indents[activePath] : null

  return (
    <div className="app">
      <Sidebar
        repo={repo}
        files={files}
        skipped={skipped}
        activePath={activePath}
        openPaths={openPaths}
        dirtyPaths={dirtyPaths}
        approved={approved}
        loading={loading}
        onOpen={openFile}
        onToggleApproved={toggleApproved}
        onRefresh={refresh}
        onPickRepo={pickRepo}
        onCommit={openCommit}
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
                onIndent={onIndent}
              />
            </div>
          ))}
        </div>

        <footer className="status-bar">
          <span className="status-path">{activeTab ? activeTab.path : repo.root || ''}</span>
          <span className="status-spacer" />
          {activeStats && (
            <ChangeNav
              hunks={activeStats.hunks}
              line={activeCursor?.line ?? 0}
              onGoto={gotoChange}
            />
          )}
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
          {activeIndent && (
            <span title="Indentation detected in this file — what Tab and Enter will insert">
              {describeIndentation(activeIndent)}
            </span>
          )}
          {activeTab && <span>{activeTab.eol === 'crlf' ? 'CRLF' : 'LF'}</span>}
          {activeTab?.readOnly && <span className="status-readonly">read-only</span>}
          {activeTab?.dirty && <span className="status-dirty">unsaved</span>}
        </footer>
      </main>

      {error && (
        <div className="toast error-toast" role="alert">
          <span>{error}</span>
          <button className="icon-button" onClick={() => setError(null)} title="Dismiss">
            ×
          </button>
        </div>
      )}

      {notice && !error && (
        <div className="toast notice-toast" role="status">
          <span>{notice}</span>
        </div>
      )}

      {confirm && <ConfirmDialog {...confirm} />}

      {commitOpen && (
        <CommitDialog
          files={approvedFiles}
          dirtyPaths={dirtyPaths}
          branch={repo.branch}
          busy={committing}
          onCommit={commit}
          onCancel={() => setCommitOpen(false)}
        />
      )}
    </div>
  )
}
