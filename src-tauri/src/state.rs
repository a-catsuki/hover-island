use crate::settings::{Settings, Size};
use crate::types::{AppNotification, InstalledApp, UsageSnapshot};
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex};

pub struct AppState {
    pub settings: Mutex<Settings>,
    pub notifications: Mutex<Vec<AppNotification>>,
    /// IDs hidden by an explicit clear or the in-memory history cap for this run.
    pub dismissed_notification_ids: Mutex<HashSet<String>>,
    /// Stable IDs returned by the most recent Windows notification poll.
    pub observed_notification_ids: Mutex<HashSet<String>>,
    /// Invalidates a notification poll that was in flight when the user cleared history.
    pub notification_clear_generation: AtomicU64,
    pub usage: Mutex<Vec<UsageSnapshot>>,
    /// Cached Start-Menu app list (built once at startup) for instant Spotlight search.
    pub apps: Mutex<Arc<Vec<InstalledApp>>>,
    /// Cached file index: (lowercased name, full path). Rebuilt on demand.
    pub files: Mutex<Arc<Vec<(String, String)>>>,
    /// Active LocalSend-compatible "Nearby" runtime, if started.
    pub nearby: Mutex<Option<Arc<crate::nearby::NearbyRuntime>>>,
    pub expanded: AtomicBool,
    /// Visible panel hit rectangle while expanded (used for short notification peeks).
    pub interaction_bounds: Mutex<Option<Size>>,
    pub shutdown: AtomicBool,
}

impl AppState {
    pub fn new(settings: Settings) -> Self {
        Self {
            settings: Mutex::new(settings),
            notifications: Mutex::new(Vec::new()),
            dismissed_notification_ids: Mutex::new(HashSet::new()),
            observed_notification_ids: Mutex::new(HashSet::new()),
            notification_clear_generation: AtomicU64::new(0),
            usage: Mutex::new(Vec::new()),
            apps: Mutex::new(Arc::new(Vec::new())),
            files: Mutex::new(Arc::new(Vec::new())),
            nearby: Mutex::new(None),
            expanded: AtomicBool::new(false),
            interaction_bounds: Mutex::new(None),
            shutdown: AtomicBool::new(false),
        }
    }
}
