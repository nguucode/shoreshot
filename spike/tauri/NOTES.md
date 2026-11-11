# Tauri spike: findings

**Recommendation: go**, for a staged port on macOS first. On every measure the capture path is as fast or
faster than Electron, the installer is ~50× smaller and idle RAM ~7× lower. The renderer moved over
unchanged. The work is the ~760-line `main.ts` rewrite and redoing the Windows side, not the editor.
Gate the port on the open items at the bottom, mainly Windows (WebView2) and keeping the signing identity.

Throwaway code. Ported only: hotkey (Cmd+Shift+X) → `xcap` capture of the display under the cursor →
`tauri-nspanel` overlay (screen-saver level, all Spaces, full-screen auxiliary, non-activating,
`worksWhenModal`) → the unchanged `static/editor.html` + `src/renderer/editor.ts` behind a stub
`window.api` (`web/api.js`) → PNG to `NSPasteboard`. No tray, settings, save dialog, auto-paste, window
mode, update check, login item. The Electron app was not touched.

Run: `npm install && npm run bundle` (needs Rust). Env switches (`SPIKE_AUTO`, `SPIKE_BENCH`,
`SPIKE_MODAL_TEST`, `SPIKE_NO_WORKS_WHEN_MODAL`) are documented at the top of `src-tauri/src/main.rs`.
Timings go to `~/Library/Logs/ShoreShot-spike/capture.log`, one line per capture, same format as Electron's.

## Results (Apple Silicon, macOS 26, 5120×2880 display, arm64 release build)

| | Electron 1.0.2 | Tauri spike |
|---|---|---|
| Installer (DMG, one arch) | 78–100 MB | **1.8 MB** (zip 1.4 MB, .app 3.2 MB) |
| Idle RAM (phys footprint, all processes) | 412 MB (app 100 + renderer 206 + GPU 151 + helper 13, after days idle) | **58 MB** (app 21 + WebContent 19 + GPU 11 + Networking 7, fresh) |
| Hotkey → overlay visible, 5K | 276–343 ms | **127–220 ms warm (median ~145)**, 165–403 ms first capture |
| of which: capture | ~110 ms (node-screenshots) | 91–257 ms (xcap), usually ~100–120 |
| of which: 59 MB bitmap to the page | structured clone | 20–57 ms (raw `ipc::Response`), one 92 ms outlier |
| Drawing (pen and rect, 250 Hz input, 2 s, full-5K canvas) | not measured | **60 fps steady**: median 17 ms, p95 18 ms, max 22 ms; handlers ≤2 ms. One 74 ms frame on the very first drag (selection start) |
| Copy (PNG to clipboard) | – | 1.1–2.8 MB PNG over IPC in 7–10 ms; verified by pasting |

The RAM comparison is not perfectly fair (Electron after days, Tauri fresh), but the gap is too wide to
matter. Capture time dominates latency on both; the rest of the Tauri path is ~30–60 ms.

## Safety (the v1.0.0 freeze class)

- **No permission:** the spike calls `CGRequestScreenCaptureAccess` and never shows the overlay
  (verified: 6 captures without a grant, nothing appeared).
- **App-modal dialog open:** the global hotkey *can* still fire during an `NSAlert` modal loop. The
  overlay then appears over the dialog, the same setup that froze v1.0.0. With the panel's
  `worksWhenModal = YES` the overlay kept taking input: a capture was annotated and copied (overlay closed)
  while the alert was still open. So no lock. (Not seen: a run where the hotkey was queued until the
  modal closed. Delivery during a modal is not reliable either way.)
- **Not tested:** the negative control (`SPIKE_NO_WORKS_WHEN_MODAL=1`). Automation could not send keys to
  a non-activating panel. A port should still keep Electron's `dialogsOpen` guard as a second layer;
  it is a few lines.
- **Watchdog:** if the renderer never reports ready within 1.5 s the overlay is hidden, not revealed.
  Safer than Electron's "reveal anyway".
- `run_on_main_thread` closures do **not** run while an NSAlert modal is up. Any port logic that hops to
  the main thread (hide/show from a command) stalls until the dialog closes. Design around it: show
  dialogs non-modally, or as sheets.

## What broke / gotchas

- exFAT `._*` AppleDouble files break `tauri-build`: it parses every file in `capabilities/` as JSON.
  The capability is inlined in `tauri.conf.json` instead. Keep `src-tauri` free of `._*` or build from a
  non-exFAT checkout (CI is fine).
- The editor's CSP (`default-src 'self'`) blocks Tauri's `ipc:` fetch transport; `build-web.sh` adds
  `connect-src ipc: http://ipc.localhost`.
- `tauri_panel!` re-exports `MainThreadMarker`; importing it yourself is a name clash.
- The `tauri build` DMG step calls `hdiutil` (fails inside a sandbox; fine on a normal shell/CI).
- Screen Recording for an ad-hoc signed build: the prompt from `CGRequestScreenCaptureAccess` did not add
  a list entry for a bundle run from a hidden `/tmp` path. It had to be added by hand with **+**. With
  the real fixed certificate and `/Applications` this should behave like today, but verify it.
- The Electron renderer ran with zero edits. `navigator.platform` still reports Mac in WKWebView, so
  shortcuts are labelled ⌘.

## Open items before a real port

1. **Windows:** WebView2 + `xcap`'s Windows backend, DPI scaling (Electron's `dipToScreenPoint` logic),
   the PowerShell auto-paste. Not touched by this spike. Biggest unknown.
2. **Signing:** the bundle id `biz.ontheshore.shoreshot` and the fixed self-signed certificate must be
   reused (Tauri: `bundle.macOS.signingIdentity` + the same CI secret) or every user re-grants Screen
   Recording.
3. Window mode (`xcap::Window::all()` has the frames), the Save dialog (`tauri-plugin-dialog`, keeping the
   modal caveat above), tray, settings window, login item (`tauri-plugin-autostart`), update check.
4. Clipboard: the spike writes PNG only. Electron writes several types; check pasting into older apps
   that want TIFF.
5. Multi-display with different scale factors (only one 5K display tested).
