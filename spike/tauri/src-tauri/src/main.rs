//! ShoreShot Tauri spike (macOS): hotkey -> capture display under cursor -> NSPanel overlay running the
//! unchanged Electron renderer -> PNG to clipboard. Throwaway: measures latency, nothing else is ported.
//!
//! Hotkeys: Cmd+Shift+X capture. Cmd+Shift+8 opens an app-modal NSAlert (dialog lock test).
//! Env: SPIKE_BENCH=1 one capture, then web/api.js scripts a selection + 2 s pen stroke + Enter (copy).
//!      SPIKE_AUTO=n triggers n captures 3 s apart without the hotkey (Esc-less: each auto-closes after 1 s).
//!      SPIKE_MODAL_TEST=1 opens the NSAlert, then fires a capture 1 s later from inside the modal loop.
//!      SPIKE_NO_WORKS_WHEN_MODAL=1 turns off the panel's worksWhenModal (reproduces the v1.0.0 setup).
use std::io::Write as _;
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use objc2_app_kit::{NSAlert, NSPasteboard, NSPasteboardTypePNG};
use objc2_foundation::{NSData, NSString};
use tauri::{ipc::Request, AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl};
use tauri_nspanel::{tauri_panel, CollectionBehavior, ManagerExt, PanelLevel, StyleMask, WebviewWindowExt};
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

tauri_panel! {
    panel!(OverlayPanel {
        config: { can_become_key_window: true, is_floating_panel: true }
    })
}

#[derive(Default)]
struct S {
    t0: Mutex<Option<Instant>>,
    marks: Mutex<Vec<String>>,
    bitmap: Mutex<Vec<u8>>,
    open: AtomicBool,
    visible: AtomicBool,
}

fn mark(s: &S, step: &str) {
    let ms = s.t0.lock().unwrap().map_or(0, |t| t.elapsed().as_millis());
    s.marks.lock().unwrap().push(format!("{step} {ms}"));
}

fn log_line(line: &str) {
    println!("{line}");
    let dir = std::env::var("HOME").unwrap() + "/Library/Logs/ShoreShot-spike";
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir + "/capture.log") {
        let _ = writeln!(f, "{line}");
    }
}

fn flush(s: &S) {
    let marks = std::mem::take(&mut *s.marks.lock().unwrap());
    if !marks.is_empty() {
        log_line(&marks.join(" · "));
    }
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

/// Global cursor position in points, top-left origin (same space as xcap monitors and Tauri logical coords).
fn cursor() -> (f64, f64) {
    unsafe {
        let ev = CGEventCreate(std::ptr::null());
        let p = CGEventGetLocation(ev);
        CFRelease(ev);
        (p.x, p.y)
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
    // Same guard as Electron: without permission xcap returns only the wallpaper, and an overlay over
    // the system prompt is exactly the v1.0.0 freeze. Ask, never show.
    if !unsafe { CGPreflightScreenCaptureAccess() } {
        unsafe { CGRequestScreenCaptureAccess() };
        log_line("no screen recording permission: asked, overlay not shown");
        return;
    }
    mark(&s, "permission");
    let (cx, cy) = cursor();
    let mon = match xcap::Monitor::from_point(cx as i32, cy as i32) {
        Ok(m) => m,
        Err(e) => return log_line(&format!("monitor: {e}")),
    };
    let (x, y, w, h) = (mon.x().unwrap(), mon.y().unwrap(), mon.width().unwrap(), mon.height().unwrap());
    mark(&s, "monitor");
    let img = match mon.capture_image() {
        Ok(i) => i,
        Err(e) => return log_line(&format!("capture: {e}")),
    };
    let (px_w, px_h) = img.dimensions();
    mark(&s, &format!("captured {px_w}x{px_h}"));
    *s.bitmap.lock().unwrap() = img.into_raw();

    let panel = app.get_webview_panel("overlay").unwrap();
    let win = app.get_webview_window("overlay").unwrap();
    let _ = win.set_position(LogicalPosition::new(x, y));
    let _ = win.set_size(LogicalSize::new(w, h));
    s.open.store(true, SeqCst);
    s.visible.store(false, SeqCst);
    panel.set_alpha_value(0.0);
    panel.show_and_make_key(); // non-activating panel: takes keys without activating the app
    let _ = app.emit_to(
        "overlay",
        "capture:show",
        serde_json::json!({
            "mode": "area", "cursor": { "x": cx - x as f64, "y": cy - y as f64 },
            "pxW": px_w, "pxH": px_h, "width": w, "height": h, "retina1x": false,
            "bench": std::env::var("SPIKE_BENCH").is_ok()
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
    s.open.store(false, SeqCst);
    if let Ok(p) = app.get_webview_panel("overlay") {
        p.set_alpha_value(0.0);
        p.hide();
    }
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
        if let Ok(p) = a.get_webview_panel("overlay") {
            p.set_alpha_value(1.0);
        }
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
        unsafe {
            let pb = NSPasteboard::generalPasteboard();
            pb.clearContents();
            pb.setData_forType(Some(&NSData::with_bytes(&png)), NSPasteboardTypePNG);
        }
        log_line(&format!("copied {} KB PNG in {} ms", png.len() / 1024, t.elapsed().as_millis()));
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

/// App-modal alert, like Electron's dialog.showMessageBox. Blocks this (main) thread in a modal loop.
fn modal_alert() {
    let mtm = MainThreadMarker::new().unwrap();
    let alert = NSAlert::new(mtm);
    alert.setMessageText(&NSString::from_str("ShoreShot spike: app-modal dialog"));
    alert.setInformativeText(&NSString::from_str("Press the capture hotkey now. Does the overlay lock the screen?"));
    log_line("modal open");
    alert.runModal();
    log_line("modal closed");
}

fn main() {
    let capture_key = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyX);
    let modal_key = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::Digit8);
    tauri::Builder::default()
        .manage(S::default())
        .plugin(tauri_nspanel::init())
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
                        modal_alert();
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![bitmap, ready, copy, close, log])
        .setup(|app| {
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
                CollectionBehavior::new()
                    .can_join_all_spaces()
                    .full_screen_auxiliary()
                    .stationary()
                    .ignores_cycle()
                    .into(),
            );
            panel.add_style_mask(StyleMask::empty().nonactivating_panel().into())?;
            // The fix for the v1.0.0 freeze class: a panel that keeps receiving events during a modal loop.
            panel.set_works_when_modal(std::env::var("SPIKE_NO_WORKS_WHEN_MODAL").is_err());
            panel.set_has_shadow(false);

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
                    let _ = handle.run_on_main_thread(modal_alert);
                    std::thread::sleep(Duration::from_secs(1));
                    let _ = h.clone().run_on_main_thread(move || capture(&h));
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("tauri run");
}
