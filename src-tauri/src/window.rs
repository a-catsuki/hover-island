use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, WebviewUrl};

use crate::settings::Size;
use crate::state::AppState;

static SETTINGS_WINDOW_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
static SETTINGS_WINDOW_GENERATION: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);
static MAIN_HIDDEN_BY_USER: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
const MAIN_WINDOW_BACKGROUND: (u8, u8, u8, u8) = (0, 0, 0, 0);

fn es<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// The island WebView keeps its expanded bounds at all times. Hover only changes CSS
/// state and hit testing; resizing a layered transparent window causes visible jank.
pub fn apply_expanded(app: &AppHandle, expanded: bool) -> tauri::Result<()> {
    let state = app.state::<AppState>();
    state.expanded.store(expanded, Ordering::Relaxed);
    if !expanded {
        *state.interaction_bounds.lock().unwrap() = None;
    }
    let _ = app.emit("island://expanded", expanded);
    Ok(())
}

/// Apply native bounds after settings changes, never from hover/expand interactions.
pub fn apply_bounds(app: &AppHandle) -> tauri::Result<()> {
    let Some(win) = app.get_webview_window("main") else {
        return Ok(());
    };
    let size = crate::placement::host_size_for_app(app)?
        .unwrap_or_else(|| app.state::<AppState>().settings.lock().unwrap().expanded);
    win.set_size(LogicalSize::new(size.w, size.h))?;
    anchor(app)
}

/// Center the island on its current monitor and use that monitor's logical origin.
pub fn anchor(app: &AppHandle) -> tauri::Result<()> {
    crate::placement::anchor(app)
}

#[cfg(test)]
fn centered_top_position(mon_x: f64, mon_y: f64, mon_w: f64, win_w: f64, scale: f64) -> (f64, f64) {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    ((mon_x + (mon_w - win_w) / 2.0) / scale, mon_y / scale)
}

/// WebView2 paints an opaque surface unless its background alpha is explicitly zero.
/// Acrylic material is deliberately omitted because it draws a rectangular panel.
pub fn apply_effects_impl(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let (r, g, b, a) = MAIN_WINDOW_BACKGROUND;
        let _ = win.set_background_color(Some(tauri::window::Color(r, g, b, a)));
    }
}

/// Reuse the single settings WebView and create it off event callbacks to avoid WebView2
/// creation deadlocks. The settings window is a regular decorated application window.
pub fn open_settings(app: &AppHandle) -> tauri::Result<()> {
    let _guard = SETTINGS_WINDOW_LOCK.lock().unwrap();
    let main = app.get_webview_window("main");
    if let Some(main) = main.as_ref() {
        // The island is topmost by design. Temporarily lower it so a normal settings
        // window can receive focus and remain fully usable above it.
        main.set_always_on_top(false)?;
    }
    let result = (|| -> tauri::Result<()> {
        if let Some(win) = app.get_webview_window("settings") {
            win.show()?;
            win.set_focus()?;
            return Ok(());
        }
        let win = tauri::WebviewWindowBuilder::new(
            app,
            "settings",
            WebviewUrl::App("settings.html".into()),
        )
        .title("Hover Island Settings")
        .inner_size(1040.0, 760.0)
        .min_inner_size(760.0, 560.0)
        .resizable(true)
        .decorations(true)
        .transparent(false)
        .disable_drag_drop_handler()
        .always_on_top(false)
        .center()
        .visible(false)
        .build()?;
        let generation = SETTINGS_WINDOW_GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
        let app_for_close = app.clone();
        win.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed)
                && SETTINGS_WINDOW_GENERATION.load(Ordering::Relaxed) == generation
            {
                if let Some(main) = app_for_close.get_webview_window("main") {
                    let _ = main.set_always_on_top(true);
                }
            }
        });
        win.show()?;
        win.set_focus()?;
        Ok(())
    })();
    if result.is_err() {
        if let Some(main) = main {
            let _ = main.set_always_on_top(true);
        }
    }
    result
}

pub fn toggle_settings(app: &AppHandle) -> tauri::Result<()> {
    let _guard = SETTINGS_WINDOW_LOCK.lock().unwrap();
    if let Some(win) = app.get_webview_window("settings") {
        if win.is_visible()? {
            win.hide()?;
            if let Some(main) = app.get_webview_window("main") {
                main.set_always_on_top(true)?;
            }
        } else {
            if let Some(main) = app.get_webview_window("main") {
                main.set_always_on_top(false)?;
            }
            if let Err(error) = win.show().and_then(|()| win.set_focus()) {
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.set_always_on_top(true);
                }
                return Err(error);
            }
        }
        return Ok(());
    }
    // Drop the lock before calling open_settings, which takes the same lock.
    drop(_guard);
    open_settings(app)
}

pub fn show_main(app: &AppHandle) -> tauri::Result<()> {
    MAIN_HIDDEN_BY_USER.store(false, Ordering::Relaxed);
    if let Some(win) = app.get_webview_window("main") {
        win.show()?;
        win.set_focus()?;
    }
    Ok(())
}

pub fn toggle_main(app: &AppHandle) -> tauri::Result<()> {
    if let Some(win) = app.get_webview_window("main") {
        if win.is_visible()? {
            MAIN_HIDDEN_BY_USER.store(true, Ordering::Relaxed);
            let _ = apply_expanded(app, false);
            win.hide()?;
        } else {
            MAIN_HIDDEN_BY_USER.store(false, Ordering::Relaxed);
            let _ = apply_expanded(app, false);
            win.show()?;
            win.set_focus()?;
        }
    }
    Ok(())
}

/* ------------------------- cursor and foreground ------------------------- */

#[cfg(windows)]
fn cursor_position() -> Option<(i32, i32)> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut point = POINT::default();
    unsafe { GetCursorPos(&mut point).ok()? };
    Some((point.x, point.y))
}

#[cfg(not(windows))]
fn cursor_position() -> Option<(i32, i32)> {
    None
}

fn main_window_rect(app: &AppHandle) -> Option<(i32, i32, i32, i32, f64, f64)> {
    let win = app.get_webview_window("main")?;
    let position = win.outer_position().ok()?;
    let size = win.outer_size().ok()?;
    let scale = win
        .scale_factor()
        .ok()
        .filter(|s| s.is_finite() && *s > 0.0)
        .unwrap_or(1.0);
    let settings = app.state::<AppState>();
    let settings = settings.settings.lock().ok()?;
    let (x, y, width, height) = crate::placement::collapsed_rect(
        position.x,
        position.y,
        size.width.min(i32::MAX as u32) as i32,
        size.height.min(i32::MAX as u32) as i32,
        scale,
        settings.collapsed.w,
        settings.collapsed.h,
        &settings.placement.edge,
        &settings.placement.mode,
    );
    Some((x, y, width, height, size.width as f64, scale))
}

fn cursor_over_pill(app: &AppHandle) -> bool {
    let Some((cx, cy)) = cursor_position() else {
        return false;
    };
    let Some((x, y, width, height, _, _)) = main_window_rect(app) else {
        return false;
    };
    cx >= x && cx < x + width && cy >= y && cy < y + height
}

#[cfg(test)]
fn centered_hit_rect(
    window_x: i32,
    window_y: i32,
    window_width: u32,
    scale: f64,
    visible_size: Size,
) -> (i32, i32, i32, i32) {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let width = (visible_size.w * scale).round() as i32;
    let height = (visible_size.h * scale).round() as i32;
    let left = window_x + (window_width as i32 - width) / 2;
    (left, window_y, left + width, window_y + height)
}

fn cursor_over_expanded_bounds(app: &AppHandle) -> bool {
    let Some((cx, cy)) = cursor_position() else {
        return false;
    };
    let Some(win) = app.get_webview_window("main") else {
        return false;
    };
    let (Ok(position), Ok(native_size)) = (win.outer_position(), win.outer_size()) else {
        return false;
    };
    let scale = win
        .scale_factor()
        .ok()
        .filter(|scale| scale.is_finite() && *scale > 0.0)
        .unwrap_or(1.0);
    let state = app.state::<AppState>();
    // Keep the same lock order as set_interaction_bounds to avoid inversion.
    let Ok(settings) = state.settings.lock() else {
        return false;
    };
    let full = settings.expanded;
    let edge = settings.placement.edge.clone();
    let mode = settings.placement.mode.clone();
    let Ok(bounds) = state.interaction_bounds.lock() else {
        return false;
    };
    let host = Size {
        w: native_size.width as f64 / scale,
        h: native_size.height as f64 / scale,
    };
    let visible = if crate::recycle::native_file_drag_active() {
        let side_edge = edge == "left" || edge == "right";
        Size {
            w: if side_edge { 420.0 } else { 366.0 },
            h: if side_edge { 110.0 } else { 92.0 },
        }
    } else {
        visible_interaction_bounds(*bounds, full, host, &mode)
    };
    let (left, top, width, height) = crate::placement::anchored_rect(
        position.x,
        position.y,
        native_size.width,
        native_size.height,
        scale,
        visible.w,
        visible.h,
        &edge,
    );
    let right = left + width;
    let bottom = top + height;
    cx >= left && cx < right && cy >= top && cy < bottom
}

fn validated_interaction_bounds(
    width: f64,
    height: f64,
    _full: Size,
    host: Size,
) -> Result<Option<Size>, String> {
    if !width.is_finite()
        || !height.is_finite()
        || width <= 0.0
        || height <= 0.0
        || width > host.w
        || height > host.h
    {
        return Err("interaction bounds must be positive and fit within the expanded panel".into());
    }
    if width == host.w && height == host.h {
        Ok(None)
    } else {
        Ok(Some(Size {
            w: width,
            h: height,
        }))
    }
}

fn visible_interaction_bounds(bounds: Option<Size>, full: Size, host: Size, mode: &str) -> Size {
    let maximum = if mode == "bar" || mode == "sidebar" {
        host
    } else {
        full
    };
    let visible = bounds.unwrap_or(maximum);
    Size {
        w: visible.w.min(maximum.w),
        h: visible.h.min(maximum.h),
    }
}

#[tauri::command]
pub fn set_interaction_bounds(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Hover Island window is unavailable.".to_string())?;
    let scale = window.scale_factor().map_err(es)?.max(0.01);
    let native = window.outer_size().map_err(es)?;
    let host = Size {
        w: native.width as f64 / scale,
        h: native.height as f64 / scale,
    };
    let state = app.state::<AppState>();
    let settings = state.settings.lock().map_err(|e| e.to_string())?;
    let bounds = validated_interaction_bounds(width, height, settings.expanded, host)?;
    *state.interaction_bounds.lock().map_err(|e| e.to_string())? = bounds;
    Ok(())
}

/// A narrow reveal band along the configured edge lets the user bring the island back
/// when a maximized window covers it, including on monitors with negative origins.
fn cursor_in_reveal_band(app: &AppHandle) -> bool {
    let Some((cx, cy)) = cursor_position() else {
        return false;
    };
    let Some((x, y, width, height, _, scale)) = main_window_rect(app) else {
        return false;
    };
    let state = app.state::<AppState>();
    let edge = state
        .settings
        .lock()
        .map(|settings| settings.placement.edge.clone())
        .unwrap_or_else(|_| "top".into());
    let (left, top, right, bottom) = reveal_band_rect(x, y, width, height, scale, &edge);
    cx >= left && cx < right && cy >= top && cy < bottom
}

fn reveal_band_rect(
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    scale: f64,
    edge: &str,
) -> (i32, i32, i32, i32) {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let band = (14.0 * scale).round().max(1.0) as i32;
    match edge {
        "bottom" => (x, y + height - band, x + width, y + height),
        "left" => (x, y, x + band.min(width), y + height),
        "right" => (x + width - band.min(width), y, x + width, y + height),
        _ => (x, y, x + width, y + band.min(height)),
    }
}

/// True when another process owns the foreground and its window is maximized or fills
/// its monitor. Settings and island windows belong to this process and are ignored.
#[cfg(windows)]
pub fn foreground_maximized() -> bool {
    // Interacting with the notch makes our own WebView foreground. Keep the
    // external window's context so collapsing after a click restores its veil.
    static LAST_EXTERNAL_MAXIMIZED: std::sync::atomic::AtomicBool =
        std::sync::atomic::AtomicBool::new(false);
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowRect, GetWindowThreadProcessId, IsZoomed,
    };

    unsafe {
        let hwnd: HWND = GetForegroundWindow();
        if hwnd.0 == 0 {
            return false;
        }
        let mut process_id = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut process_id));
        if process_id == std::process::id() {
            return LAST_EXTERNAL_MAXIMIZED.load(Ordering::Relaxed);
        }
        if IsZoomed(hwnd).as_bool() {
            LAST_EXTERNAL_MAXIMIZED.store(true, Ordering::Relaxed);
            return true;
        }
        let mut window_rect = RECT::default();
        if GetWindowRect(hwnd, &mut window_rect).is_err() {
            return false;
        }
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        if monitor.0 == 0 {
            return false;
        }
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            rcMonitor: RECT::default(),
            rcWork: RECT::default(),
            dwFlags: 0,
        };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return false;
        }
        let bounds = info.rcMonitor;
        let maximized = window_rect.left <= bounds.left + 1
            && window_rect.top <= bounds.top + 1
            && window_rect.right >= bounds.right - 1
            && window_rect.bottom >= bounds.bottom - 1;
        LAST_EXTERNAL_MAXIMIZED.store(maximized, Ordering::Relaxed);
        maximized
    }
}

#[cfg(not(windows))]
pub fn foreground_maximized() -> bool {
    false
}

/// Keep the large transparent WebView click-through except when the cursor is over the
/// visible pill. Adaptive polling is faster near the reveal edge and quiet elsewhere.
pub fn spawn_ignore_poll(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last_ignore: Option<bool> = None;
        let mut last_hidden: Option<bool> = None;
        let mut last_hover: Option<bool> = None;
        let mut last_foreground: Option<bool> = None;
        let mut last_magnetic: Option<(f64, f64)> = None;
        loop {
            if app.state::<AppState>().shutdown.load(Ordering::Relaxed) {
                break;
            }
            let (expanded, hide_behind, magnetic_enabled) = {
                let state = app.state::<AppState>();
                let settings = state.settings.lock().unwrap();
                (
                    state.expanded.load(Ordering::Relaxed),
                    settings.hide_behind_windows,
                    settings.placement.mode == "notch",
                )
            };
            let over_pill = cursor_over_pill(&app);
            let file_drag_active = crate::recycle::native_file_drag_active();
            let over_active_bounds = if expanded || file_drag_active {
                cursor_over_expanded_bounds(&app)
            } else {
                over_pill
            };
            let reveal = cursor_in_reveal_band(&app);
            let over_settings = cursor_over_window_named(&app, "settings");
            let maximized = foreground_maximized();
            let foreground = hide_behind && maximized;
            if Some(maximized) != last_foreground {
                last_foreground = Some(maximized);
                let _ = app.emit("window://foreground", maximized);
            }
            let user_hidden = MAIN_HIDDEN_BY_USER.load(Ordering::Relaxed);
            let dragging = crate::placement::is_dragging();
            let magnetic = if magnetic_enabled
                && !expanded
                && !dragging
                && !file_drag_active
                && !user_hidden
            {
                cursor_position().and_then(|(cx, cy)| {
                    main_window_rect(&app).and_then(|(x, y, width, height, _, scale)| {
                        crate::placement::magnetic_offset(cx, cy, (x, y, width, height), scale)
                    })
                })
            } else {
                None
            };
            let magnetic_changed = match (last_magnetic, magnetic) {
                (None, None) => false,
                (Some(_), None) => {
                    last_magnetic = None;
                    let _ = app.emit(
                        "island://proximity",
                        serde_json::json!({ "x": 0.0, "y": 0.0 }),
                    );
                    true
                }
                (None, Some(next)) => {
                    last_magnetic = Some(next);
                    let _ = app.emit(
                        "island://proximity",
                        serde_json::json!({ "x": next.0, "y": next.1 }),
                    );
                    true
                }
                (Some(previous), Some(next))
                    if (previous.0 - next.0).abs() >= 0.2 || (previous.1 - next.1).abs() >= 0.2 =>
                {
                    last_magnetic = Some(next);
                    let _ = app.emit(
                        "island://proximity",
                        serde_json::json!({ "x": next.0, "y": next.1 }),
                    );
                    true
                }
                _ => false,
            };
            // Only an explicit tray hide removes the window. Hiding behind a maximized
            // window is a visual veil: the window stays alive so reaching for the notch
            // reveals it again without a hide/show race.
            if Some(user_hidden) != last_hidden {
                if let Some(win) = app.get_webview_window("main") {
                    let result = if user_hidden { win.hide() } else { win.show() };
                    if result.is_ok() {
                        last_hidden = Some(user_hidden);
                    }
                }
            }
            // While veiled behind a maximized window, the pill and the thin edge
            // reveal band both count as reaching for the notch.
            let reaching = over_active_bounds || (foreground && !expanded && reveal && !dragging);
            let detected_hover = !user_hidden && !file_drag_active && reaching;
            // Moving from the island into its settings window is not a native hover leave.
            let hovered = if user_hidden {
                false
            } else if over_settings {
                last_hover.unwrap_or(detected_hover)
            } else {
                detected_hover
            };
            if Some(hovered) != last_hover {
                last_hover = Some(hovered);
                let _ = app.emit("island://hover", hovered);
            }

            let ignore = !dragging && (user_hidden || !over_active_bounds);
            if Some(ignore) != last_ignore {
                if let Some(win) = app.get_webview_window("main") {
                    if win.set_ignore_cursor_events(ignore).is_ok() {
                        last_ignore = Some(ignore);
                    }
                }
            }

            let delay = if reveal || hovered {
                12
            } else if magnetic.is_some() || magnetic_changed {
                24
            } else {
                48
            };
            std::thread::sleep(std::time::Duration::from_millis(delay));
        }
    });
}

fn cursor_over_window_named(app: &AppHandle, label: &str) -> bool {
    let Some((cx, cy)) = cursor_position() else {
        return false;
    };
    let Some(win) = app.get_webview_window(label) else {
        return false;
    };
    if !win.is_visible().unwrap_or(false) {
        return false;
    }
    let (Ok(position), Ok(size)) = (win.outer_position(), win.outer_size()) else {
        return false;
    };
    cx >= position.x
        && cx < position.x + size.width as i32
        && cy >= position.y
        && cy < position.y + size.height as i32
}

/* -------------------------------- commands -------------------------------- */

#[tauri::command]
pub fn anchor_island(app: AppHandle) -> Result<(), String> {
    anchor(&app).map_err(es)
}

#[tauri::command]
pub fn set_expanded(app: AppHandle, expanded: bool) -> Result<(), String> {
    apply_expanded(&app, expanded).map_err(es)
}

#[tauri::command]
pub fn apply_geometry(app: AppHandle) -> Result<(), String> {
    apply_bounds(&app).map_err(es)
}

#[tauri::command]
pub fn resize_island(app: AppHandle) -> Result<(), String> {
    apply_bounds(&app).map_err(es)
}

#[tauri::command]
pub fn apply_effects(app: AppHandle) -> Result<(), String> {
    apply_effects_impl(&app);
    Ok(())
}

#[tauri::command]
pub fn set_click_through(app: AppHandle, enabled: bool) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        win.set_ignore_cursor_events(enabled).map_err(es)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn open_settings_window(app: AppHandle) -> Result<(), String> {
    open_settings(&app).map_err(es)
}

#[tauri::command]
pub async fn toggle_settings_window(app: AppHandle) -> Result<(), String> {
    toggle_settings(&app).map_err(es)
}

pub fn exit_app(app: AppHandle) {
    app.state::<AppState>()
        .shutdown
        .store(true, Ordering::Relaxed);
    app.exit(0);
}

#[tauri::command]
pub fn open_devtools(app: AppHandle) {
    #[cfg(debug_assertions)]
    if let Some(win) = app.get_webview_window("main") {
        win.open_devtools();
    }
    #[cfg(not(debug_assertions))]
    let _ = app;
}

#[cfg(test)]
mod tests {
    use super::{
        centered_hit_rect, centered_top_position, reveal_band_rect, validated_interaction_bounds,
        visible_interaction_bounds, MAIN_WINDOW_BACKGROUND,
    };
    use crate::settings::Size;

    #[test]
    fn center_preserves_monitor_origin_and_scale() {
        assert_eq!(
            centered_top_position(1920.0, 120.0, 2560.0, 720.0, 2.0),
            (1420.0, 60.0)
        );
    }

    #[test]
    fn center_supports_monitor_left_and_above_primary() {
        assert_eq!(
            centered_top_position(-1920.0, -80.0, 1920.0, 700.0, 1.0),
            (-1310.0, -80.0)
        );
    }

    #[test]
    fn main_window_surface_stays_fully_transparent() {
        assert_eq!(MAIN_WINDOW_BACKGROUND.3, 0);
    }

    #[test]
    fn peek_hit_rect_is_centered_and_keeps_its_top_edge() {
        assert_eq!(
            centered_hit_rect(100, -20, 720, 1.0, Size { w: 420.0, h: 112.0 }),
            (250, -20, 670, 92)
        );
    }

    #[test]
    fn interaction_bounds_validate_and_full_panel_clears_override() {
        let full = Size { w: 720.0, h: 460.0 };
        let shelf_host = Size {
            w: 1920.0,
            h: 460.0,
        };
        assert_eq!(
            validated_interaction_bounds(420.0, 112.0, full, full).unwrap(),
            Some(Size { w: 420.0, h: 112.0 })
        );
        assert_eq!(
            validated_interaction_bounds(full.w, full.h, full, full).unwrap(),
            None
        );
        assert!(validated_interaction_bounds(721.0, 112.0, full, full).is_err());
        assert!(validated_interaction_bounds(f64::NAN, 112.0, full, full).is_err());
        assert_eq!(
            validated_interaction_bounds(1920.0, 460.0, full, shelf_host).unwrap(),
            None
        );
        assert_eq!(
            validated_interaction_bounds(1920.0, 120.0, full, shelf_host).unwrap(),
            Some(Size {
                w: 1920.0,
                h: 120.0
            })
        );
    }

    #[test]
    fn dock_hit_bounds_keep_the_full_bar_and_full_height_sidebar() {
        let notch = Size { w: 720.0, h: 460.0 };
        let bar = Size {
            w: 1920.0,
            h: 460.0,
        };
        let sidebar = Size {
            w: 420.0,
            h: 1080.0,
        };
        assert_eq!(visible_interaction_bounds(None, notch, bar, "bar"), bar);
        assert_eq!(
            visible_interaction_bounds(None, notch, sidebar, "sidebar"),
            sidebar
        );
        assert_eq!(visible_interaction_bounds(None, notch, bar, "notch"), notch);
        assert_eq!(
            visible_interaction_bounds(Some(Size { w: 400.0, h: 80.0 }), notch, bar, "bar"),
            Size { w: 400.0, h: 80.0 }
        );
    }

    #[test]
    fn reveal_band_follows_each_selected_edge_and_dpi() {
        assert_eq!(
            reveal_band_rect(100, 50, 320, 38, 2.0, "top"),
            (100, 50, 420, 78)
        );
        assert_eq!(
            reveal_band_rect(100, 50, 320, 38, 2.0, "bottom"),
            (100, 60, 420, 88)
        );
        assert_eq!(
            reveal_band_rect(100, 50, 320, 38, 2.0, "left"),
            (100, 50, 128, 88)
        );
        assert_eq!(
            reveal_band_rect(100, 50, 320, 38, 2.0, "right"),
            (392, 50, 420, 88)
        );
    }
}
