#!/usr/bin/env bash
# ShoreShot installer for macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/nguucode/shoreshort/main/scripts/install.sh | bash
#
# Tuỳ chọn (truyền sau `bash -s --`):
#   --from-source   bỏ qua bản build sẵn, build từ source (cần git + Node.js 18+)
#   --uninstall     gỡ ShoreShot
#   --no-launch     cài xong không mở app
set -euo pipefail

REPO="nguucode/shoreshort"
APP_NAME="ShoreShot"
BUNDLE_ID="biz.ontheshore.shoreshot"

FROM_SOURCE=0
UNINSTALL=0
LAUNCH=1
for arg in "$@"; do
  case "$arg" in
    --from-source) FROM_SOURCE=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --no-launch) LAUNCH=0 ;;
    -h|--help) sed -n '2,10p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "Tuỳ chọn không hợp lệ: $arg" >&2; exit 1 ;;
  esac
done

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "Script này dành cho macOS. Windows dùng scripts/install.ps1."

# Cài vào /Applications nếu ghi được, không thì ~/Applications (không cần sudo).
if [ -w /Applications ]; then DEST_DIR="/Applications"; else DEST_DIR="$HOME/Applications"; fi
DEST="$DEST_DIR/$APP_NAME.app"

quit_app() {
  osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
  pkill -x "$APP_NAME" >/dev/null 2>&1 || true
  sleep 1
}

if [ "$UNINSTALL" = 1 ]; then
  say "Gỡ $APP_NAME…"
  quit_app
  for d in "/Applications/$APP_NAME.app" "$HOME/Applications/$APP_NAME.app"; do
    [ -d "$d" ] && rm -rf "$d" && ok "Đã xoá $d"
  done
  rm -rf "$HOME/Library/Application Support/$APP_NAME"
  ok "Đã gỡ xong. (Quyền Screen Recording / Accessibility có thể xoá tay trong System Settings.)"
  exit 0
fi

ARCH="$(uname -m)"   # arm64 | x86_64
[ "$ARCH" = "x86_64" ] && ARCH="x64"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

APP_SRC=""

download_release() {
  say "Tìm bản build sẵn mới nhất trên GitHub Releases…"
  local api="https://api.github.com/repos/$REPO/releases/latest"
  local json url
  json="$(curl -fsSL -H 'Accept: application/vnd.github+json' "$api" 2>/dev/null)" || return 1
  url="$(printf '%s' "$json" | grep -o '"browser_download_url": *"[^"]*-mac-'"$ARCH"'\.zip"' | head -n1 | sed 's/.*"\(https[^"]*\)"/\1/')"
  [ -n "$url" ] || return 1
  say "Tải $(basename "$url")…"
  curl -fL --progress-bar "$url" -o "$TMP/app.zip" || return 1
  ditto -x -k "$TMP/app.zip" "$TMP/unzipped" || return 1
  APP_SRC="$(find "$TMP/unzipped" -maxdepth 2 -name "$APP_NAME.app" -type d | head -n1)"
  [ -n "$APP_SRC" ]
}

build_from_source() {
  say "Build từ source…"
  command -v git >/dev/null || die "Cần git. Cài: xcode-select --install"
  command -v node >/dev/null || die "Cần Node.js 18+. Cài: https://nodejs.org hoặc 'brew install node'"
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 18 ] || die "Node.js $major quá cũ, cần 18+."

  git clone --depth 1 "https://github.com/$REPO.git" "$TMP/src" >/dev/null 2>&1 || die "Không clone được repo."
  cd "$TMP/src"
  say "npm install (lần đầu mất 1 đến 3 phút)…"
  npm install --no-audit --no-fund --loglevel=error
  npm run build --silent
  say "Đóng gói app…"
  CSC_IDENTITY_AUTO_DISCOVERY=false npx --no-install electron-builder --mac --dir --"$ARCH" >/dev/null
  APP_SRC="$(find "$TMP/src/release" -maxdepth 2 -name "$APP_NAME.app" -type d | head -n1)"
  [ -n "$APP_SRC" ] || die "Build xong nhưng không thấy $APP_NAME.app."
  cd - >/dev/null
}

if [ "$FROM_SOURCE" = 1 ]; then
  build_from_source
elif ! download_release; then
  say "Chưa có bản build sẵn cho mac-$ARCH, chuyển sang build từ source."
  build_from_source
fi

say "Cài vào $DEST…"
mkdir -p "$DEST_DIR"
quit_app
rm -rf "$DEST"
ditto "$APP_SRC" "$DEST"

# App chưa ký bằng Apple Developer ID: bỏ cờ quarantine và ký ad-hoc để macOS (nhất là Apple Silicon) cho chạy.
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
codesign --force --deep --sign - "$DEST" >/dev/null 2>&1 || true

ok "Đã cài $APP_NAME vào $DEST"
echo
echo "  • Phím tắt mặc định: ⌘⇧X (đổi trong icon menu bar > Đổi phím tắt…)"
echo "  • Lần chụp đầu, cấp quyền Screen Recording rồi mở lại app."
echo "  • Muốn ⌘V tự dán vào app khác: cấp thêm quyền Accessibility."
echo "  • Gỡ: curl -fsSL https://raw.githubusercontent.com/$REPO/main/scripts/install.sh | bash -s -- --uninstall"
echo

if [ "$LAUNCH" = 1 ]; then
  open "$DEST"
fi
