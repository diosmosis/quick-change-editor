import React, { useState } from 'react'

/**
 * What a command printed, folded away behind a summary line. Starts open only
 * when asked to — a failure's output is the explanation, a success's is noise
 * until someone wants it.
 *
 * `onToggle` hears every open/close, so a container that would otherwise go
 * away on a timer can stay put while it's being read.
 */
export default function CommandOutput({ output, label = 'Hook output', initiallyOpen = false, onToggle }) {
  const [open, setOpen] = useState(initiallyOpen)
  if (!output) return null
  const lines = output.split('\n').length

  return (
    <details
      className="command-output"
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open
        setOpen(next)
        onToggle?.(next)
      }}
    >
      <summary>
        {label} <span className="command-output-count">({lines} line{lines === 1 ? '' : 's'})</span>
      </summary>
      <pre>{output}</pre>
    </details>
  )
}
