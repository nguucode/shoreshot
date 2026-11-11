# Porting ShoreShot from Electron to Tauri 2

Status of the port of `src/main.ts` (Electron) to `app-tauri/src-tauri/src/` (Rust). **macOS only so far.**
The Electron app in `src/` is untouched and stays the shipped app until this reaches parity; nothing here is
released. Windows comes after macOS, on the WebView2 shared-buffer path proven in `spike/tauri/NOTES.md`.

The renderer is shared and unchanged: `build-web.sh` compiles `src/renderer/editor.ts` + `settings.ts` and
copies `static/*.html|css` into `dist/`, loading `web/api.js` (the `window.api` bridge, replacing
`src/preload.ts`, same interface as `src/global.d.ts`) before them.

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

Run the bundle's binary (`…/ShoreShot.app/Contents/MacOS/shoreshot`) from a terminal that has Screen
Recording permission, or the dev build will be asked for its own. It reads and writes the same
`config.json` and `capture.log` as the Electron app, so quit Electron ShoreShot first or the hotkeys clash.

Test switches (env): `SHORESHOT_AUTO=n` runs n captures 3 s apart without a hotkey, each hidden after 1 s;
`SHORESHOT_AUTO_MODE=area|full|window|settings` (`settings` opens the Settings window instead); `SHORESHOT_AUTO_KEY=Enter|Meta+s|Meta+v|Escape` presses that key in
the page instead (full mode starts in editing, so `Enter` copies).

## Parity, feature by feature

| Feature (src/main.ts) | Status | Notes |
|---|---|---|
| Tray icon (template image from `assets/`) | Done | `trayTemplate@2x.png`, `icon_as_template`. Tooltip shows the area hotkey. |
| Tray menu: 3 capture modes with hotkey labels, Settings…, Update to x…, About x.y.z, Report an issue…, Quit | Done | Rebuilt on the main thread whenever hotkeys or the update change. |
| Three global hotkeys, saved in `config.json` | Done | Same file (`~/Library/Application Support/ShoreShot/config.json`) and shape, incl. the 0.1.11 single `hotkey` migration. Electron accelerator names are mapped to global-hotkey's (`numsub` etc.). Taken hotkey on startup opens Settings. |
| Settings window (`static/settings.html` + `src/renderer/settings.ts`) | Done | Unchanged page, verified on screen (window is 442 pt tall so WebKit gets Electron's 410 px of content). Set / clear / default hotkey, duplicate + taken checks with the old hotkey restored, recording pauses all hotkeys, Retina 1×, open at login, version, update link, About / Report links. |
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
| Windows | **Not done** | Next slice: `win.rs` with the same functions, WebView2 shared buffer, PowerShell paste, DPI. |
| Release workflow, signing in CI | **Not done (by design)** | `bundle-mac.sh` signs like `after-pack.js`; wiring it into `build.yml` is part of the switch-over. |

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
