use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use crate::types::{AppConnection, WidgetConfig};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Size {
    pub w: f64,
    pub h: f64,
}

impl Size {
    fn validated(self, fallback: Self, min_w: f64, max_w: f64, min_h: f64, max_h: f64) -> Self {
        Self {
            w: finite_clamp(self.w, fallback.w, min_w, max_w),
            h: finite_clamp(self.h, fallback.h, min_h, max_h),
        }
    }
}

fn finite_clamp(value: f64, fallback: f64, min: f64, max: f64) -> f64 {
    if value.is_finite() {
        value.clamp(min, max)
    } else {
        fallback
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Modules {
    pub media: bool,
    pub visualizer: bool,
    pub notifications: bool,
    pub usage: bool,
    pub dock: bool,
}
impl Default for Modules {
    fn default() -> Self {
        Self {
            media: true,
            visualizer: true,
            notifications: true,
            usage: true,
            dock: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VisualizerCfg {
    pub style: String,
    pub intensity: f64,
    pub reactivity: f64,
}
impl Default for VisualizerCfg {
    fn default() -> Self {
        Self {
            style: "ambient".into(),
            intensity: 0.7,
            reactivity: 0.8,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct DockItem {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub target: String,
    pub icon: Option<String>,
    pub badge: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ManualUsage {
    pub label: String,
    pub used: Option<u64>,
    pub limit: Option<u64>,
    pub unit: String,
    pub reset_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UsageCfg {
    pub codex: bool,
    pub claude_code: bool,
    pub cursor: bool,
    pub manual: bool,
    pub manual_config: ManualUsage,
}
impl Default for UsageCfg {
    fn default() -> Self {
        Self {
            codex: true,
            claude_code: true,
            cursor: true,
            manual: false,
            manual_config: ManualUsage {
                label: "Custom".into(),
                unit: "tokens".into(),
                ..Default::default()
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NotificationsCfg {
    pub enabled: bool,
    pub system_listener: bool,
    pub sound: String,
}
impl Default for NotificationsCfg {
    fn default() -> Self {
        Self {
            enabled: true,
            system_listener: true,
            sound: "soft".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Placement {
    /// Presentation: compact notch, full-width edge bar, or full-height sidebar.
    pub mode: String,
    /// Edge of the selected monitor where the notch snaps.
    pub edge: String,
    /// Stable monitor device name when available; `None` follows the primary monitor.
    pub monitor: Option<String>,
}

impl Default for Placement {
    fn default() -> Self {
        Self {
            mode: "notch".into(),
            edge: "top".into(),
            monitor: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct InteractionCfg {
    pub hover_open: bool,
    pub open_delay_ms: u64,
    pub close_delay_ms: u64,
}

impl Default for InteractionCfg {
    fn default() -> Self {
        Self {
            hover_open: true,
            open_delay_ms: 140,
            close_delay_ms: 450,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub version: u32,
    pub compact_items: Vec<String>,
    #[serde(default = "legacy_onboarding_version")]
    pub onboarding_version: u8,
    pub hotkey: String,
    pub launch_at_login: bool,
    pub collapsed: Size,
    pub expanded: Size,
    pub placement: Placement,
    pub opacity: f64,
    pub accent: String,
    pub theme: String,
    pub size_preset: String,
    pub background: String,
    pub panels: PanelNames,
    pub widgets: Vec<WidgetConfig>,
    pub connections: Vec<AppConnection>,
    pub dnd: bool,
    pub hide_behind_windows: bool,
    /// Playback buttons in the collapsed notch media item.
    pub compact_media_controls: bool,
    /// Clock face for the collapsed notch clock item: "digital" | "analog".
    pub compact_clock_style: String,
    pub clock_typography: String,
    pub clock_hour_cycle: String,
    pub clock_seconds: bool,
    /// Manual weather coordinates; unset coordinates use approximate auto-location.
    pub weather_lat: Option<f64>,
    pub weather_lon: Option<f64>,
    pub weather_city: Option<String>,
    pub modules: Modules,
    pub visualizer: VisualizerCfg,
    pub dock: Vec<DockItem>,
    pub usage: UsageCfg,
    pub notifications: NotificationsCfg,
    pub interaction: InteractionCfg,
}

// Older persisted preferences should be treated as already introduced. A fresh
// Settings::default() still starts at zero and gets the short first-run tour.
fn legacy_onboarding_version() -> u8 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PanelNames {
    pub today: String,
    pub desk: String,
    pub activity: String,
}
impl Default for PanelNames {
    fn default() -> Self {
        Self {
            today: "Today".into(),
            desk: "Desk".into(),
            activity: "Activity".into(),
        }
    }
}
fn clean_panel_title(value: &str, fallback: &str) -> String {
    let title: String = value
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(24)
        .collect();
    if title.is_empty() {
        fallback.into()
    } else {
        title
    }
}
fn default_panel(kind: &str) -> &'static str {
    match kind {
        "media" | "weather" | "calendar" => "today",
        "notes" | "dock" | "focus" | "clock" | "nearby" => "desk",
        _ => "activity",
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: 1,
            compact_items: vec!["media".into(), "clock".into()],
            onboarding_version: 0,
            hotkey: "Alt+Space".into(),
            launch_at_login: false,
            collapsed: Size { w: 320.0, h: 38.0 },
            expanded: Size { w: 800.0, h: 560.0 },
            placement: Placement::default(),
            opacity: 0.96,
            accent: "#818cf8".into(),
            theme: "midnight".into(),
            size_preset: "medium".into(),
            background: "plain".into(),
            panels: PanelNames::default(),
            widgets: default_widgets(),
            connections: Vec::new(),
            dnd: false,
            hide_behind_windows: true,
            compact_media_controls: true,
            compact_clock_style: "digital".into(),
            clock_typography: "rounded".into(),
            clock_hour_cycle: "12".into(),
            clock_seconds: false,
            weather_lat: None,
            weather_lon: None,
            weather_city: None,
            modules: Modules::default(),
            visualizer: VisualizerCfg::default(),
            dock: Vec::new(),
            usage: UsageCfg::default(),
            notifications: NotificationsCfg::default(),
            interaction: InteractionCfg::default(),
        }
    }
}

fn default_widgets() -> Vec<WidgetConfig> {
    [
        ("w-media", "media", 0),
        ("w-weather", "weather", 1),
        ("w-calendar", "calendar", 2),
        ("w-notes", "notes", 3),
        ("w-ai", "ai", 4),
        ("w-dock", "dock", 5),
        ("w-focus", "focus", 6),
        ("w-system", "system", 7),
        ("w-notifications", "notifications", 8),
        ("w-reset-watch", "reset-watch", 9),
    ]
    .into_iter()
    .map(|(id, kind, order)| WidgetConfig {
        id: id.into(),
        kind: kind.into(),
        enabled: true,
        order,
        panel: Some(default_panel(kind).into()),
        clock_style: None,
    })
    .collect()
}

fn supported_widget_kind(kind: &str) -> bool {
    matches!(
        kind,
        "media"
            | "weather"
            | "calendar"
            | "notes"
            | "usage"
            | "notifications"
            | "dock"
            | "nearby"
            | "airdrop"
            | "ai"
            | "focus"
            | "system"
            | "reset-watch"
            | "clock"
            | "bluetooth"
            | "controls"
            | "web-alerts"
    )
}

impl Settings {
    /// Repair persisted or patched values before they can reach native window APIs.
    pub fn validated(mut self) -> Self {
        let defaults = Self::default();
        self.version = defaults.version;
        let (collapsed, expanded) = match self.size_preset.as_str() {
            "small" => (Size { w: 256.0, h: 36.0 }, Size { w: 640.0, h: 440.0 }),
            "large" => (Size { w: 384.0, h: 42.0 }, Size { w: 960.0, h: 640.0 }),
            "medium" => (defaults.collapsed, defaults.expanded),
            _ => {
                self.size_preset = "medium".into();
                (defaults.collapsed, defaults.expanded)
            }
        };
        self.collapsed = collapsed;
        self.expanded = expanded;
        if !matches!(
            self.background.as_str(),
            "aurora"
                | "reactive"
                | "artwork"
                | "ember"
                | "plain"
                | "contours"
                | "dots"
                | "grid"
                | "waves"
        ) {
            self.background = defaults.background;
        }
        self.panels.today = clean_panel_title(&self.panels.today, "Today");
        self.panels.desk = clean_panel_title(&self.panels.desk, "Desk");
        self.panels.activity = clean_panel_title(&self.panels.activity, "Activity");
        self.collapsed = self
            .collapsed
            .validated(defaults.collapsed, 200.0, 420.0, 32.0, 96.0);
        self.expanded = self
            .expanded
            .validated(defaults.expanded, 480.0, 1400.0, 320.0, 1000.0);
        self.opacity = finite_clamp(self.opacity, defaults.opacity, 0.90, 1.0);
        self.visualizer.intensity = finite_clamp(
            self.visualizer.intensity,
            defaults.visualizer.intensity,
            0.0,
            2.0,
        );
        self.visualizer.reactivity = finite_clamp(
            self.visualizer.reactivity,
            defaults.visualizer.reactivity,
            0.0,
            2.0,
        );
        self.interaction.open_delay_ms = self.interaction.open_delay_ms.clamp(0, 1000);
        self.interaction.close_delay_ms = self.interaction.close_delay_ms.clamp(100, 2000);
        if !matches!(self.placement.mode.as_str(), "notch" | "bar" | "sidebar") {
            self.placement.mode = "notch".into();
        }
        if !matches!(
            self.placement.edge.as_str(),
            "top" | "bottom" | "left" | "right"
        ) {
            self.placement.edge = defaults.placement.edge;
        }
        if self.placement.mode == "bar" && matches!(self.placement.edge.as_str(), "left" | "right") {
            self.placement.edge = "top".into();
        }
        if self.placement.mode == "sidebar" && matches!(self.placement.edge.as_str(), "top" | "bottom") {
            self.placement.edge = "left".into();
        }
        self.placement.monitor = self.placement.monitor.take().and_then(|monitor| {
            let trimmed = monitor.trim();
            (!trimmed.is_empty() && trimmed.len() <= 256 && !trimmed.chars().any(char::is_control))
                .then(|| trimmed.to_string())
        });
        if !matches!(self.notifications.sound.as_str(), "soft" | "glass" | "off") {
            self.notifications.sound = "off".into();
        }
        if !matches!(self.compact_clock_style.as_str(), "digital" | "analog") {
            self.compact_clock_style = defaults.compact_clock_style.clone();
        }
        if !matches!(self.clock_typography.as_str(), "rounded"|"serif"|"mono") {self.clock_typography="rounded".into();}
        if !matches!(self.clock_hour_cycle.as_str(), "12"|"24") {self.clock_hour_cycle="12".into();}
        self.onboarding_version = self.onboarding_version.min(1);
        let compact_limit = match self.size_preset.as_str() {
            "small" => 2,
            "large" => 4,
            _ => 3,
        };
        let mut compact_items = Vec::new();
        for item in self.compact_items.drain(..) {
            if matches!(
                item.as_str(),
                "media" | "clock" | "weather" | "battery" | "ai"
            ) && !compact_items.contains(&item)
                && compact_items.len() < compact_limit
            {
                compact_items.push(item);
            }
        }
        self.compact_items = compact_items;
        if self.hotkey.trim().is_empty() || self.hotkey.len() > 128 {
            self.hotkey = defaults.hotkey;
        }
        if self.accent.len() != 7
            || !self.accent.starts_with('#')
            || !self.accent[1..].chars().all(|c| c.is_ascii_hexdigit())
        {
            self.accent = defaults.accent;
        }
        if !matches!(
            self.visualizer.style.as_str(),
            "aurora"
                | "pulse"
                | "bloom"
                | "silk"
                | "halo"
                | "orbit"
                | "bars"
                | "wave"
                | "off"
                | "orb"
                | "rings"
        ) {
            self.visualizer.style = defaults.visualizer.style;
        }
        // Normalize legacy persisted aliases to their current names.
        self.visualizer.style = match self.visualizer.style.as_str() {
            "orb" => "bloom".into(),
            "rings" => "halo".into(),
            other => other.to_string(),
        };
        if !matches!(
            self.theme.as_str(),
            "frost" | "midnight" | "aurora" | "sunset" | "neon" | "mono" | "matcha"
        ) {
            self.theme = defaults.theme;
        }
        self.dock.truncate(64);
        self.widgets.truncate(64);
        self.connections.truncate(64);
        self.widgets
            .retain(|widget| supported_widget_kind(&widget.kind));
        for widget in &mut self.widgets {
            if !matches!(widget.panel.as_deref(), Some("today" | "desk" | "activity")) {
                widget.panel = Some(default_panel(&widget.kind).into());
            }
            widget.clock_style = if widget.kind == "clock"
                && matches!(widget.clock_style.as_deref(), Some("analog" | "digital"))
            {
                widget.clock_style.clone()
            } else {
                None
            };
        }
        for connection in &mut self.connections {
            let mut sources = Vec::new();
            for source in connection.notification_sources.drain(..).take(16) {
                let source = source.trim();
                if !source.is_empty()
                    && source.chars().count() <= 128
                    && !sources
                        .iter()
                        .any(|saved: &String| saved.eq_ignore_ascii_case(source))
                {
                    sources.push(source.to_string());
                }
            }
            connection.notification_sources = sources;
        }
        if self
            .weather_lat
            .is_some_and(|v| !v.is_finite() || !(-90.0..=90.0).contains(&v))
        {
            self.weather_lat = None;
        }
        if self
            .weather_lon
            .is_some_and(|v| !v.is_finite() || !(-180.0..=180.0).contains(&v))
        {
            self.weather_lon = None;
        }
        if self.weather_city.as_ref().is_some_and(|c| c.len() > 128) {
            self.weather_city = None;
        }
        self
    }
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

pub fn load(app: &AppHandle) -> Settings {
    match config_path(app).and_then(|p| std::fs::read_to_string(&p).map_err(|e| e.to_string())) {
        Ok(text) => serde_json::from_str::<Settings>(&text)
            .unwrap_or_default()
            .validated(),
        Err(_) => Settings::default(),
    }
}

pub fn save(app: &AppHandle, s: &Settings) -> Result<(), String> {
    let path = config_path(app)?;
    let text = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    let temp_path = path.with_extension(format!("json.{}.tmp", std::process::id()));
    let result = (|| -> std::io::Result<()> {
        let mut file = std::fs::File::create(&temp_path)?;
        use std::io::Write;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        std::fs::rename(&temp_path, &path)
    })();
    if let Err(error) = result {
        let _ = std::fs::remove_file(temp_path);
        return Err(error.to_string());
    }
    Ok(())
}

fn deep_merge(base: &mut Value, patch: Value) {
    match (base, patch) {
        (Value::Object(base_map), Value::Object(patch_map)) => {
            for (k, v) in patch_map {
                deep_merge(base_map.entry(k).or_insert(Value::Null), v);
            }
        }
        (base_slot, v) => *base_slot = v,
    }
}

/// Merge a partial JSON patch into the current Settings, returning the new value.
pub fn merge_patch(current: &Settings, patch: Value) -> Settings {
    let mut base = serde_json::to_value(current).unwrap_or(Value::Object(Default::default()));
    deep_merge(&mut base, patch);
    serde_json::from_value(base)
        .unwrap_or_else(|_| current.clone())
        .validated()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validation_repairs_non_finite_and_out_of_range_dimensions() {
        let settings = Settings {
            collapsed: Size {
                w: f64::NAN,
                h: -1.0,
            },
            expanded: Size {
                w: 50_000.0,
                h: f64::INFINITY,
            },
            opacity: f64::NAN,
            ..Settings::default()
        }
        .validated();
        assert_eq!(settings.collapsed.w, Settings::default().collapsed.w);
        assert_eq!(settings.collapsed.h, Settings::default().collapsed.h);
        assert_eq!(settings.expanded.w, Settings::default().expanded.w);
        assert_eq!(settings.expanded.h, Settings::default().expanded.h);
        assert_eq!(settings.opacity, Settings::default().opacity);
    }

    #[test]
    fn merge_patch_validates_values() {
        let merged = merge_patch(
            &Settings::default(),
            serde_json::json!({ "opacity": 7.0, "hotkey": "" }),
        );
        assert_eq!(merged.opacity, 1.0);
        assert_eq!(merged.hotkey, Settings::default().hotkey);
    }

    #[test]
    fn defaults_match_frontend_contract() {
        let s = Settings::default();
        assert_eq!(s.widgets.len(), 10);
        assert_eq!(s.widgets[0].id, "w-media");
        assert_eq!(s.widgets[8].kind, "notifications");
        assert!(supported_widget_kind("focus"));
        assert!(supported_widget_kind("system"));
        assert!(!supported_widget_kind("unknown"));
        assert!(s.widgets.iter().all(|w| w.enabled));
        assert_eq!(s.widgets[4].order, 4);
        assert!(s.connections.is_empty());
        assert!(!s.dnd);
        assert!(s.hide_behind_windows);
        assert_eq!(s.weather_lat, None);
    }

    #[test]
    fn validation_preserves_supported_late_added_widget_kinds() {
        let settings = Settings {
            widgets: ["focus", "system", "airdrop", "web-alerts", "not-real"]
                .into_iter()
                .enumerate()
                .map(|(order, kind)| WidgetConfig {
                    id: format!("widget-{order}"),
                    kind: kind.into(),
                    enabled: true,
                    order: order as i32,
                    panel: None,
                    clock_style: None,
                })
                .collect(),
            ..Settings::default()
        }
        .validated();
        assert_eq!(
            settings
                .widgets
                .iter()
                .map(|widget| widget.kind.as_str())
                .collect::<Vec<_>>(),
            vec!["focus", "system", "airdrop", "web-alerts"]
        );
        assert!(!Settings::default()
            .widgets
            .iter()
            .any(|widget| widget.kind == "web-alerts" && widget.enabled));
    }

    #[test]
    fn merge_patch_preserves_new_fields_and_round_trips() {
        let merged = merge_patch(
            &Settings::default(),
            serde_json::json!({
                "dnd": true,
                "hideBehindWindows": true,
                "weatherLat": 40.7128,
                "weatherLon": -74.0060,
                "weatherCity": "New York",
                "placement": { "edge": "right", "monitor": "\\\\.\\DISPLAY2" },
                "notifications": { "sound": "glass" },
                "visualizer": { "style": "silk" },
                "connections": [
                    { "id": "gmail", "name": "Gmail", "url": "https://mail.google.com/", "notifications": true,
                      "notificationSources": [" Gmail ", "gmail", "Chrome"] }
                ]
            }),
        );
        assert!(merged.dnd);
        assert!(merged.hide_behind_windows);
        assert_eq!(merged.weather_lat, Some(40.7128));
        assert_eq!(merged.weather_city.as_deref(), Some("New York"));
        assert_eq!(merged.placement.edge, "right");
        assert_eq!(merged.placement.monitor.as_deref(), Some("\\\\.\\DISPLAY2"));
        assert_eq!(merged.notifications.sound, "glass");
        assert_eq!(merged.visualizer.style, "silk");
        assert_eq!(merged.connections.len(), 1);
        assert!(merged.connections[0].notifications);
        assert_eq!(
            merged.connections[0].notification_sources,
            vec!["Gmail", "Chrome"]
        );
        // A patch that omits those keys must not drop them.
        let preserved = merge_patch(&merged, serde_json::json!({ "opacity": 0.5 }));
        assert_eq!(preserved.connections.len(), 1);
        assert!(preserved.dnd);
        assert_eq!(preserved.widgets.len(), merged.widgets.len());
        assert_eq!(preserved.weather_city.as_deref(), Some("New York"));
        assert_eq!(preserved.placement, merged.placement);
        assert_eq!(preserved.notifications.sound, "glass");
        assert_eq!(preserved.visualizer.style, "silk");
    }

    #[test]
    fn interaction_settings_default_and_clamp() {
        let defaults = Settings::default();
        assert!(defaults.interaction.hover_open);
        assert_eq!(defaults.interaction.open_delay_ms, 140);
        assert_eq!(defaults.interaction.close_delay_ms, 450);
        let bounded = merge_patch(
            &defaults,
            serde_json::json!({ "interaction": { "openDelayMs": 5000, "closeDelayMs": 0 } }),
        );
        assert_eq!(bounded.interaction.open_delay_ms, 1000);
        assert_eq!(bounded.interaction.close_delay_ms, 100);
    }

    #[test]
    fn placement_sound_and_visualizer_values_are_validated() {
        let defaults = Settings::default();
        assert!(defaults.hide_behind_windows);
        assert_eq!(defaults.placement, Placement::default());
        assert_eq!(defaults.notifications.sound, "soft");
        assert_eq!(defaults.visualizer.style, "ambient");

        let repaired = Settings {
            placement: Placement {
                mode: "invalid".into(),
                edge: "diagonal".into(),
                monitor: Some(format!("{}", "x".repeat(300))),
            },
            notifications: NotificationsCfg {
                sound: "loud".into(),
                ..NotificationsCfg::default()
            },
            visualizer: VisualizerCfg {
                style: "not-a-style".into(),
                ..VisualizerCfg::default()
            },
            ..Settings::default()
        }
        .validated();
        assert_eq!(repaired.placement, Placement::default());
        assert_eq!(repaired.notifications.sound, "off");
        assert_eq!(repaired.visualizer.style, "ambient");
    }

    #[test]
    fn legacy_visualizer_aliases_are_migrated() {
        let orb = Settings {
            visualizer: VisualizerCfg { style: "orb".into(), ..VisualizerCfg::default() },
            ..Settings::default()
        }
        .validated();
        assert_eq!(orb.visualizer.style, "bloom");
        let rings = Settings {
            visualizer: VisualizerCfg { style: "rings".into(), ..VisualizerCfg::default() },
            ..Settings::default()
        }
        .validated();
        assert_eq!(rings.visualizer.style, "halo");
    }
}
