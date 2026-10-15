use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct NowPlaying {
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub thumbnail: Option<String>,
    /// "playing" | "paused" | "stopped"
    pub status: String,
    pub position: Option<f64>,
    pub duration: Option<f64>,
    /// Capabilities reported by the active Windows media session.
    pub can_play: bool,
    pub can_pause: bool,
    pub can_skip_next: bool,
    pub can_skip_previous: bool,
    pub can_seek: bool,
    /// Valid seek interval in seconds when `can_seek` is true.
    pub seek_min: Option<f64>,
    pub seek_max: Option<f64>,
    pub source_app: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AppNotification {
    pub id: String,
    pub app: String,
    pub title: String,
    pub body: String,
    pub timestamp: u64,
    pub icon: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledApp {
    pub id: String,
    pub name: String,
    pub target: String,
    /// "uwp" | "desktop" | "url"
    pub kind: String,
    pub icon: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct UsageSnapshot {
    pub provider: String,
    pub label: String,
    /// "ok" | "unknown" | "error"
    pub status: String,
    pub used: Option<u64>,
    pub limit: Option<u64>,
    pub unit: Option<String>,
    pub percent: Option<f64>,
    pub window: Option<String>,
    pub detail: Option<String>,
    /// "official-rate-limit" for provider quota data, "local-logs" for local activity.
    pub source: Option<String>,
    /// Provider supplied reset time in Unix milliseconds, when known.
    pub reset_at: Option<u64>,
    pub updated_at: u64,
}

pub fn now_millis() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchResult {
    pub id: String,
    pub title: String,
    pub subtitle: Option<String>,
    /// "app" | "file" | "url" | "calc" | "web" | "command"
    pub kind: String,
    pub icon: Option<String>,
    /// "launch" | "open" | "copy" | "run"
    pub action: String,
    pub target: String,
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct NearbyPeer {
    pub id: String,
    pub name: String,
    pub address: String,
    pub port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct NearbyTransfer {
    pub id: String,
    pub peer: String,
    /// "send" | "receive"
    pub direction: String,
    pub file_name: String,
    pub bytes: u64,
    pub total: u64,
    /// "active" | "done" | "failed"
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct NearbyStatus {
    pub running: bool,
    pub device_name: String,
    pub port: u16,
    pub peers: Vec<NearbyPeer>,
    pub transfers: Vec<NearbyTransfer>,
    pub detail: Option<String>,
}

/// A dashboard widget placement. `kind` is one of the frontend `WidgetKind` strings.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct WidgetConfig {
    pub id: String,
    pub kind: String,
    pub enabled: bool,
    pub order: i32,
    pub panel: Option<String>,
    pub clock_style: Option<String>,
}

/// A connected web app (WhatsApp Web, Gmail, …) surfaced in the notch.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConnection {
    pub id: String,
    pub name: String,
    pub url: String,
    /// data: URL or remote URL
    pub icon: Option<String>,
    /// Surface this app's notifications in the notch.
    pub notifications: bool,
    /// Exact Windows notification app display names that should route here.
    pub notification_sources: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct WeatherSnapshot {
    pub ok: bool,
    pub city: String,
    pub temp_c: f64,
    pub hi_c: f64,
    pub lo_c: f64,
    /// WMO weather code.
    pub code: i32,
    pub label: String,
    pub updated_at: u64,
    /// Modelled U.S. air-quality index, when available.
    pub aqi: Option<u16>,
    /// Human-readable U.S. AQI band with the standard named explicitly.
    pub aqi_label: Option<String>,
    /// `manual` for a user-selected city, `approximate` for IP-derived location.
    pub location_source: Option<String>,
    /// Whether the displayed forecast was served from the local cache after a fetch failure.
    pub stale: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct WeatherLocation {
    pub name: String,
    pub admin1: Option<String>,
    pub country: Option<String>,
    pub latitude: f64,
    pub longitude: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct CalendarEvent {
    pub id: String,
    pub title: String,
    /// epoch millis
    pub start: u64,
    /// epoch millis
    pub end: u64,
    pub all_day: bool,
    pub location: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct NotesState {
    pub text: String,
}
