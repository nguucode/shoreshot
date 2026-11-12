#!/bin/sh
# Builds dist/ from the Electron app's renderer, unchanged: compiled src/renderer/*.ts + static/*.html/css,
# with web/api.js (the window.api bridge, in place of src/preload.ts) loaded first. Also makes the icons.
set -e
cd "$(dirname "$0")"
find src-tauri -name '._*' -delete # exFAT AppleDouble files: tauri-build parses everything it finds
rm -rf dist && mkdir -p dist
npx tsc ../src/renderer/ocrtext.ts ../src/renderer/editor.ts ../src/renderer/settings.ts ../src/global.d.ts --target ES2022 \
  --lib ES2022,DOM,DOM.Iterable --strict --skipLibCheck --rootDir ../src --outDir dist/tsc
cp dist/tsc/renderer/*.js ../static/*.css web/api.js dist/ && rm -rf dist/tsc
# The pages' CSP has no connect-src for Tauri's IPC transport, so widen it.
for page in editor settings; do
  sed -e "s#<script src=\"../dist/renderer/$page.js\"></script>#<script src=\"api.js\"></script><script src=\"$page.js\"></script>#" \
      -e "s#../dist/renderer/ocrtext.js#ocrtext.js#" \
      -e "s#default-src 'self';#default-src 'self'; connect-src ipc: http://ipc.localhost;#" \
      "../static/$page.html" > "dist/$page.html"
  grep -q 'api.js' "dist/$page.html"
done
# Windows reads text with tesseract.js (see web/api.js): the library, its worker, the wasm cores and the
# Vietnamese data (it reads English too). macOS uses Vision, so its bundle leaves them out (TESSERACT=1 forces them in).
if [ "$(uname)" != Darwin ] || [ -n "$TESSERACT" ]; then
  mkdir dist/tesseract
  cp node_modules/tesseract.js/dist/tesseract.min.js node_modules/tesseract.js/dist/worker.min.js \
    node_modules/tesseract.js-core/tesseract-core*-lstm.wasm.js \
    node_modules/@tesseract.js-data/vie/4.0.0_best_int/vie.traineddata.gz dist/tesseract/
fi
[ -f src-tauri/icons/icon.icns ] || npx tauri icon ../build/icon.png -o src-tauri/icons > /dev/null
