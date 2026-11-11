# Porting ShoreShot from Electron to Tauri 2

Record of the port of the Electron main process (`src/main.ts`, removed after v2.0.0; see tag `v2.0.0`) to
`app-tauri/src-tauri/src/` (Rust), **macOS and Windows**. Shipped as v2.0.0. The Windows CI harness no longer
runs the Electron app as a baseline; the Electron numbers below are from before the removal. `main.rs` is shared and calls only `plat::*`: `mac.rs` on macOS, `win.rs` on Windows (same
functions). Windows-only parts of `main.rs` are `cfg`-gated; see "Windows" below.

The renderer is shared and unchanged: `build-web.sh` compiles `src/renderer/editor.ts` + `settings.ts` and
copies `static/*.html|css` into `dist/`, loading `web/api.js` (the `window.api` bridge, replacing
Electron's `src/preload.ts`, same interface as `src/global.d.ts`) before them.

## Run

Needs Node.js 18+ and Rust (rustup). On the exFAT drive keep the Cargo target dir elsewhere.

```bash
cd app-tauri
npm install
export CARGO_TARGET_DIR="$TMPDIR/shoreshot-tauri-target"
npm run dev      # tauri dev
npm run build    # release ShoreShot.app, ad-hoc signed by the linker
npm run bundle   # release ShoreShot.app signed like Electron's after-pack.js + DMG (see Signing)
```

Windows (needs the MSVC build tools; WebView2 ships with Windows 10/11):

```powershell
cd app-tauri
npm install
npm run web
npx tauri build --bundles nsis   # src-tauri\target\release\shoreshot.exe + bundle\nsis\ShoreShot_*-setup.exe
```

Run the bundle's binary (`…/ShoreShot.app/Contents/MacOS/shoreshot`) from a terminal that has Screen
Recording permission, or the dev build will be asked for its own. It reads and writes the same
`config.json` and `capture.log` as the Electron app, so quit Electron ShoreShot first or the hotkeys clash.

Test switches (env): `SHORESHOT_AUTO=n` runs n captures 3 s apart without a hotkey, each hidden after 1 s;
`SHORESHOT_AUTO_MODE=area|full|window|settings` (`settings` opens the Settings window instead); `SHORESHOT_AUTO_KEY=Enter|Meta+s|Meta+v|Escape` presses that key in
the page instead (full mode starts in editing, so `Enter` copies). Windows only: `SHORESHOT_TEST_MODAL=1`
opens a MessageBox on the main thread 3 s after start (the CI safety test).

## Parity, feature by feature

| Feature (src/main.ts) | Status | Notes |
|---|---|---|
| Tray icon (template image from `assets/`) | Done | `trayTemplate@2x.png`, `icon_as_template`. Tooltip shows the area hotkey. |
| Tray menu: 3 capture modes and copy text with hotkey labels, Settings…, Update to x…, About x.y.z, Report an issue…, Quit | Done | Rebuilt on the main thread whenever hotkeys or the update change. |
| Global hotkeys (3 capture modes + copy text), saved in `config.json` | Done | Same file (`~/Library/Application Support/ShoreShot/config.json`) and shape, incl. the 0.1.11 single `hotkey` migration. Electron accelerator names are mapped to global-hotkey's (`numsub` etc.). Taken hotkey on startup opens Settings. |
| Settings window (`static/settings.html` + `src/renderer/settings.ts`) | Done | Unchanged page, verified on screen (window is 484 pt tall so WebKit gets 452 px of content: Electron's 410 plus the copy text row). Set / clear / default hotkey, duplicate + taken checks with the old hotkey restored, recording pauses all hotkeys, Retina 1×, open at login, version, update link, About / Report links. |
| Capture: xcap, display under the cursor | Done | Same as the spike. |
| NSPanel overlay: screen-saver level, all Spaces, full-screen auxiliary, non-activating, `worksWhenModal` | Done | Created hidden at startup. |
| Alpha-0 show, reveal on the page's `ready` | Done | |
| 1.5 s watchdog | Done | Hides (never reveals) if the page doesn't report ready. Electron reveals anyway. |
| Window mode | Done | `xcap::Window::all()` after reveal, same clipping rules as Electron (slivers < 40 pt and display-covering windows skipped). |
| Copy | Done | PNG + TIFF on `NSPasteboard` (Electron's `writeImage` also gives older apps TIFF). |
| Copy + auto-paste | Done | Accessibility check with the macOS prompt, OK / Reset permission dialog, `osascript` ⌘V after 250 ms, error dialog on failure. |
| Save dialog | Done | `NSSavePanel` presented modeless (see Dialogs), titled "Save screenshot", in `~/Pictures`, default `Screenshot YYYY-MM-DD HH.MM.SS.png`, PNG only. Cancel shows the overlay again. Verified on screen. |
| Screen Recording permission flow incl. Reset permission | Done | `CGPreflight…`/`CGRequestScreenCaptureAccess`, `screenAsked` handling, Open System Settings / Reset permission (`tccutil reset ScreenCapture`) / Later. |
| Open at login | Done | `SMAppService.mainApp`, the API Electron uses on macOS 13+: the test Mac's existing Electron setting showed up as on. Needs a bundle, not `tauri dev`. |
| 12 h update check against GitHub Releases | Done | `curl` to the Releases API 5 s after start, then every 12 h. Tray item + Settings link + the update dialog (Copy command / Open release page / Later). |
| Update notification (Electron `Notification`) | **Not done** | Needs `UNUserNotificationCenter` (a new crate) or the notification plugin. The tray item and Settings link are there. |
| Dialog safety | Done | See below. |
| `capture.log` | Done | `~/Library/Logs/ShoreShot/capture.log`, `ISO  step ms · step ms`, emptied at startup past 256 KB. Steps differ slightly from Electron's (no `module`/`pixels`; adds `bitmap`). |
| Single instance / second launch captures | Done, macOS way | Launch Services keeps one instance; opening the app again (`RunEvent::Reopen`) starts an area capture. |
| desktopCapturer fallback | Dropped | xcap has no separate binary that can be missing. A failed capture shows the error (or the permission flow). |
| Windows | Done | See "Windows" below. |
| Release workflow, signing in CI | **Not done (by design)** | `bundle-mac.sh` signs like `after-pack.js`; wiring it into `build.yml` is part of the switch-over. |

## Windows

`win.rs` implements `mac.rs`'s functions on Win32 / WebView2; `main.rs` adds a few `cfg(windows)` lines.
Tested end to end on the GitHub Actions `windows-latest` runner by `.github/workflows/tauri-windows.yml` +
`ci/run-windows.ps1`: the real global hotkeys (`keybd_event`) and mouse drags, the Electron app run the same
way on the same machine as the baseline. The runner is 1024×768 at 100 %, no GPU, Windows Server 2025.

| Feature (src/main.ts) | Windows status | Notes |
|---|---|---|
| Tray icon, menu, left click = capture area | Done | `assets/tray.png`; menu on right click (`show_menu_on_left_click(false)`), left click starts an area capture like Electron. |
| Hotkeys, `config.json` | Done | Same file as Electron: `%APPDATA%\ShoreShot\config.json`. Labels read `Ctrl+Shift+X`. |
| Settings window | Done (not tested on CI) | Same page; inner size 440×452 (no title-bar offset on Windows). |
| Capture: xcap, display under the cursor | Done | Physical pixels: monitor, cursor (`GetCursorPos`) and windows are all physical in a per-monitor-DPI-aware process. |
| Overlay | Done | Always-on-top WebView2 window, shown at −32000 until the page has painted, then moved onto the monitor and focused. WebView2 doesn't render into layered windows, and a hidden one pauses `requestAnimationFrame`, so there is no opacity 0 here. Ctrl+P, F5, Ctrl+wheel / pinch zoom and the context menu are off in the overlay. |
| Bitmap to the page | Done | WebView2 shared buffer (`CreateSharedBuffer` + `PostSharedBufferToScript`), metadata as additionalData. Tauri IPC is the fallback (`send_ipc`), and the only path on macOS. |
| DPI, mixed-DPI multi-monitor | Done, **not tested on a real mixed-DPI desktop** | CSS px = physical / that monitor's scale, for the frame, cursor and window list (Electron's `dipToScreenPoint` / `screenToDipRect` once clipped to one display). After moving onto a monitor with another scale, the window's physical size is set again (tao keeps the logical size on WM_DPICHANGED). The first capture after a scale change may show the wrong size for a frame. Unit-tested math only. |
| Window mode | Done | `xcap::Window::all()` (DWM frame bounds, own windows excluded), minimized windows skipped, clipped and divided by the scale in `clip`. |
| Copy | Done | `"PNG"` (the page's bytes, not re-encoded) + `CF_DIB`. Windows synthesizes the rest; the formats after a copy match Electron's exactly (see Measurements). |
| Copy + auto-paste | Done (keystroke not tested on CI) | **In-process `SendInput` Ctrl+V instead of Electron's PowerShell `SendKeys`**: the same keystroke, without starting a ~0.5 s PowerShell process (agreed with the release session). No permission needed. Error box if UIPI blocks it (target app runs as admin). |
| Save dialog | Done (not tested on CI) | `GetSaveFileNameW` in `%USERPROFILE%\Pictures`, `.png` added; unowned, on a worker thread, counted by the dialog guard. |
| Message boxes (update, errors) | Done (not tested on CI) | Task Dialog with custom buttons (`TaskDialogIndirect`, looked up at run time; falls back to a MessageBox). Unowned, on a worker thread, counted by the dialog guard. |
| Open at login | Done (not tested on CI) | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, value `biz.ontheshore.shoreshot` (electron-builder's appId = Electron's AppUserModelId, the name Electron writes). |
| Update check | Done | Same `curl` (built into Windows 10 1803+), run with `CREATE_NO_WINDOW`; the dialog shows the PowerShell install command. |
| Single instance / second launch | Done | `tauri-plugin-single-instance`; a second launch starts an area capture (Electron's `second-instance`). |
| No console window | Done | `windows_subsystem = "windows"` in release builds. |
| Installer | Done | NSIS, per-user (`tauri.windows.conf.json`, no admin), WebView2 bootstrapper if missing. **1.2 MB.** Unsigned: SmartScreen will warn as it does for Electron's. |
| Dialog guard / the v1.0.0 freeze | Done | Windows has no app-modal input block, so the freeze can't happen the same way. Tested: with a MessageBox open on the app's main thread (`SHORESHOT_TEST_MODAL=1`), the hotkey still opens the overlay over it, Esc closes the overlay, and the dialog is intact afterwards. The `dialogs` guard still applies to ShoreShot's own dialogs. |
| Update notification | Not done | Same as macOS: tray item + Settings link only. |

### Windows measurements (runs 42986796697 and 42988224877, same runner for both apps)

| | Electron (from source) | Tauri |
|---|---|---|
| Hotkey → overlay visible, run 1 | 57–105 ms (median 77, n=8) | 53–74 ms (median 60, n=8) |
| Hotkey → overlay visible, run 2 | 45–72 ms (median 58, n=8) | 43–76 ms (median 65, n=8) |
| Idle RAM, private bytes, process tree | 131–132 MB (4 processes) | **100–102 MB** (7) |
| After the suite, private | 180–181 MB | **112–113 MB** |
| Installer | 78–100 MB | **1.2 MB** |
| Clipboard formats after copy | Bitmap, DeviceIndependentBitmap, Format17, PNG, System.Drawing.Bitmap | same |
| Hotkey ×6 → overlay, Esc ×6 closes | pass | pass |
| Select 500×350, draw a rectangle, Enter | pass (500×350 on the clipboard) | pass (500×350) |
| Window mode: click a 600×400 Notepad, Enter | 584×341 (not investigated) | pass (586×393, the DWM frame) |
| MessageBox open on the main thread: hotkey, Esc | (not run) | pass: overlay over the dialog, Esc closed it, dialog intact |

Latency is on par with Electron, not clearly better: each app won one run on the median, and the ranges
overlap. Capture (xcap vs node-screenshots) dominates both. In a Tauri capture.log line, `captured` (xcap) takes 21–39 ms and `posted` (copy into the shared buffer) 20–25 ms
after it. A 64 KB PNG copy takes 14 ms.

### Not verified on Windows

- Real desktops: 4K, mixed DPI across monitors, a GPU (the runner renders WebView2 in software).
- Auto-paste into another app, the Save dialog, Task Dialogs, Settings, open at login, the tray click: built
  and type-checked, not driven by the harness.
- SmartScreen with the 1.2 MB unsigned installer.

## Dialogs and the v1.0.0 freeze

v1.0.0 froze the Mac: the always-on-top overlay covered an app-modal message box. Two layers here:

1. **No modal loop in ShoreShot at all.** Message boxes are an `NSAlert` whose window is shown like any other
   window, with the buttons wired to a small target object (`mac.rs`, `ui::alert`), never `runModal`. The
   Save panel uses `beginWithCompletionHandler:` (modeless). Callers wait on a channel from a worker
   thread, so the main thread keeps running: `run_on_main_thread` never stalls (the spike found its
   closures don't run during an NSAlert modal), and the overlay panel can't be blocked by a dialog.
   Both are floating-level and don't hide when the app is inactive.
2. **`dialogsOpen` guard kept.** Open dialogs are counted; a hotkey or tray capture while one is up is
   ignored (logged) instead of showing the overlay. The overlay panel also keeps `worksWhenModal`.

Tried first and dropped: dialogs in a separate `osascript` process. Spawned from a menu bar app, macOS
(cooperative activation, macOS 14+) didn't bring them to the front, so they could open hidden.

Known gap: ShoreShot asks for activation (`activateIgnoringOtherApps`) before showing a dialog. In test
runs (synthetic keys) macOS refused it, so the panel showed on top but without keyboard focus until
clicked. A real key press in the overlay should allow it; check by hand.

## Signing (must not change)

macOS ties Screen Recording / Accessibility grants to the designated requirement:
`identifier "biz.ontheshore.shoreshot" and certificate leaf = H"7bd632f8…"` on the installed 1.0.1.
`tauri.conf.json` keeps `identifier: biz.ontheshore.shoreshot`; `bundle-mac.sh` runs the same
`codesign --force --deep --sign "$MAC_SIGN_IDENTITY"` as `scripts/after-pack.js` (ad-hoc without it), which
sets the code identifier to the bundle id. Checked locally with ad-hoc: identifier `biz.ontheshore.shoreshot`.
The real certificate is only in CI; check `codesign -d -r-` on the CI build matches the line above before
any release.

## Measurements

Apple Silicon, macOS 26, one 5120×2880 display, release build, captures started by `SHORESHOT_AUTO`
(the same `start_capture` the hotkey calls, so the clock starts at the same point). From `capture.log`:

| | Tauri port | Tauri spike | Electron 1.0.2 |
|---|---|---|---|
| Hotkey → overlay visible, warm (area) | **119–205 ms** (144, 151, 119, 195, 139, 205) | 127–220 ms | 276–343 ms |
| First capture after launch | 203–365 ms (area 273–293, window 365, full 203–358) | 165–403 ms | – |
| of which capture (xcap, 5K) | 69–270 ms, usually 80–160 | 91–257 ms | ~110 ms |
| of which bitmap to the page (59 MB) | 23–104 ms, usually 25–45 | 20–57 ms | – |
| Window list after reveal | +92 ms warm, +199 ms first | – | ~50 ms |
| Copy (1.4 MB PNG, PNG + TIFF on the pasteboard) | 35 ms | 7–10 ms (PNG only) | – |
| `ShoreShot.app` | 3.5 MB | 3.2 MB | 78–100 MB installer |

Example line: `2026-11-11T07:58:45.613Z  display area 0 · permission 0 · monitor 0 · captured 5120x2880 88 · sent 90 · bitmap 92 · visible (bitmap ipc 23 ms) 119`

## Verified on the test Mac

Area, full and window captures; copy (PNG + TIFF on the pasteboard); the Save panel appears; the Settings
window loads the saved hotkeys / options / version and all three hotkeys registered; the tray icon.

## Not verified yet

- Real key presses: the hotkeys themselves, keyboard focus in the Save panel and alerts (see Dialogs).
  Electron 1.0.1 was running with the same hotkeys, and the user was working on the Mac, so tests used
  `SHORESHOT_AUTO` and kept on-screen time short.
- Auto-paste into another app and the Accessibility prompt (a test would paste into whatever app is in
  front), the permission dialogs with no Screen Recording grant, the update dialog, toggling open at login,
  Save cancel → overlay back, multi-display with different scale factors.
- A build signed with the real certificate (only CI has it).
