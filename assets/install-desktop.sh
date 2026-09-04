#!/usr/bin/env bash
# Installs this app's XDG (XFCE) menu entry for the current user, filling the
# project's paths into the template in assets/.
#
# The paths are resolved rather than hardcoded because this tree is mounted at
# different absolute paths in different places — inside claudebox it sits under
# /home/dizzy/Projects, on the host it sits wherever the workspace is.
#
# Run this on the machine whose menu you want the entry in: a container has its
# own $HOME, so an entry installed inside one is invisible to the desktop
# outside it.
#
# This script is identical in every quick-* app; it finds the app's name from
# whichever .desktop template is in assets/.
set -euo pipefail

app_dir="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"

shopt -s nullglob
templates=("$app_dir"/assets/*.desktop)
shopt -u nullglob
if [ "${#templates[@]}" -ne 1 ]; then
  echo "Expected one .desktop template in $app_dir/assets, found ${#templates[@]}" >&2
  exit 1
fi

template="${templates[0]}"
target_dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
target="$target_dir/$(basename "$template")"

[ -x "$app_dir/launch.sh" ] || {
  echo "launch.sh is missing or not executable in $app_dir" >&2
  exit 1
}

mkdir -p "$target_dir"
sed "s|@APP_DIR@|$app_dir|g" "$template" >"$target"
chmod 644 "$target"

# Not installed everywhere, and the menu picks the file up either way.
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$target_dir" || true
fi

echo "Installed $target"
echo "  Exec=$app_dir/launch.sh"
if [ ! -f "$app_dir/out/main/index.js" ]; then
  echo "  Note: no build in out/ yet — the first launch runs 'npm run build',"
  echo "        which needs node on PATH. 'npm run build' now avoids the wait."
fi
