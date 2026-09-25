import React from 'react'

// Sizes here are a file on disk, so the units people use for files.
function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return null
  if (bytes < 1024) return `${bytes} byte${bytes === 1 ? '' : 's'}`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

/**
 * What a binary file's tab holds instead of an editor.
 *
 * These used to be left out of the list entirely, which meant they could never
 * be ticked off or committed from here. There is still nothing to show of the
 * contents — the point is to say so plainly, and let the file take part in a
 * review pass anyway.
 */
export default function BinaryFile({ path, size, exists }) {
  const readable = formatSize(size)
  return (
    <div className="binary-view">
      <div className="binary-card">
        <span className="binary-glyph" aria-hidden="true">
          ⬛
        </span>
        <h2>Binary file</h2>
        <p className="binary-path" title={path}>
          {path}
        </p>
        <p className="binary-meta">
          {readable ? (exists ? readable : `${readable} in HEAD`) : 'Size unknown'}
        </p>
        <p className="binary-note">
          There is no text to show or edit. Tick it off in the sidebar to include it in a commit
          like any other change.
        </p>
      </div>
    </div>
  )
}
