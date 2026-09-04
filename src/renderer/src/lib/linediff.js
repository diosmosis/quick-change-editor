// Line-level diff between the committed version of a file and what is in the
// editor right now.
//
// This runs in the renderer rather than shelling out to `git diff` so the
// gutter keeps up while you type: the moment an edit lands the markers are
// recomputed against HEAD, including edits that undo a generated change back to
// what was committed (which git can only tell you after a write).

// Myers' O(ND) is quadratic in the number of differing lines, so both the work
// and the trace memory need a ceiling. Past it we fall back to a positional
// comparison, which is a worse diff but still an honest one.
const MAX_LINES = 200000
const MAX_D = 1500

function splitLines(text) {
  return text.length === 0 ? [] : text.split('\n')
}

// Whitespace is not what this editor is for looking at. A generator that
// reindented a block, or a trailing space that came and went, would otherwise
// mark lines whose content nobody changed and bury the change actually worth
// reviewing. Lines are matched on their non-whitespace content instead — the
// rule `git diff -w` uses — so a line differing from the committed one only in
// spacing is not marked, not counted and not stepped through.
const squeeze = (line) => line.replace(/\s+/g, '')

// Identical lines are the overwhelming majority, so the substitution only runs
// on the ones that really do differ.
function sameLine(x, y) {
  return x === y || squeeze(x) === squeeze(y)
}

// Collects the matched (a-index, b-index) pairs of a shortest edit script.
// Returns null when the edit distance exceeds MAX_D.
function matchPairs(a, b) {
  const n = a.length
  const m = b.length
  const max = n + m
  const limit = Math.min(max, MAX_D)
  // v[k] is the furthest x reached on diagonal k, offset so k = 0 sits in the
  // middle.
  const v = new Int32Array(2 * max + 1)
  const trace = []

  let found = -1
  for (let d = 0; d <= limit && found < 0; d++) {
    // Only |k| <= d is reachable at this depth, so the round's snapshot can be
    // that slice instead of the whole array — total memory O(D²), not O(D·N).
    trace.push(v.slice(max - d, max + d + 1))
    for (let k = -d; k <= d; k += 2) {
      let x
      if (k === -d || (k !== d && v[k - 1 + max] < v[k + 1 + max])) {
        x = v[k + 1 + max] // moved down: an insertion from b
      } else {
        x = v[k - 1 + max] + 1 // moved right: a deletion from a
      }
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[k + max] = x
      if (x >= n && y >= m) {
        found = d
        break
      }
    }
  }
  if (found < 0) return null

  // Walk the trace back, recording every diagonal (matching) step.
  const matches = []
  let x = n
  let y = m
  for (let d = found; d > 0; d--) {
    const vd = trace[d]
    const k = x - y
    const prevK = k === -d || (k !== d && vd[k - 1 + d] < vd[k + 1 + d]) ? k + 1 : k - 1
    const prevX = vd[prevK + d]
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      x--
      y--
      matches.push(x * 2 ** 24 + y) // packed; unpacked below
    }
    x = prevX
    y = prevY
  }
  while (x > 0 && y > 0) {
    x--
    y--
    matches.push(x * 2 ** 24 + y)
  }

  matches.reverse()
  return matches
}

// Pairs are packed into one number to keep the (potentially long) match list
// free of per-entry array allocation.
const unpackA = (p) => Math.floor(p / 2 ** 24)
const unpackB = (p) => p % 2 ** 24

// Compares line-for-line from the top. Used when the real diff would cost too
// much; every position that differs is reported as a change. `a` and `b` are
// squeezed lines, `base` the untrimmed base text the reported content is sliced
// out of, and `offset` the number of lines trimmed off its front.
function positionalChanges(a, b, offset, base) {
  const changes = []
  const common = Math.min(a.length, b.length)
  let run = -1
  for (let i = 0; i <= common; i++) {
    const same = i < common && a[i] === b[i]
    if (!same && run < 0 && i < common) run = i
    if ((same || i === common) && run >= 0) {
      changes.push(makeChange(base, run + offset, i + offset, run + offset, i + offset))
      run = -1
    }
  }
  if (a.length !== b.length) {
    changes.push(
      makeChange(base, common + offset, a.length + offset, common + offset, b.length + offset)
    )
  }
  return changes
}

function makeChange(baseLines, baseStart, baseEnd, curStart, curEnd) {
  return {
    baseStart,
    baseCount: baseEnd - baseStart,
    curStart,
    curCount: curEnd - curStart,
    // Kept for the tooltip on a deletion marker, where there is no line left in
    // the document to show what went away.
    removed: baseLines.slice(baseStart, baseEnd)
  }
}

/**
 * Diffs two texts by line.
 *
 * Returns the regions where they differ, in document order:
 *   { baseStart, baseCount, curStart, curCount, removed }
 * with `curStart`/`curCount` indexing the *current* text (0-based lines) and
 * `baseStart`/`baseCount` the committed one. A pure insertion has
 * `baseCount === 0`, a pure deletion `curCount === 0`.
 *
 * Lines that differ only in whitespace count as the same line and appear in no
 * region at all.
 */
export function computeLineChanges(baseText, curText) {
  if (baseText === curText) return []

  const base = splitLines(baseText)
  const cur = splitLines(curText)
  if (base.length > MAX_LINES || cur.length > MAX_LINES) return []

  // Identical head and tail are the bulk of a typical "a generator changed
  // three lines" diff; stripping them is what keeps the edit distance small.
  let prefix = 0
  const maxPrefix = Math.min(base.length, cur.length)
  while (prefix < maxPrefix && sameLine(base[prefix], cur[prefix])) prefix++

  let suffix = 0
  const maxSuffix = maxPrefix - prefix
  while (
    suffix < maxSuffix &&
    sameLine(base[base.length - 1 - suffix], cur[cur.length - 1 - suffix])
  ) {
    suffix++
  }

  const a = base.slice(prefix, base.length - suffix)
  const b = cur.slice(prefix, cur.length - suffix)
  if (a.length === 0 && b.length === 0) return []
  if (a.length === 0 || b.length === 0) {
    return [makeChange(base, prefix, prefix + a.length, prefix, prefix + b.length)]
  }

  // Past this point the diff runs over squeezed lines, so it never pairs two
  // that differ in more than their whitespace and never separates two that
  // differ in nothing else. The originals are kept for `removed`, which is text
  // to be shown rather than compared.
  const aKeys = a.map(squeeze)
  const bKeys = b.map(squeeze)

  const matches = matchPairs(aKeys, bKeys)
  if (matches === null) return positionalChanges(aKeys, bKeys, prefix, base)

  const changes = []
  let ai = 0
  let bi = 0
  for (const packed of matches) {
    const i = unpackA(packed)
    const j = unpackB(packed)
    if (i > ai || j > bi) {
      changes.push(makeChange(base, ai + prefix, i + prefix, bi + prefix, j + prefix))
    }
    ai = i + 1
    bi = j + 1
  }
  if (ai < a.length || bi < b.length) {
    changes.push(makeChange(base, ai + prefix, a.length + prefix, bi + prefix, b.length + prefix))
  }
  return changes
}

/**
 * Turns changes into what the gutter draws: a kind ('added' | 'modified' |
 * 'deleted') for each changed line of the current document, plus the removed
 * lines of a deletion, which have nowhere else to be shown and end up in the
 * marker's tooltip.
 *
 * A deletion is anchored to the line that now sits where the removed lines
 * used to be, and drawn as a wedge on that line's top edge — except at the end
 * of the file, where `atEnd` moves it to the bottom edge of the last line.
 *
 * `lineCount` is the number of lines in the current document.
 * Returns a Map of 0-based line -> { kind, removed, atEnd }.
 */
export function changesToMarkers(changes, lineCount) {
  const markers = new Map()
  const lastLine = Math.max(lineCount - 1, 0)
  const clamp = (line) => Math.min(Math.max(line, 0), lastLine)

  const at = (line) => {
    const key = clamp(line)
    let marker = markers.get(key)
    if (!marker) {
      marker = { kind: 'deleted', removed: null, atEnd: false }
      markers.set(key, marker)
    }
    return marker
  }

  for (const change of changes) {
    if (change.curCount === 0) {
      // Lines were removed and nothing took their place.
      const atEnd = change.curStart > lastLine
      const marker = at(atEnd ? lastLine : change.curStart)
      marker.removed = change.removed
      marker.atEnd = atEnd
      continue
    }

    const kind = change.baseCount === 0 ? 'added' : 'modified'
    for (let i = 0; i < change.curCount; i++) at(change.curStart + i).kind = kind

    // The change replaced more lines than it left behind, so it removed content
    // as well as altering it: hang the leftovers off its last line.
    if (change.baseCount > change.curCount) {
      at(change.curStart + change.curCount - 1).removed = change.removed.slice(change.curCount)
    }
  }

  return markers
}
