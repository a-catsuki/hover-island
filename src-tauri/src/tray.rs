use std::sync::atomic::Ordering;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

use crate::state::AppState;
use crate::window;

static QUIT_REQUEST_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static QUIT_ACKNOWLEDGED_GENERATION: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

fn request_quit(app: &AppHandle) {
    // Give the user's Windows banner setting back right away; Exit does it again.
    crate::quick_controls::restore_windows_banners_global();
    let generation = QUIT_REQUEST_GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
    let _ = app.emit("app://quit-request", ());
    let fallback_app = app.clone();
    std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if fallback_app
                .state::<AppState>()
                .shutdown
                .load(Ordering::Relaxed)
                || QUIT_ACKNOWLEDGED_GENERATION.load(Ordering::Relaxed) >= generation
            {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let state = fallback_app.state::<AppState>();
        let acknowledged = QUIT_ACKNOWLEDGED_GENERATION.load(Ordering::Relaxed) >= generation;
        if !acknowledged && !state.shutdown.swap(true, Ordering::Relaxed) {
            // Keep Quit usable if the WebView failed and never handled the flush event.
            fallback_app.exit(0);
        }
    });
}

#[tauri::command]
pub fn acknowledge_quit_request() {
    let generation = QUIT_REQUEST_GENERATION.load(Ordering::Relaxed);
    QUIT_ACKNOWLEDGED_GENERATION.store(generation, Ordering::Relaxed);
}

fn toggle_window(app: &AppHandle) {
    let _ = window::toggle_main(app);
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "toggle", "Show / Hide", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show, &sep1, &settings, &sep2, &quit])?;

    let mut builder = TrayIconBuilder::new()
        .tooltip("Hover Island")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "toggle" => toggle_window(app),
            "settings" => {
                // Creating a WebView can deadlock if invoked from the native event loop.
                let app = app.clone();
                std::thread::spawn(move || {
                    let _ = window::open_settings(&app, None);
                });
            }
            "quit" => request_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}
