import React, { useEffect, useRef } from 'react'
import { useModalClaim } from './Modal'

/**
 * Modal used for the one destructive thing the app does: closing a tab that has
 * unsaved edits. Enter confirms, Escape cancels.
 */
export default function ConfirmDialog({ title, message, confirmLabel, extraLabel, onConfirm, onExtra, onCancel }) {
  const confirmRef = useRef(null)
  // Ctrl+W behind "this tab has unsaved changes" should not close another tab.
  useModalClaim()

  useEffect(() => {
    confirmRef.current?.focus()
  }, [])

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel()
        }}
      >
        <h2>{title}</h2>
        <p>{message}</p>
        <div className="modal-actions">
          <button className="button" onClick={onCancel}>
            Cancel
          </button>
          {extraLabel && (
            <button className="button" onClick={onExtra}>
              {extraLabel}
            </button>
          )}
          <button className="button primary" ref={confirmRef} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
