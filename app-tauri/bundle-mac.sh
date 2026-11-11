#!/bin/sh
# macOS bundle: ShoreShot.app signed the same way as the Electron build (../scripts/after-pack.js), then a DMG.
# macOS ties Screen Recording / Accessibility grants to the bundle id + signing certificate, so CI must sign
# with the same fixed self-signed certificate: MAC_SIGN_IDENTITY, set by the "Import signing certificate"
# step in .github/workflows/build.yml. Without it the app is signed ad-hoc (works, but grants reset).
# TARGET=x86_64-apple-darwin builds the Intel app on an Apple Silicon machine (needs that rustup target).
# Output, named like the Electron releases so install.sh, the website and old apps' update check still match:
#   ShoreShot-<version>-mac-<arm64|x64>.dmg and .zip
set -e
cd "$(dirname "$0")"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-${TMPDIR:-/tmp}/shoreshot-tauri-target}" # off the exFAT drive
sh build-web.sh
if [ -n "$TARGET" ]; then
  npx tauri build --bundles app --target "$TARGET"
  OUT="$CARGO_TARGET_DIR/$TARGET/release/bundle"
  ARCH=$(echo "$TARGET" | sed -e 's/^x86_64-.*/x64/' -e 's/^aarch64-.*/arm64/')
else
  npx tauri build --bundles app
  OUT="$CARGO_TARGET_DIR/release/bundle"
  ARCH=$(uname -m | sed 's/x86_64/x64/')
fi
APP="$OUT/macos/ShoreShot.app"
IDENTITY="${MAC_SIGN_IDENTITY:--}"
echo "signing $APP with $([ "$IDENTITY" = - ] && echo 'ad-hoc signature' || echo 'ShoreShot certificate')"
codesign --force --deep --sign "$IDENTITY" "$APP"
codesign --verify --strict "$APP"
VERSION=$(node -p "require('../package.json').version")
STAGE="$OUT/dmg-stage" && rm -rf "$STAGE" && mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/" && ln -s /Applications "$STAGE/Applications"
hdiutil create -volname ShoreShot -srcfolder "$STAGE" -ov -format UDZO "$OUT/ShoreShot-$VERSION-mac-$ARCH.dmg"
rm -rf "$STAGE"
ditto -c -k --keepParent "$APP" "$OUT/ShoreShot-$VERSION-mac-$ARCH.zip" # what install.sh downloads
