import React, { useEffect, useRef } from 'react'

// How many of these are mounted. The app's shortcuts stand down while any is,
// the same as they do for the commit dialog: a modal with a text field in it
// should get Ctrl+S and Ctrl+W, not the editor behind it.
let mounted = 0

export function anyModalOpen() {
  return mounted > 0
}

// Counts the calling component as a modal for as long as it's mounted.
export function useModalClaim() {
  useEffect(() => {
    mounted++
    return () => {
      mounted--
    }
  }, [])
}

/**
 * The dialog frame, for the parts of the app that don't carry their own — the
 * settings dialog and plugins. Escape and a click on the backdrop close it,
 * unless `busy` says closing now would lose something.
 */
export default function Modal({ label, className = '', busy = false, onClose, children }) {
  const ref = useRef(null)

  useModalClaim()

  useEffect(() => {
    // Escape is heard on the dialog, so focus has to be inside it — on the
    // dialog itself, unless something in it already asked for it (autoFocus).
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus()
  }, [])

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <div
        ref={ref}
        className={`modal ${className}`}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !busy) onClose()
        }}
      >
        {children}
      </div>
    </div>
  )
}
