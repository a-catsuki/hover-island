//! Ask WebView2 to release expendable caches while the island is compact.
//!
//! Unlike suspending the renderer, this preserves event delivery, incoming alerts,
//! media controls and immediate hover response. The WebView2 hint is an engine
//! resource hint, not a promise about aggregate process memory. In addition, a
//! few seconds after the island settles collapsed, this process's own working set
//! is trimmed (pages return on demand), at most once every 30 seconds.

use tauri::AppHandle;

#[cfg(windows)]
mod platform {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Manager};
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    use windows::Win32::System::ProcessStatus::K32EmptyWorkingSet;
    use windows::Win32::System::Threading::GetCurrentProcess;
    use windows_core::Interface;

    static MAIN_ACTIVE: AtomicBool = AtomicBool::new(false);
    static SETTINGS_ACTIVE: AtomicBool = AtomicBool::new(false);
    static REPORTED_UNAVAILABLE: AtomicBool = AtomicBool::new(false);
    static TRIM_PENDING: AtomicBool = AtomicBool::new(false);
    static LAST_TRIM: std::sync::Mutex<Option<Instant>> = std::sync::Mutex::new(None);
    const TRIM_SETTLE: Duration = Duration::from_secs(5);
    const TRIM_MIN_INTERVAL: Duration = Duration::from_secs(30);

    /// Trim this process's working set once the island has stayed collapsed.
    /// One short-lived thread at a time; hover thrash cannot pile threads up.
    fn schedule_trim() {
        if TRIM_PENDING.swap(true, Ordering::AcqRel) {
            return;
        }
        let spawned = std::thread::Builder::new()
            .name("hover-island-trim".into())
            .stack_size(128 * 1024)
            .spawn(|| {
                let wait = LAST_TRIM
                    .lock()
                    .ok()
                    .and_then(|last| *last)
                    .map(|at| TRIM_MIN_INTERVAL.saturating_sub(at.elapsed()).max(TRIM_SETTLE))
                    .unwrap_or(TRIM_SETTLE);
                std::thread::sleep(wait);
                TRIM_PENDING.store(false, Ordering::Release);
                if !MAIN_ACTIVE.load(Ordering::Acquire) {
                    // Failure only means the pages stay resident.
                    let _ = unsafe { K32EmptyWorkingSet(GetCurrentProcess()) };
                    if let Ok(mut last) = LAST_TRIM.lock() {
                        *last = Some(Instant::now());
                    }
                }
            });
        if spawned.is_err() {
            TRIM_PENDING.store(false, Ordering::Release);
        }
    }

    fn set_active(app: &AppHandle, label: &str, state: &'static AtomicBool, active: bool) {
        state.store(active, Ordering::Release);
        if !active && label == "main" {
            schedule_trim();
        }
        let Some(window) = app.get_webview_window(label) else {
            return;
        };
        // Tauri executes this closure on the owning UI thread. Read the latest
        // desired state there so queued hover reversals cannot apply stale hints.
        let result = window.with_webview(move |webview| {
            let result = unsafe {
                webview.controller().CoreWebView2().and_then(|core| {
                    core.cast::<ICoreWebView2_19>().and_then(|memory| {
                        memory.SetMemoryUsageTargetLevel(if state.load(Ordering::Acquire) {
                            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
                        } else {
                            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
                        })
                    })
                })
            };
            if let Err(error) = result {
                // Older runtimes may lack this optional interface. Never disable
                // app functionality or replace it with aggressive memory trimming.
                if !REPORTED_UNAVAILABLE.swap(true, Ordering::Relaxed) {
                    eprintln!("WebView2 memory target is unavailable: {error}");
                }
            }
        });
        if let Err(error) = result {
            if !REPORTED_UNAVAILABLE.swap(true, Ordering::Relaxed) {
                eprintln!("Could not update WebView2 memory target: {error}");
            }
        }
    }

    pub fn set_main(app: &AppHandle, active: bool) {
        set_active(app, "main", &MAIN_ACTIVE, active);
    }
    pub fn set_settings(app: &AppHandle, active: bool) {
        set_active(app, "settings", &SETTINGS_ACTIVE, active);
    }
}

/// Call once after main-window setup, and whenever its expanded state changes.
pub fn set_main_active(app: &AppHandle, active: bool) {
    #[cfg(windows)]
    platform::set_main(app, active);
    #[cfg(not(windows))]
    let _ = (app, active);
}

/// Settings can release optional caches while minimized or in the background.
pub fn set_settings_active(app: &AppHandle, active: bool) {
    #[cfg(windows)]
    platform::set_settings(app, active);
    #[cfg(not(windows))]
    let _ = (app, active);
}
