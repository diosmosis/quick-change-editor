# Quick Change Editor

An Electron editor for the files a git work tree has changed — the ones `git
diff` would show. It exists to make the last pass over generated code before a
commit quick: open only what changed, see exactly which lines changed, fix them,
save.

- **Left:** every changed path in the work tree — staged, unstaged and untracked
  alike — as a tree, with a status badge: `M` modified, `A` added (whether or
  not it has been staged), `D` deleted, `R` renamed, `T` type changed, `!`
  conflicted. Hover for the full status.
- **Right:** the files you opened, one per tab, with syntax highlighting.
- **The change bar:** a stripe down the left of the editor — green where this
  work tree added a line, amber where it changed one, and a red wedge where it
  removed lines (hover it to see what they were).

The change bar is computed against `HEAD` in the renderer, not read out of `git
diff`, so it follows what you type: undo a generated change by hand and its
marker disappears without saving first.

## Shortcuts

| | |
|---|---|
| `Ctrl+S` | save the current file |
| `Ctrl+Shift+S` | save every file with unsaved edits |
| `Ctrl+W` | close the current tab |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | next / previous tab |
| `Ctrl+O` | open a different repository |
| `Ctrl+F` | find in the current file |
| `F5` | refresh the changed-file list |
| `F12` | dev tools |

Middle-clicking a tab closes it. Closing a tab with unsaved edits asks first, as
does closing the window.

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

## How it stays in step with the work tree

Generated code changes underneath the editor, so open files are re-read when the
window regains focus and when anything in `.git` moves (a commit, a stage, a
checkout from another terminal):

- A tab with no unsaved edits is reloaded silently, and its change bar
  recomputed against the new `HEAD`.
- A tab with unsaved edits is never overwritten. It gets an amber dot and a
  banner saying the file moved on disk; saving overwrites what's there.

## Notes

- Gitignored paths never appear in the list. Git itself hides the untracked
  ones; a file that is *tracked* but matches an ignore rule (committed before
  the rule existed, or force-added) is filtered out here, even though `git
  status` still reports its edits.
- Files are edited as LF text; CRLF files are written back with their own line
  endings.
- Binary files and anything over 8 MB are refused rather than opened.
- A file deleted from the work tree still opens, read-only, showing what `HEAD`
  has.
- One repository at a time, one window.

## Layout

```
src/main/       electron main: window, git commands, IPC handlers, settings
src/preload/    the contextBridge surface the renderer sees (window.api)
src/renderer/   react UI
  src/lib/linediff.js    Myers line diff, HEAD vs the editor's current text
  src/lib/diffGutter.js  the CodeMirror extension that draws the change bar
```
