#!/usr/bin/env bash
# Installs the XFCE (well, XDG) menu entry for the current user, filling the
# app's paths in from wherever this copy of the project actually sits.
#
# The paths are resolved rather than hardcoded because this tree is mounted at
# different absolute paths in different places — inside claudebox it is
# /home/dizzy/Projects/..., on the host it is wherever the workspace lives.
#
# Run this on the machine whose menu you want the entry in. Inside a container
# $HOME is the container's own, so an entry installed there is invisible to the
# desktop outside it.
set -euo pipefail

app_dir="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
template="$app_dir/assets/quick-change-editor.desktop"
target_dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
target="$target_dir/quick-change-editor.desktop"

[ -r "$template" ] || {
  echo "Template not found: $template" >&2
  exit 1
}
[ -x "$app_dir/launch.sh" ] || {
  echo "launch.sh is missing or not executable in $app_dir" >&2
  exit 1
}

mkdir -p "$target_dir"
sed "s|@APP_DIR@|$app_dir|g" "$template" >"$target"
chmod 644 "$target"

# Not present on every system, and the menu picks the file up either way.
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$target_dir" || true
fi

echo "Installed $target"
echo "  Exec=$app_dir/launch.sh"
if [ ! -f "$app_dir/out/main/index.js" ]; then
  echo "  Note: no build in out/ yet — the first launch will run 'npm run build',"
  echo "        which needs node on PATH. 'npm run build' now avoids the wait."
fi
