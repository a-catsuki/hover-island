//! Ambient mode: after the PC has been idle for a while, show a full-screen clock, now-playing
//! and weather page. Any keyboard or mouse input closes it again. Idle time comes from
//! `GetLastInputInfo`, so it needs no hooks and reads nothing about what is typed.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, WebviewUrl};

use crate::state::AppState;

const LABEL: &str = "ambient";
/// Input that happens this soon after opening is the user's own click or key, not a wake-up.
const OPEN_GRACE: Duration = Duration::from_millis(1500);
/// How long before the Windows screen saver would start that ambient mode takes over.
const SAVER_LEAD_MS: u64 = 20_000;

/// True while ambient mode wants the screen saver and display sleep held off.
static HOLD_DISPLAY: AtomicBool = AtomicBool::new(false);

/// Seconds until Windows would start its screen saver, or `None` when it is switched off.
#[cfg(windows)]
fn screensaver_timeout_ms() -> Option<u64> {
    use windows::Win32::UI::WindowsAndMessaging::{
        SystemParametersInfoW, SPI_GETSCREENSAVEACTIVE, SPI_GETSCREENSAVETIMEOUT,
        SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
    };
    let mut active: u32 = 0;
    let mut seconds: u32 = 0;
    // SAFETY: both out-pointers are valid u32 values that live for the calls.
    unsafe {
        SystemParametersInfoW(SPI_GETSCREENSAVEACTIVE, 0, Some(&mut active as *mut u32 as *mut _), SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0)).ok()?;
        if active == 0 {
            return None;
        }
        SystemParametersInfoW(SPI_GETSCREENSAVETIMEOUT, 0, Some(&mut seconds as *mut u32 as *mut _), SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0)).ok()?;
    }
    (seconds > 0).then(|| u64::from(seconds) * 1000)
}

#[cfg(not(windows))]
fn screensaver_timeout_ms() -> Option<u64> {
    None
}

/// Keeps the display (and with it the screen saver timer) from running out while ambient mode is
/// on screen. The execution state belongs to one thread, so a small thread owns it.
#[cfg(windows)]
fn spawn_display_holder() {
    use windows::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS, ES_DISPLAY_REQUIRED};
    let _ = std::thread::Builder::new().name("ambient-display-hold".into()).spawn(|| {
        let mut holding = false;
        loop {
            let want = HOLD_DISPLAY.load(Ordering::Relaxed);
            if want != holding {
                // SAFETY: plain Win32 call with documented flag values.
                unsafe {
                    SetThreadExecutionState(if want { ES_CONTINUOUS | ES_DISPLAY_REQUIRED } else { ES_CONTINUOUS });
                }
                holding = want;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    });
}

#[cfg(not(windows))]
fn spawn_display_holder() {}

#[cfg(windows)]
fn idle_millis() -> Option<u64> {
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    let mut info = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    // SAFETY: `info` is a correctly sized LASTINPUTINFO that lives for the call.
    unsafe {
        if !GetLastInputInfo(&mut info).as_bool() {
            return None;
        }
        Some(u64::from(GetTickCount().wrapping_sub(info.dwTime)))
    }
}

#[cfg(not(windows))]
fn idle_millis() -> Option<u64> {
    None
}

fn is_open(app: &AppHandle) -> bool {
    app.get_webview_window(LABEL).is_some()
}

fn open(app: &AppHandle) -> Result<(), String> {
    if is_open(app) {
        return Ok(());
    }
    let window = tauri::WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("ambient.html".into()))
        .title("Hover Island Ambient")
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .transparent(false)
        .disable_drag_drop_handler()
        .visible(false)
        .build()
        .map_err(|error| format!("Could not open ambient mode: {error}"))?;
    window.set_fullscreen(true).map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    let _ = window.set_focus();
    Ok(())
}

fn close(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.destroy();
    }
}

/// Polls twice a second while ambient mode is on, and once every few seconds otherwise.
pub fn spawn(app: AppHandle) {
    spawn_display_holder();
    tauri::async_runtime::spawn(async move {
        let mut opened_at: Option<Instant> = None;
        loop {
            let cfg = app
                .state::<AppState>()
                .settings
                .lock()
                .map(|settings| settings.ambient.clone())
                .ok();
            let Some(cfg) = cfg else {
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            };
            let open_now = is_open(&app);
            if !open_now {
                opened_at = None;
            }
            HOLD_DISPLAY.store(open_now && cfg.take_over_screensaver, Ordering::Relaxed);
            // Start ahead of the Windows screen saver, so ambient mode is what shows instead of it.
            let mut threshold = u64::from(cfg.idle_minutes) * 60_000;
            if cfg.take_over_screensaver {
                if let Some(saver) = screensaver_timeout_ms() {
                    threshold = threshold.min(saver.saturating_sub(SAVER_LEAD_MS).max(10_000));
                }
            }
            if let Some(idle) = idle_millis() {
                if open_now {
                    let since_open = opened_at.get_or_insert_with(Instant::now).elapsed();
                    // Input after the grace period means the user is back.
                    if since_open > OPEN_GRACE && idle + OPEN_GRACE.as_millis() as u64 + 200 < since_open.as_millis() as u64 {
                        close(&app);
                        opened_at = None;
                    }
                } else if cfg.enabled && idle >= threshold {
                    if open(&app).is_ok() {
                        opened_at = Some(Instant::now());
                    }
                }
            }
            let wait = if open_now || cfg.enabled { 700 } else { 4000 };
            tokio::time::sleep(Duration::from_millis(wait)).await;
        }
    });
}

#[tauri::command]
pub async fn ambient_open(app: AppHandle) -> Result<(), String> {
    open(&app)
}

#[tauri::command]
pub async fn ambient_close(app: AppHandle) -> Result<(), String> {
    close(&app);
    Ok(())
}
