import React, { useMemo, useState } from 'react'

// One badge per git status, shared with the tab bar.
//
// A file git has never seen is 'A' like a staged addition: from the editor's
// point of view both are new files, and the distinction that matters (whether
// it has been staged) is in the tooltip.
export const STATUS = {
  modified: { letter: 'M', cls: 'st-modified', label: 'Modified' },
  added: { letter: 'A', cls: 'st-added', label: 'Added (staged)' },
  untracked: { letter: 'A', cls: 'st-untracked', label: 'Added (not staged)' },
  deleted: { letter: 'D', cls: 'st-deleted', label: 'Deleted' },
  renamed: { letter: 'R', cls: 'st-renamed', label: 'Renamed' },
  copied: { letter: 'C', cls: 'st-copied', label: 'Copied' },
  typechange: { letter: 'T', cls: 'st-typechange', label: 'Type changed' },
  conflicted: { letter: '!', cls: 'st-conflicted', label: 'Conflicted' }
}

export function statusOf(kind) {
  return STATUS[kind] || STATUS.modified
}

// Nests the flat list of changed paths into directories.
function buildTree(files) {
  const root = { name: '', path: '', dirs: new Map(), files: [] }
  for (const file of files) {
    const parts = file.path.split('/')
    let node = root
    for (const part of parts.slice(0, -1)) {
      if (!node.dirs.has(part)) {
        const dirPath = node.path ? `${node.path}/${part}` : part
        node.dirs.set(part, { name: part, path: dirPath, dirs: new Map(), files: [] })
      }
      node = node.dirs.get(part)
    }
    node.files.push(file)
  }
  return root
}

// The root itself is never drawn, so it keeps its (empty) name and only its
// children are compacted — otherwise a tree whose changes all sit under one
// directory would lose that directory's name entirely.
function compactRoot(node) {
  return { name: '', path: '', dirs: [...node.dirs.values()].map(compact), files: node.files }
}

// Collapses runs of single-child directories into one row ("src/main/handlers"),
// which is most of a deep tree when only a few files changed.
function compact(node) {
  let current = node
  const names = [node.name]
  while (current.files.length === 0 && current.dirs.size === 1) {
    current = current.dirs.values().next().value
    names.push(current.name)
  }
  return {
    name: names.filter(Boolean).join('/'),
    path: current.path,
    dirs: [...current.dirs.values()].map(compact),
    files: current.files
  }
}

// A row is two buttons rather than one: the check is its own control, and a
// button inside a button is not a thing the browser will render. The badge sits
// outside both, so the check can come between it and the name.
function FileRow({ file, isActive, isOpen, isDirty, isApproved, depth, onOpen, onToggleApproved }) {
  const status = statusOf(file.kind)
  const name = file.path.split('/').pop()
  const className = [
    'file-row',
    isActive ? 'active' : '',
    isOpen && !isActive ? 'opened' : '',
    isApproved ? 'approved' : '',
    file.exists ? '' : 'gone'
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={className} style={{ paddingLeft: 8 + depth * 12 }}>
      <button
        type="button"
        className="file-open"
        title={file.orig ? `${file.orig} → ${file.path}` : file.path}
        onClick={() => onOpen(file)}
      >
        <span className="file-name">{name}</span>
        {isDirty && <span className="dirty-dot" title="Unsaved changes" />}
      </button>
      <button
        type="button"
        className="approve-mark"
        role="checkbox"
        aria-checked={isApproved}
        title={
          isApproved
            ? 'Approved — click to clear'
            : "Mark this file's changes approved (cleared if the file changes)"
        }
        onClick={() => onToggleApproved(file)}
      >
        ✓
      </button>
      <span className={`badge ${status.cls}`} title={status.label}>
        {status.letter}
      </span>
    </div>
  )
}

function TreeNode({ node, depth, collapsed, toggle, ...rowProps }) {
  const isRoot = depth < 0
  const isCollapsed = collapsed.has(node.path)

  return (
    <>
      {!isRoot && (
        <button
          className="dir-row"
          style={{ paddingLeft: 8 + depth * 12 }}
          onClick={() => toggle(node.path)}
          title={node.path}
        >
          <span className={`chevron ${isCollapsed ? 'collapsed' : ''}`}>▾</span>
          <span className="dir-name">{node.name}</span>
        </button>
      )}
      {!isCollapsed && (
        <>
          {node.dirs.map((dir) => (
            <TreeNode
              key={dir.path}
              node={dir}
              depth={depth + 1}
              collapsed={collapsed}
              toggle={toggle}
              {...rowProps}
            />
          ))}
          {node.files.map((file) => (
            <FileRow
              key={file.path}
              file={file}
              depth={depth + 1}
              isActive={rowProps.activePath === file.path}
              isOpen={rowProps.openPaths.has(file.path)}
              isDirty={rowProps.dirtyPaths.has(file.path)}
              isApproved={rowProps.approved.has(file.path)}
              onOpen={rowProps.onOpen}
              onToggleApproved={rowProps.onToggleApproved}
            />
          ))}
        </>
      )}
    </>
  )
}

export default function Sidebar({
  repo,
  files,
  skipped,
  activePath,
  openPaths,
  dirtyPaths,
  approved,
  loading,
  onOpen,
  onToggleApproved,
  onRefresh,
  onPickRepo,
  onCommit
}) {
  const [filter, setFilter] = useState('')
  const [collapsed, setCollapsed] = useState(() => new Set())

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle) return files
    return files.filter((file) => file.path.toLowerCase().includes(needle))
  }, [files, filter])

  const tree = useMemo(() => compactRoot(buildTree(visible)), [visible])

  const toggle = (path) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const repoName = repo.root ? repo.root.split('/').filter(Boolean).pop() : null

  return (
    <aside className="sidebar">
      <header className="sidebar-header">
        <button className="repo-button" onClick={onPickRepo} title={repo.root || 'Open a repository'}>
          <span className="repo-name">{repoName || 'Open repository…'}</span>
          {repo.branch && <span className="repo-branch">{repo.branch}</span>}
        </button>
        <button
          // Spinning rather than disabling: a refresh runs on every window
          // focus, and toggling the button's enabled look would flicker.
          className={`icon-button ${loading ? 'spinning' : ''}`}
          onClick={onRefresh}
          disabled={!repo.root}
          title="Refresh changed files (F5)"
        >
          ⟳
        </button>
      </header>

      <input
        className="filter-input"
        type="search"
        placeholder="Filter changed files"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        onKeyDown={(event) => {
          // Enter opens the first match, so a filter is enough to get to a file.
          if (event.key === 'Enter' && visible.length > 0) onOpen(visible[0])
          if (event.key === 'Escape') setFilter('')
        }}
      />

      <div className="tree">
        {visible.length === 0 ? (
          <p className="empty">
            {!repo.root
              ? 'No repository open.'
              : files.length > 0
                ? 'No file matches the filter.'
                : skipped > 0
                  ? 'Nothing editable has changed — only submodules and binary files.'
                  : 'The work tree is clean.'}
          </p>
        ) : (
          <TreeNode
            node={tree}
            depth={-1}
            collapsed={collapsed}
            toggle={toggle}
            activePath={activePath}
            openPaths={openPaths}
            dirtyPaths={dirtyPaths}
            approved={approved}
            onOpen={onOpen}
            onToggleApproved={onToggleApproved}
          />
        )}
      </div>

      {/* The end of a review pass. Disabled rather than hidden with nothing
          ticked off, so it's visible as the thing the checkmarks lead to. */}
      <div className="commit-bar">
        <button
          className="button primary commit-button"
          onClick={onCommit}
          disabled={!repo.root || approved.size === 0}
          title={
            approved.size === 0
              ? 'Tick off the files you have reviewed first'
              : `Commit the ${approved.size} approved file${approved.size === 1 ? '' : 's'} (Ctrl+Enter)`
          }
        >
          {approved.size === 0
            ? 'Commit approved files'
            : `Commit ${approved.size} file${approved.size === 1 ? '' : 's'}`}
        </button>
      </div>

      <footer className="sidebar-footer">
        {files.length} changed file{files.length === 1 ? '' : 's'}
        {filter.trim() && files.length !== visible.length ? ` · ${visible.length} shown` : ''}
        {approved.size > 0 && (
          <span title="Files you have ticked off">{` · ${approved.size} approved`}</span>
        )}
        {skipped > 0 && (
          // Said out loud rather than hidden: the count would otherwise
          // disagree with `git status` for no visible reason.
          <span title="Submodules and binary files, which this editor can't open">
            {` · ${skipped} not editable`}
          </span>
        )}
      </footer>
    </aside>
  )
}
