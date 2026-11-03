import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  desktopCapturer,
  screen,
  ipcMain,
  clipboard,
  nativeImage,
  dialog,
  systemPreferences,
  shell,
  net,
  Notification,
  Display,
} from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { setTimeout as sleep } from 'timers/promises';

const run = promisify(execFile);

const DEFAULT_HOTKEY = 'CommandOrControl+Shift+X';
const BUNDLE_ID = 'biz.ontheshore.shoreshot'; // build.appId in package.json
const REPO_URL = 'https://github.com/nguucode/shoreshot';
const UPDATE_CHECK_MS = 12 * 60 * 60 * 1000;
const isMac = process.platform === 'darwin';

interface CapturePayload {
  bitmap: Buffer; // raw pixels at full native resolution: no PNG encode/decode
  bgra: boolean; // desktopCapturer gives BGRA, node-screenshots gives RGBA
  pxW: number;
  pxH: number;
  width: number; // display size in CSS px (DIP)
  height: number;
  enterPastes: boolean;
  retina1x: boolean;
}

interface Config {
  hotkey: string;
  /** true: Enter / the ✓ button copies, then pastes into the previous app. */
  enterPastes: boolean;
  /** Export at 1x on Retina / HiDPI displays (half the pixels at 2x) instead of native resolution. */
  retina1x: boolean;
  /** Whether macOS has already shown its Screen Recording prompt (it only asks once). */
  screenAsked: boolean;
}

let tray: Tray | null = null;
let overlay: BrowserWindow | null = null;
let settingsWin: BrowserWindow | null = null;
let capturing = false;
const DEFAULT_CONFIG: Config = { hotkey: DEFAULT_HOTKEY, enterPastes: false, retina1x: false, screenAsked: false };
let config: Config = { ...DEFAULT_CONFIG };
let hotkeyActive = false; // whether the current hotkey is registered
let revealTimer: NodeJS.Timeout | undefined;
let overlayScale = 1; // scaleFactor of the display the overlay was created on
let overlayOpen = false; // a capture is in progress (including while the overlay is hidden for the Save dialog)
let update: { version: string; url: string } | null = null; // newer release on GitHub, if any

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.whenReady().then(async () => {
  if (isMac) app.dock?.hide();
  config = await loadConfig();
  hotkeyActive = registerHotkey(config.hotkey);
  createTray();
  overlay = createOverlay(screen.getPrimaryDisplay()); // created up front so the hotkey shows it instantly
  if (!hotkeyActive) {
    // The saved hotkey is taken by another app: open Settings so the user can pick another.
    openSettings();
  }
  setTimeout(() => void checkForUpdate(), 5000);
  setInterval(() => void checkForUpdate(), UPDATE_CHECK_MS);
});

// Keep running in the background when the overlay / Settings close.
app.on('window-all-closed', () => {});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('second-instance', () => void startCapture());

// ---------- config ----------
const configPath = () => path.join(app.getPath('userData'), 'config.json');

async function loadConfig(): Promise<Config> {
  try {
    const raw = JSON.parse(await fs.readFile(configPath(), 'utf8')) as Partial<Config>;
    return {
      hotkey: typeof raw.hotkey === 'string' && raw.hotkey ? raw.hotkey : DEFAULT_HOTKEY,
      enterPastes: raw.enterPastes === true,
      retina1x: raw.retina1x === true,
      screenAsked: raw.screenAsked === true,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function saveConfig(): Promise<void> {
  await fs.mkdir(path.dirname(configPath()), { recursive: true });
  await fs.writeFile(configPath(), JSON.stringify(config, null, 2), 'utf8');
}

// ---------- hotkey ----------
function registerHotkey(accel: string): boolean {
  try {
    return globalShortcut.register(accel, () => void startCapture());
  } catch {
    return false; // invalid accelerator syntax
  }
}

type SetHotkeyResult = { ok: true; hotkey: string } | { ok: false; error: string };

async function setHotkey(accel: string): Promise<SetHotkeyResult> {
  const old = config.hotkey;
  if (accel === old && hotkeyActive) return { ok: true, hotkey: old };
  // Only unregister when registered: a hand-edited config may hold an invalid accelerator and unregister would throw.
  if (hotkeyActive) globalShortcut.unregister(old);
  if (!registerHotkey(accel)) {
    hotkeyActive = registerHotkey(old); // restore the old hotkey
    return {
      ok: false,
      error: `${prettyHotkey(accel)} is already used by the system or another app. Pick another combination.`,
    };
  }
  hotkeyActive = true;
  config.hotkey = accel;
  await saveConfig();
  refreshTray();
  return { ok: true, hotkey: accel };
}

/** Show an accelerator the way each OS does: ⌘⇧X on Mac, Ctrl+Shift+X on Windows. */
function prettyHotkey(accel: string = config.hotkey): string {
  const mac: Record<string, string> = {
    CommandOrControl: '⌘', CmdOrCtrl: '⌘', Command: '⌘', Cmd: '⌘', Super: '⌘', Meta: '⌘',
    Control: '⌃', Ctrl: '⌃', Alt: '⌥', Option: '⌥', Shift: '⇧',
  };
  const win: Record<string, string> = {
    CommandOrControl: 'Ctrl', CmdOrCtrl: 'Ctrl', Control: 'Ctrl', Command: 'Win', Super: 'Win', Meta: 'Win',
  };
  const parts = accel.split('+').map((p) => (isMac ? mac[p] : win[p]) ?? p);
  return parts.join(isMac ? '' : '+');
}

// ---------- tray ----------
function createTray(): void {
  const iconPath = isMac
    ? path.join(__dirname, '../assets/trayTemplate.png')
    : path.join(__dirname, '../assets/tray.png');
  const icon = nativeImage.createFromPath(iconPath);
  if (isMac) icon.setTemplateImage(true);
  tray = new Tray(icon);
  refreshTray();
  // Windows: left-clicking the tray icon captures right away.
  if (!isMac) tray.on('click', () => void startCapture());
}

function refreshTray(): void {
  if (!tray) return;
  const keyLabel = hotkeyActive ? prettyHotkey() : 'not set';
  tray.setToolTip(`ShoreShot (${keyLabel})`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Capture screen    ${keyLabel}`, click: () => void startCapture() },
      { label: 'Settings…', click: () => openSettings() },
      { type: 'separator' },
      ...(update ? [{ label: `Update to ${update.version}…`, click: () => void showUpdate() }] : []),
      { label: `About ShoreShot ${app.getVersion()}`, click: () => void shell.openExternal(REPO_URL) },
      { label: 'Report an issue…', click: () => void shell.openExternal(`${REPO_URL}/issues/new`) },
      { type: 'separator' },
      { label: 'Quit ShoreShot', role: 'quit' },
    ]),
  );
}

// ---------- settings window ----------
function openSettings(): void {
  if (settingsWin) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 440,
    height: 380,
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'ShoreShot Settings',
    useContentSize: true,
    backgroundColor: '#1c1c1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWin = win;
  win.setMenuBarVisibility(false);
  win.once('ready-to-show', () => {
    win.show();
    if (isMac) app.focus({ steal: true });
    win.focus();
  });
  win.on('closed', () => {
    settingsWin = null;
    // Window closed while recording a hotkey: re-register the current one.
    if (!hotkeyActive) hotkeyActive = registerHotkey(config.hotkey);
    refreshTray();
  });
  void win.loadFile(path.join(__dirname, '../static/settings.html'));
}

ipcMain.handle('settings:get', () => ({
  retina1x: config.retina1x,
  openAtLogin: app.getLoginItemSettings().openAtLogin,
  version: app.getVersion(),
  update: update?.version ?? null,
  hotkey: config.hotkey,
  pretty: prettyHotkey(),
  active: hotkeyActive,
  defaultHotkey: DEFAULT_HOTKEY,
  platform: process.platform,
  enterPastes: config.enterPastes,
}));

// Checkbox options in Settings. Returns the value actually applied.
ipcMain.handle('settings:setOption', async (_e, name: string, value: boolean) => {
  const on = value === true;
  if (name === 'openAtLogin') {
    app.setLoginItemSettings({ openAtLogin: on });
    return app.getLoginItemSettings().openAtLogin;
  }
  if (name !== 'enterPastes' && name !== 'retina1x') return false; // only known config keys
  config[name] = on;
  await saveConfig();
  return on;
});

// Links in the Settings footer.
ipcMain.on('settings:link', (_e, name: string) => {
  if (name === 'about') void shell.openExternal(REPO_URL);
  else if (name === 'issues') void shell.openExternal(`${REPO_URL}/issues/new`);
  else if (name === 'update') void showUpdate();
});

// ---------- update check ----------
/** true if version a is newer than b ("0.1.10" > "0.1.9"). */
function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

/** Ask GitHub for the latest release; on a newer one, add a tray item and notify once per version. */
async function checkForUpdate(): Promise<void> {
  try {
    const res = await net.fetch('https://api.github.com/repos/nguucode/shoreshot/releases/latest', {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return;
    const { tag_name: tag, html_url: url } = (await res.json()) as { tag_name: string; html_url: string };
    const version = tag.replace(/^v/, '');
    if (!isNewer(version, app.getVersion()) || update?.version === version) return;
    update = { version, url };
    refreshTray();
    if (Notification.isSupported()) {
      const n = new Notification({
        title: 'ShoreShot update available',
        body: `Version ${version} is out (you have ${app.getVersion()}). Click to update.`,
      });
      n.on('click', () => void showUpdate());
      n.show();
    }
  } catch {
    /* offline: try again on the next check */
  }
}

async function showUpdate(): Promise<void> {
  if (!update) return;
  const command = isMac
    ? 'curl -fsSL https://raw.githubusercontent.com/nguucode/shoreshot/main/scripts/install.sh | bash'
    : 'irm https://raw.githubusercontent.com/nguucode/shoreshot/main/scripts/install.ps1 | iex';
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: 'ShoreShot update',
    message: `ShoreShot ${update.version} is available`,
    detail: `You have ${app.getVersion()}. To update, run the install command again in ${isMac ? 'Terminal' : 'PowerShell'}:\n\n${command}\n\nYour settings and permissions are kept.`,
    buttons: ['Copy command', 'Open release page', 'Later'],
    defaultId: 0,
    cancelId: 2,
  });
  if (response === 0) clipboard.writeText(command);
  else if (response === 1) void shell.openExternal(update.url);
}

// While recording a new hotkey, unregister the current one so pressing it doesn't start a capture.
ipcMain.on('settings:recording', (_e, recording: boolean) => {
  if (recording) {
    if (hotkeyActive) globalShortcut.unregister(config.hotkey);
    hotkeyActive = false;
  } else if (!hotkeyActive) {
    hotkeyActive = registerHotkey(config.hotkey);
  }
});

ipcMain.handle('settings:setHotkey', async (_e, accel: string) => {
  const res = await setHotkey(accel);
  return res.ok ? { ...res, pretty: prettyHotkey(res.hotkey) } : res;
});

/**
 * macOS: without Screen Recording permission, ask for it instead of showing an error.
 * The first time, let macOS ask (its prompt has a button to open System Settings). macOS only
 * asks once, so after that the app shows its own dialog explaining how to turn it on.
 */
async function ensureMacPermission(): Promise<boolean> {
  if (!isMac || systemPreferences.getMediaAccessStatus('screen') === 'granted') return true;
  // Always request a capture first: that is what puts ShoreShot in the Screen Recording list
  // (after a reset or a signature change it isn't there), and macOS prompts again if it can.
  // Without permission this call fails: ignore it.
  await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).catch(() => undefined);
  if (!config.screenAsked) {
    config.screenAsked = true;
    await saveConfig();
    return false;
  }
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: 'ShoreShot needs Screen Recording permission',
    message: 'Allow ShoreShot to record the screen to take screenshots',
    detail:
      'Open System Settings > Privacy & Security > Screen & System Audio Recording and turn on ShoreShot. When macOS asks to reopen the app, choose "Quit & Reopen", then press the hotkey again.\n\nShoreShot is already on but capture still fails? Choose Reset permission and allow it again.',
    buttons: ['Open System Settings', 'Reset permission', 'Later'],
    defaultId: 0,
    cancelId: 2,
  });
  if (response === 0) {
    await shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    );
  } else if (response === 1) {
    // ShoreShot shows as allowed but capture still fails: macOS holds a grant for an older
    // signature. Drop it and let macOS ask again.
    await resetPermission('ScreenCapture');
    config.screenAsked = false;
    return ensureMacPermission();
  }
  return false;
}

/** Remove this app's macOS privacy grant so macOS asks again. Errors (e.g. in dev, other bundle id) are ignored. */
const resetPermission = (service: 'ScreenCapture' | 'Accessibility') =>
  run('tccutil', ['reset', service, BUNDLE_ID]).catch(() => undefined);

async function startCapture(): Promise<void> {
  if (overlayOpen) {
    overlay?.focus();
    return;
  }
  if (capturing) return;
  capturing = true;
  try {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const { width, height } = display.bounds;

    if (!(await ensureMacPermission())) return;

    let shot: Shot;
    try {
      shot = await grabNative(display);
    } catch {
      shot = await grabDesktopCapturer(display); // native module failed / no binary for this machine
    }
    if (shot.bitmap.length !== shot.pxW * shot.pxH * 4) {
      throw new Error(`bitmap ${shot.bitmap.length} B does not match ${shot.pxW}×${shot.pxH}`);
    }
    await showCapture(display, { ...shot, width, height, enterPastes: config.enterPastes, retina1x: config.retina1x });
  } catch (err) {
    // Permission was turned off mid-run: explain how to turn it back on instead of erroring.
    if (isMac && systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
      await ensureMacPermission();
      return;
    }
    dialog.showErrorBox('ShoreShot', `Capture failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    capturing = false;
  }
}

type Shot = Pick<CapturePayload, 'bitmap' | 'pxW' | 'pxH' | 'bgra'>;

/**
 * Capture just one display with node-screenshots (RGBA output). desktopCapturer renders every display
 * at full resolution even though one is used. Required at runtime: a missing binary falls back instead of crashing the app.
 */
async function grabNative(display: Display): Promise<Shot> {
  const { Monitor } = require('node-screenshots') as typeof import('node-screenshots');
  const { x, y, width, height } = display.bounds;
  // macOS: id equals Electron's CGDirectDisplayID. Windows: ids differ, so look up by the display's center (physical coordinates).
  const center = { x: Math.round(x + width / 2), y: Math.round(y + height / 2) };
  const p = isMac ? center : screen.dipToScreenPoint(center);
  const monitor = Monitor.all().find((m) => m.id() === display.id) ?? Monitor.fromPoint(p.x, p.y);
  if (!monitor) throw new Error('Display not found');
  const img = await monitor.captureImage();
  // Size mismatch = wrong display: let the fallback handle it.
  const sf = display.scaleFactor;
  if (Math.abs(img.width - width * sf) > 2 || Math.abs(img.height - height * sf) > 2) {
    throw new Error(`Image ${img.width}×${img.height} does not match the display`);
  }
  return { bitmap: await img.toRaw(true), pxW: img.width, pxH: img.height, bgra: false };
}

async function grabDesktopCapturer(display: Display): Promise<Shot> {
  const { width, height } = display.bounds;
  const sf = display.scaleFactor;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(width * sf), height: Math.round(height * sf) },
  });
  const allIds = screen.getAllDisplays().map((d) => d.id);
  const source =
    sources.find((s) => s.display_id === String(display.id)) ??
    sources[allIds.indexOf(display.id)] ??
    sources[0];
  if (!source || source.thumbnail.isEmpty()) throw new Error('Could not capture the screen.');
  const { width: pxW, height: pxH } = source.thumbnail.getSize();
  return { bitmap: source.thumbnail.toBitmap(), pxW, pxH, bgra: true };
}

function createOverlay(display: Display): BrowserWindow {
  const win = new BrowserWindow({
    ...display.bounds,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    enableLargerThanScreen: true,
    backgroundColor: '#000000',
    opacity: 0,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  if (isMac) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayScale = display.scaleFactor;
  win.webContents.on('render-process-gone', () => win.destroy()); // recreated on the next capture
  win.on('closed', () => {
    if (overlay !== win) return;
    overlay = null;
    overlayOpen = false;
  });
  void win.loadFile(path.join(__dirname, '../static/editor.html'));
  return win;
}

/**
 * Reuse the preloaded overlay. Show it at opacity 0 (so the renderer can paint), send the image,
 * and only make it visible once the renderer reports 'capture:ready': no flash of the previous capture.
 */
async function showCapture(display: Display, cap: CapturePayload): Promise<void> {
  // Windows: setBounds onto a display with another scale while hidden can size the window wrongly,
  // so on a scale change recreate the overlay on that display (costs only the first switch).
  if (overlay && !overlay.isDestroyed() && overlayScale !== display.scaleFactor) overlay.destroy();
  const win = overlay && !overlay.isDestroyed() ? overlay : (overlay = createOverlay(display));
  if (win.webContents.isLoading()) {
    const loaded = await new Promise<boolean>((r) => {
      win.webContents.once('did-finish-load', () => r(true));
      win.webContents.once('did-fail-load', () => r(false));
    });
    if (!loaded) {
      win.destroy(); // recreated next time
      throw new Error('Could not load the capture window.');
    }
  }
  overlayOpen = true;
  win.setOpacity(0);
  win.setBounds(display.bounds);
  showOverlay(win);
  win.webContents.send('capture:show', cap);
  clearTimeout(revealTimer);
  revealTimer = setTimeout(() => reveal(win), 1500); // show anyway if the renderer never answers
}

function reveal(win: BrowserWindow): void {
  clearTimeout(revealTimer);
  if (!win.isDestroyed()) win.setOpacity(1);
}

function showOverlay(win: BrowserWindow): void {
  if (win.isDestroyed() || win.isVisible()) return;
  win.show();
  win.setAlwaysOnTop(true, 'screen-saver'); // reapply after hide() for the Save dialog
  if (isMac) app.focus({ steal: true });
  win.focus();
}

/** Hide instead of close so the next capture skips window creation. The renderer frees the image on 'capture:hidden'. */
function hideOverlay(win: BrowserWindow | null): void {
  overlayOpen = false;
  if (!win || win.isDestroyed()) return;
  clearTimeout(revealTimer);
  win.setOpacity(0);
  win.hide();
  win.webContents.send('capture:hidden');
}

const toImage = (png: Uint8Array) => nativeImage.createFromBuffer(Buffer.from(png.buffer, png.byteOffset, png.byteLength));

ipcMain.on('capture:ready', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) reveal(win);
});

ipcMain.on('capture:close', (e) => hideOverlay(BrowserWindow.fromWebContents(e.sender)));

ipcMain.handle('capture:copy', (e, png: Uint8Array) => {
  clipboard.writeImage(toImage(png));
  hideOverlay(BrowserWindow.fromWebContents(e.sender));
  return true;
});

// Copy, then auto-paste (⌘V / Ctrl+V) into the app that was active before the capture.
ipcMain.handle('capture:copyPaste', async (e, png: Uint8Array) => {
  clipboard.writeImage(toImage(png));
  const win = BrowserWindow.fromWebContents(e.sender);

  if (isMac && !systemPreferences.isTrustedAccessibilityClient(false)) {
    hideOverlay(win);
    app.hide();
    systemPreferences.isTrustedAccessibilityClient(true); // shows the macOS permission prompt
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'ShoreShot',
      message: 'Image copied, but it could not be pasted automatically',
      detail:
        'To auto-paste, allow ShoreShot in System Settings > Privacy & Security > Accessibility, then reopen the app. For now, press ⌘V to paste.\n\nShoreShot is already on but pasting still fails? Choose Reset permission and allow it again.',
      buttons: ['OK', 'Reset permission'],
      defaultId: 0,
      cancelId: 0,
    });
    if (response === 1) {
      await resetPermission('Accessibility');
      systemPreferences.isTrustedAccessibilityClient(true);
    }
    return false;
  }

  hideOverlay(win);
  // Give focus back to the previous app. macOS: hide the app; Windows: hiding the overlay brings the previous window back.
  if (isMac) app.hide();
  await sleep(isMac ? 250 : 150);
  try {
    await sendPasteKeystroke();
    return true;
  } catch (err) {
    const { stderr, message } = err as { stderr?: string; message: string };
    dialog.showErrorBox(
      'ShoreShot',
      `Image copied, but auto-paste failed: ${(stderr || message).trim()}. Press ${isMac ? '⌘V' : 'Ctrl+V'} to paste.`,
    );
    return false;
  }
});

function sendPasteKeystroke(): Promise<unknown> {
  const opts = { windowsHide: true, timeout: 8000 };
  if (isMac) {
    return run('osascript', ['-e', 'tell application "System Events" to keystroke "v" using command down'], opts);
  }
  return run('powershell.exe', [ // Windows (the app only ships for mac + win)
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')",
  ], opts);
}

ipcMain.handle('capture:save', async (e, png: Uint8Array) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  // Hide the overlay so it doesn't cover the Save dialog.
  win?.hide();
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Save screenshot',
    defaultPath: path.join(app.getPath('pictures'), `Screenshot ${timestamp()}.png`),
    filters: [{ name: 'PNG', extensions: ['png'] }],
  });
  if (canceled || !filePath) {
    if (win) showOverlay(win);
    return false;
  }
  await fs.writeFile(filePath, png);
  hideOverlay(win);
  return true;
});

// sv-SE gives "YYYY-MM-DD HH:MM:SS"; swap ":" because Windows forbids it in file names.
const timestamp = () => new Date().toLocaleString('sv-SE').replace(/:/g, '.');
