# Tauri spike: findings

**Update after the Windows run (below): go on macOS, not yet on Windows.** On Windows the WebView2 IPC
makes Tauri slower than Electron. The bitmap transport has to be replaced, then measured on a real 4K
display, before the port is committed. Original macOS verdict follows.

**Recommendation (macOS): go**, for a staged port on macOS first. On every measure the capture path is as fast or
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

## Windows (GitHub Actions `windows-latest`, run 42973589821)

Same spike, `cfg`-split in `main.rs`: a plain always-on-top WebView2 window instead of NSPanel, physical-pixel
coordinates (xcap and `cursor_position()` agree), `arboard` for the clipboard, an unowned `MessageBoxW` for
the modal test. `.github/workflows/spike-windows.yml` + `ci/run-windows.ps1` press the real Ctrl+Shift+X with
`keybd_event` and run the Electron app (from source) the same way on the same machine. The run's artifact
has the logs and screenshots.

Runner limits: 1024×768 at 100 %, no GPU (WebView2 renders in software), Windows Server 2025. Absolute numbers
are not a desktop's; the Electron-vs-Tauri comparison on the same box is the point.

| | Electron (same runner) | Tauri spike |
|---|---|---|
| Installer | 78–100 MB (release) | **1.2 MB** NSIS (exe 3.3 MB; WebView2 ships with Windows 10/11) |
| Idle RAM, private bytes, process tree | 131 MB (4 processes) | 101 MB (8 processes) |
| Idle RAM, working set | 277 MB | 311 MB (shared Edge runtime pages count here) |
| After 6 captures, private | 156 MB | 113 MB |
| Hotkey → overlay visible, 1024×768 | **56–97 ms** | **103–149 ms** |
| of which: capture | 26–48 ms (node-screenshots) | 27–46 ms (xcap) |
| of which: event to page | ~15 ms | 15–22 ms |
| of which: 3 MB bitmap to the page | (in "sent") | **47–77 ms** |
| Drawing bench (software rendering) | – | 64 fps steady (15.6 ms), handlers <1 ms |
| Copy to clipboard | – | 46 KB PNG: 67 ms IPC + 35 ms decode/set |

**Tauri is slower on Windows, and the reason is bandwidth.** WebView2 moves Tauri's raw IPC bytes at
roughly 40–60 MB/s, through its custom-protocol / WebResourceRequested path. At 1024×768 that is 3 MB and
~50 ms. A 4K screen is 33 MB and would cost ~0.5–0.8 s, which is unusable. (WKWebView on macOS moved 59 MB in
20–40 ms.) The rest of the Windows path is on par with Electron.

Fix to try before a Windows port: skip IPC for the bitmap. WebView2's `PostSharedBufferToScript` hands
the page a shared-memory `ArrayBuffer` with no copy. Tauri doesn't expose it, but `WebviewWindow::with_webview`
gives the raw `ICoreWebView2`, so it is ~50 lines with the `webview2-com` crate. Alternatives: encode to
BMP/JPEG and load via a custom protocol (still a copy), or capture at reduced size for the first frame.

Safety on Windows: **no lock.** With the MessageBox open, the hotkey still captured (MessageBox runs its own
message pump), the overlay drew on top of the dialog, and Esc closed it (`hidden 1561`). The dialog was
intact afterwards. Windows has no app-modal input block like macOS, so the v1.0.0 class does not apply
there. Esc also closed every one of the 6 normal captures: focus works without extra tricks.

Windows gotchas:
- Release builds open a console window. A real port needs `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]`.
- The overlay is shown off-screen (−32000) until painted, then moved on. Layered/opacity windows don't
  render WebView2, and a hidden WebView2 pauses `requestAnimationFrame`. Worked without a visible flash in
  the screenshots.
- `pwsh` 7 can't compile System.Drawing helpers without extra references; the harness runs in Windows PowerShell 5.1.
- Not covered: mixed-DPI multi-monitor, 4K, the PowerShell auto-paste, SmartScreen with a 1.2 MB unsigned installer.
