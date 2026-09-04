// Which indentation a file already uses, worked out from the text itself.
//
// The point is to leave a file looking the way it looked: Tab in a tab-indented
// file has to insert a tab, and in a four-space file four spaces. CodeMirror has
// no opinion of its own — its `indentUnit` facet is two spaces whatever the
// document holds — so the answer has to be measured per file and configured.

// Only the top of a file is examined. Indentation is a whole-file property in
// practice, and this runs again whenever a tab's contents are replaced.
const MAX_LINES = 5000

// What's being measured is the step from one indentation level to the next, and
// a step this wide is a continuation line aligned under an opening bracket
// rather than a level of its own.
const MAX_STEP = 8

// A tab-indented file carries no record of how wide its author drew a tab, so
// the near-universal convention stands in.
const TAB_WIDTH = 4

// What a file with nothing to go on gets: CodeMirror's own default, so files
// that say nothing behave exactly as they did before any of this existed.
const FALLBACK = { useTabs: false, size: 2 }

/**
 * Reads a file's indentation style out of its text.
 *
 * Returns `{ useTabs, size }`, where `size` is how many spaces make one level —
 * or, when `useTabs`, how wide to draw a tab.
 */
export function detectIndentation(text) {
  const lines = text.split('\n')
  const limit = Math.min(lines.length, MAX_LINES)

  let tabLines = 0
  let spaceLines = 0
  // How often each step up in width appears from one line to the next. This is
  // a far better signal than the absolute widths, which are all multiples of the
  // step and so can't distinguish 2 from 4 without guessing at a common factor.
  const steps = new Map()
  let previous = 0

  for (let i = 0; i < limit; i++) {
    const line = lines[i]
    let width = 0
    while (width < line.length && (line[width] === ' ' || line[width] === '\t')) width++

    // A line with nothing on it says nothing about indentation, and neither
    // does the body of a block comment: ` * like this` reads as a one-space
    // step and, in a file with enough of them, outvotes the real indentation.
    if (width === line.length) continue
    if (width > 0 && line[width] === '*') continue

    if (line[0] === '\t') {
      tabLines++
      continue
    }

    if (width === 0) {
      previous = 0
      continue
    }

    spaceLines++
    const step = width - previous
    if (step > 0 && step <= MAX_STEP) steps.set(step, (steps.get(step) ?? 0) + 1)
    previous = width
  }

  // Ties go to the narrower step. A file indented with two spaces produces some
  // four-space steps wherever a line skips a level (a nested object literal
  // opening and its body), but never the other way round.
  let size = 0
  let best = 0
  for (const [step, count] of steps) {
    if (count > best || (count === best && step < size)) {
      size = step
      best = count
    }
  }

  if (tabLines > spaceLines) return { useTabs: true, size: TAB_WIDTH }
  if (size === 0) return FALLBACK
  return { useTabs: false, size }
}

/** How the status bar says it. */
export function describeIndentation({ useTabs, size }) {
  return useTabs ? `Tabs (${size})` : `Spaces: ${size}`
}
