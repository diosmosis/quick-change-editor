#!/usr/bin/env bash
# Launches the production build. Used by the .desktop entry so the app can be
# started from the XFCE menu instead of `npm run dev`.
#
# The menu runs this with the desktop session's environment, which does NOT
# source ~/.bashrc. Anything that relies on an interactive shell (notably nvm's
# node on PATH) is therefore unavailable here and has to be resolved by hand.
set -euo pipefail

# A repository path argument is relative to where the user ran this, so it has
# to be resolved before the cd below.
args=()
for arg in "$@"; do args+=("$(readlink -f "$arg" || echo "$arg")"); done

cd "$(dirname "$(readlink -f "$0")")"

LOG="${XDG_CACHE_HOME:-$HOME/.cache}/quick-change-editor-launch.log"
mkdir -p "$(dirname "$LOG")"
exec 2> >(tee -a "$LOG" >&2)

die() {
  echo "$1" >&2
  # Terminal=false means stderr is invisible from the menu, so say it onscreen.
  if command -v zenity >/dev/null 2>&1; then
    zenity --error --title="Quick Change Editor" --text="$1"$'\n\n'"Log: $LOG" 2>/dev/null || true
  elif command -v xmessage >/dev/null 2>&1; then
    xmessage -center "$1" || true
  fi
  exit 1
}

# nvm installs node outside the default PATH; find the version its `default`
# alias points at (falling back to the newest installed).
ensure_node_on_path() {
  command -v node >/dev/null 2>&1 && return 0

  local nvm_dir="${NVM_DIR:-$HOME/.nvm}" want="" candidate=""
  [ -r "$nvm_dir/alias/default" ] && want="$(<"$nvm_dir/alias/default")"
  [ -n "$want" ] && candidate="$(ls -d "$nvm_dir/versions/node/v${want#v}"* 2>/dev/null | sort -V | tail -1)"
  [ -n "$candidate" ] || candidate="$(ls -d "$nvm_dir"/versions/node/v* 2>/dev/null | sort -V | tail -1)"

  [ -n "$candidate" ] && [ -x "$candidate/bin/node" ] || return 1
  PATH="$candidate/bin:$PATH"
  export PATH
}

# The out/ directory is gitignored, so build on first run (or after a clean).
if [ ! -f out/main/index.js ]; then
  ensure_node_on_path || die "No build in out/ and node was not found — run 'npm run build' in a terminal first."
  npm run build || die "npm run build failed."
fi

# Run electron's native binary rather than node_modules/.bin/electron, which is
# a '#!/usr/bin/env node' script and so needs node on PATH.
ELECTRON=node_modules/electron/dist/electron
[ -x "$ELECTRON" ] || die "Electron binary missing at $ELECTRON — run 'npm install' in a terminal."

# chrome-sandbox isn't setuid root in node_modules, same reason dev sets NO_SANDBOX=1.
# The ${args[@]+...} form keeps `set -u` happy when no arguments were given.
exec "$ELECTRON" --no-sandbox . ${args[@]+"${args[@]}"}
