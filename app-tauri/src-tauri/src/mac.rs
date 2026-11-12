//! macOS side: overlay panel, permissions, clipboard, text recognition, login item, dialogs, paste keystroke.
//!
//! Dialogs (message boxes, the Save panel) are non-modal: ShoreShot never runs an app-modal loop, so nothing
//! can lock the overlay (the v1.0.0 freeze) and `run_on_main_thread` never stalls behind a dialog. The
//! caller still counts open dialogs and never shows the overlay over one.
use std::path::PathBuf;
use std::process::Command;

use objc2::runtime::AnyClass;
use objc2::AllocAnyThread as _;
// tauri_panel! below also brings msg_send! and AnyObject into scope.
use objc2_app_kit::{NSImage, NSPasteboard, NSPasteboardTypePNG, NSPasteboardTypeString, NSPasteboardTypeTIFF};
use objc2_foundation::{NSData, NSDictionary, NSNumber, NSString};
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
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrustedWithOptions(options: *const std::ffi::c_void) -> bool;
}
#[link(name = "ServiceManagement", kind = "framework")]
extern "C" {}
#[link(name = "Vision", kind = "framework")]
extern "C" {}

#[repr(C)]
struct CGPoint {
    x: f64,
    y: f64,
}

pub const BUNDLE_ID: &str = "biz.ontheshore.shoreshot";

pub fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default())
}

/// Same folders as Electron's app.getPath('logs') / ('userData'), so capture.log and config.json carry over.
pub fn log_dir() -> PathBuf {
    home().join("Library/Logs/ShoreShot")
}
pub fn config_dir() -> PathBuf {
    home().join("Library/Application Support/ShoreShot")
}

// ---------- screen ----------
pub fn screen_access() -> bool {
    unsafe { CGPreflightScreenCaptureAccess() }
}

/// Puts ShoreShot in the Screen Recording list and lets macOS prompt (it only does that once).
pub fn request_screen_access() {
    unsafe { CGRequestScreenCaptureAccess() };
}

/// Global cursor position in points, top-left origin (the space of xcap monitors and Tauri logical coords).
pub fn cursor() -> (f64, f64) {
    unsafe {
        let ev = CGEventCreate(std::ptr::null());
        let p = CGEventGetLocation(ev);
        CFRelease(ev);
        (p.x, p.y)
    }
}

// ---------- overlay ----------
/// The overlay: a non-activating NSPanel at screen-saver level on all Spaces, created hidden up front so
/// the hotkey only has to show it. `worksWhenModal` keeps it taking input even during a modal loop.
pub fn create_overlay(app: &AppHandle) -> tauri::Result<()> {
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
    panel.add_style_mask(StyleMask::empty().nonactivating_panel().into()).expect("non-activating panel");
    panel.set_works_when_modal(true);
    panel.set_has_shadow(false);
    Ok(())
}

/// Show at alpha 0 over the display so the renderer can paint; reveal() makes it visible.
pub fn show_hidden(app: &AppHandle, (x, y, w, h): (f64, f64, f64, f64)) {
    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.set_position(LogicalPosition::new(x, y));
        let _ = win.set_size(LogicalSize::new(w, h));
    }
    if let Ok(p) = app.get_webview_panel("overlay") {
        p.set_alpha_value(0.0);
        p.show_and_make_key(); // non-activating: takes keys without activating the app
    }
}

pub fn reveal(app: &AppHandle) {
    if let Ok(p) = app.get_webview_panel("overlay") {
        p.set_alpha_value(1.0);
    }
}

/// Visible again (after the Save panel was cancelled) or brought forward (hotkey while open).
pub fn focus_overlay(app: &AppHandle) {
    if let Ok(p) = app.get_webview_panel("overlay") {
        p.set_alpha_value(1.0);
        p.show_and_make_key();
    }
}

pub fn hide_overlay(app: &AppHandle) {
    if let Ok(p) = app.get_webview_panel("overlay") {
        p.set_alpha_value(0.0);
        p.hide();
    }
}

/// Scrolling capture: the overlay lets the mouse through to the app below (`area` set) and keeps itself out
/// of the grabs; the page shows the real screen through a transparent window. None restores it.
pub fn scroll_passthrough(app: &AppHandle, area: Option<(u32, u32, u32, u32)>) {
    if let Some(win) = app.get_webview_window("overlay") {
        let _ = win.set_ignore_cursor_events(area.is_some());
        // The frame and the guide sit outside the area; this keeps the overlay out of the grabs regardless.
        let _ = win.set_content_protected(area.is_some());
    }
}

// ---------- clipboard ----------
/// PNG plus TIFF (what Electron's clipboard.writeImage gives older apps). Main thread.
/// PNG only past 8 MB: TIFF is uncompressed (a 3,876 × 14,432 scrolling capture makes 220 MB of it), and
/// building it here held the main thread for half a second and made the whole Mac stutter.
pub fn clipboard_image(png: &[u8]) {
    let data = NSData::with_bytes(png);
    let small = png.len() <= 8 * 1024 * 1024;
    let tiff = small.then(|| NSImage::initWithData(NSImage::alloc(), &data).and_then(|i| i.TIFFRepresentation())).flatten();
    unsafe {
        let pb = NSPasteboard::generalPasteboard();
        pb.clearContents();
        pb.setData_forType(Some(&data), NSPasteboardTypePNG);
        if let Some(tiff) = tiff {
            pb.setData_forType(Some(&tiff), NSPasteboardTypeTIFF);
        }
    }
}

pub fn clipboard_text(text: &str) {
    unsafe {
        let pb = NSPasteboard::generalPasteboard();
        pb.clearContents();
        pb.setString_forType(&NSString::from_str(text), NSPasteboardTypeString);
    }
}

// ---------- text recognition ----------
pub use vision::ocr;

/// Its own module, like `ui` below: tauri_panel! above imports names that clash.
mod vision {
    use objc2::rc::{autoreleasepool, Allocated, Retained};
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2::{msg_send, sel};
    use objc2_foundation::{NSArray, NSData, NSDictionary, NSNumber, NSRect, NSString};

    /// The text in a PNG, one fragment per line Vision finds (it already splits texts that are far apart on a
    /// row). English and Vietnamese where the OS has them (Vietnamese: macOS 13+). Blocks for ~100-300 ms: worker thread.
    pub fn ocr(png: &[u8]) -> Result<Vec<crate::Fragment>, String> {
        // Vision's boxes are fractions of the image with a bottom-left origin; the size is in the PNG header.
        if png.len() < 24 {
            return Err("not a PNG".into());
        }
        let px = |at: usize| u32::from_be_bytes([png[at], png[at + 1], png[at + 2], png[at + 3]]) as f64;
        let (img_w, img_h) = (px(16), px(20));
        let (Some(request_cls), Some(handler_cls)) =
            (AnyClass::get(c"VNRecognizeTextRequest"), AnyClass::get(c"VNImageRequestHandler"))
        else {
            return Err("Vision is not available".into());
        };
        let no_error = std::ptr::null_mut::<*mut AnyObject>();
        autoreleasepool(|_| unsafe {
            let request: Retained<AnyObject> = msg_send![request_cls, new];
            // macOS 12+: ask which languages this OS reads, so an unsupported one never fails the request.
            let can_ask: bool = msg_send![&*request, respondsToSelector: sel!(supportedRecognitionLanguagesAndReturnError:)];
            if can_ask {
                let supported: Option<Retained<NSArray<NSString>>> =
                    msg_send![&*request, supportedRecognitionLanguagesAndReturnError: no_error];
                let supported: Vec<String> = supported.iter().flat_map(|a| a.iter()).map(|l| l.to_string()).collect();
                let languages: Vec<Retained<NSString>> = ["en-US", "vi-VT"] // "vi-VT" is how Vision spells Vietnamese
                    .iter()
                    .filter(|l| supported.iter().any(|s| s == *l))
                    .map(|l| NSString::from_str(l))
                    .collect();
                if !languages.is_empty() {
                    let _: () = msg_send![&*request, setRecognitionLanguages: &*NSArray::from_retained_slice(&languages)];
                }
            }
            let data = NSData::with_bytes(png);
            let options = NSDictionary::<NSString, NSNumber>::new();
            let handler: Allocated<AnyObject> = msg_send![handler_cls, alloc];
            let handler: Retained<AnyObject> = msg_send![handler, initWithData: &*data, options: &*options];
            let requests = NSArray::from_retained_slice(&[request.clone()]);
            let ok: bool = msg_send![&*handler, performRequests: &*requests, error: no_error];
            if !ok {
                return Err("Vision could not read the image".into());
            }
            let results: Option<Retained<NSArray<AnyObject>>> = msg_send![&*request, results];
            let mut found = Vec::new();
            for line in results.iter().flat_map(|r| r.iter()) {
                let candidates: Retained<NSArray<AnyObject>> = msg_send![&*line, topCandidates: 1usize];
                let Some(best) = candidates.firstObject() else { continue };
                let text: Retained<NSString> = msg_send![&*best, string];
                let b: NSRect = msg_send![&*line, boundingBox];
                let (w, h) = (b.size.width * img_w, b.size.height * img_h);
                let rect = (b.origin.x * img_w, (1.0 - b.origin.y - b.size.height) * img_h, w, h);
                found.push(crate::Fragment { text: text.to_string(), rect });
            }
            Ok(found)
        })
    }
}

// ---------- accessibility + paste ----------
/// Whether ShoreShot may send keystrokes. With `prompt`, macOS shows its Accessibility prompt if not.
pub fn accessibility(prompt: bool) -> bool {
    let key = NSString::from_str("AXTrustedCheckOptionPrompt");
    let value = NSNumber::new_bool(prompt);
    let opts = NSDictionary::from_slices(&[&*key], &[&*value]);
    unsafe { AXIsProcessTrustedWithOptions((&*opts as *const NSDictionary<NSString, NSNumber>).cast()) }
}

pub fn paste_keystroke() -> Result<(), String> {
    run("osascript", &["-e", r#"tell application "System Events" to keystroke "v" using command down"#])
}

/// Remove ShoreShot's privacy grant so macOS asks again. Errors (e.g. a dev build) are ignored.
pub fn reset_permission(service: &str) {
    let _ = run("tccutil", &["reset", service, BUNDLE_ID]);
}

// ---------- login item ----------
/// SMAppService.mainApp, the same API Electron's setLoginItemSettings uses on macOS 13+, so the setting carries over.
fn main_app_service() -> Option<*mut AnyObject> {
    let cls = AnyClass::get(c"SMAppService")?;
    let svc: *mut AnyObject = unsafe { msg_send![cls, mainAppService] };
    (!svc.is_null()).then_some(svc)
}

pub fn open_at_login() -> bool {
    let Some(svc) = main_app_service() else { return false };
    let status: isize = unsafe { msg_send![svc, status] };
    status == 1 // SMAppServiceStatusEnabled
}

pub fn set_open_at_login(on: bool) -> bool {
    if let Some(svc) = main_app_service() {
        let err = std::ptr::null_mut::<*mut AnyObject>();
        let _: bool = unsafe {
            if on {
                msg_send![svc, registerAndReturnError: err]
            } else {
                msg_send![svc, unregisterAndReturnError: err]
            }
        };
    }
    open_at_login()
}

// ---------- dialogs (non-modal) ----------
/// Message box: an NSAlert shown as a plain window, never `runModal`. Call from a worker thread; it waits
/// for the click while the main thread keeps running. Returns the index of the clicked button (the first is
/// the default, `cancel` also answers Esc).
pub fn dialog(app: &AppHandle, message: &str, detail: &str, buttons: &[&str], cancel: usize) -> usize {
    let (tx, rx) = std::sync::mpsc::channel();
    let (m, d) = (message.to_string(), detail.to_string());
    let b: Vec<String> = buttons.iter().map(|s| s.to_string()).collect();
    let _ = app.run_on_main_thread(move || ui::alert(&m, &d, &b, cancel, tx));
    rx.recv().unwrap_or(cancel)
}

/// Save panel in ~/Pictures, presented modeless (`beginWithCompletionHandler`). Worker thread. None = cancelled.
pub fn save_dialog(app: &AppHandle, default_name: &str) -> Option<PathBuf> {
    let (tx, rx) = std::sync::mpsc::channel();
    let name = default_name.to_string();
    let _ = app.run_on_main_thread(move || ui::save(&name, tx));
    let mut path = rx.recv().ok()??;
    if path.extension().map_or(true, |e| !e.eq_ignore_ascii_case("png")) {
        path.as_mut_os_string().push(".png");
    }
    Some(path)
}

/// AppKit side of the dialogs. Its own module: tauri_panel! above imports names that clash.
mod ui {
    use std::cell::RefCell;
    use std::path::PathBuf;
    use std::sync::mpsc::Sender;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{
        NSAlert, NSApplication, NSButton, NSFloatingWindowLevel, NSModalResponse, NSModalResponseOK, NSSavePanel,
    };
    use objc2_foundation::{NSArray, NSObject, NSString, NSURL};

    pub struct Ivars {
        tx: Sender<usize>,
    }

    define_class!(
        // SAFETY: NSObject has no subclassing requirements; AlertTarget does not implement Drop.
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "ShoreShotAlertTarget"]
        #[ivars = Ivars]
        struct AlertTarget;

        impl AlertTarget {
            #[unsafe(method(clicked:))]
            fn clicked(&self, sender: &NSButton) {
                let _ = self.ivars().tx.send(sender.tag() as usize);
                if let Some(w) = sender.window() {
                    w.orderOut(None);
                }
                OPEN.with(|o| o.borrow_mut().retain(|(_, t)| !std::ptr::eq(&**t, self)));
            }
        }
    );

    thread_local! {
        /// Alerts on screen with their button target (buttons only hold it weakly).
        static OPEN: RefCell<Vec<(Retained<NSAlert>, Retained<AlertTarget>)>> = const { RefCell::new(Vec::new()) };
    }

    fn activate(mtm: MainThreadMarker) {
        #[allow(deprecated)] // `activate` alone may be refused for a menu bar app
        NSApplication::sharedApplication(mtm).activateIgnoringOtherApps(true);
    }

    pub fn alert(message: &str, detail: &str, buttons: &[String], cancel: usize, tx: Sender<usize>) {
        let mtm = MainThreadMarker::new().expect("main thread");
        let alert = NSAlert::new(mtm);
        alert.setMessageText(&NSString::from_str(message));
        alert.setInformativeText(&NSString::from_str(detail));
        for b in buttons {
            alert.addButtonWithTitle(&NSString::from_str(b));
        }
        let target = AlertTarget::alloc(mtm).set_ivars(Ivars { tx });
        let target: Retained<AlertTarget> = unsafe { msg_send![super(target), init] };
        for (i, btn) in alert.buttons().iter().enumerate() {
            btn.setTag(i as isize);
            let _: () = unsafe { msg_send![&*btn, setTarget: &*target] };
            let _: () = unsafe { msg_send![&*btn, setAction: sel!(clicked:)] };
            if i == cancel && i != 0 {
                btn.setKeyEquivalent(&NSString::from_str("\u{1b}"));
            }
        }
        alert.layout();
        let win = alert.window();
        win.setLevel(NSFloatingWindowLevel);
        win.setHidesOnDeactivate(false); // panels hide while the app is inactive, and a menu bar app often is
        win.center();
        activate(mtm);
        win.makeKeyAndOrderFront(None);
        OPEN.with(|o| o.borrow_mut().push((alert, target)));
    }

    pub fn save(name: &str, tx: Sender<Option<PathBuf>>) {
        let mtm = MainThreadMarker::new().expect("main thread");
        let panel = NSSavePanel::savePanel(mtm);
        panel.setTitle(Some(&NSString::from_str("Save screenshot")));
        panel.setNameFieldStringValue(&NSString::from_str(name));
        let pictures = super::home().join("Pictures");
        panel.setDirectoryURL(Some(&NSURL::fileURLWithPath(&NSString::from_str(&pictures.to_string_lossy()))));
        #[allow(deprecated)]
        panel.setAllowedFileTypes(Some(&NSArray::from_retained_slice(&[NSString::from_str("png")])));
        panel.setLevel(NSFloatingWindowLevel);
        panel.setHidesOnDeactivate(false);
        let p = panel.clone();
        let done = RcBlock::new(move |resp: NSModalResponse| {
            let url = if resp == NSModalResponseOK { p.URL() } else { None };
            let _ = tx.send(url.and_then(|u| u.path()).map(|s| PathBuf::from(s.to_string())));
        });
        activate(mtm);
        panel.beginWithCompletionHandler(&done);
    }
}

/// "YYYY-MM-DD HH.MM.SS" in local time, like Electron's Save default name.
pub fn timestamp() -> String {
    output("date", &["+%Y-%m-%d %H.%M.%S"]).unwrap_or_default()
}

pub fn open_url(url: &str) {
    let _ = Command::new("open").arg(url).spawn();
}

fn output(cmd: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new(cmd).args(args).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim_end_matches('\n').to_string())
}

fn run(cmd: &str, args: &[&str]) -> Result<(), String> {
    output(cmd, args).map(|_| ())
}
