// The change bar down the left of the editor: green for lines this work tree
// added, amber for lines it altered, and a red wedge where it removed lines.
//
// Markers are recomputed from the committed text a short moment after each
// edit, so they follow what you type instead of only what git has been told
// about. Between recomputes the existing markers are mapped through the edit,
// which keeps them attached to the right lines.
import { RangeSet, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state'
import { EditorView, GutterMarker, ViewPlugin, gutter } from '@codemirror/view'

import { changesToMarkers, computeLineChanges } from './linediff'

const RECOMPUTE_DELAY = 120
const TOOLTIP_MAX_LINES = 20

const setBase = StateEffect.define()
const setMarkers = StateEffect.define()

// The committed version of the file, i.e. what the gutter compares against.
const baseField = StateField.define({
  create: () => '',
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setBase)) return effect.value
    return value
  }
})

const markerField = StateField.define({
  create: () => RangeSet.empty,
  update(markers, tr) {
    // Keep the markers pinned to their lines until the next recompute lands.
    let updated = tr.docChanged ? markers.map(tr.changes) : markers
    for (const effect of tr.effects) if (effect.is(setMarkers)) updated = effect.value
    return updated
  }
})

function tooltipFor(removed) {
  const shown = removed.slice(0, TOOLTIP_MAX_LINES).join('\n')
  const rest = removed.length - TOOLTIP_MAX_LINES
  const label = `${removed.length} line${removed.length === 1 ? '' : 's'} removed`
  return rest > 0 ? `${label}:\n${shown}\n… ${rest} more` : `${label}:\n${shown}`
}

class DiffMarker extends GutterMarker {
  constructor(kind, removed, atEnd) {
    super()
    this.kind = kind
    this.removed = removed
    this.atEnd = atEnd
  }

  eq(other) {
    return (
      this.kind === other.kind &&
      this.atEnd === other.atEnd &&
      (this.removed?.length ?? 0) === (other.removed?.length ?? 0)
    )
  }

  toDOM() {
    const el = document.createElement('div')
    el.className = `cm-diffMark cm-diffMark-${this.kind}`
    if (this.removed?.length) {
      const wedge = document.createElement('div')
      wedge.className = this.atEnd ? 'cm-diffWedge cm-diffWedge-end' : 'cm-diffWedge'
      wedge.title = tooltipFor(this.removed)
      el.appendChild(wedge)
    }
    return el
  }
}

function buildMarkers(state) {
  const doc = state.doc
  const changes = computeLineChanges(state.field(baseField), doc.toString())
  const markers = changesToMarkers(changes, doc.lines)

  const builder = new RangeSetBuilder()
  const stats = { added: 0, modified: 0, removed: 0 }
  // RangeSetBuilder needs positions in ascending order; the map is keyed by
  // line number, so sorting the keys is enough.
  for (const line of [...markers.keys()].sort((a, b) => a - b)) {
    const marker = markers.get(line)
    builder.add(doc.line(line + 1).from, doc.line(line + 1).from, new DiffMarker(
      marker.kind,
      marker.removed,
      marker.atEnd
    ))
    if (marker.kind === 'added') stats.added++
    else if (marker.kind === 'modified') stats.modified++
    if (marker.removed?.length) stats.removed += marker.removed.length
  }
  return { set: builder.finish(), stats }
}

const diffTheme = EditorView.baseTheme({
  '.cm-diffGutter': {
    width: '6px',
    padding: '0',
    // The wedge for a removed block sticks out past the gutter's own box.
    overflow: 'visible'
  },
  '.cm-diffGutter .cm-gutterElement': { padding: '0', overflow: 'visible' },
  '.cm-diffMark': { position: 'relative', width: '100%', height: '100%' },
  '.cm-diffMark-added': { background: 'var(--diff-added)' },
  '.cm-diffMark-modified': { background: 'var(--diff-modified)' },
  '.cm-diffWedge': {
    position: 'absolute',
    left: '0',
    top: '0',
    width: '0',
    height: '0',
    borderLeft: '6px solid var(--diff-removed)',
    borderBottom: '5px solid transparent',
    cursor: 'default'
  },
  '.cm-diffWedge-end': { top: 'auto', bottom: '0', borderBottom: 'none', borderTop: '5px solid transparent' }
})

/**
 * Builds the extension. `initialBase` is the committed text; `onStats` (if
 * given) is called with { added, modified, removed } after every recompute, for
 * the status bar.
 */
export function diffGutter(initialBase, onStats) {
  const recompute = ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.view = view
        this.timer = null
        this.schedule(0)
      }

      update(update) {
        const baseChanged = update.transactions.some((tr) =>
          tr.effects.some((effect) => effect.is(setBase))
        )
        if (update.docChanged || baseChanged) this.schedule(RECOMPUTE_DELAY)
      }

      schedule(delay) {
        clearTimeout(this.timer)
        // Always out of band: a plugin can't dispatch from inside update().
        this.timer = setTimeout(() => {
          const { set, stats } = buildMarkers(this.view.state)
          this.view.dispatch({ effects: setMarkers.of(set) })
          onStats?.(stats)
        }, delay)
      }

      destroy() {
        clearTimeout(this.timer)
      }
    }
  )

  return [
    baseField.init(() => initialBase),
    markerField,
    gutter({
      class: 'cm-diffGutter',
      markers: (view) => view.state.field(markerField),
      // Without a spacer the gutter has no width until the first marker exists.
      initialSpacer: () => new DiffMarker('none', null, false)
    }),
    diffTheme,
    recompute
  ]
}

/** Points the gutter at a different committed text (after a reload). */
export function setDiffBase(view, base) {
  view.dispatch({ effects: setBase.of(base) })
}
