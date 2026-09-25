import React, { useEffect, useRef, useState } from 'react'
import { statusOf } from './Sidebar'
import CommandOutput from './CommandOutput'

/**
 * Asks for a message, then commits the approved files. The list is shown in
 * full rather than summarised: this is the last look at what is about to be
 * written, and the point of the app is that nothing gets committed unlooked-at.
 *
 * Ticking "amend" folds the files into HEAD instead, and swaps the message for
 * HEAD's so it can be edited rather than retyped. Unticking brings back whatever
 * was being written before.
 *
 * `head` is the commit an amend would rewrite: undefined while it's being looked
 * up, null when there isn't one. `failure` is the last attempt's rejection, as
 * { error, output, attempt } — shown here, output open, since the dialog stays
 * up for another try.
 *
 * Ctrl+Enter commits, Escape cancels.
 */
export default function CommitDialog({
  files,
  dirtyPaths,
  branch,
  head,
  busy,
  failure,
  onCommit,
  onCancel
}) {
  const [message, setMessage] = useState('')
  const [amend, setAmend] = useState(false)
  // The new-commit message, set aside while the amend one is in the box.
  const draftRef = useRef('')
  const inputRef = useRef(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const unsaved = files.filter((file) => dirtyPaths.has(file.path))
  const ready = message.trim().length > 0 && !busy
  const submit = () => {
    if (ready) onCommit(message, amend)
  }

  const toggleAmend = (next) => {
    if (next === amend || (next && !head)) return
    if (next) {
      draftRef.current = message
      setMessage(head.message)
    } else {
      setMessage(draftRef.current)
    }
    setAmend(next)
    inputRef.current?.focus()
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
        aria-label={amend ? 'Amend the last commit' : 'Commit approved files'}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !busy) onCancel()
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            submit()
          }
        }}
      >
        <h2>
          {amend ? 'Amend the last commit with' : 'Commit'} {files.length} approved file
          {files.length === 1 ? '' : 's'}
          {branch && <span className="commit-branch">on {branch}</span>}
        </h2>

        <label
          className={`commit-amend ${head ? '' : 'disabled'}`}
          title={head === null ? 'There is no commit to amend yet.' : undefined}
        >
          <input
            type="checkbox"
            checked={amend}
            onChange={(event) => toggleAmend(event.target.checked)}
            disabled={busy || !head}
          />
          Amend the previous commit
          {head && (
            <span className="commit-amend-head" title={head.subject}>
              {head.hash} {head.subject}
            </span>
          )}
        </label>

        <textarea
          ref={inputRef}
          className="commit-message"
          rows={4}
          placeholder={amend ? 'Amended commit message' : 'Commit message'}
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
          {amend && head && ` Amending rewrites ${head.hash}; don’t, if it has already been pushed.`}
        </p>

        {failure && (
          <div className="commit-failure" role="alert">
            <p className="commit-error">{failure.error}</p>
            <CommandOutput key={failure.attempt} output={failure.output} initiallyOpen />
          </div>
        )}

        <div className="modal-actions">
          <button className="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="button primary" onClick={submit} disabled={!ready} title="Ctrl+Enter">
            {busy ? (amend ? 'Amending…' : 'Committing…') : amend ? 'Amend' : 'Commit'}
          </button>
        </div>
      </div>
    </div>
  )
}
