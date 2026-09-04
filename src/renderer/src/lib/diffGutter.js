// The change bar down the left of the editor: green for lines this work tree
// added, amber for lines it altered, and a red wedge where it removed lines.
//
// Markers are recomputed from the committed text a short moment after each
// edit, so they follow what you type instead of only what git has been told
// about. Between recomputes the existing markers are mapped through the edit,
// which keeps them attached to the right lines.
//
// The same markers back the change navigator: `gotoChange` steps the cursor
// from one run of marked lines to the next, so a file can be reviewed without
// scrolling through the parts of it nothing touched.
//
// Clicking a marker opens that one change: the lines it replaced are drawn
// above it, read-only and on red, and the lines that replaced them go green.
// The rest of the file is untouched, and any number of changes can be open at
// once.
import { RangeSet, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, GutterMarker, ViewPlugin, WidgetType, gutter } from '@codemirror/view'

import { changesToMarkers, computeLineChanges } from './linediff'

const RECOMPUTE_DELAY = 120
const TOOLTIP_MAX_LINES = 20
// Long enough for the eye to catch where the jump landed, short enough not to
// linger over the line you are about to edit.
const FLASH_DURATION = 700

const setBase = StateEffect.define()
const setMarkers = StateEffect.define()
// The change list the markers were built from, kept so a click can tell which
// change it landed on and what that change removed.
const setChanges = StateEffect.define()
// A document position — the first line of a change — to open or close.
const toggleExpanded = StateEffect.define()
const clearExpanded = StateEffect.define()
// The block a jump just landed on, as { from, to } line numbers, or null to
// clear it again.
const setFlash = StateEffect.define()

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

// Whatever `buildMarkers` last diffed. Only read when a change is opened or
// drawn, so being up to one recompute out of date costs nothing.
const changesField = StateField.define({
  create: () => [],
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setChanges)) return effect.value
    return value
  }
})

// The open changes, held as the document position of each one's first line so
// they survive edits elsewhere in the file. A position that no longer starts a
// change simply draws nothing, which is what should happen when an edit makes
// the change it belonged to go away.
const expandedField = StateField.define({
  create: () => new Set(),
  update(value, tr) {
    let next = value
    if (tr.docChanged && next.size > 0) {
      next = new Set([...next].map((pos) => tr.changes.mapPos(pos)))
    }
    for (const effect of tr.effects) {
      if (effect.is(clearExpanded)) {
        next = next.size > 0 ? new Set() : next
      } else if (effect.is(toggleExpanded)) {
        next = new Set(next)
        if (!next.delete(effect.value)) next.add(effect.value)
      }
    }
    return next
  }
})

// Where a change hangs its marker, as a 1-based line number, or 0 when it has
// nowhere to hang it in this document. A deletion goes on the line that now
// sits where the removed lines were — the end of the file, if they were its
// last lines — and everything else on its own first line.
function anchorLineFor(change, doc) {
  const line = change.curCount === 0 ? Math.min(change.curStart, doc.lines - 1) : change.curStart
  return line >= 0 && line < doc.lines ? line + 1 : 0
}

// The change a click on the change bar was aimed at, or null for a line the
// bar doesn't mark.
function changeAtLine(changes, line, doc) {
  for (const change of changes) {
    if (change.curCount === 0) {
      if (anchorLineFor(change, doc) === line) return change
    } else if (line > change.curStart && line <= change.curStart + change.curCount) {
      return change
    }
  }
  return null
}

const replacementLine = Decoration.line({ class: 'cm-diffReplacement' })

// The lines a change removed, drawn above what replaced them. A widget rather
// than text in the document: it is not part of the file, so it must not be
// editable and must not be saved.
class RemovedLinesWidget extends WidgetType {
  constructor(lines) {
    super()
    this.lines = lines
  }

  eq(other) {
    return this.lines.length === other.lines.length && this.lines.every((l, i) => l === other.lines[i])
  }

  toDOM() {
    const el = document.createElement('div')
    el.className = 'cm-diffRemovedBlock'
    el.contentEditable = 'false'
    el.title = `${this.lines.length} line${this.lines.length === 1 ? '' : 's'} removed`
    for (const line of this.lines) {
      const row = document.createElement('div')
      row.className = 'cm-diffRemovedLine'
      row.textContent = line
      el.appendChild(row)
    }
    return el
  }

  // Clicks and selections inside belong to the browser, not to the editor.
  ignoreEvent() {
    return true
  }
}

function buildExpansions(state) {
  const anchors = state.field(expandedField)
  if (anchors.size === 0) return Decoration.none

  const doc = state.doc
  const ranges = []
  for (const change of state.field(changesField)) {
    const anchor = anchorLineFor(change, doc)
    if (anchor === 0) continue
    const pos = doc.line(anchor).from
    if (!anchors.has(pos)) continue

    if (change.removed.length > 0) {
      // Lines removed off the end of the file have no line left below them to
      // sit above, so they go after the last one instead.
      const atEnd = change.curCount === 0 && change.curStart > doc.lines - 1
      ranges.push(
        Decoration.widget({
          widget: new RemovedLinesWidget(change.removed),
          block: true,
          side: atEnd ? 1 : -1
        }).range(atEnd ? doc.line(doc.lines).to : pos)
      )
    }
    for (let i = 0; i < change.curCount; i++) {
      const number = change.curStart + 1 + i
      if (number > doc.lines) break
      ranges.push(replacementLine.range(doc.line(number).from))
    }
  }
  return Decoration.set(ranges, true)
}

const expansionField = StateField.define({
  create: () => Decoration.none,
  update(value, tr) {
    const rebuild = tr.effects.some(
      (effect) =>
        effect.is(setChanges) || effect.is(toggleExpanded) || effect.is(clearExpanded)
    )
    if (rebuild) return buildExpansions(tr.state)
    // Between rebuilds, ride along with the edit like the gutter markers do.
    return tr.docChanged ? value.map(tr.changes) : value
  },
  provide: (field) => EditorView.decorations.from(field)
})

const flashDecoration = Decoration.line({ class: 'cm-changeFlash' })

const flashField = StateField.define({
  create: () => Decoration.none,
  update(value, tr) {
    let updated = tr.docChanged ? value.map(tr.changes) : value
    for (const effect of tr.effects) {
      if (!effect.is(setFlash)) continue
      if (!effect.value) {
        updated = Decoration.none
        continue
      }
      const builder = new RangeSetBuilder()
      for (let line = effect.value.from; line <= effect.value.to; line++) {
        builder.add(tr.state.doc.line(line).from, tr.state.doc.line(line).from, flashDecoration)
      }
      updated = builder.finish()
    }
    return updated
  },
  provide: (field) => EditorView.decorations.from(field)
})

// Clears the flash once it has been seen. A timer rather than a CSS animation
// end, so a second jump landing on the same block restarts it cleanly.
const flashTimer = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.view = view
      this.timer = null
    }

    update(update) {
      const flashed = update.transactions.some((tr) =>
        tr.effects.some((effect) => effect.is(setFlash) && effect.value)
      )
      if (!flashed) return
      clearTimeout(this.timer)
      this.timer = setTimeout(() => {
        this.view.dispatch({ effects: setFlash.of(null) })
      }, FLASH_DURATION)
    }

    destroy() {
      clearTimeout(this.timer)
    }
  }
)

function tooltipFor(removed) {
  const shown = removed.slice(0, TOOLTIP_MAX_LINES).join('\n')
  const rest = removed.length - TOOLTIP_MAX_LINES
  const label = `${removed.length} line${removed.length === 1 ? '' : 's'} removed`
  return rest > 0 ? `${label}:\n${shown}\n… ${rest} more` : `${label}:\n${shown}`
}

class DiffMarker extends GutterMarker {
  constructor(kind, removed, atEnd, open) {
    super()
    this.kind = kind
    this.removed = removed
    this.atEnd = atEnd
    this.open = open
  }

  eq(other) {
    return (
      this.kind === other.kind &&
      this.atEnd === other.atEnd &&
      this.open === other.open &&
      (this.removed?.length ?? 0) === (other.removed?.length ?? 0)
    )
  }

  toDOM() {
    const el = document.createElement('div')
    el.className = `cm-diffMark cm-diffMark-${this.kind}${this.open ? ' cm-diffMark-open' : ''}`
    el.title = this.open ? 'Hide what this replaced' : 'Show what this replaced'
    if (this.removed?.length) {
      const wedge = document.createElement('div')
      wedge.className = this.atEnd ? 'cm-diffWedge cm-diffWedge-end' : 'cm-diffWedge'
      wedge.title = tooltipFor(this.removed)
      el.appendChild(wedge)
    }
    return el
  }
}

// The 0-based lines whose change is currently open, so the bar can show which
// ones they are.
function openLines(state, changes) {
  const anchors = state.field(expandedField)
  const lines = new Set()
  if (anchors.size === 0) return lines

  const doc = state.doc
  for (const change of changes) {
    const anchor = anchorLineFor(change, doc)
    if (anchor === 0 || !anchors.has(doc.line(anchor).from)) continue
    if (change.curCount === 0) lines.add(anchor - 1)
    else for (let i = 0; i < change.curCount; i++) lines.add(change.curStart + i)
  }
  return lines
}

function buildMarkers(state) {
  const doc = state.doc
  const changes = computeLineChanges(state.field(baseField), doc.toString())
  const markers = changesToMarkers(changes, doc.lines)
  const open = openLines(state, changes)

  const builder = new RangeSetBuilder()
  // `hunks` holds each run of consecutive marked lines as { from, to } (1-based,
  // inclusive) — the blocks the next/previous-change commands step through.
  const stats = { added: 0, modified: 0, removed: 0, hunks: [] }
  // RangeSetBuilder needs positions in ascending order; the map is keyed by
  // line number, so sorting the keys is enough.
  for (const line of [...markers.keys()].sort((a, b) => a - b)) {
    const marker = markers.get(line)
    const number = line + 1
    builder.add(doc.line(number).from, doc.line(number).from, new DiffMarker(
      marker.kind,
      marker.removed,
      marker.atEnd,
      open.has(line)
    ))
    const last = stats.hunks[stats.hunks.length - 1]
    if (last && number === last.to + 1) last.to = number
    else stats.hunks.push({ from: number, to: number })
    if (marker.kind === 'added') stats.added++
    else if (marker.kind === 'modified') stats.modified++
    if (marker.removed?.length) stats.removed += marker.removed.length
  }
  return { set: builder.finish(), changes, stats }
}

/**
 * The changed blocks of the current document, as { from, to } line numbers
 * (1-based, inclusive). Consecutive marked lines are one block, so a rewritten
 * paragraph is a single stop rather than one per line.
 *
 * Read off the live markers rather than re-diffing, so it stays in step with
 * what the change bar is actually showing.
 */
export function changeHunks(state) {
  const hunks = []
  for (const iter = state.field(markerField).iter(); iter.value; iter.next()) {
    const line = state.doc.lineAt(iter.from).number
    const last = hunks[hunks.length - 1]
    if (last && line === last.to + 1) last.to = line
    else hunks.push({ from: line, to: line })
  }
  return hunks
}

/**
 * Moves the cursor to the change before or after it (`direction` -1 or 1),
 * wrapping around the ends of the file, and flashes what it landed on.
 * Returns false when the file has no changes, which lets it be used as a
 * CodeMirror command.
 */
export function gotoChange(view, direction) {
  const hunks = changeHunks(view.state)
  if (hunks.length === 0) return false

  const line = view.state.doc.lineAt(view.state.selection.main.head).number
  const target =
    direction > 0
      ? hunks.find((hunk) => hunk.from > line) ?? hunks[0]
      : [...hunks].reverse().find((hunk) => hunk.to < line) ?? hunks[hunks.length - 1]

  const pos = view.state.doc.line(target.from).from
  view.dispatch({
    selection: { anchor: pos },
    effects: [
      // Centred rather than merely scrolled into view: a change at the very
      // bottom of the viewport is hard to read in context.
      EditorView.scrollIntoView(pos, { y: 'center' }),
      setFlash.of(target)
    ]
  })
  view.focus()
  return true
}

const diffTheme = EditorView.baseTheme({
  '.cm-diffGutter': {
    width: '6px',
    padding: '0',
    // The wedge for a removed block sticks out past the gutter's own box.
    overflow: 'visible'
  },
  '.cm-diffGutter .cm-gutterElement': { padding: '0', overflow: 'visible' },
  '.cm-diffMark': { position: 'relative', width: '100%', height: '100%', cursor: 'pointer' },
  '.cm-diffMark-added': { background: 'var(--diff-added)' },
  '.cm-diffMark-modified': { background: 'var(--diff-modified)' },
  // An open change dims its own marker, so the bar says which of them are
  // already showing what they replaced.
  '.cm-diffMark-open': { opacity: '0.45' },
  '.cm-diffWedge': {
    position: 'absolute',
    left: '0',
    top: '0',
    width: '0',
    height: '0',
    borderLeft: '6px solid var(--diff-removed)',
    borderBottom: '5px solid transparent',
    cursor: 'pointer'
  },
  '.cm-diffWedge-end': { top: 'auto', bottom: '0', borderBottom: 'none', borderTop: '5px solid transparent' },

  // Two classes deep on purpose: a one-class rule ties with `.cm-activeLine`,
  // which the app theme sets later and would otherwise win.
  '.cm-line.cm-diffReplacement': { backgroundColor: 'var(--diff-added-bg)' },
  '.cm-diffRemovedBlock': {
    backgroundColor: 'var(--diff-removed-bg)',
    cursor: 'text',
    userSelect: 'text'
  },
  '.cm-diffRemovedLine': {
    padding: '0 2px 0 6px',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere'
  },
  // A removed blank line still took up a line; without this it would have no
  // height at all and the block would come out shorter than what it shows.
  '.cm-diffRemovedLine:empty::before': { content: '"\\200b"' }
})

/**
 * Builds the extension. `initialBase` is the committed text; `onStats` (if
 * given) is called with { added, modified, removed, hunks } after every
 * recompute, for the status bar and its change navigator.
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
        let baseChanged = false
        let opened = false
        for (const tr of update.transactions) {
          for (const effect of tr.effects) {
            if (effect.is(setBase)) baseChanged = true
            else if (effect.is(toggleExpanded) || effect.is(clearExpanded)) opened = true
          }
        }
        // Opening a change only restyles its marker, so it need not wait for
        // the settling delay the way a keystroke does.
        if (opened) this.schedule(0)
        else if (update.docChanged || baseChanged) this.schedule(RECOMPUTE_DELAY)
      }

      schedule(delay) {
        clearTimeout(this.timer)
        // Always out of band: a plugin can't dispatch from inside update().
        this.timer = setTimeout(() => {
          const { set, changes, stats } = buildMarkers(this.view.state)
          this.view.dispatch({ effects: [setMarkers.of(set), setChanges.of(changes)] })
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
    changesField,
    expandedField,
    expansionField,
    flashField,
    flashTimer,
    gutter({
      class: 'cm-diffGutter',
      markers: (view) => view.state.field(markerField),
      // Without a spacer the gutter has no width until the first marker exists.
      initialSpacer: () => new DiffMarker('none', null, false, false),
      domEventHandlers: { mousedown: toggleChangeAt }
    }),
    diffTheme,
    recompute
  ]
}

// Opens or closes the change the change bar was clicked on. The diff is redone
// here rather than read off `changesField`, so a click lands on what is on
// screen even when the last keystroke is still inside the recompute delay —
// and the fresh list is published so the decorations agree with it.
function toggleChangeAt(view, block, event) {
  if (event.button !== 0) return false

  const doc = view.state.doc
  const changes = computeLineChanges(view.state.field(baseField), doc.toString())
  const change = changeAtLine(changes, doc.lineAt(block.from).number, doc)
  if (!change) return false

  view.dispatch({
    effects: [setChanges.of(changes), toggleExpanded.of(doc.line(anchorLineFor(change, doc)).from)]
  })
  return true
}

/**
 * Points the gutter at a different committed text (after a reload). A base
 * that hasn't moved is ignored: this runs on every window focus, and any open
 * change would otherwise close each time the window was clicked into.
 */
export function setDiffBase(view, base) {
  if (view.state.field(baseField) === base) return
  view.dispatch({ effects: [setBase.of(base), clearExpanded.of(null)] })
}

/** Closes every open change. The file was re-read from disk. */
export function clearDiffExpansions(view) {
  if (view.state.field(expandedField).size > 0) view.dispatch({ effects: clearExpanded.of(null) })
}
