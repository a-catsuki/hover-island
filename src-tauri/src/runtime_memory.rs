//! Keep browser caches economical and return unused native heap pages to Windows.
//! Live allocations are never paged out to make a working-set number look smaller.

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::AppHandle;
static AMBIENT_COVERING: AtomicBool = AtomicBool::new(false);
static MAIN_WAS_VISIBLE: AtomicBool = AtomicBool::new(false);

pub fn ambient_covering() -> bool {
    AMBIENT_COVERING.load(Ordering::Acquire)
}

/// Keep the covered notch's state, but stop its renderer and compositor work.
pub fn set_ambient_covering(app: &AppHandle, covered: bool) {
    use tauri::Manager;
    if AMBIENT_COVERING.swap(covered, Ordering::AcqRel) == covered {
        return;
    }
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if covered {
        let visible = window.is_visible().unwrap_or(false);
        MAIN_WAS_VISIBLE.store(visible, Ordering::Release);
        if visible {
            let _ = window.hide();
            #[cfg(windows)]
            platform::set_suspended(app, true);
        }
    } else if MAIN_WAS_VISIBLE.swap(false, Ordering::AcqRel) {
        #[cfg(windows)]
        platform::set_suspended(app, false);
        if !crate::window::main_hidden_by_user() {
            let _ = window.show();
        }
    }
}

#[cfg(windows)]
mod platform {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Manager};
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, ICoreWebView2_3, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
    };
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Memory::{HeapOptimizeResources, HeapSetInformation};
    use windows_core::Interface;

    static REPORTED_UNAVAILABLE: AtomicBool = AtomicBool::new(false);
    static RELEASE_PENDING: AtomicBool = AtomicBool::new(false);
    static LAST_RELEASE: std::sync::Mutex<Option<Instant>> = std::sync::Mutex::new(None);
    const SETTLE: Duration = Duration::from_millis(1500);
    const MIN_INTERVAL: Duration = Duration::from_secs(30);

    // HEAP_OPTIMIZE_RESOURCES_INFORMATION from winnt.h (Windows 8.1+).
    #[repr(C)]
    struct HeapResources {
        version: u32,
        flags: u32,
    }

    pub fn set_suspended(app: &AppHandle, suspended: bool) {
        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        let _ = window.with_webview(move |webview| {
            let result = unsafe {
                webview.controller().CoreWebView2().and_then(|core| {
                    let core = core.cast::<ICoreWebView2_3>()?;
                    if suspended {
                        webview.controller().SetIsVisible(false)?;
                        let callback =
                            webview2_com::TrySuspendCompletedHandler::create(Box::new(|_, _| {
                                Ok(())
                            }));
                        core.TrySuspend(&callback)
                    } else {
                        core.Resume()?;
                        webview.controller().SetIsVisible(true)
                    }
                })
            };
            if let Err(error) = result {
                eprintln!("Could not change covered notch activity: {error}");
            }
        });
    }

    pub fn schedule_release() {
        if RELEASE_PENDING.swap(true, Ordering::AcqRel) {
            return;
        }
        let spawned = std::thread::Builder::new()
            .name("hover-heap-release".into())
            .stack_size(128 * 1024)
            .spawn(|| {
                let wait = LAST_RELEASE
                    .lock()
                    .ok()
                    .and_then(|last| *last)
                    .map(|at| MIN_INTERVAL.saturating_sub(at.elapsed()).max(SETTLE))
                    .unwrap_or(SETTLE);
                std::thread::sleep(wait);
                let info = HeapResources {
                    version: 1,
                    flags: 0,
                };
                // NULL selects this process's heaps. Decommit free LFH cache pages;
                // unlike EmptyWorkingSet, live data stays resident and responsive.
                let _ = unsafe {
                    HeapSetInformation(
                        HANDLE(0),
                        HeapOptimizeResources,
                        Some((&info as *const HeapResources).cast()),
                        std::mem::size_of::<HeapResources>(),
                    )
                };
                if let Ok(mut last) = LAST_RELEASE.lock() {
                    *last = Some(Instant::now());
                }
                RELEASE_PENDING.store(false, Ordering::Release);
            });
        if spawned.is_err() {
            RELEASE_PENDING.store(false, Ordering::Release);
        }
    }

    pub fn set_low(app: &AppHandle, label: &str) {
        let Some(window) = app.get_webview_window(label) else {
            return;
        };
        let result = window.with_webview(move |webview| {
            let result = unsafe {
                webview.controller().CoreWebView2().and_then(|core| {
                    core.cast::<ICoreWebView2_19>().and_then(|memory| {
                        memory.SetMemoryUsageTargetLevel(COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW)
                    })
                })
            };
            if let Err(error) = result {
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
}

pub fn release_native_caches() {
    #[cfg(windows)]
    platform::schedule_release();
}

pub fn set_main_active(app: &AppHandle, active: bool) {
    #[cfg(windows)]
    platform::set_low(app, "main");
    #[cfg(not(windows))]
    let _ = app;
    if !active {
        release_native_caches();
    }
}

pub fn set_settings_active(app: &AppHandle, active: bool) {
    #[cfg(windows)]
    platform::set_low(app, "settings");
    #[cfg(not(windows))]
    let _ = app;
    if !active {
        release_native_caches();
    }
}

pub fn set_ambient_active(app: &AppHandle, active: bool) {
    #[cfg(windows)]
    platform::set_low(app, "ambient");
    #[cfg(not(windows))]
    let _ = app;
    if !active {
        release_native_caches();
    }
}
