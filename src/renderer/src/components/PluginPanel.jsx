import React, { useCallback, useEffect, useRef, useState } from 'react'
import { anyModalOpen } from './Modal'

const WIDTH_KEY = 'pluginPanelWidth'
const EXPANDED_KEY = 'pluginPanelExpanded'
const DEFAULT_WIDTH = 420
const MIN_WIDTH = 280
// The sidebar's width: however wide the sheet gets, the file list stays in
// view beside it. Matches the first column of .app in styles.css.
const SIDEBAR_WIDTH = 300

function savedWidth() {
  const width = Number(localStorage.getItem(WIDTH_KEY))
  return Number.isFinite(width) && width >= MIN_WIDTH ? width : DEFAULT_WIDTH
}

/**
 * The sheet plugin panels are drawn in: it slides in over the editor from the
 * right edge of the window rather than taking room from it, so opening and
 * closing it never reflows the file being read. Every panel stays mounted
 * whether or not it is showing — a plugin keeps its state, and its
 * subscriptions, while the user is back in the editor.
 *
 * Its left edge drags to resize; the expand button widens it over the whole
 * editor, and back. Both are remembered. Escape inside it closes it.
 */
export default function PluginPanel({ panels, openId, repo, onClose }) {
  const [width, setWidth] = useState(savedWidth)
  const [expanded, setExpanded] = useState(() => localStorage.getItem(EXPANDED_KEY) === '1')
  const drag = useRef(null)
  // While dragging, the width follows the pointer instead of animating to it.
  const [resizing, setResizing] = useState(false)
  // The panel last shown, kept while the sheet slides away so that it doesn't
  // empty out on its way.
  const lastKey = useRef(null)
  if (openId) lastKey.current = openId
  const shownKey = openId ?? lastKey.current

  const onPointerDown = useCallback(
    (event) => {
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      // Expanded, the width on screen is the one to drag from, not the saved one.
      const startWidth = expanded ? event.currentTarget.parentElement.offsetWidth : width
      drag.current = { startX: event.clientX, startWidth }
      setResizing(true)
    },
    [width, expanded]
  )

  const onPointerMove = useCallback((event) => {
    if (!drag.current) return
    const max = Math.max(MIN_WIDTH, window.innerWidth - SIDEBAR_WIDTH)
    const next = drag.current.startWidth + (drag.current.startX - event.clientX)
    // Dragging picks up from wherever it is, expanded or not.
    setExpanded(false)
    setWidth(Math.min(max, Math.max(MIN_WIDTH, next)))
  }, [])

  const onPointerUp = useCallback(() => {
    drag.current = null
    setResizing(false)
  }, [])

  useEffect(() => {
    localStorage.setItem(WIDTH_KEY, String(width))
  }, [width])
  useEffect(() => {
    localStorage.setItem(EXPANDED_KEY, expanded ? '1' : '0')
  }, [expanded])

  // A dialog the panel opened owns its own Escape.
  const onKeyDown = (event) => {
    if (event.key === 'Escape' && !anyModalOpen()) {
      event.preventDefault()
      onClose()
    }
  }

  const shown = panels.find((panel) => panel.key === shownKey)

  return (
    <aside
      className={`plugin-panel ${openId ? 'open' : ''} ${expanded ? 'expanded' : ''} ${resizing ? 'resizing' : ''}`}
      style={expanded ? undefined : { width }}
      aria-hidden={!openId}
      onKeyDown={onKeyDown}
    >
      <div
        className="plugin-panel-resize"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        title="Drag to resize"
      />
      {shown && (
        <header className="plugin-panel-header">
          <span className="plugin-panel-title">{shown.title}</span>
          <button
            className="icon-button"
            onClick={() => setExpanded((value) => !value)}
            title={expanded ? 'Shrink the panel' : 'Expand the panel over the editor'}
          >
            {expanded ? '⇥' : '⇤'}
          </button>
          <button className="icon-button" onClick={onClose} title="Close panel (Escape)">
            ×
          </button>
        </header>
      )}
      {panels.map(({ Component, key }) => (
        <div key={key} className="plugin-panel-body" hidden={key !== shownKey}>
          <Component repo={repo} open={key === openId} />
        </div>
      ))}
    </aside>
  )
}
