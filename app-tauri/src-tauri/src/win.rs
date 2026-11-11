//! Windows side: the same functions as mac.rs (overlay, clipboard, paste, login item, dialogs), plus the
//! WebView2 shared buffer for the bitmap (`post_frame`) and the DPI scale (`scale`).
//!
//! Coordinates: the process is per-monitor DPI aware (v2, set by tao), so xcap monitors and windows and the
//! cursor are physical pixels in virtual-screen space. The page works in CSS px = physical / the scale of
//! the monitor being captured. Everything is clipped to that one monitor, which is what Electron's
//! `dipToScreenPoint` / `screenToDipRect` reduce to.
//!
//! No permissions on Windows: `screen_access` and `accessibility` are always true. Dialogs are unowned and
//! run their own message loop on the calling worker thread; on Windows they never block the overlay (the
//! spike showed the hotkey, the overlay and Esc all working over an open MessageBox).
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Environment12, ICoreWebView2Settings3, ICoreWebView2Settings5, ICoreWebView2SharedBuffer,
    ICoreWebView2_17, COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_WRITE,
};
use windows_core::Interface as _;
use windows_sys::Win32::Foundation::{GlobalFree, POINT};
use windows_sys::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
};
use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};

type Rect = (f64, f64, f64, f64);

pub const BUNDLE_ID: &str = "biz.ontheshore.shoreshot";

pub fn home() -> PathBuf {
    PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default())
}

/// Same folders as Electron's app.getPath('logs') / ('userData'), so capture.log and config.json carry over.
pub fn log_dir() -> PathBuf {
    config_dir().join("logs")
}
pub fn config_dir() -> PathBuf {
    PathBuf::from(std::env::var("APPDATA").unwrap_or_default()).join("ShoreShot")
}

// ---------- screen ----------
pub fn screen_access() -> bool {
    true
}
pub fn request_screen_access() {}

/// Physical pixels, virtual-screen coordinates (same space as xcap).
pub fn cursor() -> (f64, f64) {
    let mut p = POINT { x: 0, y: 0 };
    unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos(&mut p) };
    (p.x as f64, p.y as f64)
}

/// Physical px per CSS px on this monitor (1.0, 1.25, 1.5, 2.0…).
pub fn scale(mon: &xcap::Monitor) -> f64 {
    mon.scale_factor().map(f64::from).ok().filter(|k| *k > 0.0).unwrap_or(1.0)
}

// ---------- overlay ----------
/// Where the overlay goes on reveal (physical px), set by show_hidden.
static FRAME: Mutex<Rect> = Mutex::new((0.0, 0.0, 0.0, 0.0));

/// An always-on-top WebView2 window, created hidden up front so the hotkey only has to show it.
pub fn create_overlay(app: &AppHandle) -> tauri::Result<()> {
    let win = tauri::WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("editor.html".into()))
        .visible(false)
        .decorations(false)
        .resizable(false)
        .shadow(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .build()?;
    // WebView2's browser shortcuts don't belong in an overlay: Ctrl+P (a print dialog over the overlay),
    // Ctrl+F, F5 (reload drops the capture), Ctrl+wheel / pinch zoom (the editor uses the wheel for sizes),
    // the right-click menu. Electron without a menu has none of these.
    win.with_webview(|wv| unsafe {
        let Ok(core) = wv.controller().CoreWebView2() else { return };
        let Ok(settings) = core.Settings() else { return };
        let _ = settings.SetIsZoomControlEnabled(false);
        let _ = settings.SetAreDefaultContextMenusEnabled(false);
        let _ = settings.SetIsStatusBarEnabled(false);
        if let Ok(s3) = settings.cast::<ICoreWebView2Settings3>() {
            let _ = s3.SetAreBrowserAcceleratorKeysEnabled(false);
        }
        if let Ok(s5) = settings.cast::<ICoreWebView2Settings5>() {
            let _ = s5.SetIsPinchZoomEnabled(false);
        }
    })?;
    if std::env::var_os("SHORESHOT_TEST_MODAL").is_some() {
        test_modal(app.clone());
    }
    Ok(())
}

// shortcut: off-screen instead of Electron's opacity 0. WebView2 does not render into layered
// (WS_EX_LAYERED) windows, and a hidden WebView2 pauses requestAnimationFrame, so the overlay is shown far
// off-screen (it paints there) and moved onto the monitor in reveal().
const OFF: i32 = -32000;

/// Show the overlay where nobody can see it, at the monitor's physical size, so the page can paint.
pub fn show_hidden(app: &AppHandle, frame: Rect) {
    *FRAME.lock().unwrap() = frame;
    let Some(win) = app.get_webview_window("overlay") else { return };
    let _ = win.set_position(PhysicalPosition::new(OFF, OFF));
    let _ = win.set_size(PhysicalSize::new(frame.2 as u32, frame.3 as u32));
    let _ = win.show();
}

/// Move the painted overlay onto the monitor and give it the keyboard.
pub fn reveal(app: &AppHandle) {
    let Some(win) = app.get_webview_window("overlay") else { return };
    let (x, y, w, h) = *FRAME.lock().unwrap();
    let _ = win.set_position(PhysicalPosition::new(x as i32, y as i32));
    // Mixed DPI: crossing onto a monitor with another scale sends WM_DPICHANGED and tao rescales the window
    // to keep its logical size (Electron's "setBounds onto a display with another scale" bug). Setting the
    // physical size again after the move pins it; the page re-lays out in CSS px.
    // shortcut: the first capture after a scale change can show the rescaled size for a frame; per-scale
    // overlays (Electron recreates one) if that is ever visible on a real mixed-DPI desktop.
    let _ = win.set_size(PhysicalSize::new(w as u32, h as u32));
    let _ = win.set_always_on_top(true);
    let _ = win.set_focus(); // allowed: the process just received the hotkey or the tray click
}

/// Visible again (Save dialog cancelled) or brought forward (hotkey while open).
pub fn focus_overlay(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.show();
    }
    reveal(app);
}

pub fn hide_overlay(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.hide();
    }
    release_frame(); // the page released its view right after painting
}

thread_local! {
    /// The frame the page is showing. Main thread only (COM object); closed on the next frame or on hide.
    static SHARED: std::cell::RefCell<Option<ICoreWebView2SharedBuffer>> = const { std::cell::RefCell::new(None) };
}

/// Why a frame went over IPC instead: the pixels and metadata come back so the caller can send them.
pub type NotPosted = (Vec<u8>, serde_json::Value, String);

/// Hand the frame to the page through a WebView2 shared buffer: one memcpy, no IPC copy (a 4K frame takes
/// ~20 ms instead of ~320 ms over Tauri IPC). `meta` arrives as the event's additionalData; the page listens
/// for `chrome.webview` 'sharedbufferreceived'. Runs on the main thread via `with_webview`; `done` gets
/// `Err` with the frame back if it could not be posted, so the caller sends it over IPC instead.
pub fn post_frame(
    app: &AppHandle,
    rgba: Vec<u8>,
    meta: serde_json::Value,
    done: impl FnOnce(Result<(), NotPosted>) + Send + 'static,
) {
    let Some(win) = app.get_webview_window("overlay") else {
        return done(Err((rgba, meta, "no overlay window".into())));
    };
    // with_webview only fails when the window is gone; then there is nothing to show the frame in either.
    let _ = win.with_webview(move |wv| {
        let r = unsafe {
            (|| -> windows_core::Result<()> {
                let env: ICoreWebView2Environment12 = wv.environment().cast()?;
                let core: ICoreWebView2_17 = wv.controller().CoreWebView2()?.cast()?;
                let buf = env.CreateSharedBuffer(rgba.len() as u64)?;
                let mut ptr = std::ptr::null_mut();
                buf.Buffer(&mut ptr)?;
                std::ptr::copy_nonoverlapping(rgba.as_ptr(), ptr, rgba.len());
                let json = windows_core::HSTRING::from(meta.to_string());
                core.PostSharedBufferToScript(&buf, COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_WRITE, &json)?;
                if let Some(old) = SHARED.with(|f| f.replace(Some(buf))) {
                    let _ = old.Close();
                }
                Ok(())
            })()
        };
        done(r.map_err(|e| (rgba, meta, format!("shared buffer: {e}"))));
    });
}

fn release_frame() {
    if let Some(buf) = SHARED.with(|f| f.take()) {
        let _ = unsafe { buf.Close() };
    }
}

// ---------- clipboard ----------
/// "PNG" (the bytes as they are, no re-encode) plus CF_DIB for apps that only take bitmaps; Windows
/// synthesizes CF_BITMAP and CF_DIBV5 from it. Main thread.
pub fn clipboard_image(png: &[u8]) {
    let Ok(img) = image::load_from_memory_with_format(png, image::ImageFormat::Png) else { return };
    let img = img.to_rgba8();
    let dib = dib_from_rgba(img.width(), img.height(), img.as_raw());
    let png_format = unsafe { RegisterClipboardFormatW(wide("PNG").as_ptr()) };
    set_clipboard(&[(png_format, png), (CF_DIB, &dib)]);
}

pub fn clipboard_text(text: &str) {
    let utf16: Vec<u8> = wide(text).iter().flat_map(|c| c.to_le_bytes()).collect();
    set_clipboard(&[(CF_UNICODETEXT, &utf16)]);
}

const CF_DIB: u32 = 8;
const CF_UNICODETEXT: u32 = 13;

fn set_clipboard(items: &[(u32, &[u8])]) -> bool {
    unsafe {
        // Another app may hold the clipboard for a moment (clipboard managers): retry briefly.
        if !(0..10).any(|i| {
            if i > 0 {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            OpenClipboard(std::ptr::null_mut()) != 0
        }) {
            return false;
        }
        let mut ok = EmptyClipboard() != 0;
        for &(format, bytes) in items {
            let h = GlobalAlloc(GMEM_MOVEABLE, bytes.len());
            let p = if h.is_null() { std::ptr::null_mut() } else { GlobalLock(h) as *mut u8 };
            if p.is_null() {
                ok = false;
                continue;
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), p, bytes.len());
            GlobalUnlock(h);
            if SetClipboardData(format, h).is_null() {
                GlobalFree(h); // still ours: the clipboard only owns it on success
                ok = false;
            }
        }
        CloseClipboard();
        ok
    }
}

/// BITMAPINFOHEADER + bottom-up 32-bit BGRA rows (BI_RGB), the plain CF_DIB layout.
fn dib_from_rgba(w: u32, h: u32, rgba: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(40 + rgba.len());
    for v in [40u32, w, h] {
        out.extend_from_slice(&v.to_le_bytes()); // biSize, biWidth, biHeight (positive = bottom-up)
    }
    out.extend_from_slice(&1u16.to_le_bytes()); // biPlanes
    out.extend_from_slice(&32u16.to_le_bytes()); // biBitCount
    out.extend_from_slice(&0u32.to_le_bytes()); // biCompression = BI_RGB
    out.extend_from_slice(&(rgba.len() as u32).to_le_bytes()); // biSizeImage
    out.extend_from_slice(&[0u8; 16]); // resolution, colour table: unused
    for line in rgba.chunks_exact(w as usize * 4).rev() {
        for p in line.chunks_exact(4) {
            out.extend_from_slice(&[p[2], p[1], p[0], p[3]]);
        }
    }
    out
}

// ---------- paste ----------
pub fn accessibility(_prompt: bool) -> bool {
    true
}
pub fn reset_permission(_service: &str) {}

/// Ctrl+V into whatever window is in front (hiding the overlay hands the foreground back). The editor only
/// asks once Ctrl/Shift/Alt are released. In-process SendInput instead of Electron's PowerShell SendKeys:
/// the same keystroke without a ~0.5 s process start.
pub fn paste_keystroke() -> Result<(), String> {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_CONTROL,
    };
    const VK_V: u16 = 0x56;
    let key = |vk: u16, up: bool| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT { wVk: vk, wScan: 0, dwFlags: if up { KEYEVENTF_KEYUP } else { 0 }, time: 0, dwExtraInfo: 0 },
        },
    };
    let inputs = [key(VK_CONTROL, false), key(VK_V, false), key(VK_V, true), key(VK_CONTROL, true)];
    let sent = unsafe { SendInput(inputs.len() as u32, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32) };
    // Fewer sent = blocked by UIPI: the target runs as administrator and ShoreShot does not.
    if sent as usize == inputs.len() {
        Ok(())
    } else {
        Err("Windows blocked the keystroke (is that app running as administrator?)".into())
    }
}

// ---------- login item ----------
// HKCU\...\Run, the key Electron's setLoginItemSettings writes. Electron names the value after the app's
// AppUserModelId, which electron-builder sets to the appId, so an existing setting carries over.
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

pub fn open_at_login() -> bool {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};
    let mut len = 0u32;
    unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            wide(RUN_KEY).as_ptr(),
            wide(BUNDLE_ID).as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut len,
        ) == 0
    }
}

pub fn set_open_at_login(on: bool) -> bool {
    use windows_sys::Win32::System::Registry::{RegDeleteKeyValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ};
    unsafe {
        if on {
            let exe = std::env::current_exe().map(|p| format!("\"{}\"", p.display())).unwrap_or_default();
            let data = wide(&exe);
            RegSetKeyValueW(
                HKEY_CURRENT_USER,
                wide(RUN_KEY).as_ptr(),
                wide(BUNDLE_ID).as_ptr(),
                REG_SZ,
                data.as_ptr().cast(),
                (data.len() * 2) as u32,
            );
        } else {
            RegDeleteKeyValueW(HKEY_CURRENT_USER, wide(RUN_KEY).as_ptr(), wide(BUNDLE_ID).as_ptr());
        }
    }
    open_at_login()
}

// ---------- dialogs ----------
/// Message box with custom buttons (a Task Dialog, like Electron's showMessageBox on Windows). Unowned, on
/// the calling worker thread. Returns the index of the clicked button (the first is the default; `cancel`
/// also answers Esc and the close box).
pub fn dialog(_app: &AppHandle, message: &str, detail: &str, buttons: &[&str], cancel: usize) -> usize {
    task_dialog(message, detail, buttons, cancel).unwrap_or(cancel)
}

/// TaskDialogIndirect is only in comctl32 v6 (tauri-build's manifest asks for it). Looked up at run time so a
/// binary without that manifest (the unit tests) still loads; then this falls back to a plain MessageBox.
fn task_dialog(message: &str, detail: &str, buttons: &[&str], cancel: usize) -> Option<usize> {
    use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
    use windows_sys::Win32::UI::Controls::{
        TASKDIALOGCONFIG, TASKDIALOG_BUTTON, TDF_ALLOW_DIALOG_CANCELLATION,
    };
    type TaskDialogIndirect =
        unsafe extern "system" fn(*const TASKDIALOGCONFIG, *mut i32, *mut i32, *mut i32) -> windows_sys::core::HRESULT;
    const IDCANCEL: i32 = 2;
    const BASE: i32 = 100; // button ids: BASE + index

    let f = unsafe {
        let lib = LoadLibraryW(wide("comctl32.dll").as_ptr());
        if lib.is_null() {
            None
        } else {
            GetProcAddress(lib, c"TaskDialogIndirect".as_ptr().cast())
        }
    };
    let Some(f) = f else {
        message_box("ShoreShot", &format!("{message}\n\n{detail}"));
        return None;
    };
    let f: TaskDialogIndirect = unsafe { std::mem::transmute(f) };
    let title = wide("ShoreShot");
    let (main, content) = (wide(message), wide(detail));
    let labels: Vec<Vec<u16>> = buttons.iter().map(|b| wide(b)).collect();
    let btns: Vec<TASKDIALOG_BUTTON> = labels
        .iter()
        .enumerate()
        .map(|(i, l)| TASKDIALOG_BUTTON { nButtonID: BASE + i as i32, pszButtonText: l.as_ptr() })
        .collect();
    let mut cfg: TASKDIALOGCONFIG = unsafe { std::mem::zeroed() };
    cfg.cbSize = std::mem::size_of::<TASKDIALOGCONFIG>() as u32;
    cfg.dwFlags = TDF_ALLOW_DIALOG_CANCELLATION;
    cfg.pszWindowTitle = title.as_ptr();
    cfg.pszMainInstruction = main.as_ptr();
    cfg.pszContent = content.as_ptr();
    cfg.cButtons = btns.len() as u32;
    cfg.pButtons = btns.as_ptr();
    cfg.nDefaultButton = BASE;
    let mut clicked = 0i32;
    let hr = unsafe { f(&cfg, &mut clicked, std::ptr::null_mut(), std::ptr::null_mut()) };
    if hr < 0 {
        return None;
    }
    Some(if clicked == IDCANCEL { cancel } else { (clicked - BASE).clamp(0, buttons.len() as i32 - 1) as usize })
}

fn message_box(title: &str, text: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_OK, MB_TOPMOST};
    unsafe { MessageBoxW(std::ptr::null_mut(), wide(text).as_ptr(), wide(title).as_ptr(), MB_OK | MB_TOPMOST) };
}

/// Save dialog in Pictures, unowned, on the calling worker thread. None = cancelled.
pub fn save_dialog(_app: &AppHandle, default_name: &str) -> Option<PathBuf> {
    use windows_sys::Win32::UI::Controls::Dialogs::{
        GetSaveFileNameW, OFN_EXPLORER, OFN_NOCHANGEDIR, OFN_OVERWRITEPROMPT, OFN_PATHMUSTEXIST, OPENFILENAMEW,
    };
    let mut file = [0u16; 1024];
    let name = wide(default_name);
    file[..name.len().min(1023)].copy_from_slice(&name[..name.len().min(1023)]);
    let dir = wide(&home().join("Pictures").to_string_lossy());
    let filter: Vec<u16> = "PNG\0*.png\0\0".encode_utf16().collect();
    let (title, ext) = (wide("Save screenshot"), wide("png"));
    let mut ofn: OPENFILENAMEW = unsafe { std::mem::zeroed() };
    ofn.lStructSize = std::mem::size_of::<OPENFILENAMEW>() as u32;
    ofn.lpstrFilter = filter.as_ptr();
    ofn.lpstrFile = file.as_mut_ptr();
    ofn.nMaxFile = file.len() as u32;
    ofn.lpstrInitialDir = dir.as_ptr();
    ofn.lpstrTitle = title.as_ptr();
    ofn.lpstrDefExt = ext.as_ptr(); // ".png" added when the name has no extension
    ofn.Flags = OFN_EXPLORER | OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR;
    if unsafe { GetSaveFileNameW(&mut ofn) } == 0 {
        return None;
    }
    let end = file.iter().position(|&c| c == 0).unwrap_or(file.len());
    let mut path = PathBuf::from(String::from_utf16_lossy(&file[..end]));
    if path.extension().map_or(true, |e| !e.eq_ignore_ascii_case("png")) {
        path.as_mut_os_string().push(".png");
    }
    Some(path)
}

/// "YYYY-MM-DD HH.MM.SS" in local time, like Electron's Save default name.
pub fn timestamp() -> String {
    let mut t: windows_sys::Win32::Foundation::SYSTEMTIME = unsafe { std::mem::zeroed() };
    unsafe { windows_sys::Win32::System::SystemInformation::GetLocalTime(&mut t) };
    format!("{:04}-{:02}-{:02} {:02}.{:02}.{:02}", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond)
}

pub fn open_url(url: &str) {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            wide("open").as_ptr(),
            wide(url).as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
}

/// CI only (SHORESHOT_TEST_MODAL=1): an unowned MessageBox on the main thread 3 s after start, the setup that
/// froze macOS v1.0.0. The harness then presses the hotkey and Esc and checks the dialog survives.
fn test_modal(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(3));
        let _ = app.run_on_main_thread(|| {
            message_box("ShoreShot modal test", "The capture hotkey must still work and Esc must close the overlay.")
        });
    });
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dib_is_bottom_up_bgra() {
        let dib = dib_from_rgba(1, 2, &[1, 2, 3, 4, /* row 2 */ 5, 6, 7, 8]);
        assert_eq!(dib.len(), 40 + 8);
        assert_eq!(&dib[40..], &[7, 6, 5, 8, 3, 2, 1, 4]);
    }

    #[test]
    fn timestamp_is_file_name_safe() {
        let t = timestamp();
        assert_eq!(t.len(), 19);
        assert!(!t.contains(':'));
    }
}
