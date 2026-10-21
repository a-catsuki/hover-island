//! Monitor-aware island placement and explicit pointer-captured dragging.
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, PhysicalPosition};

use crate::settings::Placement;
use crate::settings::Size;

static DRAGGING: AtomicBool = AtomicBool::new(false);
static DRAG_OFFSET: Mutex<Option<(f64, f64)>> = Mutex::new(None);
/// Physical position `anchor` last gave the host window. The island is never
/// user-movable: anything that displaces it is put back (see `enforce_anchor`).
static LAST_ANCHOR: Mutex<Option<(i32, i32)>> = Mutex::new(None);
static DRAG_ENDED_AT: Mutex<Option<std::time::Instant>> = Mutex::new(None);
static ENFORCE_MISMATCHES: AtomicU32 = AtomicU32::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct MonitorRect {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

impl MonitorRect {
    fn right(self) -> i32 {
        self.x.saturating_add(self.width)
    }
    fn bottom(self) -> i32 {
        self.y.saturating_add(self.height)
    }
}

fn center_offset(container: i32, extent: i32) -> i32 {
    ((i64::from(container) - i64::from(extent)) / 2).clamp(i64::from(i32::MIN), i64::from(i32::MAX))
        as i32
}

pub fn is_dragging() -> bool {
    DRAGGING.load(Ordering::Relaxed)
}

pub fn anchor(app: &AppHandle) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    let (placement, expanded) = {
        let settings = app.state::<crate::state::AppState>();
        let settings = settings.settings.lock().unwrap();
        (settings.placement.clone(), settings.expanded)
    };
    let Some(monitor) = find_monitor(&window, placement.monitor.as_deref())? else {
        return Ok(());
    };
    let scale = valid_scale(monitor.scale_factor());
    let monitor_position = monitor.position();
    let monitor_size = monitor.size();
    let rect = MonitorRect {
        x: monitor_position.x,
        y: monitor_position.y,
        width: monitor_size.width.min(i32::MAX as u32) as i32,
        height: monitor_size.height.min(i32::MAX as u32) as i32,
    };
    let (logical_width, logical_height) = host_logical_size(&placement, expanded, rect, scale);
    let host_width = (logical_width * scale).round().max(1.0) as i32;
    let host_height = (logical_height * scale).round().max(1.0) as i32;
    let (x, y) = anchor_position(rect, host_width, host_height, &placement.edge);
    window.set_position(PhysicalPosition::new(x, y))?;
    if let Ok(mut last) = LAST_ANCHOR.lock() {
        *last = Some((x, y));
    }
    ENFORCE_MISMATCHES.store(0, Ordering::Relaxed);
    crate::window::invalidate_geometry_cache();
    Ok(())
}

/// The expanded notch is anchored, not a free window. If anything (a stray
/// non-client drag, a snap gesture, a display change) leaves the host away from
/// its anchor, recompute the anchor from the live monitor layout and move it
/// back. Cheap when nothing is wrong: one position read compared to a cache.
/// Called from the hover poll about twice a second; never while the user is
/// deliberately dragging the island between edges (placement drag), nor in the
/// short window after a drag ends while the frontend commits the new placement.
pub fn enforce_anchor(app: &AppHandle) {
    if is_dragging() {
        return;
    }
    if DRAG_ENDED_AT
        .lock()
        .ok()
        .and_then(|ended| *ended)
        .is_some_and(|at| at.elapsed() < std::time::Duration::from_secs(2))
    {
        return;
    }
    let Some(target) = LAST_ANCHOR.lock().ok().and_then(|last| *last) else {
        return;
    };
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(position) = window.outer_position() else {
        return;
    };
    if position.x == target.0 && position.y == target.1 {
        ENFORCE_MISMATCHES.store(0, Ordering::Relaxed);
        return;
    }
    // If the OS refuses the target (clamped coordinates), do not hammer it:
    // after a few attempts retry only every tenth call (about every 5 seconds).
    let attempts = ENFORCE_MISMATCHES.fetch_add(1, Ordering::Relaxed);
    if attempts >= 4 && attempts % 10 != 0 {
        return;
    }
    let _ = anchor(app);
    // `anchor` resets the counter for deliberate moves; keep it for retries.
    ENFORCE_MISMATCHES.store(attempts.saturating_add(1), Ordering::Relaxed);
}

/// Geometry for the native transparent WebView. Shelf bars span a horizontal
/// monitor edge, while sidebars span the height of a vertical monitor edge.
pub fn host_size_for_app(app: &AppHandle) -> tauri::Result<Option<Size>> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(None);
    };
    let (placement, expanded) = {
        let state = app.state::<crate::state::AppState>();
        let settings = state.settings.lock().unwrap();
        (settings.placement.clone(), settings.expanded)
    };
    let Some(monitor) = find_monitor(&window, placement.monitor.as_deref())? else {
        return Ok(None);
    };
    let scale = valid_scale(monitor.scale_factor());
    let position = monitor.position();
    let size = monitor.size();
    let rect = MonitorRect {
        x: position.x,
        y: position.y,
        width: size.width.min(i32::MAX as u32) as i32,
        height: size.height.min(i32::MAX as u32) as i32,
    };
    let (w, h) = host_logical_size(&placement, expanded, rect, scale);
    Ok(Some(Size { w, h }))
}

fn host_logical_size(
    placement: &Placement,
    expanded: Size,
    monitor: MonitorRect,
    scale: f64,
) -> (f64, f64) {
    let edge = placement.edge.as_str();
    let desired = match placement.mode.as_str() {
        "bar" if edge == "top" || edge == "bottom" => {
            (f64::from(monitor.width) / scale, expanded.h)
        }
        "sidebar" if edge == "left" || edge == "right" => {
            (expanded.w.min(420.0), f64::from(monitor.height) / scale)
        }
        // Keep the native transparent surface stable across the three standard
        // size presets. Only CSS changes their visible width, so an in-flight
        // spring cannot be clipped by an early native shrink or delayed growth.
        // Anchor and hit testing both center the visible surface in this same
        // host; the extra transparent area remains click-through. Custom sizes
        // above this bounded envelope still require a native surface resize.
        "notch" => (expanded.w.max(960.0), expanded.h.max(560.0)),
        _ => (expanded.w, expanded.h),
    };
    // A saved custom size or a high display scale can exceed the current
    // monitor. The CSS material and hit rectangle use these same host limits.
    (
        desired.0.min(f64::from(monitor.width) / scale),
        desired.1.min(f64::from(monitor.height) / scale),
    )
}

fn find_monitor(
    window: &tauri::WebviewWindow,
    monitor_id: Option<&str>,
) -> tauri::Result<Option<tauri::Monitor>> {
    let monitors = window.available_monitors()?;
    if let Some(id) = monitor_id {
        if let Some(monitor) = monitors
            .iter()
            .find(|monitor| monitor_id_for(monitor) == id)
        {
            return Ok(Some(monitor.clone()));
        }
    }
    if let Some(primary) = window.primary_monitor()? {
        return Ok(Some(primary));
    }
    if let Some(current) = window.current_monitor()? {
        return Ok(Some(current));
    }
    Ok(monitors.into_iter().next())
}

fn monitor_id_for(monitor: &tauri::Monitor) -> String {
    if let Some(name) = monitor.name() {
        if !name.trim().is_empty() {
            return name.clone();
        }
    }
    let position = monitor.position();
    let size = monitor.size();
    format!(
        "@{},{},{},{}",
        position.x, position.y, size.width, size.height
    )
}

fn valid_scale(scale: f64) -> f64 {
    if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    }
}

fn anchor_position(
    monitor: MonitorRect,
    host_width: i32,
    host_height: i32,
    edge: &str,
) -> (i32, i32) {
    match edge {
        "bottom" => (
            monitor
                .x
                .saturating_add(center_offset(monitor.width, host_width)),
            monitor.bottom().saturating_sub(host_height),
        ),
        "left" => (
            monitor.x,
            monitor
                .y
                .saturating_add(center_offset(monitor.height, host_height)),
        ),
        "right" => (
            monitor.right().saturating_sub(host_width),
            monitor
                .y
                .saturating_add(center_offset(monitor.height, host_height)),
        ),
        _ => (
            monitor
                .x
                .saturating_add(center_offset(monitor.width, host_width)),
            monitor.y,
        ),
    }
}

fn nearest_edge(cursor_x: i32, cursor_y: i32, monitor: MonitorRect) -> &'static str {
    let distances = [
        (cursor_y.saturating_sub(monitor.y).unsigned_abs(), "top"),
        (
            monitor.bottom().saturating_sub(cursor_y).unsigned_abs(),
            "bottom",
        ),
        (cursor_x.saturating_sub(monitor.x).unsigned_abs(), "left"),
        (
            monitor.right().saturating_sub(cursor_x).unsigned_abs(),
            "right",
        ),
    ];
    distances
        .into_iter()
        .min_by_key(|(distance, _)| *distance)
        .map(|(_, edge)| edge)
        .unwrap_or("top")
}

fn monitor_containing_cursor(
    monitors: &[tauri::Monitor],
    cursor_x: i32,
    cursor_y: i32,
) -> Option<&tauri::Monitor> {
    monitors.iter().find(|monitor| {
        let position = monitor.position();
        let size = monitor.size();
        cursor_x >= position.x
            && cursor_x
                < position
                    .x
                    .saturating_add(size.width.min(i32::MAX as u32) as i32)
            && cursor_y >= position.y
            && cursor_y
                < position
                    .y
                    .saturating_add(size.height.min(i32::MAX as u32) as i32)
    })
}

fn closest_monitor(
    monitors: &[tauri::Monitor],
    cursor_x: i32,
    cursor_y: i32,
) -> Option<&tauri::Monitor> {
    monitor_containing_cursor(monitors, cursor_x, cursor_y).or_else(|| {
        monitors.iter().min_by_key(|monitor| {
            let position = monitor.position();
            let size = monitor.size();
            let rect = MonitorRect {
                x: position.x,
                y: position.y,
                width: size.width.min(i32::MAX as u32) as i32,
                height: size.height.min(i32::MAX as u32) as i32,
            };
            let dx = if cursor_x < rect.x {
                (i64::from(rect.x) - i64::from(cursor_x)) as u64
            } else if cursor_x > rect.right() {
                (i64::from(cursor_x) - i64::from(rect.right())) as u64
            } else {
                0
            };
            let dy = if cursor_y < rect.y {
                (i64::from(rect.y) - i64::from(cursor_y)) as u64
            } else if cursor_y > rect.bottom() {
                (i64::from(cursor_y) - i64::from(rect.bottom())) as u64
            } else {
                0
            };
            dx.saturating_mul(dx).saturating_add(dy.saturating_mul(dy))
        })
    })
}

#[tauri::command]
pub fn placement_begin_drag(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Hover Island window is unavailable.".to_string())?;
    let (cursor_x, cursor_y) =
        cursor_position().ok_or_else(|| "Could not read the pointer position.".to_string())?;
    let position = window
        .outer_position()
        .map_err(|error| format!("Could not read window position: {error}"))?;
    let scale = valid_scale(
        window
            .scale_factor()
            .map_err(|error| format!("Could not read display scale: {error}"))?,
    );
    *DRAG_OFFSET
        .lock()
        .map_err(|_| "Window drag state is unavailable.".to_string())? = Some((
        f64::from(cursor_x - position.x) / scale,
        f64::from(cursor_y - position.y) / scale,
    ));
    DRAGGING.store(true, Ordering::Release);
    if let Err(error) = window.set_ignore_cursor_events(false) {
        DRAGGING.store(false, Ordering::Release);
        if let Ok(mut offset) = DRAG_OFFSET.lock() {
            *offset = None;
        }
        return Err(format!("Could not start dragging Hover Island: {error}"));
    }
    Ok(())
}

#[tauri::command]
pub fn placement_move(app: AppHandle) -> Result<(), String> {
    if !is_dragging() {
        return Err("Window drag is not active.".into());
    }
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Hover Island window is unavailable.".to_string())?;
    let (cursor_x, cursor_y) =
        cursor_position().ok_or_else(|| "Could not read the pointer position.".to_string())?;
    let offset = DRAG_OFFSET
        .lock()
        .map_err(|_| "Window drag state is unavailable.".to_string())?
        .ok_or_else(|| "Window drag has no pointer offset.".to_string())?;
    let scale = window
        .available_monitors()
        .ok()
        .and_then(|monitors| {
            closest_monitor(&monitors, cursor_x, cursor_y).map(|monitor| monitor.scale_factor())
        })
        .map(valid_scale)
        .or_else(|| window.scale_factor().ok().map(valid_scale))
        .unwrap_or(1.0);
    window
        .set_position(PhysicalPosition::new(
            cursor_x - (offset.0 * scale).round() as i32,
            cursor_y - (offset.1 * scale).round() as i32,
        ))
        .map_err(|error| format!("Could not move Hover Island: {error}"))
}

#[tauri::command]
pub fn placement_snap(app: AppHandle) -> Result<Placement, String> {
    if !is_dragging() {
        return Err("Window drag is not active.".into());
    }
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Hover Island window is unavailable.".to_string())?;
    let (cursor_x, cursor_y) =
        cursor_position().ok_or_else(|| "Could not read the pointer position.".to_string())?;
    let monitors = window
        .available_monitors()
        .map_err(|error| format!("Could not list display monitors: {error}"))?;
    let monitor = closest_monitor(&monitors, cursor_x, cursor_y)
        .ok_or_else(|| "No display monitor is available.".to_string())?;
    let position = monitor.position();
    let size = monitor.size();
    let rect = MonitorRect {
        x: position.x,
        y: position.y,
        width: size.width.min(i32::MAX as u32) as i32,
        height: size.height.min(i32::MAX as u32) as i32,
    };
    let edge = nearest_edge(cursor_x, cursor_y, rect);
    let current_mode = app
        .state::<crate::state::AppState>()
        .settings
        .lock()
        .unwrap()
        .placement
        .mode
        .clone();
    let mode = if current_mode == "notch" {
        "notch"
    } else if edge == "left" || edge == "right" {
        "sidebar"
    } else {
        "bar"
    };
    let edge = supported_edge(edge, mode);
    Ok(Placement {
        edge: edge.into(),
        monitor: Some(monitor_id_for(monitor)),
        mode: mode.into(),
    })
}

fn supported_edge<'a>(edge: &'a str, mode: &str) -> &'a str {
    if mode == "notch" && edge == "bottom" {
        "top"
    } else {
        edge
    }
}

#[tauri::command]
pub fn placement_end_drag() {
    DRAGGING.store(false, Ordering::Release);
    if let Ok(mut ended) = DRAG_ENDED_AT.lock() {
        *ended = Some(std::time::Instant::now());
    }
    if let Ok(mut offset) = DRAG_OFFSET.lock() {
        *offset = None;
    }
}

pub fn collapsed_rect(
    host_x: i32,
    host_y: i32,
    host_width: i32,
    host_height: i32,
    scale: f64,
    collapsed_width: f64,
    collapsed_height: f64,
    edge: &str,
    mode: &str,
) -> (i32, i32, i32, i32) {
    // Compact content stays upright; side notch anchors use a compact vertical
    // pill while the separate sidebar mode owns a full-height reveal rail.
    let scale = valid_scale(scale);
    let pill_width = (collapsed_width * scale).round() as i32;
    let pill_height = (collapsed_height * scale).round() as i32;
    if mode == "bar" && (edge == "top" || edge == "bottom") {
        let y = if edge == "bottom" {
            host_y + host_height - pill_height
        } else {
            host_y
        };
        return (host_x, y, host_width, pill_height);
    }
    if mode == "sidebar" && (edge == "left" || edge == "right") {
        let rail_width = (72.0 * scale).round() as i32;
        let x = if edge == "right" {
            host_x + host_width - rail_width
        } else {
            host_x
        };
        return (x, host_y, rail_width, host_height);
    }
    if mode == "notch" && (edge == "left" || edge == "right") {
        let width = (40.0 * scale).round() as i32;
        let height = (128.0 * scale).round() as i32;
        let x = if edge == "right" {
            host_x + host_width - width
        } else {
            host_x
        };
        return (x, host_y + (host_height - height) / 2, width, height);
    }
    match edge {
        "bottom" => (
            host_x + (host_width - pill_width) / 2,
            host_y + host_height - pill_height,
            pill_width,
            pill_height,
        ),
        "left" => (
            host_x,
            host_y + (host_height - pill_height) / 2,
            pill_width,
            pill_height,
        ),
        "right" => (
            host_x + host_width - pill_width,
            host_y + (host_height - pill_height) / 2,
            pill_width,
            pill_height,
        ),
        _ => (
            host_x + (host_width - pill_width) / 2,
            host_y,
            pill_width,
            pill_height,
        ),
    }
}

/// Small cursor attraction used only near a collapsed notch. The sine envelope
/// reaches zero at the pill boundary and at the outer radius, avoiding a jump
/// as native hit testing takes over from the proximity signal. Its magnitude is
/// always smaller than the pointer's gap to the stable hit rectangle, so the
/// visual pull cannot sweep the pill across the cursor or create a hover loop.
pub fn magnetic_offset(
    cursor_x: i32,
    cursor_y: i32,
    bounds: (i32, i32, i32, i32),
    scale: f64,
) -> Option<(f64, f64)> {
    let (left, top, width, height) = bounds;
    let right = left.saturating_add(width);
    let bottom = top.saturating_add(height);
    if cursor_x >= left && cursor_x < right && cursor_y >= top && cursor_y < bottom {
        return None;
    }
    let dx = (if cursor_x < left {
        cursor_x.saturating_sub(left)
    } else if cursor_x >= right {
        cursor_x.saturating_sub(right)
    } else {
        0
    }) as f64;
    let dy = (if cursor_y < top {
        cursor_y.saturating_sub(top)
    } else if cursor_y >= bottom {
        cursor_y.saturating_sub(bottom)
    } else {
        0
    }) as f64;
    let distance = dx.hypot(dy) / valid_scale(scale);
    const RADIUS: f64 = 96.0;
    const MAX_PULL: f64 = 4.0;
    if distance <= f64::EPSILON || distance >= RADIUS {
        return None;
    }
    let magnitude = MAX_PULL * (std::f64::consts::PI * distance / RADIUS).sin();
    let logical_dx = dx / valid_scale(scale);
    let logical_dy = dy / valid_scale(scale);
    Some((
        magnitude * logical_dx / distance,
        magnitude * logical_dy / distance,
    ))
}

pub fn anchored_rect(
    host_x: i32,
    host_y: i32,
    host_width: u32,
    host_height: u32,
    scale: f64,
    visible_width: f64,
    visible_height: f64,
    edge: &str,
) -> (i32, i32, i32, i32) {
    let scale = valid_scale(scale);
    let width = (visible_width * scale).round() as i32;
    let height = (visible_height * scale).round() as i32;
    let host_width = host_width.min(i32::MAX as u32) as i32;
    let host_height = host_height.min(i32::MAX as u32) as i32;
    match edge {
        "bottom" => (
            host_x + (host_width - width) / 2,
            host_y + host_height - height,
            width,
            height,
        ),
        "left" => (host_x, host_y + (host_height - height) / 2, width, height),
        "right" => (
            host_x + host_width - width,
            host_y + (host_height - height) / 2,
            width,
            height,
        ),
        _ => (host_x + (host_width - width) / 2, host_y, width, height),
    }
}

fn cursor_position() -> Option<(i32, i32)> {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::POINT;
        use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
        let mut point = POINT::default();
        unsafe { GetCursorPos(&mut point).ok()? };
        Some((point.x, point.y))
    }
    #[cfg(not(windows))]
    {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::{
        anchor_position, collapsed_rect, host_logical_size, magnetic_offset, nearest_edge,
        supported_edge, MonitorRect,
    };
    use crate::settings::{Placement, Size};

    #[test]
    fn bottom_notch_snaps_to_top_but_bottom_bar_remains_valid() {
        assert_eq!(supported_edge("bottom", "notch"), "top");
        assert_eq!(supported_edge("bottom", "bar"), "bottom");
        assert_eq!(supported_edge("left", "notch"), "left");
        assert_eq!(supported_edge("right", "notch"), "right");
    }

    #[test]
    fn screen_edges_snap_to_their_center_anchors() {
        let monitor = MonitorRect {
            x: -1920,
            y: -100,
            width: 1920,
            height: 1080,
        };
        assert_eq!(anchor_position(monitor, 800, 560, "top"), (-1360, -100));
        assert_eq!(anchor_position(monitor, 800, 560, "bottom"), (-1360, 420));
        assert_eq!(anchor_position(monitor, 800, 560, "left"), (-1920, 160));
        assert_eq!(anchor_position(monitor, 800, 560, "right"), (-800, 160));
    }

    #[test]
    fn pointer_near_each_edge_selects_that_edge() {
        let monitor = MonitorRect {
            x: 100,
            y: 50,
            width: 1600,
            height: 900,
        };
        assert_eq!(nearest_edge(900, 52, monitor), "top");
        assert_eq!(nearest_edge(900, 948, monitor), "bottom");
        assert_eq!(nearest_edge(102, 500, monitor), "left");
        assert_eq!(nearest_edge(1698, 500, monitor), "right");
    }

    #[test]
    fn dock_modes_choose_real_host_dimensions_at_the_selected_edge() {
        let monitor = MonitorRect {
            x: -1920,
            y: -100,
            width: 3840,
            height: 2160,
        };
        let expanded = Size { w: 800.0, h: 560.0 };
        let placement = |edge: &str, mode: &str| Placement {
            edge: edge.into(),
            monitor: None,
            mode: mode.into(),
        };
        assert_eq!(
            host_logical_size(&placement("top", "notch"), expanded, monitor, 2.0),
            (960.0, 560.0)
        );
        assert_eq!(
            host_logical_size(&placement("top", "bar"), expanded, monitor, 2.0),
            (1920.0, 560.0)
        );
        assert_eq!(
            host_logical_size(&placement("right", "sidebar"), expanded, monitor, 2.0),
            (420.0, 1080.0)
        );
        // Invalid mode/edge combinations safely retain the notch geometry.
        assert_eq!(
            host_logical_size(&placement("left", "bar"), expanded, monitor, 2.0),
            (800.0, 560.0)
        );
    }

    #[test]
    fn standard_notch_presets_share_a_host_and_preserve_visible_edge_anchors() {
        let monitor = MonitorRect {
            x: -1920,
            y: -100,
            width: 1920,
            height: 1080,
        };
        for edge in ["top", "left", "right"] {
            let placement = Placement {
                edge: edge.into(),
                monitor: None,
                mode: "notch".into(),
            };
            for width in [640.0, 800.0, 960.0] {
                let visible = Size { w: width, h: 560.0 };
                let (host_w, host_h) = host_logical_size(&placement, visible, monitor, 1.0);
                assert_eq!((host_w, host_h), (960.0, 560.0));
                let (x, y) = anchor_position(monitor, host_w as i32, host_h as i32, edge);
                let (left, top, w, h) = super::anchored_rect(
                    x,
                    y,
                    host_w as u32,
                    host_h as u32,
                    1.0,
                    width,
                    560.0,
                    edge,
                );
                let (pill_x, pill_y, pill_w, pill_h) = collapsed_rect(
                    x,
                    y,
                    host_w as i32,
                    host_h as i32,
                    1.0,
                    320.0,
                    38.0,
                    edge,
                    "notch",
                );
                match edge {
                    "left" => {
                        assert_eq!(left, monitor.x);
                        assert_eq!(top + h / 2, monitor.y + monitor.height / 2);
                        assert_eq!(pill_x, monitor.x);
                        assert_eq!(pill_y + pill_h / 2, monitor.y + monitor.height / 2);
                    }
                    "right" => {
                        assert_eq!(left + w, monitor.right());
                        assert_eq!(top + h / 2, monitor.y + monitor.height / 2);
                        assert_eq!(pill_x + pill_w, monitor.right());
                        assert_eq!(pill_y + pill_h / 2, monitor.y + monitor.height / 2);
                    }
                    _ => {
                        assert_eq!(top, monitor.y);
                        assert_eq!(left + w / 2, monitor.x + monitor.width / 2);
                        assert_eq!(pill_y, monitor.y);
                        assert_eq!(pill_x + pill_w / 2, monitor.x + monitor.width / 2);
                    }
                }
            }
        }
        let custom = Placement {
            edge: "top".into(),
            monitor: None,
            mode: "notch".into(),
        };
        assert_eq!(
            host_logical_size(
                &custom,
                Size {
                    w: 1200.0,
                    h: 700.0
                },
                monitor,
                1.0
            ),
            (1200.0, 700.0)
        );
    }

    #[test]
    fn collapsed_hit_rect_tracks_the_selected_edge_and_dpi() {
        assert_eq!(
            collapsed_rect(100, 50, 1600, 900, 2.0, 320.0, 38.0, "left", "notch"),
            (100, 372, 80, 256)
        );
        assert_eq!(
            collapsed_rect(100, 50, 1600, 900, 2.0, 320.0, 38.0, "right", "notch"),
            (1620, 372, 80, 256)
        );
        assert_eq!(
            collapsed_rect(100, 50, 1600, 900, 1.0, 320.0, 38.0, "bottom", "notch"),
            (740, 912, 320, 38)
        );
        assert_eq!(
            collapsed_rect(100, 50, 1600, 900, 1.0, 320.0, 38.0, "bottom", "bar"),
            (100, 912, 1600, 38)
        );
        assert_eq!(
            collapsed_rect(100, 50, 840, 2160, 2.0, 320.0, 38.0, "right", "sidebar"),
            (796, 50, 144, 2160)
        );
    }

    #[test]
    fn magnetic_pull_is_bounded_and_fades_before_the_hit_target() {
        let bounds = (100, 100, 40, 128);
        let offset = magnetic_offset(140, 52, bounds, 1.0).unwrap();
        assert!(offset.0.abs() < 0.01);
        assert!(offset.1 < 0.0 && offset.1.abs() <= 4.0);
        assert!(magnetic_offset(120, 120, bounds, 1.0).is_none());
        assert!(magnetic_offset(100, 4, bounds, 1.0).is_none());
        for distance in [1, 10, 24, 48, 90] {
            let offset = magnetic_offset(100 - distance, 180, bounds, 1.0).unwrap();
            assert!(offset.0.hypot(offset.1) < f64::from(distance));
            assert!(offset.0.hypot(offset.1) <= 4.0);
        }
    }
}
