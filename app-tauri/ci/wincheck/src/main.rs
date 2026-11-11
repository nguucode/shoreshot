//! CI only: compiles platform/windows.rs on its own and runs its unit tests (`cargo test`), so the Windows
//! module is checked on Windows before and independently of the app that uses it.
#[cfg(windows)]
#[path = "../../../src-tauri/src/platform/windows.rs"]
#[allow(dead_code)]
mod windows;

fn main() {}
