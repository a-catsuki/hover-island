//! Ambient mode: after the PC has been idle for a while, show a full-screen clock, now-playing
//! and weather page. Any keyboard or mouse input closes it again. Idle time comes from
//! `GetLastInputInfo`, so it needs no hooks and reads nothing about what is typed.

use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, WebviewUrl};

use crate::state::AppState;

const LABEL: &str = "ambient";
/// Input that happens this soon after opening is the user's own click or key, not a wake-up.
const OPEN_GRACE: Duration = Duration::from_millis(1500);

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
            if let Some(idle) = idle_millis() {
                if open_now {
                    let since_open = opened_at.get_or_insert_with(Instant::now).elapsed();
                    // Input after the grace period means the user is back.
                    if since_open > OPEN_GRACE && idle + OPEN_GRACE.as_millis() as u64 + 200 < since_open.as_millis() as u64 {
                        close(&app);
                        opened_at = None;
                    }
                } else if cfg.enabled && idle >= u64::from(cfg.idle_minutes) * 60_000 {
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
