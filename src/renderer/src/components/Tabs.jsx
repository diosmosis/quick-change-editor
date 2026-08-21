import React, { useEffect, useRef } from 'react'
import { statusOf } from './Sidebar'

// Two open files can share a basename ("index.js"), so those tabs get enough of
// their parent directories to tell them apart.
function labelsFor(tabs) {
  const labels = new Map()
  const byName = new Map()
  for (const tab of tabs) {
    const name = tab.name
    byName.set(name, [...(byName.get(name) || []), tab])
  }
  for (const [name, group] of byName) {
    if (group.length === 1) {
      labels.set(group[0].path, name)
      continue
    }
    for (const tab of group) {
      const parts = tab.path.split('/')
      labels.set(tab.path, parts.length > 1 ? `${parts[parts.length - 2]}/${name}` : name)
    }
  }
  return labels
}

export default function Tabs({ tabs, activePath, onSelect, onClose }) {
  const stripRef = useRef(null)
  const labels = labelsFor(tabs)

  // Keep the active tab in view when it was opened from the sidebar or reached
  // with Ctrl+Tab rather than by clicking.
  useEffect(() => {
    const active = stripRef.current?.querySelector('.tab.active')
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activePath, tabs.length])

  if (tabs.length === 0) return null

  return (
    <div className="tab-strip" ref={stripRef}>
      {tabs.map((tab) => {
        const status = statusOf(tab.kind)
        return (
          <div
            key={tab.path}
            className={`tab ${tab.path === activePath ? 'active' : ''}`}
            title={tab.path}
            onMouseDown={(event) => {
              if (event.button === 1) {
                event.preventDefault()
                onClose(tab.path)
              } else if (event.button === 0) {
                onSelect(tab.path)
              }
            }}
          >
            <span className={`badge ${status.cls}`} title={status.label}>
              {status.letter}
            </span>
            <span className="tab-label">{labels.get(tab.path)}</span>
            {tab.stale && <span className="tab-stale" title="Changed on disk since it was opened" />}
            <button
              className="tab-close"
              title="Close (Ctrl+W)"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                onClose(tab.path)
              }}
            >
              {tab.dirty ? <span className="dirty-dot" /> : '×'}
            </button>
          </div>
        )
      })}
    </div>
  )
}
