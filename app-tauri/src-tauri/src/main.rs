//! ShoreShot on Tauri: a port of src/main.ts (Electron), macOS first. Parity status: ../PORTING.md.
//!
//! Hotkey -> capture the display under the cursor (xcap) -> show the overlay panel at alpha 0 -> the page
//! pulls the raw bitmap, paints, calls `ready` -> alpha 1. The renderer is the Electron one, unchanged,
//! behind web/api.js.
//!
//! Test switches: SHORESHOT_AUTO=n runs n captures 3 s apart without the hotkey (each hides after 1 s),
//! SHORESHOT_AUTO_MODE=area|full|window|text|settings picks the mode, SHORESHOT_AUTO_KEY=Enter|Meta+s|Meta+v|… presses
//! that key in the page instead of hiding (full mode starts in editing, so Enter copies).
// Release builds on Windows are GUI apps: no console window next to the tray icon.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// One module per platform with the same functions; main.rs only calls plat::*.
#[cfg(target_os = "macos")]
mod mac;
#[cfg(target_os = "macos")]
use mac as plat;
#[cfg(windows)]
mod win;
#[cfg(windows)]
use win as plat;

use std::io::Write as _;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering::SeqCst};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

const REPO_URL: &str = "https://github.com/nguucode/shoreshot";
const UPDATE_CHECK: Duration = Duration::from_secs(12 * 60 * 60);
const WATCHDOG: Duration = Duration::from_millis(1500);

/// Modes, indexed 0..N everywhere (config, hotkeys, tray). "text" selects an area like "area", then copies
/// the text in it (OCR) instead of opening the editor.
const N: usize = 4;
const MODES: [&str; N] = ["area", "full", "window", "text"];
const MODE_LABEL: [&str; N] = ["Capture area", "Capture full screen", "Capture window", "Copy text from area"];
const DEFAULT_HOTKEYS: [&str; N] = ["CommandOrControl+Shift+X", "", "", "CommandOrControl+Shift+2"]; // "" = not set

/// A piece of recognized text and its box in image pixels, top-left origin. src/renderer/ocrtext.ts lays them out.
struct Fragment {
    text: String,
    rect: Rect,
}

type Rect = (f64, f64, f64, f64); // x, y, w, h: points (= CSS px) on screen, image pixels in Fragment

/// config.json, same file and shape as Electron's (loadConfig in src/main.ts).
#[derive(Clone)]
struct Config {
    hotkeys: [String; N],
    /// Export at 1x on Retina displays.
    retina1x: bool,
    /// macOS has already shown its Screen Recording prompt (it only asks once).
    screen_asked: bool,
}

#[derive(Default)]
struct State {
    config: Mutex<Option<Config>>,
    /// Registered hotkey per mode (None = not set, invalid or taken by another app).
    hotkeys: Mutex<[Option<Shortcut>; N]>,
    /// Newer release on GitHub: (version, page url).
    update: Mutex<Option<(String, String)>>,
    // capture
    t0: Mutex<Option<Instant>>,
    marks: Mutex<Vec<String>>,
    bitmap: Mutex<Vec<u8>>,
    /// Window mode: list the windows of this display once the overlay is visible.
    windows_for: Mutex<Option<Rect>>,
    /// A capture is in progress (also while the overlay is hidden for the Save panel).
    open: AtomicBool,
    visible: AtomicBool,
    /// Bumped per capture so a watchdog from an earlier capture can't hide this one.
    generation: AtomicUsize,
    /// Open dialogs. The overlay is never shown while one is up (v1.0.0 freeze).
    dialogs: AtomicUsize,
}

fn st(app: &AppHandle) -> tauri::State<'_, State> {
    app.state::<State>()
}

fn config(app: &AppHandle) -> Config {
    st(app).config.lock().unwrap().clone().expect("config loaded in setup")
}

fn update_config(app: &AppHandle, f: impl FnOnce(&mut Config)) {
    let s = st(app);
    let mut c = s.config.lock().unwrap();
    f(c.as_mut().unwrap());
    save_config(c.as_ref().unwrap());
}

// ---------- config ----------
fn config_path() -> PathBuf {
    plat::config_dir().join("config.json")
}

fn parse_config(raw: &Value) -> Config {
    let saved = &raw["hotkeys"];
    let mut hotkeys = DEFAULT_HOTKEYS.map(String::from);
    for (i, m) in MODES.iter().enumerate() {
        // 0.1.11 and older: a single "hotkey"
        let v = if i == 0 && saved.get("area").is_none() { &raw["hotkey"] } else { &saved[*m] };
        if let Some(s) = v.as_str() {
            hotkeys[i] = s.to_string();
        }
    }
    Config { hotkeys, retina1x: raw["retina1x"] == true, screen_asked: raw["screenAsked"] == true }
}

fn load_config() -> Config {
    let raw = std::fs::read_to_string(config_path()).ok().and_then(|s| serde_json::from_str(&s).ok());
    parse_config(&raw.unwrap_or(Value::Null))
}

fn save_config(c: &Config) {
    let hotkeys: serde_json::Map<String, Value> =
        MODES.iter().zip(&c.hotkeys).map(|(m, h)| (m.to_string(), json!(h))).collect();
    let v = json!({ "hotkeys": hotkeys, "retina1x": c.retina1x, "screenAsked": c.screen_asked });
    let _ = std::fs::create_dir_all(plat::config_dir());
    if let Err(e) = std::fs::write(config_path(), serde_json::to_string_pretty(&v).unwrap()) {
        log_line(&format!("config: {e}"));
    }
}

// ---------- capture.log ----------
// One line of step timings (ms since the hotkey) per capture in ~/Library/Logs/ShoreShot/capture.log,
// same format as Electron. Emptied at startup once it passes 256 KB.
fn log_path() -> PathBuf {
    plat::log_dir().join("capture.log")
}

fn prepare_log() {
    let _ = std::fs::create_dir_all(plat::log_dir());
    if std::fs::metadata(log_path()).is_ok_and(|m| m.len() > 256 * 1024) {
        let _ = std::fs::write(log_path(), "");
    }
}

fn log_line(line: &str) {
    if cfg!(debug_assertions) {
        println!("{line}");
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(log_path()) {
        let _ = writeln!(f, "{}  {line}", iso_now());
    }
}

fn iso_now() -> String {
    let d = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    iso(d.as_secs() as i64, d.subsec_millis())
}

/// UTC ISO 8601 like JS toISOString(). Days -> civil date: Howard Hinnant's algorithm.
fn iso(secs: i64, ms: u32) -> String {
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{ms:03}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

fn mark(app: &AppHandle, step: &str) {
    let s = st(app);
    let ms = s.t0.lock().unwrap().map_or(0, |t| t.elapsed().as_millis());
    s.marks.lock().unwrap().push(format!("{step} {ms}"));
}

fn flush_marks(app: &AppHandle) {
    let marks = std::mem::take(&mut *st(app).marks.lock().unwrap());
    if !marks.is_empty() {
        log_line(&marks.join(" · "));
    }
}

// ---------- hotkeys ----------
/// Electron accelerator -> global-hotkey syntax. Settings records Electron names; most parse as they are.
fn parse_accel(accel: &str) -> Option<Shortcut> {
    let parts: Vec<&str> = accel
        .split('+')
        .map(|p| match p {
            "Meta" => "Super",
            "numsub" => "NumpadSubtract",
            "nummult" => "NumpadMultiply",
            "numdiv" => "NumpadDivide",
            "numdec" => "NumpadDecimal",
            p => p,
        })
        .collect();
    parts.join("+").parse().ok()
}

fn register(app: &AppHandle, m: usize, accel: &str) -> bool {
    let Some(sc) = (!accel.is_empty()).then(|| parse_accel(accel)).flatten() else { return false };
    let ok = app.global_shortcut().register(sc).is_ok();
    if ok {
        st(app).hotkeys.lock().unwrap()[m] = Some(sc);
    }
    ok
}

fn unregister(app: &AppHandle, m: usize) {
    if let Some(sc) = st(app).hotkeys.lock().unwrap()[m].take() {
        let _ = app.global_shortcut().unregister(sc);
    }
}

fn active(app: &AppHandle) -> [bool; N] {
    st(app).hotkeys.lock().unwrap().each_ref().map(Option::is_some)
}

fn register_all(app: &AppHandle) {
    let c = config(app);
    let act = active(app);
    for m in 0..N {
        if !act[m] {
            register(app, m, &c.hotkeys[m]);
        }
    }
}

/// accel "" clears the hotkey. Ok = the hotkey now in use.
fn set_hotkey(app: &AppHandle, m: usize, accel: &str) -> Result<String, String> {
    let old = config(app).hotkeys[m].clone();
    if accel == old && (active(app)[m] || accel.is_empty()) {
        return Ok(old);
    }
    let taken = (0..N).find(|&o| o != m && !accel.is_empty() && config(app).hotkeys[o] == accel);
    if let Some(t) = taken {
        return Err(format!("{} is already used for {}.", pretty_hotkey(accel), MODE_LABEL[t]));
    }
    unregister(app, m);
    if !accel.is_empty() && !register(app, m, accel) {
        register(app, m, &old); // restore the old hotkey
        return Err(format!(
            "{} is already used by the system or another app. Pick another combination.",
            pretty_hotkey(accel)
        ));
    }
    update_config(app, |c| c.hotkeys[m] = accel.to_string());
    refresh_tray(app);
    Ok(accel.to_string())
}

/// ⌘⇧X on macOS, Ctrl+Shift+X on Windows: the way each OS shows shortcuts.
fn pretty_hotkey(accel: &str) -> String {
    if cfg!(windows) {
        return accel
            .split('+')
            .filter(|p| !p.is_empty())
            .map(|p| match p {
                "CommandOrControl" | "CmdOrCtrl" | "Control" => "Ctrl",
                "Command" | "Cmd" | "Super" | "Meta" => "Win",
                p => p,
            })
            .collect::<Vec<_>>()
            .join("+");
    }
    accel
        .split('+')
        .filter(|p| !p.is_empty())
        .map(|p| match p {
            "CommandOrControl" | "CmdOrCtrl" | "Command" | "Cmd" | "Super" | "Meta" => "⌘",
            "Control" | "Ctrl" => "⌃",
            "Alt" | "Option" => "⌥",
            "Shift" => "⇧",
            p => p,
        })
        .collect()
}

// ---------- tray ----------
fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    let icon = tauri::image::Image::from_bytes(include_bytes!("../../../assets/trayTemplate@2x.png"))?;
    #[cfg(windows)]
    let icon = tauri::image::Image::from_bytes(include_bytes!("../../../assets/tray.png"))?;
    TrayIconBuilder::with_id("main")
        .icon(icon)
        .icon_as_template(cfg!(target_os = "macos"))
        // Windows: left click captures right away, the menu is on right click (as in Electron).
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_tray_icon_event(|_tray, _ev| {
            #[cfg(windows)]
            if let tauri::tray::TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                button_state: tauri::tray::MouseButtonState::Up,
                ..
            } = _ev
            {
                start_capture(_tray.app_handle(), 0);
            }
        })
        .menu(&tray_menu(app)?)
        .tooltip(tray_tooltip(app))
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "area" => start_capture(app, 0),
            "full" => start_capture(app, 1),
            "window" => start_capture(app, 2),
            "text" => start_capture(app, 3),
            "settings" => open_settings(app),
            "update" => show_update(app),
            "about" => plat::open_url(REPO_URL),
            "issues" => plat::open_url(&format!("{REPO_URL}/issues/new")),
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

fn tray_tooltip(app: &AppHandle) -> String {
    match active(app)[0] {
        true => format!("ShoreShot ({})", pretty_hotkey(&config(app).hotkeys[0])),
        false => "ShoreShot".into(),
    }
}

fn tray_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let c = config(app);
    let act = active(app);
    let menu = Menu::new(app)?;
    for m in 0..N {
        let key = if act[m] { format!("    {}", pretty_hotkey(&c.hotkeys[m])) } else { String::new() };
        menu.append(&MenuItem::with_id(app, MODES[m], format!("{}{key}", MODE_LABEL[m]), true, None::<&str>)?)?;
    }
    // The first section is only what starts a capture; Settings opens the second one.
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?)?;
    if let Some((version, _)) = st(app).update.lock().unwrap().clone() {
        menu.append(&MenuItem::with_id(app, "update", format!("Update to {version}…"), true, None::<&str>)?)?;
    }
    let about = format!("About ShoreShot {}", app.package_info().version);
    menu.append(&MenuItem::with_id(app, "about", about, true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, "issues", "Report an issue…", true, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "quit", "Quit ShoreShot", true, None::<&str>)?)?;
    Ok(menu)
}

/// Menus are AppKit objects: rebuilt on the main thread.
fn refresh_tray(app: &AppHandle) {
    let a = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(tray) = a.tray_by_id("main") else { return };
        if let Ok(menu) = tray_menu(&a) {
            let _ = tray.set_menu(Some(menu));
        }
        let _ = tray.set_tooltip(Some(tray_tooltip(&a)));
    });
}

// ---------- settings window ----------
fn open_settings(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    let built = tauri::WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
        .title("ShoreShot Settings")
        // The page gets 452; on macOS the title bar takes 32 of the inner size.
        .inner_size(440.0, if cfg!(windows) { 452.0 } else { 484.0 })
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .background_color(tauri::window::Color(0x1c, 0x1c, 0x1e, 0xff))
        .center()
        .build();
    match built {
        Ok(win) => {
            let _ = win.set_focus(); // also activates the app (it has no Dock icon)
            let a = app.clone();
            win.on_window_event(move |ev| {
                if let WindowEvent::Destroyed = ev {
                    register_all(&a); // closed while recording a hotkey
                    refresh_tray(&a);
                }
            });
        }
        Err(e) => log_line(&format!("settings window: {e}")),
    }
}

#[tauri::command]
fn settings_get(app: AppHandle) -> Value {
    let c = config(&app);
    let act = active(&app);
    let hotkeys: serde_json::Map<String, Value> = (0..N)
        .map(|m| {
            let h = &c.hotkeys[m];
            (MODES[m].to_string(), json!({ "hotkey": h, "pretty": pretty_hotkey(h), "active": act[m] }))
        })
        .collect();
    let defaults: serde_json::Map<String, Value> =
        MODES.iter().zip(DEFAULT_HOTKEYS).map(|(m, d)| (m.to_string(), json!(d))).collect();
    json!({
        "retina1x": c.retina1x,
        "openAtLogin": plat::open_at_login(),
        "version": app.package_info().version.to_string(),
        "update": st(&app).update.lock().unwrap().as_ref().map(|u| u.0.clone()),
        "hotkeys": hotkeys,
        "defaults": defaults,
    })
}

#[tauri::command]
fn settings_set_hotkey(app: AppHandle, mode: String, accel: String) -> Value {
    let Some(m) = MODES.iter().position(|x| *x == mode) else {
        return json!({ "ok": false, "error": "Invalid hotkey." });
    };
    match set_hotkey(&app, m, &accel) {
        Ok(h) => json!({ "ok": true, "hotkey": h, "pretty": pretty_hotkey(&h) }),
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

/// While recording a new hotkey, unregister them all so pressing one doesn't start a capture.
#[tauri::command]
fn settings_recording(app: AppHandle, on: bool) {
    if !on {
        return register_all(&app);
    }
    let _ = app.global_shortcut().unregister_all();
    *st(&app).hotkeys.lock().unwrap() = Default::default();
}

/// Checkbox options in Settings. Returns the value actually applied.
#[tauri::command]
fn settings_set_option(app: AppHandle, name: String, on: bool) -> bool {
    match name.as_str() {
        "openAtLogin" => plat::set_open_at_login(on),
        "retina1x" => {
            update_config(&app, |c| c.retina1x = on);
            on
        }
        _ => false,
    }
}

#[tauri::command]
fn settings_link(app: AppHandle, name: String) {
    match name.as_str() {
        "about" => plat::open_url(REPO_URL),
        "issues" => plat::open_url(&format!("{REPO_URL}/issues/new")),
        "update" => show_update(&app),
        _ => {}
    }
}

// ---------- dialogs ----------
/// Message box, from a worker thread (see mac.rs: non-modal). Counted so no capture starts over it.
fn dialog(app: &AppHandle, msg: &str, detail: &str, buttons: &[&str], cancel: usize) -> usize {
    let s = st(app);
    s.dialogs.fetch_add(1, SeqCst);
    let r = plat::dialog(app, msg, detail, buttons, cancel);
    s.dialogs.fetch_sub(1, SeqCst);
    r
}

fn error_box(app: &AppHandle, msg: String) {
    let a = app.clone();
    std::thread::spawn(move || dialog(&a, "ShoreShot", &msg, &["OK"], 0));
}

// ---------- update check ----------
/// true if version a is newer than b ("0.1.10" > "0.1.9").
fn is_newer(a: &str, b: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> { v.split('.').map(|p| p.parse().unwrap_or(0)).collect() };
    let (pa, pb) = (parse(a), parse(b));
    for i in 0..3 {
        let (x, y) = (pa.get(i).copied().unwrap_or(0), pb.get(i).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    false
}

/// `curl`, which ships with macOS and Windows 10 1803+: ShoreShot's only way onto the network.
fn curl() -> std::process::Command {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut curl = std::process::Command::new("curl");
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut curl, 0x0800_0000); // CREATE_NO_WINDOW
    curl
}

/// Ask GitHub for the latest release; on a newer one, add a tray item (and a link in Settings).
fn check_for_update(app: &AppHandle) {
    let out = curl()
        .args(["-fsSL", "--max-time", "30", "-H", "Accept: application/vnd.github+json"])
        .arg("https://api.github.com/repos/nguucode/shoreshot/releases/latest")
        .output();
    let Ok(out) = out else { return }; // offline: try again on the next check
    let Ok(v) = serde_json::from_slice::<Value>(&out.stdout) else { return };
    let (Some(tag), Some(url)) = (v["tag_name"].as_str(), v["html_url"].as_str()) else { return };
    let version = tag.trim_start_matches('v').to_string();
    let current = app.package_info().version.to_string();
    {
        let s = st(app);
        let mut update = s.update.lock().unwrap();
        if !is_newer(&version, &current) || update.as_ref().is_some_and(|u| u.0 == version) {
            return;
        }
        *update = Some((version, url.to_string()));
    }
    refresh_tray(app);
}

fn show_update(app: &AppHandle) {
    let Some((version, url)) = st(app).update.lock().unwrap().clone() else { return };
    let a = app.clone();
    std::thread::spawn(move || {
        let (command, shell) = if cfg!(windows) {
            ("irm https://raw.githubusercontent.com/nguucode/shoreshot/main/scripts/install.ps1 | iex", "PowerShell")
        } else {
            ("curl -fsSL https://raw.githubusercontent.com/nguucode/shoreshot/main/scripts/install.sh | bash", "Terminal")
        };
        let detail = format!(
            "You have {}. To update, run the install command again in {shell}:\n\n{command}\n\nYour settings and permissions are kept.",
            a.package_info().version
        );
        let msg = format!("ShoreShot {version} is available");
        let buttons = ["Copy command", "Open release page", "Later"];
        match dialog(&a, &msg, &detail, &buttons, 2) {
            0 => {
                let _ = a.run_on_main_thread(move || plat::clipboard_text(command));
            }
            1 => plat::open_url(&url),
            _ => {}
        }
    });
}

// ---------- permission ----------
/// Without Screen Recording permission, ask for it instead of showing an error. The first time macOS asks
/// (its prompt opens System Settings); it only asks once, so after that ShoreShot explains. Worker thread.
fn ensure_permission(app: &AppHandle) {
    if plat::screen_access() {
        return;
    }
    // What puts ShoreShot in the Screen Recording list (after a reset it isn't there); prompts if it still can.
    plat::request_screen_access();
    if !config(app).screen_asked {
        update_config(app, |c| c.screen_asked = true);
        return;
    }
    let choice = dialog(
        app,
        "Allow ShoreShot to record the screen to take screenshots",
        "Open System Settings > Privacy & Security > Screen & System Audio Recording and turn on ShoreShot. When macOS asks to reopen the app, choose \"Quit & Reopen\", then press the hotkey again.\n\nShoreShot is already on but capture still fails? Choose Reset permission and allow it again.",
        &["Open System Settings", "Reset permission", "Later"],
        2,
    );
    if choice == 0 {
        plat::open_url("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
    } else if choice == 1 {
        // ShoreShot shows as allowed but capture fails: macOS holds a grant for an older signature.
        plat::reset_permission("ScreenCapture");
        update_config(app, |c| c.screen_asked = false);
        ensure_permission(app);
    }
}

// ---------- capture ----------
/// Hotkey / tray -> overlay. Main thread, synchronous up to showing the overlay.
fn start_capture(app: &AppHandle, m: usize) {
    let s = st(app);
    if s.dialogs.load(SeqCst) > 0 {
        return log_line(&format!("{} ignored: a dialog is open", MODES[m]));
    }
    if s.open.load(SeqCst) {
        if s.visible.load(SeqCst) {
            plat::focus_overlay(app);
        }
        return;
    }
    *s.t0.lock().unwrap() = Some(Instant::now());
    s.marks.lock().unwrap().clear();
    let (cx, cy) = plat::cursor();
    mark(app, &format!("display {}", MODES[m]));
    if !plat::screen_access() {
        mark(app, "no permission");
        flush_marks(app);
        let a = app.clone();
        std::thread::spawn(move || ensure_permission(&a));
        return;
    }
    mark(app, "permission");
    if let Err(e) = capture(app, m, cx, cy) {
        capture_failed(app, e);
    }
}

fn capture(app: &AppHandle, m: usize, cx: f64, cy: f64) -> Result<(), String> {
    let mon = xcap::Monitor::from_point(cx as i32, cy as i32).map_err(|e| e.to_string())?;
    let geo = || -> xcap::XCapResult<Rect> {
        Ok((mon.x()? as f64, mon.y()? as f64, mon.width()? as f64, mon.height()? as f64))
    };
    let frame = geo().map_err(|e| e.to_string())?;
    mark(app, "monitor");
    let img = mon.capture_image().map_err(|e| e.to_string())?;
    let (px_w, px_h) = img.dimensions();
    mark(app, &format!("captured {px_w}x{px_h}"));

    // macOS: frame and cursor are points (= CSS px). Windows: physical pixels, CSS px = physical / scale.
    #[cfg(windows)]
    let k = plat::scale(&mon);
    #[cfg(not(windows))]
    let k = 1.0;
    let s = st(app);
    let c = config(app);
    s.open.store(true, SeqCst);
    s.visible.store(false, SeqCst);
    let generation = s.generation.fetch_add(1, SeqCst) + 1;
    *s.windows_for.lock().unwrap() = (m == 2).then_some(frame);
    plat::show_hidden(app, frame);
    let meta = json!({
        "mode": MODES[m],
        "cursor": { "x": (cx - frame.0) / k, "y": (cy - frame.1) / k },
        "pxW": px_w, "pxH": px_h, "width": (frame.2 / k).round(), "height": (frame.3 / k).round(),
        "retina1x": c.retina1x,
        "autoKey": std::env::var("SHORESHOT_AUTO_KEY").ok(),
    });
    // Windows: Tauri's IPC moves only ~50 MB/s through WebView2 (a 4K frame took ~320 ms), so the bitmap goes
    // through a WebView2 shared buffer (~20 ms). If that fails it comes back and goes over IPC like on macOS.
    #[cfg(windows)]
    {
        let a = app.clone();
        plat::post_frame(app, img.into_raw(), meta, move |r| match r {
            Ok(()) => mark(&a, "posted"),
            Err((rgba, meta, why)) => {
                mark(&a, &why);
                send_ipc(&a, rgba, meta);
            }
        });
    }
    #[cfg(not(windows))]
    send_ipc(app, img.into_raw(), meta);
    // Safety valve: if the page never reports ready, hide instead of revealing an unresponsive overlay.
    let a = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(WATCHDOG);
        let b = a.clone();
        let _ = a.run_on_main_thread(move || {
            let s = st(&b);
            if s.open.load(SeqCst) && !s.visible.load(SeqCst) && s.generation.load(SeqCst) == generation {
                mark(&b, "watchdog-hide");
                hide(&b);
            }
        });
    });
    Ok(())
}

/// The page pulls the bitmap with `invoke('bitmap')` after 'capture:show'.
fn send_ipc(app: &AppHandle, rgba: Vec<u8>, meta: Value) {
    *st(app).bitmap.lock().unwrap() = rgba;
    let _ = app.emit_to("overlay", "capture:show", meta);
    mark(app, "sent");
}

fn capture_failed(app: &AppHandle, err: String) {
    mark(app, &format!("failed: {err}"));
    flush_marks(app);
    let a = app.clone();
    if !plat::screen_access() {
        // Permission was turned off mid-run: explain how to turn it back on instead of erroring.
        std::thread::spawn(move || ensure_permission(&a));
    } else {
        error_box(app, format!("Capture failed: {err}"));
    }
}

/// Main thread. Hide (not close) so the next capture skips window creation; the page frees the image.
fn hide(app: &AppHandle) {
    let s = st(app);
    s.open.store(false, SeqCst);
    s.visible.store(false, SeqCst);
    *s.windows_for.lock().unwrap() = None;
    plat::hide_overlay(app);
    s.bitmap.lock().unwrap().clear();
    let _ = app.emit_to("overlay", "capture:hidden", ());
    flush_marks(app); // only the watchdog leaves marks here; normally they went out at reveal
}

/// Windows on the display, front to back, relative to it. Skips slivers (menu bar items) and windows
/// covering the whole display (the overlay itself, the desktop), so clicking empty desktop means the whole screen.
fn list_windows(d: Rect) -> Vec<Value> {
    let Ok(all) = xcap::Window::all() else { return vec![] }; // falls back to area selection
    // Windows: frames are physical pixels; the page wants CSS px of this display. macOS: already points.
    #[cfg(windows)]
    let k = xcap::Monitor::from_point(d.0 as i32, d.1 as i32).map(|m| plat::scale(&m)).unwrap_or(1.0);
    #[cfg(not(windows))]
    let k = 1.0;
    all.iter()
        .filter(|w| !w.is_minimized().unwrap_or(false)) // Windows parks minimized windows at -32000
        .filter_map(|w| {
            let r = (w.x().ok()? as f64, w.y().ok()? as f64, w.width().ok()? as f64, w.height().ok()? as f64);
            let (x, y, w, h) = clip(r, d, k)?;
            Some(json!({ "x": x, "y": y, "w": w, "h": h }))
        })
        .collect()
}

/// Clip to the display and convert to CSS px relative to it (`k` = physical px per CSS px; 1 on macOS).
fn clip((x, y, w, h): Rect, (dx, dy, dw, dh): Rect, k: f64) -> Option<Rect> {
    let (x1, y1) = (x.max(dx), y.max(dy));
    let (x2, y2) = ((x + w).min(dx + dw), (y + h).min(dy + dh));
    if (x2 - x1) / k < 40.0 || (y2 - y1) / k < 40.0 || (x2 - x1 >= dw && y2 - y1 >= dh) {
        return None;
    }
    Some(((x1 - dx) / k, (y1 - dy) / k, (x2 - x1) / k, (y2 - y1) / k))
}

// ---------- renderer commands ----------
#[tauri::command]
fn bitmap(app: AppHandle) -> Response {
    mark(&app, "bitmap");
    Response::new(std::mem::take(&mut *st(&app).bitmap.lock().unwrap()))
}

/// The page painted the capture: make the overlay visible.
#[tauri::command]
fn ready(app: AppHandle, transfer_ms: u64) {
    let a = app.clone();
    let _ = app.run_on_main_thread(move || {
        let s = st(&a);
        if !s.open.load(SeqCst) || s.visible.swap(true, SeqCst) {
            return;
        }
        plat::reveal(&a);
        mark(&a, &format!("visible (bitmap ipc {transfer_ms} ms)"));
        let windows_for = s.windows_for.lock().unwrap().take();
        let b = a.clone();
        std::thread::spawn(move || {
            if let Some(d) = windows_for {
                // ~50 ms: after the overlay is visible, not between the hotkey and the overlay.
                let _ = b.emit_to("overlay", "capture:windows", list_windows(d));
                mark(&b, "windows");
            }
            flush_marks(&b);
            if std::env::var("SHORESHOT_AUTO").is_ok() && std::env::var("SHORESHOT_AUTO_KEY").is_err() {
                std::thread::sleep(Duration::from_secs(1));
                let c = b.clone();
                let _ = b.run_on_main_thread(move || hide(&c));
            }
        });
    });
}

fn png_body(request: &Request<'_>) -> Result<Vec<u8>, String> {
    match request.body() {
        InvokeBody::Raw(png) => Ok(png.clone()),
        _ => Err("expected raw PNG bytes".into()),
    }
}

#[tauri::command]
fn close(app: AppHandle) {
    let a = app.clone();
    let _ = app.run_on_main_thread(move || hide(&a));
}

#[tauri::command]
fn copy(app: AppHandle, request: Request<'_>) -> Result<bool, String> {
    let png = png_body(&request)?;
    let a = app.clone();
    let _ = app.run_on_main_thread(move || {
        hide(&a);
        let t = Instant::now();
        plat::clipboard_image(&png);
        log_line(&format!("copied {} KB PNG in {} ms", png.len() / 1024, t.elapsed().as_millis()));
    });
    Ok(true)
}

/// Copy, then auto-paste (⌘V) into the app that was active before the capture.
#[tauri::command]
fn copy_paste(app: AppHandle, request: Request<'_>) -> Result<bool, String> {
    let png = png_body(&request)?;
    let a = app.clone();
    let _ = app.run_on_main_thread(move || {
        hide(&a);
        plat::clipboard_image(&png);
        paste_into_previous_app(&a, "Image");
    });
    Ok(true)
}

/// Main thread, after hiding the overlay and filling the clipboard with `what` ("Image" / "Text").
fn paste_into_previous_app(app: &AppHandle, what: &'static str) {
    #[cfg(target_os = "macos")]
    let _ = app.hide(); // give focus back to the previous app (Windows: hiding the overlay already does)
    let b = app.clone();
    std::thread::spawn(move || {
        if !plat::accessibility(true) {
            // accessibility(true) showed the macOS prompt
            let choice = dialog(
                &b,
                &format!("{what} copied, but it could not be pasted automatically"),
                "To auto-paste, allow ShoreShot in System Settings > Privacy & Security > Accessibility, then reopen the app. For now, press ⌘V to paste.\n\nShoreShot is already on but pasting still fails? Choose Reset permission and allow it again.",
                &["OK", "Reset permission"],
                0,
            );
            if choice == 1 {
                plat::reset_permission("Accessibility");
                plat::accessibility(true);
            }
            return;
        }
        std::thread::sleep(Duration::from_millis(250));
        if let Err(e) = plat::paste_keystroke() {
            let key = if cfg!(windows) { "Ctrl+V" } else { "⌘V" };
            error_box(&b, format!("{what} copied, but auto-paste failed: {e}. Press {key} to paste."));
        }
    });
}

#[tauri::command]
async fn save(app: AppHandle, request: Request<'_>) -> Result<bool, String> {
    let png = png_body(&request)?;
    let a = app.clone();
    let _ = app.run_on_main_thread(move || plat::hide_overlay(&a)); // out of the Save panel's way; still open
    let name = format!("Screenshot {}.png", plat::timestamp());
    let a = app.clone();
    let path = tauri::async_runtime::spawn_blocking(move || {
        let s = st(&a);
        s.dialogs.fetch_add(1, SeqCst);
        let p = plat::save_dialog(&a, &name);
        s.dialogs.fetch_sub(1, SeqCst);
        p
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(path) = path else {
        let a = app.clone();
        let _ = app.run_on_main_thread(move || {
            if st(&a).open.load(SeqCst) {
                plat::focus_overlay(&a);
            }
        });
        return Ok(false);
    };
    let written = std::fs::write(&path, &png);
    let a = app.clone();
    let _ = app.run_on_main_thread(move || hide(&a));
    if let Err(e) = written {
        error_box(&app, format!("Could not save {}: {e}", path.display()));
        return Ok(false);
    }
    Ok(true)
}

/// Copy-text mode: the text in the selection (a PNG), as fragments for the page to lay out. Off the main thread.
#[tauri::command]
async fn ocr(request: Request<'_>) -> Result<Value, String> {
    let png = png_body(&request)?;
    let t = Instant::now();
    let found = tauri::async_runtime::spawn_blocking(move || plat::ocr(&png)).await.map_err(|e| e.to_string())?;
    match &found {
        Ok(f) => log_line(&format!("ocr: {} fragments in {} ms", f.len(), t.elapsed().as_millis())),
        Err(e) => log_line(&format!("ocr failed: {e}")),
    }
    let rows = found?.into_iter().map(|f| {
        let (x, y, w, h) = f.rect;
        json!({ "t": f.text, "x": x, "y": y, "w": w, "h": h })
    });
    Ok(rows.collect())
}

/// Copy-text mode: ⌘C copies (the page closes the overlay after its HUD), ⌘V also pastes like `copy_paste`.
#[tauri::command]
fn copy_text(app: AppHandle, text: String, paste: bool) {
    let a = app.clone();
    let _ = app.run_on_main_thread(move || {
        if paste {
            hide(&a);
        }
        plat::clipboard_text(&text);
        if paste {
            paste_into_previous_app(&a, "Text");
        }
    });
}

/// Copy-text mode, ⌘T: `text` in Vietnamese (`to` = "vi") or English ("en"), from Google Translate's free
/// endpoint (no key; unofficial, so it can change or refuse). The only time text from the screen leaves the
/// machine, and only on that key. The text goes to curl on stdin: no length limit, nothing in the process list.
#[tauri::command]
async fn translate(text: String, to: String) -> Result<String, String> {
    if to != "vi" && to != "en" {
        return Err("unknown language".into());
    }
    let run = move || -> Result<String, String> {
        use std::process::Stdio;
        let url = format!("https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl={to}&dt=t");
        let mut child = curl()
            .args(["-fsS", "--max-time", "10", "--data-urlencode", "q@-", &url])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        child.stdin.take().expect("piped").write_all(text.as_bytes()).map_err(|e| e.to_string())?; // drop = EOF
        let out = child.wait_with_output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        serde_json::from_slice(&out.stdout).ok().and_then(|v| parse_translation(&v)).ok_or("unexpected reply".into())
    };
    let done = tauri::async_runtime::spawn_blocking(run).await.map_err(|e| e.to_string())?;
    if let Err(e) = &done {
        log_line(&format!("translate failed: {e}"));
    }
    done
}

/// The reply is `[[[translated, original, …], …], null, "en", …]`: the translated pieces, in order.
fn parse_translation(reply: &Value) -> Option<String> {
    let text: String = reply[0].as_array()?.iter().filter_map(|piece| piece[0].as_str()).collect();
    (!text.is_empty()).then_some(text)
}

#[tauri::command]
fn log(line: String) {
    log_line(&line);
}

// ---------- app ----------
fn main() {
    let builder = tauri::Builder::default();
    // Windows: a second launch (Start menu, the installer's "Run ShoreShot") captures, like Electron's
    // second-instance. Registered first so the second process exits before anything else starts.
    #[cfg(windows)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| start_capture(app, 0)));
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_nspanel::init());
    builder
        .manage(State::default())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, sc, ev| {
                    if ev.state != ShortcutState::Pressed {
                        return;
                    }
                    let m = st(app).hotkeys.lock().unwrap().iter().position(|h| h.as_ref() == Some(sc));
                    if let Some(m) = m {
                        start_capture(app, m);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            bitmap,
            ready,
            close,
            copy,
            copy_paste,
            save,
            ocr,
            copy_text,
            translate,
            log,
            settings_get,
            settings_set_hotkey,
            settings_recording,
            settings_set_option,
            settings_link
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory); // no Dock icon
            let handle = app.handle().clone();
            *st(&handle).config.lock().unwrap() = Some(load_config());
            prepare_log();
            register_all(&handle);
            create_tray(&handle)?;
            plat::create_overlay(&handle)?; // created up front so the hotkey shows it instantly
            let c = config(&handle);
            if (0..N).any(|m| !c.hotkeys[m].is_empty() && !active(&handle)[m]) {
                open_settings(&handle); // a saved hotkey is taken by another app: let the user pick another
            }
            let h = handle.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(5));
                loop {
                    check_for_update(&h);
                    std::thread::sleep(UPDATE_CHECK);
                }
            });
            if let Ok(n) = std::env::var("SHORESHOT_AUTO") {
                let mode = std::env::var("SHORESHOT_AUTO_MODE").unwrap_or_default();
                let m = MODES.iter().position(|x| *x == mode).unwrap_or(0);
                let settings = mode == "settings";
                std::thread::spawn(move || {
                    for _ in 0..n.parse::<u32>().unwrap_or(3) {
                        std::thread::sleep(Duration::from_secs(3));
                        let a = handle.clone();
                        let _ = handle.run_on_main_thread(move || match settings {
                            true => open_settings(&a),
                            false => start_capture(&a, m),
                        });
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("tauri build")
        .run(|_app, ev| match ev {
            // Opening the app again (Finder, Spotlight, `open`) starts a capture, like Electron's second-instance.
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => start_capture(_app, 0),
            // Keep running in the background when Settings closes.
            RunEvent::ExitRequested { code: None, api, .. } => api.prevent_exit(),
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helpers() {
        assert_eq!(iso(0, 0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso(1_794_412_920, 7), "2026-11-11T16:02:00.007Z");
        assert_eq!(iso(951_782_400, 0), "2000-02-29T00:00:00.000Z");
        assert!(is_newer("0.1.10", "0.1.9") && !is_newer("1.1.0", "1.1.0") && is_newer("2", "1.9.9"));
        assert_eq!(pretty_hotkey("CommandOrControl+Shift+X"), if cfg!(windows) { "Ctrl+Shift+X" } else { "⌘⇧X" });
        assert!(parse_accel("Command+Alt+numsub").is_some() && parse_accel("Control+Shift+Up").is_some());
        assert!(parse_accel("Shift+nope").is_none());
        let d = (0.0, 0.0, 1000.0, 800.0);
        assert_eq!(clip((-10.0, 100.0, 300.0, 200.0), d, 1.0), Some((0.0, 100.0, 290.0, 200.0)));
        assert_eq!(clip((0.0, 0.0, 1000.0, 24.0), d, 1.0), None); // menu bar
        assert_eq!(clip((0.0, 0.0, 1000.0, 800.0), d, 1.0), None); // covers the display
        // Windows, a 150 % monitor right of a 1920 px one: physical px in, CSS px of that monitor out.
        let d2 = (1920.0, 0.0, 3840.0, 2160.0);
        assert_eq!(clip((1000.0, 0.0, 1220.0, 600.0), d2, 1.5), Some((0.0, 0.0, 200.0, 400.0)));
        assert_eq!(clip((5000.0, 100.0, 50.0, 50.0), d2, 1.5), None); // 33 CSS px: a sliver
        let c = parse_config(&json!({ "hotkey": "Alt+Q", "retina1x": true }));
        assert_eq!((c.hotkeys[0].as_str(), c.hotkeys[1].as_str(), c.retina1x, c.screen_asked), ("Alt+Q", "", true, false));
        // Configs from before copy-text get its default hotkey, and that default is a valid shortcut.
        assert_eq!(c.hotkeys[3], DEFAULT_HOTKEYS[3]);
        assert!(parse_accel(DEFAULT_HOTKEYS[3]).is_some());
        // A real reply from the translate endpoint, trimmed.
        let reply = json!([[["Nút\n", "Button\n", null, null, 3], ["- Tổng quan", "- Overview", null, null, 3]], null, "en"]);
        assert_eq!(parse_translation(&reply).as_deref(), Some("Nút\n- Tổng quan"));
        assert_eq!(parse_translation(&json!([null, null, "en"])), None);
    }
}
