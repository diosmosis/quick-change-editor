// Everything that shells out to git. Nothing here touches Electron, so it can
// be reasoned about (and run) on its own.
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// Generous: `git show HEAD:<file>` has to hold a whole blob, and generated
// files can be big.
const MAX_BUFFER = 64 * 1024 * 1024

// A failing command's own words are what gets shown; a runaway hook shouldn't
// be able to fill the window with them.
const MAX_MESSAGE_CHARS = 2000

// Bookkeeping for the .git watcher. `git status` refreshes the index, which
// writes .git/index (via .git/index.lock) — so the app's own reads look exactly
// like someone else changing the repository, and acting on them would mean
// refreshing forever. Anything that fires while git is running on our behalf,
// or immediately after, is ours.
let running = 0
let finishedAt = 0

function started() {
  running++
}

function finished() {
  running--
  finishedAt = Date.now()
}

/** True when no git command of ours has run for at least `graceMs`. */
export function gitIsSettled(graceMs) {
  return running === 0 && Date.now() - finishedAt > graceMs
}

// Runs git and resolves with the raw stdout Buffer. Rejects with git's stderr
// message, which is far more useful than "Command failed".
function git(root, args) {
  started()
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', root, ...args],
      { encoding: 'buffer', maxBuffer: MAX_BUFFER },
      (err, stdout, stderr) => {
        finished()
        if (err) {
          // A hook that rejects a commit says why on whichever stream it likes,
          // and that explanation is the only thing the user can act on.
          const said =
            stderr?.toString('utf8').trim() || stdout?.toString('utf8').trim() || ''
          reject(new Error(said ? said.slice(0, MAX_MESSAGE_CHARS) : err.message))
          return
        }
        resolve(stdout)
      }
    )
  })
}

// Same, but resolves to null instead of rejecting. Used where a non-zero exit
// is an answer rather than a failure ("this path is not in HEAD").
async function gitOrNull(root, args) {
  try {
    return await git(root, args)
  } catch {
    return null
  }
}

// Resolves a directory to the root of the work tree containing it, or null if
// it isn't in one. Bare repositories have no work tree, so they're rejected too.
export async function findRepoRoot(dir) {
  if (!dir || !fs.existsSync(dir)) return null
  const out = await gitOrNull(dir, ['rev-parse', '--show-toplevel'])
  if (!out) return null
  const root = out.toString('utf8').trim()
  return root ? path.resolve(root) : null
}

export async function currentBranch(root) {
  const out = await gitOrNull(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const name = out?.toString('utf8').trim()
  // No commits yet: rev-parse reports the unborn branch name via symbolic-ref.
  if (!name || name === 'HEAD') {
    const sym = await gitOrNull(root, ['symbolic-ref', '--short', 'HEAD'])
    return sym?.toString('utf8').trim() || null
  }
  return name
}

// Splits a NUL-separated buffer into fields, dropping the empty trailing one.
function splitNul(buf) {
  const parts = buf.toString('utf8').split('\0')
  if (parts.length && parts[parts.length - 1] === '') parts.pop()
  return parts
}

// One porcelain status code pair (index, work tree) reduced to a single kind.
// The work tree state wins when both sides changed, because that's the content
// the editor is about to show.
function kindOf(x, y) {
  if (x === '?' && y === '?') return 'untracked'
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) {
    return 'conflicted'
  }
  const code = y !== ' ' && y !== '' ? y : x
  switch (code) {
    case 'M':
      return 'modified'
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    case 'T':
      return 'typechange'
    default:
      return 'modified'
  }
}

// Which of `paths` match a gitignore rule.
//
// `git status` already leaves untracked ignored files out, so this is about the
// one case it can't help with: a file that was committed before the ignore rule
// existed (or force-added) stays tracked, and git goes on reporting its edits.
// --no-index is what makes check-ignore look at tracked paths at all.
function ignoredPaths(root, paths) {
  return new Promise((resolve) => {
    if (paths.length === 0) {
      resolve(new Set())
      return
    }
    // The paths go over stdin: check-ignore only accepts -z with --stdin, and
    // NUL separation is the only way to be safe about odd filenames.
    started()
    const child = spawn('git', ['-C', root, 'check-ignore', '--no-index', '-z', '--stdin'])
    const chunks = []
    child.stdout.on('data', (chunk) => chunks.push(chunk))

    // A failure to spawn emits both 'error' and 'close', and the bookkeeping
    // has to happen exactly once.
    let done = false
    const settle = (value) => {
      if (done) return
      done = true
      finished()
      resolve(value)
    }
    child.on('error', () => settle(new Set()))
    child.on('close', (code) => {
      // Exit 1 only means "none of them matched". Any other failure means the
      // check didn't happen, and filtering nothing is the safe answer.
      settle(code === 0 || code === 1 ? new Set(splitNul(Buffer.concat(chunks))) : new Set())
    })
    // git may exit before reading it all; an EPIPE here isn't interesting.
    child.stdin.on('error', () => {})
    child.stdin.end(paths.join('\0') + '\0')
  })
}

// Follows symlinks, so a link to a file counts as a file. Returns null when the
// path isn't there at all (including a dangling link), which is what
// `existsSync` used to answer here.
function statOrNull(abs) {
  try {
    return fs.statSync(abs)
  } catch {
    return null
  }
}

// The same first-block NUL test `looksBinary` does, but reading only that block
// rather than the whole file — this runs over every changed path on every
// refresh, and some of them are the multi-megabyte assets we're looking for.
function looksBinaryOnDisk(abs) {
  let fd = null
  try {
    fd = fs.openSync(abs, 'r')
    const buf = Buffer.alloc(8000)
    const read = fs.readSync(fd, buf, 0, 8000, 0)
    return looksBinary(buf.subarray(0, read))
  } catch {
    // Unreadable is not the same as binary. Leave it listed, and let opening it
    // report the real problem.
    return false
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

// Which of `paths` HEAD holds as binary content.
//
// Only asked about paths that are gone from the work tree, where there is
// nothing left on disk to sniff: --numstat reports a binary file as "-" added
// and "-" removed in place of line counts.
async function binaryInHead(root, paths) {
  if (paths.length === 0) return new Set()
  const out = await gitOrNull(root, ['diff', '--numstat', '-z', 'HEAD', '--', ...paths])
  if (!out) return new Set()
  const found = new Set()
  for (const entry of splitNul(out)) {
    // A rename would spread its two paths over further fields, but a path that
    // has gone from the work tree is never the target of one.
    if (entry.startsWith('-\t-\t')) found.add(entry.slice(4))
  }
  return found
}

// Why a changed path isn't worth a row in the tree, or null if it is.
//
// A submodule is recorded as a single gitlink entry, so it arrives here looking
// like an ordinary changed path whose work-tree counterpart is a directory —
// there is nothing behind it to open, and its own changes belong to its own
// repository. A binary file has nothing this editor can show either; it used to
// be listed and then refuse to open.
function unopenableBecause(stat, abs) {
  if (!stat) return null // Gone from the work tree; `binaryInHead` judges these.
  if (stat.isDirectory()) return 'submodule'
  if (!stat.isFile()) return null // A fifo or socket; vanishingly rare, let it through.
  return looksBinaryOnDisk(abs) ? 'binary' : null
}

/**
 * Every path git considers changed in the work tree: staged, unstaged and
 * untracked alike, minus anything gitignore covers and anything this editor
 * couldn't open anyway.
 *
 * Returns { files, skipped }, where `skipped` counts what the last filter
 * dropped — the sidebar says so rather than quietly disagreeing with
 * `git status`.
 */
export async function changedFiles(root) {
  const out = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  const fields = splitNul(out)
  const files = []

  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]
    if (entry.length < 4) continue
    const x = entry[0]
    const y = entry[1]
    const filePath = entry.slice(3)
    let orig = null
    // With -z, a rename/copy puts the source path in the *next* field rather
    // than using the " -> " notation, so it has to be consumed here.
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      orig = fields[++i] ?? null
    }
    const abs = path.join(root, filePath)
    const stat = statOrNull(abs)
    files.push({
      path: filePath,
      orig,
      index: x,
      work: y,
      kind: kindOf(x, y),
      staged: x !== ' ' && x !== '?',
      // A file staged as deleted but still on disk is the odd case; trust the
      // filesystem rather than the status letters.
      exists: stat !== null,
      // What the renderer fingerprints a file by, to tell that something
      // rewrote it since it was last looked at.
      mtimeMs: stat ? stat.mtimeMs : 0,
      size: stat ? stat.size : 0,
      unopenable: unopenableBecause(stat, abs)
    })
  }

  const ignored = await ignoredPaths(root, files.map((file) => file.path))
  const visible = ignored.size === 0 ? files : files.filter((file) => !ignored.has(file.path))

  const binaryGone = await binaryInHead(
    root,
    visible.filter((file) => !file.exists).map((file) => file.path)
  )

  // `unopenable` was only ever a working note; it doesn't need to cross IPC.
  const openable = visible
    .filter((file) => file.unopenable === null && !binaryGone.has(file.path))
    .map(({ unopenable, ...file }) => file)
  openable.sort((a, b) => a.path.localeCompare(b.path))
  return { files: openable, skipped: visible.length - openable.length }
}

// The half-finished operations that make committing part of a work tree a bad
// idea, each a file or directory in the git dir. A merge and a cherry-pick git
// refuses outright ("cannot do a partial commit during a merge"); a rebase it
// allows, which is worse — the commit lands quietly on the detached head the
// rebase is building and is lost when it finishes.
const IN_PROGRESS = [
  ['MERGE_HEAD', 'a merge'],
  ['CHERRY_PICK_HEAD', 'a cherry-pick'],
  ['REVERT_HEAD', 'a revert'],
  ['rebase-merge', 'a rebase'],
  ['rebase-apply', 'a rebase']
]

/** What the repository is in the middle of, phrased for a sentence, or null. */
export async function operationInProgress(root) {
  // --git-path rather than assuming .git/: a linked work tree's git dir is
  // somewhere else entirely, and this is exactly what it's for.
  const out = await gitOrNull(root, [
    'rev-parse',
    ...IN_PROGRESS.flatMap(([name]) => ['--git-path', name])
  ])
  if (!out) return null
  const paths = out.toString('utf8').trim().split('\n')
  for (let i = 0; i < IN_PROGRESS.length; i++) {
    const rel = paths[i]?.trim()
    if (rel && fs.existsSync(path.resolve(root, rel))) return IN_PROGRESS[i][1]
  }
  return null
}

/**
 * Commits the given entries and nothing else, with the content they have in the
 * work tree right now.
 *
 * Naming the paths on the commit is what makes this a review tool rather than a
 * `git commit -a`: git takes those paths from the work tree and leaves every
 * other entry in the index exactly as it found it, so whatever was staged for a
 * file nobody approved stays staged and uncommitted.
 *
 * `entries` are the sidebar's own rows — { path, orig, kind } — because two of
 * git's rules here need more than the path:
 *
 *  - a rename is two paths as far as a commit is concerned, and naming only the
 *    new one commits the copy while leaving the old one in the tree;
 *  - a path git has never seen can't be named in a partial commit at all
 *    ("pathspec ... did not match any file(s) known to git"), so an untracked
 *    file has to be added first.
 */
export async function commitFiles(root, entries, message) {
  const text = message.trim()
  if (!text) throw new Error('A commit message is required.')
  if (entries.length === 0) throw new Error('No approved files to commit.')

  const busy = await operationInProgress(root)
  if (busy) {
    throw new Error(
      `This work tree is in the middle of ${busy}, and git won't commit part of one. ` +
        'Finish it in a terminal first.'
    )
  }

  const paths = []
  for (const entry of entries) {
    for (const candidate of [entry.path, entry.orig]) {
      if (!candidate || paths.includes(candidate)) continue
      // Nothing from the renderer gets handed to git without this check.
      resolveInRepo(root, candidate)
      paths.push(candidate)
    }
  }

  const added = entries.filter((entry) => entry.kind === 'untracked').map((entry) => entry.path)
  if (added.length > 0) await git(root, ['add', '--', ...added])

  try {
    await git(root, ['commit', '-m', text, '--', ...paths])
  } catch (err) {
    // A rejected commit — a pre-commit hook, an unset identity — would otherwise
    // leave those files staged, which is not a state the app can explain. They
    // were untracked a moment ago and so have nothing in HEAD, which is what
    // makes dropping the index entry the exact inverse of the add above.
    if (added.length > 0) await gitOrNull(root, ['rm', '--cached', '--force', '--', ...added])
    throw err
  }

  const head = await gitOrNull(root, ['rev-parse', '--short', 'HEAD'])
  return { hash: head?.toString('utf8').trim() || null, count: entries.length }
}

// The committed content a work-tree file should be compared against: HEAD's
// version, or '' when there isn't one (untracked, newly added, or an unborn
// HEAD in a repository with no commits).
export async function baseText(root, relPath, origPath = null) {
  const source = origPath || relPath
  const out = await gitOrNull(root, ['show', `HEAD:${source}`])
  if (out === null) return ''
  return normalizeEol(decode(out))
}

// Rejects paths that would escape the work tree (a rename entry, a stale tab,
// anything the renderer might send that didn't come from `changedFiles`).
export function resolveInRepo(root, relPath) {
  const abs = path.resolve(root, relPath)
  const rel = path.relative(root, abs)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path is outside the repository: ${relPath}`)
  }
  return abs
}

// A NUL byte in the first block is the same heuristic git itself uses to call
// a file binary; those can't be edited as text.
export function looksBinary(buf) {
  return buf.subarray(0, 8000).includes(0)
}

export function decode(buf) {
  // Strip a UTF-8 BOM so it doesn't show up as a stray character in column one.
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8')
  }
  return buf.toString('utf8')
}

// CodeMirror splits lines on \n alone, so a CRLF file would carry a visible \r
// at the end of every line. Editing happens on LF text; `file:save` puts the
// file's own line endings back.
export function normalizeEol(text) {
  return text.includes('\r\n') ? text.replace(/\r\n/g, '\n') : text
}

export function detectEol(text) {
  return text.includes('\r\n') ? 'crlf' : 'lf'
}
