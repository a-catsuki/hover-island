use crate::state::AppState;
use crate::types::{now_millis, AppNotification};
use std::collections::HashSet;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager, State};
use windows::UI::Notifications::Management::{
    UserNotificationListener, UserNotificationListenerAccessStatus,
};
use windows::UI::Notifications::{NotificationKinds, UserNotification};

const MAX_TITLE_CHARS: usize = 160;
const MAX_BODY_CHARS: usize = 400;

/// Collapse runs of whitespace (including newlines) and cap the length.
fn clean_text(input: &str, max_chars: usize) -> String {
    let joined = input.split_whitespace().collect::<Vec<_>>().join(" ");
    if joined.chars().count() <= max_chars {
        joined
    } else {
        let mut cut: String = joined.chars().take(max_chars.saturating_sub(1)).collect();
        cut.push('\u{2026}');
        cut
    }
}

thread_local! {
    static COM: () = {
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
        unsafe { let _ = CoInitializeEx(None, COINIT_MULTITHREADED); }
    };
}

fn ensure_com() {
    COM.with(|_| {});
}

#[link(name = "kernel32")]
extern "system" {
    fn GetCurrentPackageFullName(length: *mut u32, name: *mut u16) -> i32;
}

fn package_identity_status() -> Result<bool, String> {
    let mut length = 0;
    let status = unsafe { GetCurrentPackageFullName(&mut length, std::ptr::null_mut()) };
    classify_package_identity_status(status)
}

fn classify_package_identity_status(status: i32) -> Result<bool, String> {
    if status == 15700 {
        // APPMODEL_ERROR_NO_PACKAGE
        return Ok(false);
    }
    // With a null output buffer, a packaged process should report
    // ERROR_INSUFFICIENT_BUFFER (the required name length is returned). Do not
    // silently treat unrelated identity-query failures as a packaged app.
    if status == 122 {
        Ok(true)
    } else {
        Err(format!(
            "Could not verify the Windows package identity (Windows error 0x{:08X}). Install the MSIX build to capture Windows notifications.",
            status as u32
        ))
    }
}

fn require_package_identity() -> Result<(), String> {
    if package_identity_status()? {
        Ok(())
    } else {
        Err("Windows notifications need the packaged Hover Island build. Install the MSIX build, then allow notification access in Settings.".into())
    }
}

fn windows_error(context: &str, error: windows::core::Error) -> String {
    // Keep errors useful to the UI and logs without forwarding arbitrary OS text.
    format!("{context} (Windows error 0x{:08X})", error.code().0 as u32)
}

fn status_error(status: UserNotificationListenerAccessStatus) -> String {
    match status {
        UserNotificationListenerAccessStatus::Denied => {
            "Windows notification access is denied. Enable it in Windows Settings, then retry."
                .to_string()
        }
        UserNotificationListenerAccessStatus::Unspecified => {
            "Windows notification access has not been granted yet. Retry and choose Allow."
                .to_string()
        }
        _ => "Windows notification access is unavailable.".to_string(),
    }
}

fn access_is_allowed(status: UserNotificationListenerAccessStatus) -> bool {
    status == UserNotificationListenerAccessStatus::Allowed
}

/// Merge the current Windows notification snapshot into the app inbox.
/// Windows can update an existing toast while keeping its native ID, so an
/// ID-only dedupe drops meaningful title/body changes. Return changed state
/// separately from genuinely new entries so callers can refresh the inbox
/// without replaying alert peeks for edits to an existing toast.
pub(crate) fn merge_poll(
    current: &mut Vec<AppNotification>,
    incoming: Vec<AppNotification>,
    dismissed: &HashSet<String>,
) -> (bool, Vec<AppNotification>) {
    let mut positions: std::collections::HashMap<String, usize> = current
        .iter()
        .enumerate()
        .map(|(index, notification)| (notification.id.clone(), index))
        .collect();
    let mut changed = false;
    let mut fresh = Vec::new();

    for notification in incoming {
        if dismissed.contains(&notification.id) {
            continue;
        }
        if let Some(index) = positions.get(&notification.id).copied() {
            if current[index] != notification {
                current[index] = notification;
                changed = true;
            }
        } else {
            positions.insert(notification.id.clone(), current.len());
            fresh.push(notification.clone());
            current.push(notification);
            changed = true;
        }
    }

    if changed {
        current.sort_by_key(|notification| notification.timestamp);
    }
    (changed, fresh)
}

pub fn poll() -> Result<Vec<AppNotification>, String> {
    require_package_identity()?;
    ensure_com();
    let mut out = Vec::new();
    let listener = UserNotificationListener::Current()
        .map_err(|error| windows_error("Windows notification listener is unavailable", error))?;
    let status = listener
        .GetAccessStatus()
        .map_err(|error| windows_error("Could not check Windows notification access", error))?;
    if !access_is_allowed(status) {
        return Err(status_error(status));
    }
    let list = listener
        .GetNotificationsAsync(NotificationKinds::Toast)
        .and_then(|operation| operation.get())
        .map_err(|error| windows_error("Could not read Windows notifications", error))?;
    let size = list
        .Size()
        .map_err(|error| windows_error("Could not enumerate Windows notifications", error))?;
    for i in 0..size {
        let Ok(n) = list.GetAt(i) else { continue };
        let app_info = n.AppInfo().ok();
        let app = app_info
            .as_ref()
            .and_then(|a| a.DisplayInfo().ok())
            .and_then(|d| d.DisplayName().ok())
            .map(|h| h.to_string())
            .unwrap_or_else(|| "Notification".to_string());
        let app_key = app_info
            .as_ref()
            .and_then(|a| a.AppUserModelId().ok())
            .map(|id| id.to_string())
            .unwrap_or_else(|| app.clone());
        let ts = n
            .CreationTime()
            .ok()
            .map(datetime_to_millis)
            .unwrap_or_else(now_millis);
        let native_id = n
            .Id()
            .map(|id| id.to_string())
            .unwrap_or_else(|_| ts.to_string());
        let (title, body) = texts(&n);
        let icon = crate::notification_icon::resolve(&app_key, app_info.as_ref());
        out.push(AppNotification {
            id: format!("notification:{app_key}:{native_id}"),
            app,
            title,
            body,
            timestamp: ts,
            icon,
        });
    }
    Ok(out)
}

/// Windows' native notification id from our composed id
/// (`notification:{app_key}:{native_id}`).
fn native_notification_id(id: &str) -> Option<u32> {
    id.rsplit(':').next()?.parse().ok()
}

/// True when the user muted this app in Connections (notifications switched off).
fn app_is_muted(connections: &[crate::types::AppConnection], app: &str) -> bool {
    let app = app.trim().to_lowercase();
    connections.iter().any(|connection| {
        !connection.notifications
            && std::iter::once(&connection.name)
                .chain(connection.notification_sources.iter())
                .any(|name| name.trim().to_lowercase() == app)
    })
}

/// `windowsBanners = "clear"`: remove notifications the notch has just surfaced
/// from Windows' Action Center so they do not pile up in the sidebar. Only
/// notifications that were shown (not muted, not during island Do Not Disturb,
/// not the first baseline poll) are passed in by the poll loop; muted apps are
/// filtered again here. The notch inbox keeps its own copy. Runs on its own
/// thread so a slow call never stalls the poll.
pub(crate) fn clear_surfaced(app: &AppHandle, surfaced: &[AppNotification]) {
    if surfaced.is_empty() {
        return;
    }
    let ids: Vec<u32> = {
        let state = app.state::<AppState>();
        let settings = state.settings.lock().unwrap();
        if settings.windows_banners != "clear" || settings.dnd {
            return;
        }
        surfaced
            .iter()
            .filter(|item| !app_is_muted(&settings.connections, &item.app))
            .filter_map(|item| native_notification_id(&item.id))
            .collect()
    };
    if ids.is_empty() {
        return;
    }
    std::thread::spawn(move || {
        ensure_com();
        let Ok(listener) = UserNotificationListener::Current() else {
            return;
        };
        // Give the notch a moment to take its copy before Windows drops its own.
        std::thread::sleep(std::time::Duration::from_millis(400));
        for id in ids {
            let _ = listener.RemoveNotification(id);
        }
    });
}

fn datetime_to_millis(dt: windows::Foundation::DateTime) -> u64 {
    let millis_since_1601 = dt.UniversalTime / 10_000;
    let epoch = millis_since_1601 - 11_644_473_600_000;
    if epoch < 0 {
        0
    } else {
        epoch as u64
    }
}

fn texts(n: &UserNotification) -> (String, String) {
    let parts = (|| -> windows::core::Result<Vec<String>> {
        let binding_name = windows::core::HSTRING::from("ToastGeneric");
        let binding = n.Notification()?.Visual()?.GetBinding(&binding_name)?;
        let elems = binding.GetTextElements()?;
        let mut v = Vec::new();
        for i in 0..elems.Size()? {
            if let Ok(t) = elems.GetAt(i) {
                if let Ok(s) = t.Text() {
                    v.push(s.to_string());
                }
            }
        }
        Ok(v)
    })()
    .unwrap_or_default();

    let title = clean_text(parts.first().map(String::as_str).unwrap_or(""), MAX_TITLE_CHARS);
    let body = clean_text(
        &parts.iter().skip(1).cloned().collect::<Vec<_>>().join(" "),
        MAX_BODY_CHARS,
    );
    (title, body)
}

/* ------------------------------- commands ------------------------------- */

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationAccess {
    packaged: bool,
    status: &'static str,
}

#[tauri::command]
pub async fn notifications_access_status() -> Result<NotificationAccess, String> {
    tauri::async_runtime::spawn_blocking(|| {
        if !package_identity_status()? {
            return Ok(NotificationAccess {
                packaged: false,
                status: "unpackaged",
            });
        }
        ensure_com();
        let status = UserNotificationListener::Current()
            .and_then(|listener| listener.GetAccessStatus())
            .map_err(|error| windows_error("Could not check notification access", error))?;
        Ok(NotificationAccess {
            packaged: true,
            status: access_label(status),
        })
    })
    .await
    .map_err(|_| "Notification status worker stopped".to_string())?
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NotificationDiagnostics {
    packaged: bool,
    access: &'static str,
    toast_count: Option<u32>,
}

/// Read-only CLI diagnostics. Toast content and identifiers are never read.
pub(crate) fn diagnostics_json() -> (String, i32) {
    let packaged = match package_identity_status() {
        Ok(packaged) => packaged,
        Err(_) => {
            return (diagnostic_json(false, "error", None), 4);
        }
    };
    if !packaged {
        return (diagnostic_json(false, "unpackaged", None), 3);
    }

    ensure_com();
    let result = UserNotificationListener::Current().and_then(|listener| {
        listener.GetAccessStatus().and_then(|status| {
            if !access_is_allowed(status) {
                return Ok((status, None));
            }
            listener
                .GetNotificationsAsync(NotificationKinds::Toast)?
                .get()
                .and_then(|notifications| notifications.Size())
                .map(|count| (status, Some(count)))
        })
    });
    match result {
        Ok((status, count)) => {
            let access = access_label(status);
            let code = if status == UserNotificationListenerAccessStatus::Allowed {
                0
            } else if status == UserNotificationListenerAccessStatus::Denied {
                2
            } else {
                3
            };
            (
                diagnostic_json(true, access, if code == 0 { count } else { None }),
                code,
            )
        }
        Err(_) => (diagnostic_json(true, "error", None), 5),
    }
}

fn diagnostic_json(packaged: bool, access: &'static str, toast_count: Option<u32>) -> String {
    serde_json::to_string(&NotificationDiagnostics {
        packaged,
        access,
        toast_count,
    })
    .unwrap_or_else(|_| {
        format!(r#"{{"packaged":{packaged},"access":"{access}","toastCount":null}}"#)
    })
}

fn access_label(status: UserNotificationListenerAccessStatus) -> &'static str {
    if access_is_allowed(status) {
        "allowed"
    } else if status == UserNotificationListenerAccessStatus::Denied {
        "denied"
    } else {
        "not-requested"
    }
}

/// Deliberate test through the real popup event path. An empty `id` sends a
/// generic sample; otherwise the saved source is used. This verifies notch
/// routing, not delivery by another Windows application.
#[tauri::command]
pub fn notifications_test_connection(
    app: AppHandle,
    state: State<AppState>,
    id: String,
) -> Result<(), String> {
    let settings = state.settings.lock().map_err(|_| "Settings unavailable")?;
    let connection = if id.is_empty() {
        None
    } else {
        Some(
            settings
                .connections
                .iter()
                .find(|item| item.id == id)
                .ok_or("Connection not found")?,
        )
    };
    if connection.map_or(false, |item| !item.notifications)
        || !settings.notifications.enabled
        || settings.dnd
    {
        return Err("Turn on app notifications and turn off Do Not Disturb to test.".into());
    }
    let item = AppNotification {
        id: format!("notification:routing-test:{}", uuid::Uuid::new_v4()),
        app: connection
            .map(|item| {
                item.notification_sources
                    .first()
                    .cloned()
                    .unwrap_or_else(|| item.name.clone())
            })
            .unwrap_or_else(|| "Hover Island".to_string()),
        title: "Test notification".into(),
        body: "Notifications from your apps will look like this.".into(),
        timestamp: now_millis(),
        icon: connection.and_then(|item| item.icon.clone()),
    };
    drop(settings);
    app.emit("notifications://popup", item)
        .map_err(|_| "Could not send test alert".into())
}

#[tauri::command]
pub fn notifications_get(state: State<AppState>) -> Vec<AppNotification> {
    state.notifications.lock().unwrap().clone()
}

/// Remove a single notification from the inbox (it is not restored by later polls).
#[tauri::command]
pub fn notifications_dismiss(app: AppHandle, state: State<AppState>, id: String) {
    let mut dismissed = state.dismissed_notification_ids.lock().unwrap();
    let mut notifications = state.notifications.lock().unwrap();
    dismissed.insert(id.clone());
    while dismissed.len() > 1024 {
        let Some(oldest) = dismissed.iter().next().cloned() else {
            break;
        };
        dismissed.remove(&oldest);
    }
    notifications.retain(|notification| notification.id != id);
    let snapshot = notifications.clone();
    drop(notifications);
    drop(dismissed);
    let _ = app.emit("notifications://changed", &snapshot);
}

#[tauri::command]
pub fn notifications_clear(app: AppHandle, state: State<AppState>) {
    let mut dismissed = state.dismissed_notification_ids.lock().unwrap();
    let mut observed = state.observed_notification_ids.lock().unwrap();
    let mut notifications = state.notifications.lock().unwrap();
    dismissed.extend(observed.iter().cloned());
    observed.clear();
    for notification in notifications.iter() {
        dismissed.insert(notification.id.clone());
    }
    while dismissed.len() > 1024 {
        let Some(oldest) = dismissed.iter().next().cloned() else {
            break;
        };
        dismissed.remove(&oldest);
    }
    notifications.clear();
    // The poll worker snapshots this generation before reading Windows. Bump it
    // while the same state locks are still held so an older poll cannot restore
    // entries that the user just cleared.
    state
        .notification_clear_generation
        .fetch_add(1, Ordering::Release);
    drop(notifications);
    drop(dismissed);
    let _ = app.emit("notifications://changed", Vec::<AppNotification>::new());
}

#[tauri::command]
pub async fn notifications_request_access(app: AppHandle) -> Result<bool, String> {
    require_package_identity()?;
    // Microsoft requires RequestAccessAsync to be invoked from the UI thread.
    // Create the operation there, but wait for the user's decision off-thread.
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let operation =
            UserNotificationListener::Current().and_then(|listener| listener.RequestAccessAsync());
        let _ = tx.send(operation);
    })
    .map_err(|error| format!("Could not request Windows notification access: {error}"))?;

    let operation = tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(std::time::Duration::from_secs(10))
            .map_err(|_| "Windows notification request could not reach the UI thread".to_string())?
            .map_err(|error| {
                windows_error("Could not start Windows notification access request", error)
            })
    })
    .await
    .map_err(|error| format!("Windows notification access worker failed: {error}"))??;
    let status = operation
        .await
        .map_err(|error| windows_error("Windows notification access request failed", error))?;
    Ok(access_is_allowed(status))
}

#[cfg(test)]
mod tests {
    use super::{
        access_is_allowed, classify_package_identity_status, clean_text, merge_poll, status_error,
    };
    use crate::types::AppNotification;
    use std::collections::HashSet;
    use windows::UI::Notifications::Management::UserNotificationListenerAccessStatus;

    #[test]
    fn notification_access_requires_an_explicit_allow() {
        assert!(access_is_allowed(
            UserNotificationListenerAccessStatus::Allowed
        ));
        assert!(!access_is_allowed(
            UserNotificationListenerAccessStatus::Denied
        ));
        assert!(!access_is_allowed(
            UserNotificationListenerAccessStatus::Unspecified
        ));
        assert!(status_error(UserNotificationListenerAccessStatus::Denied).contains("retry"));
        assert!(status_error(UserNotificationListenerAccessStatus::Unspecified).contains("Retry"));
    }

    #[test]
    fn package_identity_only_calls_the_specific_no_package_code_unpacked() {
        assert_eq!(classify_package_identity_status(122), Ok(true));
        assert_eq!(classify_package_identity_status(15700), Ok(false));
        assert!(classify_package_identity_status(5).is_err());
    }

    #[test]
    fn clean_text_collapses_whitespace_and_caps_length() {
        assert_eq!(clean_text("  a \n\n b\t c  ", 50), "a b c");
        let long = "x".repeat(30);
        let cut = clean_text(&long, 10);
        assert_eq!(cut.chars().count(), 10);
        assert!(cut.ends_with('\u{2026}'));
    }

    fn notification(id: &str, title: &str, timestamp: u64) -> AppNotification {
        AppNotification {
            id: id.into(),
            app: "Messages".into(),
            title: title.into(),
            body: String::new(),
            timestamp,
            icon: None,
        }
    }

    #[test]
    fn poll_updates_existing_toast_without_replaying_it_as_new() {
        let mut inbox = vec![notification("app:42", "Original", 10)];
        let (changed, fresh) = merge_poll(
            &mut inbox,
            vec![notification("app:42", "Edited", 20)],
            &HashSet::new(),
        );

        assert!(changed);
        assert!(fresh.is_empty());
        assert_eq!(inbox.len(), 1);
        assert_eq!(inbox[0].title, "Edited");
        assert_eq!(inbox[0].timestamp, 20);
    }

    #[test]
    fn poll_reports_only_new_toasts_for_alert_peeks_and_respects_clear() {
        let mut inbox = vec![notification("app:42", "Existing", 10)];
        let mut dismissed = HashSet::new();
        dismissed.insert("app:43".into());
        let (changed, fresh) = merge_poll(
            &mut inbox,
            vec![
                notification("app:42", "Existing", 10),
                notification("app:43", "Dismissed", 11),
                notification("app:44", "New", 12),
            ],
            &dismissed,
        );

        assert!(changed);
        assert_eq!(fresh.len(), 1);
        assert_eq!(fresh[0].id, "app:44");
        assert_eq!(inbox.len(), 2);
    }
}
