#!/bin/sh
# Builds dist/ from the Electron app's renderer, unchanged: compiled editor.ts + editor.html/css + the stub bridge.
set -e
cd "$(dirname "$0")"
rm -rf dist && mkdir -p dist
npx tsc ../../src/renderer/editor.ts ../../src/global.d.ts --target ES2022 --lib ES2022,DOM,DOM.Iterable \
  --strict --skipLibCheck --outDir dist/tsc
cp dist/tsc/editor.js dist/editor.js && rm -rf dist/tsc
cp ../../static/editor.css web/api.js dist/
# Load the bridge before the editor; the editor's CSP has no connect-src for Tauri's IPC, so widen it.
sed -e 's#<script src="../dist/renderer/editor.js"></script>#<script src="api.js"></script><script src="editor.js"></script>#' \
    -e "s#default-src 'self';#default-src 'self'; connect-src ipc: http://ipc.localhost;#" \
    ../../static/editor.html > dist/editor.html
grep -q 'api.js' dist/editor.html
