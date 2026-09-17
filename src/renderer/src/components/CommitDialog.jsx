import React, { useEffect, useRef, useState } from 'react'
import { statusOf } from './Sidebar'

/**
 * Asks for a message, then commits the approved files. The list is shown in
 * full rather than summarised: this is the last look at what is about to be
 * written, and the point of the app is that nothing gets committed unlooked-at.
 *
 * Ctrl+Enter commits, Escape cancels.
 */
export default function CommitDialog({ files, dirtyPaths, branch, busy, onCommit, onCancel }) {
  const [message, setMessage] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const unsaved = files.filter((file) => dirtyPaths.has(file.path))
  const ready = message.trim().length > 0 && !busy
  const submit = () => {
    if (ready) onCommit(message)
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel()
      }}
    >
      <div
        className="modal commit-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Commit approved files"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !busy) onCancel()
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            submit()
          }
        }}
      >
        <h2>
          Commit {files.length} approved file{files.length === 1 ? '' : 's'}
          {branch && <span className="commit-branch">on {branch}</span>}
        </h2>

        <textarea
          ref={inputRef}
          className="commit-message"
          rows={4}
          placeholder="Commit message"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          disabled={busy}
        />

        <ul className="commit-files">
          {files.map((file) => {
            const status = statusOf(file.kind)
            return (
              <li key={file.path}>
                <span className={`badge ${status.cls}`} title={status.label}>
                  {status.letter}
                </span>
                <span className="commit-file-path" title={file.orig ? `${file.orig} → ${file.path}` : file.path}>
                  {file.orig ? `${file.orig} → ${file.path}` : file.path}
                </span>
              </li>
            )
          })}
        </ul>

        <p className="commit-note">
          {unsaved.length > 0 && (
            <>
              {unsaved.length === 1
                ? `${unsaved[0].path} has unsaved edits and will be saved first. `
                : `${unsaved.length} of these have unsaved edits and will be saved first. `}
            </>
          )}
          Everything else in the work tree is left alone, staged or not.
        </p>

        <div className="modal-actions">
          <button className="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="button primary" onClick={submit} disabled={!ready} title="Ctrl+Enter">
            {busy ? 'Committing…' : 'Commit'}
          </button>
        </div>
      </div>
    </div>
  )
}
