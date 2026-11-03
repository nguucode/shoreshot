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
  Display,
} from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { setTimeout as sleep } from 'timers/promises';

const run = promisify(execFile);

const DEFAULT_HOTKEY = 'CommandOrControl+Shift+X';
const isMac = process.platform === 'darwin';

interface CapturePayload {
  dataURL: string; // ảnh full độ phân giải thật (physical px)
  width: number; // kích thước màn hình theo CSS px (DIP)
  height: number;
}

interface Config {
  hotkey: string;
  /** true: Enter / nút ✓ sẽ copy rồi tự dán vào app trước đó. */
  enterPastes: boolean;
}

let tray: Tray | null = null;
let overlay: BrowserWindow | null = null;
let settingsWin: BrowserWindow | null = null;
let capturing = false;
let config: Config = { hotkey: DEFAULT_HOTKEY, enterPastes: false };
let hotkeyActive = false; // phím tắt hiện có đang đăng ký thành công không
let payload: CapturePayload | null = null; // ảnh của overlay đang mở (chỉ có 1 overlay)

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.whenReady().then(async () => {
  if (isMac) app.dock?.hide();
  config = await loadConfig();
  hotkeyActive = registerHotkey(config.hotkey);
  createTray();
  if (!hotkeyActive) {
    // Phím tắt đã lưu bị app khác chiếm: mở Cài đặt để người dùng chọn phím khác.
    openSettings();
  }
});

// Giữ app chạy nền khi đóng overlay / cài đặt.
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
    };
  } catch {
    return { hotkey: DEFAULT_HOTKEY, enterPastes: false };
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
    return false; // accelerator sai cú pháp
  }
}

type SetHotkeyResult = { ok: true; hotkey: string } | { ok: false; error: string };

async function setHotkey(accel: string): Promise<SetHotkeyResult> {
  const old = config.hotkey;
  if (accel === old && hotkeyActive) return { ok: true, hotkey: old };
  // Chỉ gỡ khi đang đăng ký: phím trong config sửa tay có thể sai cú pháp, unregister sẽ throw.
  if (hotkeyActive) globalShortcut.unregister(old);
  if (!registerHotkey(accel)) {
    hotkeyActive = registerHotkey(old); // trả lại phím cũ
    return {
      ok: false,
      error: `${prettyHotkey(accel)} đang bị hệ thống hoặc app khác dùng. Chọn tổ hợp khác.`,
    };
  }
  hotkeyActive = true;
  config.hotkey = accel;
  await saveConfig();
  refreshTray();
  return { ok: true, hotkey: accel };
}

/** Hiển thị accelerator theo kiểu từng OS: ⌘⇧X trên Mac, Ctrl+Shift+X trên Windows. */
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
  // Windows: click trái vào icon khay là chụp luôn.
  if (!isMac) tray.on('click', () => void startCapture());
}

function refreshTray(): void {
  if (!tray) return;
  const keyLabel = hotkeyActive ? prettyHotkey() : 'chưa gán';
  tray.setToolTip(`ShoreShot (${keyLabel})`);
  const login = app.getLoginItemSettings().openAtLogin;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Chụp màn hình    ${keyLabel}`, click: () => void startCapture() },
      { label: 'Đổi phím tắt…', click: () => openSettings() },
      { type: 'separator' },
      {
        label: 'Khởi động cùng máy',
        type: 'checkbox',
        checked: login,
        click: (item) => {
          app.setLoginItemSettings({ openAtLogin: item.checked });
          refreshTray();
        },
      },
      { type: 'separator' },
      { label: 'Thoát ShoreShot', role: 'quit' },
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
    height: 260,
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'ShoreShot · Cài đặt',
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
    // Lỡ đóng cửa sổ khi đang ghi phím: đăng ký lại phím hiện tại.
    if (!hotkeyActive) hotkeyActive = registerHotkey(config.hotkey);
    refreshTray();
  });
  void win.loadFile(path.join(__dirname, '../static/settings.html'));
}

ipcMain.handle('settings:get', () => ({
  hotkey: config.hotkey,
  pretty: prettyHotkey(),
  active: hotkeyActive,
  defaultHotkey: DEFAULT_HOTKEY,
  platform: process.platform,
  enterPastes: config.enterPastes,
}));

ipcMain.handle('settings:setEnterPastes', async (_e, value: boolean) => {
  config.enterPastes = value === true;
  await saveConfig();
  return config.enterPastes;
});

// Khi đang ghi phím mới, tạm gỡ phím hiện tại để bấm lại chính nó không kích hoạt chụp.
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

async function ensureMacPermission(): Promise<boolean> {
  if (!isMac) return true;
  const status = systemPreferences.getMediaAccessStatus('screen');
  if (status === 'granted') return true;
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: 'ShoreShot cần quyền ghi màn hình',
    message: 'Chưa có quyền Screen Recording',
    detail:
      'Vào System Settings > Privacy & Security > Screen & System Audio Recording, bật ShoreShot, rồi mở lại app.',
    buttons: ['Mở System Settings', 'Để sau'],
    defaultId: 0,
  });
  if (response === 0) {
    await shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    );
  }
  return false;
}

async function startCapture(): Promise<void> {
  if (overlay) {
    overlay.focus();
    return;
  }
  if (capturing) return;
  capturing = true;
  try {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const { width, height } = display.bounds;
    const sf = display.scaleFactor;

    // Gọi getSources trước: trên macOS lần đầu sẽ bật hộp thoại xin quyền của hệ thống.
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(width * sf), height: Math.round(height * sf) },
    });
    if (!(await ensureMacPermission())) return;

    const allIds = screen.getAllDisplays().map((d) => d.id);
    const source =
      sources.find((s) => s.display_id === String(display.id)) ??
      sources[allIds.indexOf(display.id)] ??
      sources[0];
    if (!source || source.thumbnail.isEmpty()) {
      dialog.showErrorBox('ShoreShot', 'Không chụp được màn hình.');
      return;
    }
    openOverlay(display, { dataURL: source.thumbnail.toDataURL(), width, height });
  } catch (err) {
    dialog.showErrorBox('ShoreShot', `Lỗi khi chụp: ${(err as Error).message}`);
  } finally {
    capturing = false;
  }
}

function openOverlay(display: Display, p: CapturePayload): void {
  const { x, y, width, height } = display.bounds;
  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  overlay = win;
  payload = p;

  win.setAlwaysOnTop(true, 'screen-saver');
  if (isMac) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setBounds(display.bounds);

  // Chỉ hiện cửa sổ khi renderer đã vẽ xong ảnh để không bị chớp đen.
  const fallback = setTimeout(() => showOverlay(win), 1500);
  win.once('closed', () => {
    clearTimeout(fallback);
    if (overlay === win) {
      overlay = null;
      payload = null;
    }
  });
  void win.loadFile(path.join(__dirname, '../static/editor.html'));
}

function showOverlay(win: BrowserWindow): void {
  if (win.isDestroyed() || win.isVisible()) return;
  win.show();
  win.setAlwaysOnTop(true, 'screen-saver'); // đặt lại sau khi bị hide() lúc mở hộp thoại Save
  if (isMac) app.focus({ steal: true });
  win.focus();
}

ipcMain.handle('capture:get', () => (payload ? { ...payload, enterPastes: config.enterPastes } : null));

ipcMain.on('capture:ready', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) showOverlay(win);
});

ipcMain.on('capture:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close());

ipcMain.handle('capture:copy', (e, dataURL: string) => {
  clipboard.writeImage(nativeImage.createFromDataURL(dataURL));
  BrowserWindow.fromWebContents(e.sender)?.close();
  return true;
});

// Copy rồi tự dán (⌘V / Ctrl+V) vào app đang dùng trước khi chụp.
ipcMain.handle('capture:copyPaste', async (e, dataURL: string) => {
  clipboard.writeImage(nativeImage.createFromDataURL(dataURL));
  const win = BrowserWindow.fromWebContents(e.sender);

  if (isMac && !systemPreferences.isTrustedAccessibilityClient(false)) {
    win?.close();
    app.hide();
    systemPreferences.isTrustedAccessibilityClient(true); // bật hộp thoại xin quyền của macOS
    await dialog.showMessageBox({
      type: 'info',
      title: 'ShoreShot',
      message: 'Ảnh đã được copy, nhưng chưa tự dán được',
      detail:
        'Để tự dán, cấp quyền cho ShoreShot ở System Settings > Privacy & Security > Accessibility, rồi mở lại app. Lần này sếp bấm ⌘V để dán.',
    });
    return false;
  }

  win?.close();
  // Trả focus về app trước đó. macOS: ẩn app; Windows: đóng overlay là cửa sổ trước tự lên lại.
  if (isMac) app.hide();
  await sleep(isMac ? 250 : 150);
  try {
    await sendPasteKeystroke();
    return true;
  } catch (err) {
    const { stderr, message } = err as { stderr?: string; message: string };
    dialog.showErrorBox(
      'ShoreShot',
      `Ảnh đã copy nhưng không tự dán được: ${(stderr || message).trim()}. Bấm ${isMac ? '⌘V' : 'Ctrl+V'} để dán.`,
    );
    return false;
  }
});

function sendPasteKeystroke(): Promise<unknown> {
  const opts = { windowsHide: true, timeout: 8000 };
  if (isMac) {
    return run('osascript', ['-e', 'tell application "System Events" to keystroke "v" using command down'], opts);
  }
  return run('powershell.exe', [ // Windows (app chỉ build cho mac + win)
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')",
  ], opts);
}

ipcMain.handle('capture:save', async (e, dataURL: string) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  // Ẩn overlay để hộp thoại Save không bị che.
  win?.hide();
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Lưu ảnh chụp',
    defaultPath: path.join(app.getPath('pictures'), `Screenshot ${timestamp()}.png`),
    filters: [{ name: 'PNG', extensions: ['png'] }],
  });
  if (canceled || !filePath) {
    if (win) showOverlay(win);
    return false;
  }
  const base64 = dataURL.replace(/^data:image\/png;base64,/, '');
  await fs.writeFile(filePath, Buffer.from(base64, 'base64'));
  win?.close();
  return true;
});

// sv-SE cho dạng "YYYY-MM-DD HH:MM:SS"; đổi ":" vì Windows cấm trong tên file.
const timestamp = () => new Date().toLocaleString('sv-SE').replace(/:/g, '.');
