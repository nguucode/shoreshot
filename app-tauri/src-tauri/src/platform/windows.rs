//! Windows half of the platform layer. Same functions as `macos.rs`; the shared capture flow in main.rs
//! calls them and never touches Win32 itself.
//!
//! Coordinates: the process is per-monitor DPI aware (v2, set by tao), so xcap monitors, xcap windows and
//! `AppHandle::cursor_position()` are all physical pixels in virtual-screen space. The page works in CSS
//! px: CSS = physical / the monitor's scale factor. Only the target monitor's scale is ever used, which
//! is what Electron's `dipToScreenPoint` / `screenToDipRect` reduce to once everything is clipped to one
//! display.
use std::path::PathBuf;

use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Environment12, ICoreWebView2Settings3, ICoreWebView2Settings5, ICoreWebView2SharedBuffer,
    ICoreWebView2_17, COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_WRITE,
};
use windows_core::Interface as _;

/// x, y, width, height of the target monitor, physical pixels.
pub type Frame = (i32, i32, u32, u32);

/// A window frame in CSS px relative to the captured display (`ShoreShotBox` in the renderer).
#[derive(serde::Serialize, Clone, Copy, Debug, PartialEq)]
pub struct WinBox {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Same folder as Electron's `app.getPath('logs')`, so existing tooling keeps finding capture.log.
pub fn log_dir() -> PathBuf {
    PathBuf::from(std::env::var("APPDATA").unwrap_or_default()).join("ShoreShot").join("logs")
}

/// No screen capture permission on Windows.
pub fn has_permission() -> bool {
    true
}

/// Physical pixels, virtual-screen coordinates (same space as xcap).
pub fn cursor(app: &AppHandle) -> (f64, f64) {
    app.cursor_position().map(|p| (p.x, p.y)).unwrap_or((0.0, 0.0))
}

/// CSS px per physical pixel divisor for this monitor (1.0, 1.25, 1.5, 2.0…).
pub fn scale(mon: &xcap::Monitor) -> f64 {
    mon.scale_factor().map(f64::from).ok().filter(|k| *k > 0.0).unwrap_or(1.0)
}

/// Creates the hidden overlay window ("overlay") once, at startup, so the hotkey only has to show it.
pub fn setup(app: &mut tauri::App, url: WebviewUrl) -> tauri::Result<()> {
    let win = tauri::WebviewWindowBuilder::new(app, "overlay", url)
        .visible(false)
        .decorations(false)
        .resizable(false)
        .shadow(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .build()?;
    // WebView2's browser shortcuts don't belong in an overlay: Ctrl+P (print dialog over the overlay),
    // Ctrl+F, F5 (reload drops the capture), Ctrl+wheel / pinch zoom (the editor uses the wheel for sizes),
    // and the right-click menu. Electron without a menu has none of these.
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
        test_modal(app.handle().clone());
    }
    Ok(())
}

// ponytail: off-screen instead of Electron's opacity 0. WebView2 does not render into layered
// (WS_EX_LAYERED) windows, and a hidden WebView2 pauses requestAnimationFrame, so the overlay is shown far
// off-screen (it paints there) and moved onto the monitor in reveal().
const OFF: i32 = -32000;

/// Show the overlay where nobody can see it, at the target monitor's physical size, so the page can paint.
pub fn show_hidden(app: &AppHandle, (_, _, w, h): Frame) {
    let Some(win) = app.get_webview_window("overlay") else { return };
    let _ = win.set_position(PhysicalPosition::new(OFF, OFF));
    let _ = win.set_size(PhysicalSize::new(w, h));
    let _ = win.show();
}

/// Move the painted overlay onto the monitor and give it the keyboard.
pub fn reveal(app: &AppHandle, (x, y, w, h): Frame) {
    let Some(win) = app.get_webview_window("overlay") else { return };
    let _ = win.set_position(PhysicalPosition::new(x, y));
    // Mixed DPI: crossing onto a monitor with another scale sends WM_DPICHANGED, and tao then rescales the
    // window to keep its logical size (Electron's "setBounds onto a display with another scale" bug).
    // Setting the physical size again after the move pins it to the monitor; the page re-lays out in CSS px.
    // ponytail: on the first capture after a scale change the rescaled size can show for one frame;
    // per-scale overlays (Electron recreates one) if that flash is ever visible on a real desktop.
    let _ = win.set_size(PhysicalSize::new(w, h));
    let _ = win.set_always_on_top(true);
    let _ = win.set_focus(); // allowed: the process just received the hotkey or the tray click
}

pub fn hide(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.hide();
    }
    release_frame();
}

thread_local! {
    /// The frame the page is showing. Main thread only (COM object); closed on the next frame or on hide.
    static FRAME: std::cell::RefCell<Option<ICoreWebView2SharedBuffer>> = const { std::cell::RefCell::new(None) };
}

/// Why a frame went over IPC instead: the pixels and metadata come back so the caller can send them.
pub type NotPosted = (Vec<u8>, serde_json::Value, String);

/// Hand the frame to the page through a WebView2 shared buffer: one memcpy here, no IPC copy (a 4K frame
/// takes ~20 ms instead of ~320 ms over Tauri IPC). `meta` arrives as the event's additionalData; the page
/// listens for `chrome.webview` 'sharedbufferreceived'. Runs on the main thread via `with_webview`;
/// `done` gets `Err` with the frame back if the buffer could not be posted, so the caller falls back to IPC.
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
                if let Some(old) = FRAME.with(|f| f.replace(Some(buf))) {
                    let _ = old.Close();
                }
                Ok(())
            })()
        };
        done(r.map_err(|e| (rgba, meta, format!("shared buffer: {e}"))));
    });
}

/// Unmap the last frame (the page released its view right after painting).
pub fn release_frame() {
    if let Some(buf) = FRAME.with(|f| f.take()) {
        let _ = unsafe { buf.Close() };
    }
}

/// Windows on the monitor, front to back, in CSS px relative to it. Skips minimized windows, slivers and
/// windows covering the whole monitor (the desktop, a maximized-and-fullscreen app), so clicking empty
/// desktop still means the whole screen. xcap already skips our own windows, invisible and cloaked ones,
/// and uses the DWM frame (no invisible resize border). List it after the overlay is visible.
pub fn list_windows(mon: &xcap::Monitor) -> Vec<WinBox> {
    let (Ok(mx), Ok(my), Ok(mw), Ok(mh)) = (mon.x(), mon.y(), mon.width(), mon.height()) else { return vec![] };
    let rects = xcap::Window::all().unwrap_or_default().into_iter().filter_map(|w| {
        if w.is_minimized().unwrap_or(true) {
            return None;
        }
        Some((w.x().ok()?, w.y().ok()?, w.width().ok()?, w.height().ok()?))
    });
    clip_windows(rects, (mx, my, mw, mh), scale(mon))
}

/// The pure part of `list_windows`: clip physical rects to the monitor, convert to CSS px, filter.
fn clip_windows(rects: impl Iterator<Item = (i32, i32, u32, u32)>, (mx, my, mw, mh): Frame, k: f64) -> Vec<WinBox> {
    let (mr, mb) = (mx + mw as i32, my + mh as i32);
    rects
        .filter_map(|(x, y, w, h)| {
            let (x1, y1) = (x.max(mx), y.max(my));
            let (x2, y2) = ((x + w as i32).min(mr), (y + h as i32).min(mb));
            let (cw, ch) = ((x2 - x1) as f64 / k, (y2 - y1) as f64 / k);
            if cw < 40.0 || ch < 40.0 || (x2 - x1 >= mw as i32 && y2 - y1 >= mh as i32) {
                return None;
            }
            Some(WinBox { x: (x1 - mx) as f64 / k, y: (y1 - my) as f64 / k, w: cw, h: ch })
        })
        .collect()
}

/// Put the PNG on the clipboard as "PNG" (the bytes as they are: no re-encode) and CF_DIB (for apps that
/// only take bitmaps; Windows synthesizes CF_BITMAP and CF_DIBV5 from it).
pub fn clipboard_png(png: &[u8]) -> Result<(), String> {
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
    };
    use windows_sys::Win32::Foundation::GlobalFree;
    use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    const CF_DIB: u32 = 8;

    let img = image::load_from_memory_with_format(png, image::ImageFormat::Png).map_err(|e| e.to_string())?.to_rgba8();
    let dib = dib_from_rgba(img.width(), img.height(), img.as_raw());

    unsafe {
        // Another app may hold the clipboard for a moment (clipboard managers): retry briefly.
        let mut opened = false;
        for _ in 0..10 {
            if OpenClipboard(std::ptr::null_mut()) != 0 {
                opened = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        if !opened {
            return Err("the clipboard is in use by another app".into());
        }
        let put = |format: u32, bytes: &[u8]| -> bool {
            let h = GlobalAlloc(GMEM_MOVEABLE, bytes.len());
            if h.is_null() {
                return false;
            }
            let p = GlobalLock(h) as *mut u8;
            if p.is_null() {
                GlobalFree(h);
                return false;
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), p, bytes.len());
            GlobalUnlock(h);
            if SetClipboardData(format, h).is_null() {
                GlobalFree(h); // still ours: the clipboard only owns it on success
                return false;
            }
            true
        };
        let png_format = RegisterClipboardFormatW(wide("PNG").as_ptr());
        let ok = EmptyClipboard() != 0 && put(png_format, png) & put(CF_DIB, &dib);
        CloseClipboard();
        if ok { Ok(()) } else { Err("could not write the image to the clipboard".into()) }
    }
}

/// BITMAPINFOHEADER + bottom-up 32-bit BGRA rows (BI_RGB), the plain CF_DIB layout.
fn dib_from_rgba(w: u32, h: u32, rgba: &[u8]) -> Vec<u8> {
    let row = w as usize * 4;
    let mut out = Vec::with_capacity(40 + rgba.len());
    for v in [40u32, w, h] {
        out.extend_from_slice(&v.to_le_bytes()); // biSize, biWidth, biHeight (positive = bottom-up)
    }
    out.extend_from_slice(&1u16.to_le_bytes()); // biPlanes
    out.extend_from_slice(&32u16.to_le_bytes()); // biBitCount
    out.extend_from_slice(&0u32.to_le_bytes()); // biCompression = BI_RGB
    out.extend_from_slice(&(rgba.len() as u32).to_le_bytes()); // biSizeImage
    out.extend_from_slice(&[0u8; 16]); // resolution, colour table: unused
    for line in rgba.chunks_exact(row).rev() {
        for p in line.chunks_exact(4) {
            out.extend_from_slice(&[p[2], p[1], p[0], p[3]]);
        }
    }
    out
}

/// Ctrl+V into whatever window is in front. The editor only asks once Ctrl/Shift/Alt are released, and
/// hiding the overlay hands the foreground back to the window that had it before the capture.
/// In-process SendInput instead of Electron's PowerShell SendKeys: same keystroke, no ~0.5 s process start.
pub fn paste() -> Result<(), String> {
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
    // 0 sent = blocked by UIPI: the target runs elevated (as admin) and we don't.
    if sent as usize == inputs.len() { Ok(()) } else { Err("Windows blocked the keystroke (is the target app running as administrator?)".into()) }
}

/// Native error box for "capture failed" style messages (Electron's dialog.showErrorBox). Unowned and
/// modal only to its own message loop: on Windows a capture during it still works and Esc closes it.
pub fn error_box(title: &str, text: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK, MB_TOPMOST};
    unsafe { MessageBoxW(std::ptr::null_mut(), wide(text).as_ptr(), wide(title).as_ptr(), MB_OK | MB_ICONERROR | MB_TOPMOST) };
}

/// CI only (SHORESHOT_TEST_MODAL=1): open an unowned MessageBox on the main thread 3 s after start, the
/// setup that froze macOS v1.0.0. The harness then presses the hotkey and Esc and checks the dialog survives.
fn test_modal(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(3));
        let _ = app.run_on_main_thread(|| {
            use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_OK};
            unsafe {
                MessageBoxW(
                    std::ptr::null_mut(),
                    wide("Test dialog: the capture hotkey must still work and Esc must close the overlay.").as_ptr(),
                    wide("ShoreShot modal test").as_ptr(),
                    MB_OK,
                )
            };
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
    fn windows_clip_to_monitor_in_css_px() {
        // Second monitor at 150 %, right of a 1920 px primary.
        let mon = (1920, 0, 3840, 2160);
        let rects = [
            (1920 + 300, 150, 1500, 900), // fully inside
            (1000, 0, 1220, 600),         // straddles both monitors: only the part on this one counts
            (1920, 0, 3840, 2160),        // covers the monitor (desktop): skipped
            (5000, 100, 50, 50),          // sliver (33 CSS px): skipped
            (0, 0, 800, 600),             // other monitor: skipped
        ];
        let got = clip_windows(rects.into_iter(), mon, 1.5);
        assert_eq!(got, vec![
            WinBox { x: 200.0, y: 100.0, w: 1000.0, h: 600.0 },
            WinBox { x: 0.0, y: 0.0, w: 200.0, h: 400.0 },
        ]);
    }

    #[test]
    fn dib_is_bottom_up_bgra() {
        let rgba = [1, 2, 3, 4, /* row 2 */ 5, 6, 7, 8];
        let dib = dib_from_rgba(1, 2, &rgba);
        assert_eq!(dib.len(), 40 + 8);
        assert_eq!(&dib[40..], &[7, 6, 5, 8, 3, 2, 1, 4]);
    }
}
