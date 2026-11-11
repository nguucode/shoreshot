#!/usr/bin/env bash
# ShoreShot installer for macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/nguucode/shoreshot/main/scripts/install.sh | bash
#
# Options (pass after `bash -s --`):
#   --uninstall     remove ShoreShot
#   --no-launch     don't open the app after installing
set -euo pipefail

REPO="nguucode/shoreshot"
APP_NAME="ShoreShot"
BUNDLE_ID="biz.ontheshore.shoreshot"

UNINSTALL=0
LAUNCH=1
for arg in "$@"; do
  case "$arg" in
    --uninstall) UNINSTALL=1 ;;
    --no-launch) LAUNCH=0 ;;
    -h|--help) sed -n '2,8p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "This script is for macOS. On Windows use scripts/install.ps1."

# Install into /Applications when writable, otherwise ~/Applications (no sudo needed).
if [ -w /Applications ]; then DEST_DIR="/Applications"; else DEST_DIR="$HOME/Applications"; fi
DEST="$DEST_DIR/$APP_NAME.app"

quit_app() {
  osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
  pkill -x "$APP_NAME" >/dev/null 2>&1 || true
  sleep 1
}

if [ "$UNINSTALL" = 1 ]; then
  say "Removing ${APP_NAME}..."
  quit_app
  for d in "/Applications/$APP_NAME.app" "$HOME/Applications/$APP_NAME.app"; do
    [ -d "$d" ] && rm -rf "$d" && ok "Removed $d"
  done
  rm -rf "$HOME/Library/Application Support/$APP_NAME"
  ok "Uninstalled. (Screen Recording / Accessibility permissions can be removed in System Settings.)"
  exit 0
fi

ARCH="$(uname -m)"   # arm64 | x86_64
[ "$ARCH" = "x86_64" ] && ARCH="x64"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

APP_SRC=""

download_release() {
  say "Looking up the latest build on GitHub Releases..."
  local api="https://api.github.com/repos/$REPO/releases/latest"
  local json url
  json="$(curl -fsSL -H 'Accept: application/vnd.github+json' "$api" 2>/dev/null)" || return 1
  url="$(printf '%s' "$json" | grep -o '"browser_download_url": *"[^"]*-mac-'"$ARCH"'\.zip"' | head -n1 | sed 's/.*"\(https[^"]*\)"/\1/')"
  [ -n "$url" ] || return 1
  say "Downloading $(basename "$url")..."
  curl -fL --progress-bar "$url" -o "$TMP/app.zip" || return 1
  ditto -x -k "$TMP/app.zip" "$TMP/unzipped" || return 1
  APP_SRC="$(find "$TMP/unzipped" -maxdepth 2 -name "$APP_NAME.app" -type d | head -n1)"
  [ -n "$APP_SRC" ]
}

download_release || die "No build for mac-$ARCH yet. See https://github.com/$REPO/releases"

say "Installing to ${DEST}..."
mkdir -p "$DEST_DIR"
quit_app
rm -rf "$DEST"
ditto "$APP_SRC" "$DEST"

# The app isn't signed with an Apple Developer ID: drop the quarantine flag so macOS opens it.
# Don't re-sign here: releases carry a fixed signature, which is what keeps Screen Recording /
# Accessibility permissions across updates.
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

ok "Installed $APP_NAME to $DEST"
echo
echo "  • Default hotkeys: ⌘⇧X captures an area, ⌘⇧2 copies the text in an area (change them from the menu bar icon > Settings...)"
echo "  • On the first capture, allow Screen Recording, then reopen the app."
echo "  • For ⌘V to paste into other apps, also allow Accessibility."
echo "  • Uninstall: curl -fsSL https://raw.githubusercontent.com/$REPO/main/scripts/install.sh | bash -s -- --uninstall"
echo

if [ "$LAUNCH" = 1 ]; then
  open "$DEST"
fi
