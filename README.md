# Quick Change Editor

An Electron editor for the files a git work tree has changed — the ones `git
diff` would show. It exists to make the last pass over generated code before a
commit quick: open only what changed, see exactly which lines changed, fix them,
tick them off, and commit the ones you ticked without leaving the window.

- **Left:** every changed path in the work tree — staged, unstaged and untracked
  alike — as a tree, with a status badge: `M` modified, `A` added (whether or
  not it has been staged), `D` deleted, `R` renamed, `T` type changed, `!`
  conflicted. Hover for the full status. Binary files are listed like anything
  else, marked `bin`: they open to a tab that says so instead of an editor, so
  they can still be ticked off and committed. Submodules are the one thing left
  out — their changes belong to their own repository — and the footer says how
  many, so the count still adds up against `git status`.
- **Right:** the files you opened, one per tab, with syntax highlighting.
- **Approving a file:** the faint check to the right of each name is there to
  tick off as you work through the list. A tick is against the file as it stood
  when you gave it, so anything that rewrites the file from outside takes the
  tick back — a generator, a checkout — and the file wants looking at again.
  Your own saves carry the tick over: the person editing here is the one doing
  the reviewing. The footer counts them.
- **Committing:** the button under the tree commits the ticked-off files, and
  only those. It asks for a message, lists what is about to go in, and leaves
  everything else in the work tree exactly where it was — including anything
  already staged that you didn't tick. See [What gets
  committed](#what-gets-committed).
- **The change bar:** a stripe down the left of the editor — green where this
  work tree added a line, amber where it changed one, and a red wedge where it
  removed lines (hover it to see what they were). Whitespace is ignored, the way
  `git diff -w` ignores it: a line that was only reindented, or that gained a
  trailing space or lost the spaces around an operator, is not a change and is
  not marked. A reformatting pass over a file therefore leaves only the lines
  whose content actually moved.

- **Opening a change:** clicking the change bar shows what that one change
  replaced. The lines it took out appear above it on red — they are not part of
  the file, so they cannot be edited and are never saved — and the lines that
  replaced them go green and stay editable. The rest of the file is left as it
  was, and as many changes can be open at once as you like. An open change's
  marker is dimmed; clicking it again closes it.

- **The change navigator:** `F7` and `Shift`+`F7` jump the cursor to the next
  and previous changed block, wrapping around the ends of the file, so a long
  file can be reviewed without scrolling past the parts nothing touched. The
  block that was jumped to flashes, and the status bar shows which of the
  file's changes the cursor is in — `3 / 8` — with arrows that do the same
  thing.

The change bar is computed against `HEAD` in the renderer, not read out of `git
diff`, so it follows what you type: undo a generated change by hand and its
marker disappears without saving first. The navigator steps through the same
markers, so it too keeps up with your edits — and since whitespace is not a
change, neither the bar, the navigator, nor the `+ ~ −` counts in the status bar
will ever send you to a line that was only respaced.

## Shortcuts

| | |
|---|---|
| `Ctrl+S` | save the current file |
| `Ctrl+Shift+S` | save every file with unsaved edits |
| `Ctrl+W` | close the current tab |
| `Ctrl+Shift+W` | close every tab |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | next / previous tab |
| `Ctrl+O` | open a different repository |
| `Ctrl+Enter` | commit the approved files (and again, in the dialog, to commit) |
| `F7` / `Shift+F7` | next / previous change in the current file |
| `Ctrl+↓` / `Ctrl+↑` | the same, for the arrow-key inclined |
| `Ctrl+F` | find in the current file |
| `F5` | refresh the changed-file list |
| `F12` | dev tools |

Middle-clicking a tab closes it. Closing a tab with unsaved edits asks first, as
does closing the window. Closing every tab asks once for all of them; a file
that then refuses to save keeps its tab and its edits.

## Running it

```
npm install
npm run dev                     # dev server + electron
npm run build && npm start      # production build
./launch.sh /path/to/repo       # production build, opening a specific repository
```

## Adding it to the desktop menu

```
npm run desktop:install     # or, without npm: ./assets/install-desktop.sh
```

That writes `~/.local/share/applications/quick-change-editor.desktop` from the
template in `assets/`, filling in this project's absolute path as it goes — the
path is resolved at install time rather than hardcoded, because this tree is
mounted at different paths in different places (inside claudebox it is under
`/home/dizzy/Projects`, on the host it is wherever the workspace lives).

**Run it on the machine whose menu you want it in.** A container has its own
`$HOME`, so an entry installed inside one is invisible to the desktop outside
it.

The entry runs `launch.sh`, which builds into `out/` on first use if it has to.
Running `npm run build` beforehand avoids that wait — and the build needs node
on `PATH`, which a menu-launched process may not have.

To open a repository straight from the file manager, add
`MimeType=inode/directory;` to the template and `%f` to its `Exec` line before
installing; `launch.sh` already accepts a repository path.

Without a path argument the app reopens the repository it had last time; the
name in the top left opens the picker.

## What gets committed

The commit names its paths — `git commit -m … -- <the approved files>` — which
is what keeps it to the files you ticked. Git takes those paths from the work
tree and leaves every other index entry alone, so a file someone staged and
nobody approved stays staged and uncommitted, and comes back next time.

- **What is committed is what is on disk**, not what was staged. A file staged
  at one version and then edited again commits as it now reads; the editor has
  been showing you the work-tree version all along, and that is the version the
  tick was given to.
- **An approved tab with unsaved edits is saved first**, and the dialog says so
  before you commit. Committing the older text sitting on disk would not be the
  thing that was approved.
- **A rename commits both of its paths.** Naming only the new one would commit
  the copy and leave the original in the tree.
- **An untracked file is added first**, because git will not accept a path it
  has never seen in a commit like this. If the commit is then refused — a
  `pre-commit` hook, an unset `user.email` — that add is undone, so a failure
  leaves the index exactly as it found it and the dialog stays up to try again.
  Whatever git or the hook said is shown verbatim.
- **Not during a merge, cherry-pick, revert or rebase.** Git refuses to commit
  part of a work tree mid-merge; mid-rebase it does *not* refuse, and quietly
  puts the commit on the detached head the rebase is building, where finishing
  the rebase loses it. Both are turned down here with a message pointing at the
  terminal.

Hooks run normally, and their output is what you get back on a failure.

## How it stays in step with the work tree

Generated code changes underneath the editor, so open files are re-read when the
window regains focus and when anything in `.git` moves (a commit, a stage, a
checkout from another terminal):

- A tab with no unsaved edits is reloaded silently, and its change bar
  recomputed against the new `HEAD`. Its open changes close, since what they
  were showing was a comparison against text the file no longer has.
- A tab with unsaved edits is never overwritten. It gets an amber dot and a
  banner saying the file moved on disk; saving overwrites what's there. Its
  open changes stay open — nothing on screen moved — unless `HEAD` itself
  changed, which does close them.
- An approval tick is dropped when the file's size or timestamp moves under it,
  and when the file stops being a changed file at all (it was committed, or
  edited back to what `HEAD` has). Saving from here moves the tick onto the
  version it wrote rather than dropping it. Ticks last as long as the window
  does; they are not written anywhere.

## Notes

- Gitignored paths never appear in the list. Git itself hides the untracked
  ones; a file that is *tracked* but matches an ignore rule (committed before
  the rule existed, or force-added) is filtered out here, even though `git
  status` still reports its edits.
- Files are edited as LF text; CRLF files are written back with their own line
  endings.
- Indentation follows the file rather than a setting: `Tab`, `Shift`+`Tab`,
  `Enter` and auto-indent insert tabs in a tab-indented file and the file's own
  width where it uses spaces. It is measured from the text every time a file is
  opened or re-read from disk, and the status bar says what it found. A file
  with nothing to go on — a new, empty one — gets two spaces.
- A binary file opens to a placeholder — its path and size — rather than an
  editor. Nothing about it can be changed here, but it takes part in a review
  pass like any other row.
- A text file over 8 MB is refused rather than opened. The limit doesn't apply
  to binary files, which are recognised from their first block and never read
  in full.
- A file deleted from the work tree still opens, read-only, showing what `HEAD`
  has — or, if `HEAD` holds it as binary, its committed size.
- One repository at a time, one window.

## Layout

```
src/main/       electron main: window, git commands, IPC handlers, settings
src/preload/    the contextBridge surface the renderer sees (window.api)
src/renderer/   react UI
  src/lib/linediff.js    Myers line diff, HEAD vs the editor's current text
  src/lib/diffGutter.js  the CodeMirror extension that draws the change bar
                         and the removed text of an opened change
```
