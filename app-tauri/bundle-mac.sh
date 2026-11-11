#!/bin/sh
# macOS bundle: ShoreShot.app signed the same way as the Electron build (../scripts/after-pack.js), then a DMG.
# macOS ties Screen Recording / Accessibility grants to the bundle id + signing certificate, so CI must sign
# with the same fixed self-signed certificate: MAC_SIGN_IDENTITY, set by the "Import signing certificate"
# step in .github/workflows/build.yml. Without it the app is signed ad-hoc (works, but grants reset).
set -e
cd "$(dirname "$0")"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-${TMPDIR:-/tmp}/shoreshot-tauri-target}" # off the exFAT drive
sh build-web.sh
npx tauri build --bundles app
OUT="$CARGO_TARGET_DIR/release/bundle"
APP="$OUT/macos/ShoreShot.app"
IDENTITY="${MAC_SIGN_IDENTITY:--}"
echo "signing $APP with $([ "$IDENTITY" = - ] && echo 'ad-hoc signature' || echo 'ShoreShot certificate')"
codesign --force --deep --sign "$IDENTITY" "$APP"
codesign --verify --strict "$APP"
VERSION=$(node -p "require('../package.json').version")
ARCH=$(uname -m | sed 's/x86_64/x64/')
STAGE="$OUT/dmg-stage" && rm -rf "$STAGE" && mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/" && ln -s /Applications "$STAGE/Applications"
hdiutil create -volname ShoreShot -srcfolder "$STAGE" -ov -format UDZO "$OUT/ShoreShot-$VERSION-mac-$ARCH.dmg"
rm -rf "$STAGE"
