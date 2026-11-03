# ShoreShot

Screenshot + annotation app for **macOS and Windows** (Electron + TypeScript). Runs in the background from the menu bar (macOS) / system tray (Windows).

## Features

| Area | Details |
|---|---|
| Capture area | Global hotkey, `⌘⇧X` (macOS) / `Ctrl+Shift+X` (Windows) by default, **changeable** in Settings. Drag to select an area, single click = whole screen. Drag an edge or corner of the frame to adjust the selection (works after drawing too). Captures the display under the mouse cursor. Exports at native resolution (Retina / HiDPI), or at 1× if you turn that on in Settings. |
| Capture full screen | Selects the whole display under the cursor and goes straight to annotating. No hotkey by default: assign one in Settings, or use the tray menu. |
| Capture window | Hover to frame the window under the cursor, click to select it (what is visible on screen in that window's frame). Dragging still selects an area; clicking the empty desktop selects the whole screen. No hotkey by default: assign one in Settings, or use the tray menu. |
| Rectangle | Tool `R`. Hold `Shift` for a square. Scroll to change the border width (1 to 40px), even while dragging. |
| Ellipse | Tool `O`. Hold `Shift` for a circle. Scroll to change the border width. |
| Line | Tool `L`. Scroll to change the stroke width. |
| Text | Tool `T`. Click to type, `Enter` to finish, `Shift+Enter` for a new line, `Esc` to cancel. While typing, drag the dashed frame around the text to move it. Scroll to change the font size (10 to 160px). Click existing text to edit its content, size, color. |
| Pen | Tool `P`. Strokes are smoothed. Scroll to change the stroke width. |
| Delete | Hover a shape, line, pen stroke or text: it gets a dashed frame. Press `⌫` / `Delete` or right-click to delete it. `⌘/Ctrl+Z` brings it back. |
| Color | 6 presets + a custom color picker. Applies to every tool. Changing color while typing recolors the text right away. |
| Export | `⌘/Ctrl+C`: copy to clipboard. `⌘/Ctrl+S`: save PNG (Pictures by default). |
| Copy + paste | `⌘V` / `Ctrl+V`: copy, then paste straight into the app you were using before the capture (Slack, Telegram, Figma…). |
| Other | `Enter`: copy. `⌘/Ctrl+Z` undo, `⌘/Ctrl+Shift+Z` or `Ctrl+Y` redo, `Esc` exit. Right-click before drawing = select again. Two vertical bars sit to the right of the selection, bottom-aligned: tools (shapes, colors, size) and actions (undo, cancel, save, copy). The copy/paste shortcuts are shown under the selection. Hover a button to see its name and shortcut. |
| Settings | Tray menu > **Settings…**: hotkeys for area / full screen / window capture, export at 1× on Retina displays, open at login. The footer shows the version and links to About and Report an issue. |
| Updates | ShoreShot checks GitHub Releases at startup and every 12 hours. When a newer version is out it shows a notification and an **Update to x.y.z…** item in the tray menu, with the command to run. |

Scroll up = bigger, scroll down = smaller. Trackpad scrolling is accumulated so it doesn't jump too fast.

## Install

### Option 1: one command

**macOS** (open Terminal):
```bash
curl -fsSL https://raw.githubusercontent.com/nguucode/shoreshot/main/scripts/install.sh | bash
```

**Windows** (open PowerShell, no Admin needed):
```powershell
irm https://raw.githubusercontent.com/nguucode/shoreshot/main/scripts/install.ps1 | iex
```

The script downloads the latest build from [Releases](https://github.com/nguucode/shoreshot/releases), installs it and opens the app.

| | macOS | Windows |
|---|---|---|
| Installs to | `/Applications` (or `~/Applications` if not writable) | `%LOCALAPPDATA%\Programs\ShoreShot` |
| Uninstall | `... \| bash -s -- --uninstall` | `& ([scriptblock]::Create((irm <url>))) -Uninstall` |

Run the install command again to update to the latest version.

### Option 2: download the installer

From [Releases](https://github.com/nguucode/shoreshot/releases/latest), download:
- Mac Apple Silicon (M1 or later): `ShoreShot-x.y.z-mac-arm64.dmg`
- Mac Intel: `ShoreShot-x.y.z-mac-x64.dmg`
- Windows: `ShoreShot-Setup-x.y.z.exe`

The app is not code-signed:
- **macOS** says "is damaged" or "cannot be opened": run `xattr -cr /Applications/ShoreShot.app` and open it again. (Option 1 avoids this.)
- **Windows** SmartScreen warning: click More info > Run anyway.

### macOS permissions

- **Screen Recording**: macOS asks on the first capture. Turn on ShoreShot in System Settings > Privacy & Security > Screen & System Audio Recording, then choose "Quit & Reopen". If you dismissed the macOS prompt, the next capture shows a dialog with a button that opens that settings page.
- **Accessibility**: only needed for `⌘V` to paste into other apps.
- Releases are signed with a fixed ShoreShot certificate, so these permissions survive updates. If ShoreShot shows as allowed but capture or paste still fails (e.g. after updating from 0.1.5 or older, which were signed ad-hoc), choose **Reset permission** in ShoreShot's permission dialog and allow it again. From a terminal: `tccutil reset ScreenCapture biz.ontheshore.shoreshot`.

## Development

Requires Node.js 18+.

```bash
git clone https://github.com/nguucode/shoreshot.git && cd shoreshot
npm install
npm start          # run in dev (macOS: allow Screen Recording for the "Electron" app)
npm run dist:mac   # build .dmg + .zip on a Mac
npm run dist:win   # build .exe on Windows
```

Each capture writes one line of step timings (ms since the hotkey) to `~/Library/Logs/ShoreShot/capture.log` (Windows: `%APPDATA%\ShoreShot\logs\capture.log`):

```bash
tail -f ~/Library/Logs/ShoreShot/capture.log
```

### Releasing a new version

Bump `version` in `package.json`, commit, then either:
- On GitHub: **Actions** > **build** > **Run workflow** > tick **release** > Run.
- Or from a terminal: `git tag v0.1.3 && git push origin v0.1.3`

GitHub Actions (`.github/workflows/build.yml`) builds on macOS + Windows and creates the Release with the `.dmg`, `.zip`, `.exe` files. The install scripts always pick the latest release.

#### macOS signing certificate

macOS ties Screen Recording / Accessibility permissions to the app's signature, so every release must be signed with the same certificate (`scripts/after-pack.js`). The build reads it from two repository secrets: `MAC_CERT_P12` (base64 of a `.p12` holding a self-signed code-signing certificate whose name contains "ShoreShot") and `MAC_CERT_PASSWORD`. Without them the build falls back to ad-hoc signing, and users get asked for permissions again after every update. Keep the `.p12` safe: a new certificate also resets everyone's permissions once.

## Changing the hotkeys

Menu bar / tray icon > **Settings…** > click the field next to **Capture area**, **Capture full screen** or **Capture window** > press the new combination. The app registers it right away; if the combination is taken by the system, another app or another ShoreShot capture, it shows an error and keeps the old hotkey. At least one modifier is required, except for `F1` to `F24` and `PrintScreen`. **Default** puts the area hotkey back to `⌘⇧X` / `Ctrl+Shift+X`; **Clear** removes the full screen / window hotkey.

Settings are stored in `config.json` in the userData folder (macOS: `~/Library/Application Support/ShoreShot/`, Windows: `%APPDATA%\ShoreShot\`). If a saved hotkey is taken by another app at startup, the Settings window opens automatically.

Windows 11 note: `PrintScreen` is usually assigned to Snipping Tool. To use it, turn that off in Settings > Accessibility > Keyboard > "Use the Print screen key to open screen capture".

## Copy + paste: required permissions

- **macOS**: needs **Accessibility** to send ⌘V (System Settings > Privacy & Security > Accessibility). The first time, macOS may also ask "ShoreShot wants to control System Events"; click OK. Without the permission the image is still copied and the app tells you to press ⌘V yourself.
- **Windows**: no permission needed. The app sends Ctrl+V through PowerShell, so there's about half a second of delay. It can't paste into apps running as Administrator while ShoreShot runs as a normal user (a Windows limitation).
- On `⌘V` / `Ctrl+V` the app waits until you release every key before sending the paste, so held keys don't mix in (e.g. turning it into `Ctrl+Shift+V`, paste without formatting).

## Layout

```
src/main.ts              main process: tray, hotkey + config, capture, clipboard, auto-paste, save
src/preload.ts           safe IPC bridge (contextIsolation + sandbox)
src/renderer/editor.ts   overlay for selecting an area + drawing annotations (canvas)
src/renderer/settings.ts Settings window: hotkey recording, options
static/                  HTML/CSS for the overlay and Settings
scripts/install.sh|.ps1  terminal install/uninstall (macOS/Windows)
assets/                  tray icons
build/icon.png           app icon (electron-builder converts it to .icns/.ico)
```

## Current limitations

- One display per capture (the one under the cursor). A selection can't span two displays.
- Shapes can't be moved after drawing (text can be clicked to edit, anything can be deleted).
- Window capture crops what is on screen inside the window's frame, so anything covering that window is included.
