import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { Compartment, EditorState } from '@codemirror/state'
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import {
  LanguageDescription,
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput
} from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { oneDark } from '@codemirror/theme-one-dark'

import { diffGutter, setDiffBase } from '../lib/diffGutter'

// Sits after oneDark so it wins: the editor has to match the rest of the app's
// chrome rather than bring its own background.
const appTheme = EditorView.theme(
  {
    '&': { height: '100%', fontSize: '13px', backgroundColor: 'var(--editor-bg)' },
    '.cm-scroller': {
      fontFamily: "'JetBrains Mono', 'Fira Code', 'DejaVu Sans Mono', Menlo, Consolas, monospace",
      lineHeight: '1.5'
    },
    '.cm-gutters': {
      backgroundColor: 'var(--editor-bg)',
      color: 'var(--muted)',
      border: 'none'
    },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text)' },
    '.cm-activeLine': { backgroundColor: 'rgba(255, 255, 255, 0.03)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
      backgroundColor: 'rgba(91, 140, 255, 0.25)'
    },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 12px' }
  },
  { dark: true }
)

// `editable` as well as `readOnly`: the first stops the caret and the drop
// target, the second stops programmatic and command-driven changes.
function readOnlyExtension(readOnly) {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]
}

/**
 * One CodeMirror instance, one open file. The parent keeps every open tab's
 * editor mounted (hidden when inactive) so switching tabs preserves the
 * cursor, scroll position and undo history.
 *
 * Talks to the parent through the imperative handle rather than props, because
 * the document is CodeMirror's state to own — mirroring it into React would
 * mean a re-render per keystroke.
 */
const Editor = forwardRef(function Editor(
  { path, name, initialContent, initialBase, readOnly, active, onDirtyChange, onStats, onCursor },
  ref
) {
  const hostRef = useRef(null)
  const viewRef = useRef(null)
  // The text as it is on disk. Dirty state is "document differs from this".
  const savedDocRef = useRef(null)
  const dirtyRef = useRef(false)
  const languageRef = useRef(new Compartment())
  // A file can be deleted (or restored) from under an open tab, which changes
  // whether it may be edited, so this can't be baked in at construction.
  const readOnlyRef = useRef(new Compartment())
  // Callbacks are read through a ref so the view is built exactly once, no
  // matter how often the parent re-renders.
  const handlers = useRef({ onDirtyChange, onStats, onCursor })
  handlers.current = { onDirtyChange, onStats, onCursor }

  useEffect(() => {
    const state = EditorState.create({
      doc: initialContent,
      extensions: [
        // Before lineNumbers, so the change bar is the leftmost thing on screen.
        diffGutter(initialBase, (stats) => handlers.current.onStats?.(path, stats)),
        lineNumbers(),
        highlightActiveLineGutter(),
        foldGutter(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        bracketMatching(),
        rectangularSelection(),
        highlightActiveLine(),
        search(),
        highlightSelectionMatches(),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...foldKeymap, indentWithTab]),
        readOnlyRef.current.of(readOnlyExtension(Boolean(readOnly))),
        EditorView.lineWrapping,
        oneDark,
        appTheme,
        languageRef.current.of([]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const dirty = !update.state.doc.eq(savedDocRef.current)
            if (dirty !== dirtyRef.current) {
              dirtyRef.current = dirty
              handlers.current.onDirtyChange?.(path, dirty)
            }
          }
          if (update.docChanged || update.selectionSet) {
            const head = update.state.selection.main.head
            const line = update.state.doc.lineAt(head)
            handlers.current.onCursor?.(path, {
              line: line.number,
              column: head - line.from + 1
            })
          }
        })
      ]
    })

    const view = new EditorView({ state, parent: hostRef.current })
    viewRef.current = view
    savedDocRef.current = state.doc

    return () => {
      view.destroy()
      viewRef.current = null
    }
    // Deliberately mount-only: everything that changes later goes through the
    // imperative handle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Syntax highlighting: the language for this filename is loaded lazily and
  // swapped in when it arrives, so opening a file never waits on it.
  useEffect(() => {
    const description = LanguageDescription.matchFilename(languages, name)
    if (!description) return undefined

    let cancelled = false
    description
      .load()
      .then((support) => {
        if (!cancelled && viewRef.current) {
          viewRef.current.dispatch({ effects: languageRef.current.reconfigure(support) })
        }
      })
      .catch(() => {
        // An unloadable grammar just means plain text.
      })
    return () => {
      cancelled = true
    }
  }, [name])

  // A hidden editor can't measure itself, so it comes back with a stale layout.
  useEffect(() => {
    if (!active || !viewRef.current) return
    viewRef.current.requestMeasure()
    viewRef.current.focus()
  }, [active])

  useImperativeHandle(ref, () => ({
    content: () => viewRef.current?.state.doc.toString() ?? '',
    focus: () => viewRef.current?.focus(),

    // Called after a successful write: the document on screen is now what's on
    // disk, so it is no longer dirty.
    markSaved: () => {
      const view = viewRef.current
      if (!view) return
      savedDocRef.current = view.state.doc
      if (dirtyRef.current) {
        dirtyRef.current = false
        handlers.current.onDirtyChange?.(path, false)
      }
    },

    // Points the change bar at a different committed version, after a commit or
    // a stage changed what HEAD holds. Leaves the document alone.
    setBase: (base) => {
      if (viewRef.current) setDiffBase(viewRef.current, base)
    },

    setReadOnly: (value) => {
      const view = viewRef.current
      if (!view || view.state.readOnly === Boolean(value)) return
      view.dispatch({
        effects: readOnlyRef.current.reconfigure(readOnlyExtension(Boolean(value)))
      })
    },

    // Something outside the app rewrote the file (a generator, a checkout).
    // Replace the document wholesale, keeping the scroll position.
    replaceContent: (content, base) => {
      const view = viewRef.current
      if (!view) return
      if (view.state.doc.toString() === content) {
        // Same text: re-dispatching it would only churn the undo history.
        if (base !== undefined) setDiffBase(view, base)
        return
      }
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: content },
        // A full replace would otherwise scroll the file back to the top.
        scrollIntoView: false
      })
      savedDocRef.current = view.state.doc
      if (dirtyRef.current) {
        dirtyRef.current = false
        handlers.current.onDirtyChange?.(path, false)
      }
      if (base !== undefined) setDiffBase(view, base)
    }
  }))

  return <div className="editor-host" ref={hostRef} />
})

export default React.memo(Editor)
