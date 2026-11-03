# ShoreShot

Screenshot + annotation app for **macOS and Windows** (Electron + TypeScript). Runs in the background from the menu bar (macOS) / system tray (Windows).

## Features

| Area | Details |
|---|---|
| Capture | Global hotkey, `⌘⇧X` (macOS) / `Ctrl+Shift+X` (Windows) by default, **changeable** in Settings. Drag to select an area, single click = whole screen. Drag an edge or corner of the frame to adjust the selection (works after drawing too). Captures the display under the mouse cursor. Exports at native resolution (Retina / HiDPI), or at 1× if you turn that on in Settings. |
| Rectangle | Tool `R`. Hold `Shift` for a square. Scroll to change the border width (1 to 40px), even while dragging. |
| Ellipse | Tool `O`. Hold `Shift` for a circle. Scroll to change the border width. |
| Line | Tool `L`. Scroll to change the stroke width. |
| Text | Tool `T`. Click to type, `Enter` to finish, `Shift+Enter` for a new line, `Esc` to cancel. Scroll to change the font size (10 to 160px). Click existing text to edit its content, size, color. |
| Pen | Tool `P`. Strokes are smoothed. Scroll to change the stroke width. |
| Color | 8 presets + a custom color picker. Applies to every tool. Changing color while typing recolors the text right away. |
| Export | `⌘/Ctrl+C`: copy to clipboard. `⌘/Ctrl+S`: save PNG (Pictures by default). |
| Copy + paste | `⌘V` / `Ctrl+V`: copy, then paste straight into the app you were using before the capture (Slack, Telegram, Figma…). |
| Other | `Enter`: copy. `⌘/Ctrl+Z` undo, `⌘/Ctrl+Shift+Z` or `Ctrl+Y` redo, `Esc` exit. Right-click before drawing = select again. Hover a toolbar button to see its name and shortcut. |
| Settings | Tray menu > **Settings…**: capture hotkey, export at 1× on Retina displays, open at login. The footer shows the version and links to About and Report an issue. |
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

To see how long each capture stage takes, start the app from a terminal with `SHORESHOT_TIMING=1`, e.g. `SHORESHOT_TIMING=1 /Applications/ShoreShot.app/Contents/MacOS/ShoreShot`.

### Releasing a new version

Bump `version` in `package.json`, commit, then either:
- On GitHub: **Actions** > **build** > **Run workflow** > tick **release** > Run.
- Or from a terminal: `git tag v0.1.3 && git push origin v0.1.3`

GitHub Actions (`.github/workflows/build.yml`) builds on macOS + Windows and creates the Release with the `.dmg`, `.zip`, `.exe` files. The install scripts always pick the latest release.

#### macOS signing certificate

macOS ties Screen Recording / Accessibility permissions to the app's signature, so every release must be signed with the same certificate (`scripts/after-pack.js`). The build reads it from two repository secrets: `MAC_CERT_P12` (base64 of a `.p12` holding a self-signed code-signing certificate whose name contains "ShoreShot") and `MAC_CERT_PASSWORD`. Without them the build falls back to ad-hoc signing, and users get asked for permissions again after every update. Keep the `.p12` safe: a new certificate also resets everyone's permissions once.

## Changing the hotkey

Menu bar / tray icon > **Settings…** > click the hotkey field > press the new combination. The app registers it right away; if the combination is taken by the system or another app, it shows an error and keeps the old hotkey. At least one modifier is required, except for `F1` to `F24` and `PrintScreen`. **Default** goes back to `⌘⇧X` / `Ctrl+Shift+X`.

Settings are stored in `config.json` in the userData folder (macOS: `~/Library/Application Support/ShoreShot/`, Windows: `%APPDATA%\ShoreShot\`). If the saved hotkey is taken by another app at startup, the Settings window opens automatically.

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
src/renderer/settings.ts Settings window: hotkey recording, what Enter does
static/                  HTML/CSS for the overlay and Settings
scripts/install.sh|.ps1  terminal install/uninstall (macOS/Windows)
assets/                  tray icons
build/icon.png           app icon (electron-builder converts it to .icns/.ico)
```

## Current limitations

- One display per capture (the one under the cursor). A selection can't span two displays.
- Shapes can't be selected and moved after drawing (text can be clicked to edit).
