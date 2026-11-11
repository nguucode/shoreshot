//! ShoreShot Tauri spike (macOS + Windows): hotkey -> capture display under cursor -> full-screen overlay
//! running the unchanged Electron renderer -> PNG to clipboard. Throwaway: measures latency, nothing else.
//!
//! Hotkeys: Cmd+Shift+X (Windows: Ctrl+Shift+X) capture. Cmd/Ctrl+Shift+8 opens a modal dialog (lock test).
//! Env: SPIKE_BENCH=1 one capture, then web/api.js scripts a selection + 2 s pen stroke + Enter (copy).
//!      SPIKE_AUTO=n triggers n captures 3 s apart without the hotkey (each auto-closes after 1 s).
//!      SPIKE_MODAL_TEST=1 opens the modal dialog 2 s after start, then fires a capture 1 s later.
//!      SPIKE_NO_WORKS_WHEN_MODAL=1 (macOS) turns off the panel's worksWhenModal (the v1.0.0 setup).
use std::io::Write as _;
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{ipc::Request, AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

#[cfg(target_os = "macos")]
use mac as plat;
#[cfg(windows)]
use win as plat;

#[derive(Default)]
struct S {
    t0: Mutex<Option<Instant>>,
    marks: Mutex<Vec<String>>,
    bitmap: Mutex<Vec<u8>>,
    /// Where the overlay goes once the renderer has painted (x, y, w, h in the platform's window units).
    frame: Mutex<(i32, i32, u32, u32)>,
    open: AtomicBool,
    visible: AtomicBool,
}

fn mark(s: &S, step: &str) {
    let ms = s.t0.lock().unwrap().map_or(0, |t| t.elapsed().as_millis());
    s.marks.lock().unwrap().push(format!("{step} {ms}"));
}

fn log_line(line: &str) {
    println!("{line}");
    let dir = plat::log_dir();
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("capture.log")) {
        let _ = writeln!(f, "{line}");
    }
}

fn flush(s: &S) {
    let marks = std::mem::take(&mut *s.marks.lock().unwrap());
    if !marks.is_empty() {
        log_line(&marks.join(" · "));
    }
}

/// Runs on the main thread (global-shortcut callbacks come from the event loop).
fn capture(app: &AppHandle) {
    let s = app.state::<S>();
    if s.open.load(SeqCst) {
        return;
    }
    *s.t0.lock().unwrap() = Some(Instant::now());
    s.marks.lock().unwrap().clear();
    // Same guard as Electron: an overlay over the system permission prompt is the v1.0.0 freeze. Ask, never show.
    if !plat::has_permission() {
        log_line("no screen recording permission: asked, overlay not shown");
        return;
    }
    mark(&s, "permission");
    let (cx, cy) = plat::cursor(app);
    let mon = match xcap::Monitor::from_point(cx as i32, cy as i32) {
        Ok(m) => m,
        Err(e) => return log_line(&format!("monitor: {e}")),
    };
    let (x, y, w, h) = (mon.x().unwrap(), mon.y().unwrap(), mon.width().unwrap(), mon.height().unwrap());
    // macOS: monitor geometry and cursor are in points (= CSS px). Windows: physical pixels, divide by scale.
    let k = if cfg!(windows) { mon.scale_factor().unwrap_or(1.0) as f64 } else { 1.0 };
    mark(&s, "monitor");
    let img = match mon.capture_image() {
        Ok(i) => i,
        Err(e) => return log_line(&format!("capture: {e}")),
    };
    let (px_w, px_h) = img.dimensions();
    mark(&s, &format!("captured {px_w}x{px_h} @{k}"));
    *s.bitmap.lock().unwrap() = img.into_raw();
    *s.frame.lock().unwrap() = (x, y, w, h);

    s.open.store(true, SeqCst);
    s.visible.store(false, SeqCst);
    plat::show_hidden(app, (x, y, w, h));
    let _ = app.emit_to(
        "overlay",
        "capture:show",
        serde_json::json!({
            "mode": "area", "cursor": { "x": (cx - x as f64) / k, "y": (cy - y as f64) / k },
            "pxW": px_w, "pxH": px_h, "width": (w as f64 / k).round(), "height": (h as f64 / k).round(),
            "retina1x": false, "bench": std::env::var("SPIKE_BENCH").is_ok()
        }),
    );
    mark(&s, "sent");

    // Safety valve: if the renderer never reports ready, hide instead of revealing an unresponsive overlay.
    let app2 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1500));
        let a = app2.clone();
        let _ = app2.run_on_main_thread(move || {
            let s = a.state::<S>();
            if s.open.load(SeqCst) && !s.visible.load(SeqCst) {
                mark(&s, "watchdog-hide");
                hide(&a);
            }
        });
    });
}

fn hide(app: &AppHandle) {
    let s = app.state::<S>();
    if s.open.swap(false, SeqCst) {
        mark(&s, "hidden");
    }
    plat::hide(app);
    s.bitmap.lock().unwrap().clear();
    let _ = app.emit_to("overlay", "capture:hidden", ());
    flush(&s);
}

#[tauri::command]
fn bitmap(s: tauri::State<S>) -> tauri::ipc::Response {
    mark(&s, "bitmap-requested");
    tauri::ipc::Response::new(std::mem::take(&mut *s.bitmap.lock().unwrap()))
}

#[tauri::command]
fn ready(app: AppHandle, transfer_ms: u64) {
    let a = app.clone();
    let _ = app.run_on_main_thread(move || {
        let s = a.state::<S>();
        if !s.open.load(SeqCst) {
            return;
        }
        plat::reveal(&a, *s.frame.lock().unwrap());
        s.visible.store(true, SeqCst);
        mark(&s, &format!("visible (bitmap ipc {transfer_ms} ms)"));
        flush(&s);
        if std::env::var("SPIKE_AUTO").is_ok() {
            let a2 = a.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(1));
                let a3 = a2.clone();
                let _ = a2.run_on_main_thread(move || hide(&a3));
            });
        }
    });
}

#[tauri::command]
fn copy(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(png) = request.body() else {
        return Err("expected raw PNG bytes".into());
    };
    let png = png.clone();
    let a = app.clone();
    let _ = app.run_on_main_thread(move || {
        let t = Instant::now();
        match plat::clipboard_png(&png) {
            Ok(()) => log_line(&format!("copied {} KB PNG in {} ms", png.len() / 1024, t.elapsed().as_millis())),
            Err(e) => log_line(&format!("clipboard: {e}")),
        }
        hide(&a);
    });
    Ok(())
}

#[tauri::command]
fn close(app: AppHandle) {
    let a = app.clone();
    let _ = app.run_on_main_thread(move || hide(&a));
}

#[tauri::command]
fn log(line: String) {
    log_line(&line);
}

fn modal_dialog() {
    log_line("modal open");
    plat::modal_dialog();
    log_line("modal closed");
}

fn main() {
    let mods = if cfg!(target_os = "macos") { Modifiers::SUPER } else { Modifiers::CONTROL } | Modifiers::SHIFT;
    let capture_key = Shortcut::new(Some(mods), Code::KeyX);
    let modal_key = Shortcut::new(Some(mods), Code::Digit8);
    let builder = tauri::Builder::default().manage(S::default());
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_nspanel::init());
    builder
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcuts([capture_key, modal_key])
                .unwrap()
                .with_handler(move |app, sc, ev| {
                    if ev.state != ShortcutState::Pressed {
                        return;
                    }
                    if *sc == capture_key {
                        capture(app);
                    } else if *sc == modal_key {
                        modal_dialog();
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![bitmap, ready, copy, close, log])
        .setup(|app| {
            plat::setup(app)?;
            let handle = app.handle().clone();
            let auto = std::env::var("SPIKE_AUTO").map(|v| v.parse::<u32>().unwrap_or(3));
            if let Ok(n) = auto.or_else(|_| std::env::var("SPIKE_BENCH").map(|_| 1)) {
                std::thread::spawn(move || {
                    for _ in 0..n {
                        std::thread::sleep(Duration::from_secs(3));
                        let h = handle.clone();
                        let _ = handle.run_on_main_thread(move || capture(&h));
                    }
                });
            } else if std::env::var("SPIKE_MODAL_TEST").is_ok() {
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(2));
                    let h = handle.clone();
                    let _ = handle.run_on_main_thread(modal_dialog);
                    std::thread::sleep(Duration::from_secs(1));
                    let _ = h.clone().run_on_main_thread(move || capture(&h));
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("tauri run");
}

#[cfg(target_os = "macos")]
mod mac {
    use objc2_app_kit::{NSAlert, NSPasteboard, NSPasteboardTypePNG};
    use objc2_foundation::{NSData, NSString};
    use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl};
    use tauri_nspanel::{tauri_panel, CollectionBehavior, ManagerExt, PanelLevel, StyleMask, WebviewWindowExt};

    tauri_panel! {
        panel!(OverlayPanel {
            config: { can_become_key_window: true, is_floating_panel: true }
        })
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
        fn CGEventCreate(source: *const std::ffi::c_void) -> *mut std::ffi::c_void;
        fn CGEventGetLocation(event: *mut std::ffi::c_void) -> CGPoint;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: *mut std::ffi::c_void);
    }
    #[repr(C)]
    struct CGPoint {
        x: f64,
        y: f64,
    }

    pub fn log_dir() -> std::path::PathBuf {
        std::path::PathBuf::from(std::env::var("HOME").unwrap()).join("Library/Logs/ShoreShot-spike")
    }

    pub fn has_permission() -> bool {
        if unsafe { CGPreflightScreenCaptureAccess() } {
            return true;
        }
        unsafe { CGRequestScreenCaptureAccess() }; // shows the system prompt; the overlay stays hidden
        false
    }

    /// Global cursor position in points, top-left origin (same space as xcap monitors and Tauri logical coords).
    pub fn cursor(_: &AppHandle) -> (f64, f64) {
        unsafe {
            let ev = CGEventCreate(std::ptr::null());
            let p = CGEventGetLocation(ev);
            CFRelease(ev);
            (p.x, p.y)
        }
    }

    pub fn setup(app: &mut tauri::App) -> tauri::Result<()> {
        app.set_activation_policy(tauri::ActivationPolicy::Accessory); // LSUIElement
        let win = tauri::WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("editor.html".into()))
            .visible(false)
            .decorations(false)
            .transparent(true)
            .resizable(false)
            .shadow(false)
            .skip_taskbar(true)
            .build()?;
        let panel = win.to_panel::<OverlayPanel>()?;
        panel.set_level(PanelLevel::ScreenSaver.value());
        panel.set_collection_behavior(
            CollectionBehavior::new().can_join_all_spaces().full_screen_auxiliary().stationary().ignores_cycle().into(),
        );
        panel.add_style_mask(StyleMask::empty().nonactivating_panel().into()).expect("style mask");
        // The fix for the v1.0.0 freeze class: a panel that keeps receiving events during a modal loop.
        panel.set_works_when_modal(std::env::var("SPIKE_NO_WORKS_WHEN_MODAL").is_err());
        panel.set_has_shadow(false);
        Ok(())
    }

    /// Show at alpha 0 so the renderer can paint; reveal() makes it visible.
    pub fn show_hidden(app: &AppHandle, (x, y, w, h): (i32, i32, u32, u32)) {
        let win = app.get_webview_window("overlay").unwrap();
        let _ = win.set_position(LogicalPosition::new(x, y));
        let _ = win.set_size(LogicalSize::new(w, h));
        let panel = app.get_webview_panel("overlay").unwrap();
        panel.set_alpha_value(0.0);
        panel.show_and_make_key(); // non-activating panel: takes keys without activating the app
    }

    pub fn reveal(app: &AppHandle, _: (i32, i32, u32, u32)) {
        if let Ok(p) = app.get_webview_panel("overlay") {
            p.set_alpha_value(1.0);
        }
    }

    pub fn hide(app: &AppHandle) {
        if let Ok(p) = app.get_webview_panel("overlay") {
            p.set_alpha_value(0.0);
            p.hide();
        }
    }

    pub fn clipboard_png(png: &[u8]) -> Result<(), String> {
        unsafe {
            let pb = NSPasteboard::generalPasteboard();
            pb.clearContents();
            pb.setData_forType(Some(&NSData::with_bytes(png)), NSPasteboardTypePNG);
        }
        Ok(())
    }

    /// App-modal alert, like Electron's dialog.showMessageBox. Blocks the main thread in a modal loop.
    pub fn modal_dialog() {
        let mtm = objc2::MainThreadMarker::new().unwrap();
        let alert = NSAlert::new(mtm);
        alert.setMessageText(&NSString::from_str("ShoreShot spike: app-modal dialog"));
        alert.setInformativeText(&NSString::from_str("Press the capture hotkey now. Does the overlay lock the screen?"));
        alert.runModal();
    }
}

#[cfg(windows)]
mod win {
    use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl};

    pub fn log_dir() -> std::path::PathBuf {
        std::path::PathBuf::from(std::env::var("APPDATA").unwrap()).join("ShoreShot-spike")
    }

    pub fn has_permission() -> bool {
        true // no screen capture permission on Windows
    }

    /// Physical pixels, virtual-screen coordinates (same space as xcap monitors on Windows).
    pub fn cursor(app: &AppHandle) -> (f64, f64) {
        app.cursor_position().map(|p| (p.x, p.y)).unwrap_or((0.0, 0.0))
    }

    pub fn setup(app: &mut tauri::App) -> tauri::Result<()> {
        tauri::WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("editor.html".into()))
            .visible(false)
            .decorations(false)
            .resizable(false)
            .shadow(false)
            .skip_taskbar(true)
            .always_on_top(true)
            .build()?;
        Ok(())
    }

    // ponytail: off-screen instead of Electron's opacity 0. WebView2 does not render into layered
    // (WS_EX_LAYERED) windows, and a hidden WebView2 pauses requestAnimationFrame, so the overlay is
    // shown far off-screen (it paints there) and moved onto the monitor on reveal().
    const OFF: i32 = -32000;

    pub fn show_hidden(app: &AppHandle, (_, _, w, h): (i32, i32, u32, u32)) {
        let win = app.get_webview_window("overlay").unwrap();
        let _ = win.set_position(PhysicalPosition::new(OFF, OFF));
        let _ = win.set_size(PhysicalSize::new(w, h));
        let _ = win.show();
    }

    pub fn reveal(app: &AppHandle, (x, y, _, _): (i32, i32, u32, u32)) {
        let win = app.get_webview_window("overlay").unwrap();
        let _ = win.set_position(PhysicalPosition::new(x, y));
        let _ = win.set_always_on_top(true);
        let _ = win.set_focus(); // allowed: the process just received the hotkey
    }

    pub fn hide(app: &AppHandle) {
        if let Some(win) = app.get_webview_window("overlay") {
            let _ = win.hide();
        }
    }

    pub fn clipboard_png(png: &[u8]) -> Result<(), String> {
        let img = image::load_from_memory_with_format(png, image::ImageFormat::Png).map_err(|e| e.to_string())?.to_rgba8();
        let (width, height) = img.dimensions();
        arboard::Clipboard::new()
            .and_then(|mut c| {
                c.set_image(arboard::ImageData { width: width as usize, height: height as usize, bytes: img.into_raw().into() })
            })
            .map_err(|e| e.to_string())
    }

    /// Unowned MessageBox on the main thread, like Electron's dialog.showMessageBox without a parent.
    pub fn modal_dialog() {
        use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_OK};
        let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                wide("Press the capture hotkey now. Does the overlay lock the screen?").as_ptr(),
                wide("ShoreShot spike: modal dialog").as_ptr(),
                MB_OK,
            );
        }
    }
}
