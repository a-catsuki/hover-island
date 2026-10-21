use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
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
    #[serde(default)]
    pub onboarding_version: u8,
    pub hotkey: String,
    pub spotlight_hotkey: String,
    pub launch_at_login: bool,
    pub auto_update: bool,
    pub collapsed: Size,
    pub expanded: Size,
    pub placement: Placement,
    pub opacity: f64,
    pub accent: String,
    pub theme: String,
    pub size_preset: String,
    pub background: String,
    pub panels: PanelNames,
    #[serde(default = "default_panel_order")]
    pub panel_order: Vec<String>,
    /// Custom display names for pages, keyed by panel id. Empty means the defaults.
    #[serde(default)]
    pub panel_names: BTreeMap<String, String>,
    pub widgets: Vec<WidgetConfig>,
    pub connections: Vec<AppConnection>,
    pub dnd: bool,
    pub hide_behind_windows: bool,
    /// Playback buttons in the collapsed notch media item.
    pub compact_media_controls: bool,
    /// Clock face for the collapsed notch clock item: "digital" | "analog".
    pub compact_clock_style: String,
    /// Windows' own toast banners while Hover Island runs: "normal" | "quiet" | "clear".
    pub windows_banners: String,
    /// Small AI stat in the collapsed notch: "off" | "usage-left" | "response-time" | "active-count".
    pub compact_ai_stat: String,
    /// Show live AI agent toasts (started, progress, question, completed, failed).
    pub ai_toasts_enabled: bool,
    /// Provider ids that may raise toasts. Empty means every provider.
    pub ai_toast_providers: Vec<String>,
    pub clock_typography: String,
    pub clock_hour_cycle: String,
    pub clock_seconds: bool,
    /// Manual weather coordinates. Automatic lookup requires weather_auto_location.
    pub weather_lat: Option<f64>,
    pub weather_lon: Option<f64>,
    pub weather_city: Option<String>,
    pub weather_auto_location: bool,
    /// Weather display units: "metric" (C, km/h) or "imperial" (F, mph).
    pub weather_units: String,
    pub modules: Modules,
    pub visualizer: VisualizerCfg,
    pub dock: Vec<DockItem>,
    pub usage: UsageCfg,
    pub notifications: NotificationsCfg,
    pub interaction: InteractionCfg,
}

pub type PanelNames = BTreeMap<String, String>;

fn default_panel_names() -> PanelNames {
    BTreeMap::from([
        ("today".into(), "Today".into()),
        ("desk".into(), "Desk".into()),
        ("activity".into(), "Activity".into()),
    ])
}

fn default_panel_order() -> Vec<String> {
    vec!["today".into(), "desk".into(), "activity".into()]
}

fn valid_panel_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
        && id.as_bytes()[0].is_ascii_alphanumeric()
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

const MAX_PANEL_COUNT: usize = 128;

/// Split enabled widgets into pages using the editor's two-column cell geometry.
fn flat_panel_groups(widgets: &[WidgetConfig]) -> Vec<Vec<String>> {
    let mut groups = Vec::new();
    let mut group = Vec::new();
    let mut occupied = [[false; 2]; 2];
    for widget in widgets
        .iter()
        .filter(|widget| widget.enabled && widget.kind != "airdrop")
    {
        let minimum_full = matches!(widget.kind.as_str(), "nearby" | "controls" | "calendar");
        let size = widget.size.as_deref().unwrap_or_else(|| {
            if matches!(widget.kind.as_str(), "usage" | "web-alerts" | "clock") {
                "full"
            } else if widget.kind == "dock" {
                "wide"
            } else {
                "compact"
            }
        });
        let span_x = if !minimum_full && matches!(size, "compact" | "tall") {
            1
        } else {
            2
        };
        let span_y = if minimum_full || matches!(size, "full" | "tall") { 2 } else { 1 };
        // Honor the same pinned cell as the frontend so saving cannot move a drop.
        let mut target = widget.slot.as_ref().and_then(|slot| {
            let row = slot.row.saturating_sub(1) as usize;
            let column = slot.column.saturating_sub(1) as usize;
            if row + span_y <= 2 && column + span_x <= 2
                && (row..row + span_y).all(|y| (column..column + span_x).all(|x| !occupied[y][x])) {
                Some((row, column))
            } else {
                None
            }
        });
        for row in 0..=2 - span_y {
            if target.is_some() { break; }
            for column in 0..=2 - span_x {
                let free =
                    (row..row + span_y).all(|y| (column..column + span_x).all(|x| !occupied[y][x]));
                if free {
                    target = Some((row, column));
                    break;
                }
            }
            if target.is_some() {
                break;
            }
        }
        if target.is_none() && !group.is_empty() {
            groups.push(std::mem::take(&mut group));
            occupied = [[false; 2]; 2];
            target = widget.slot.as_ref().and_then(|slot| {
                let row = slot.row.saturating_sub(1) as usize;
                let column = slot.column.saturating_sub(1) as usize;
                (row + span_y <= 2 && column + span_x <= 2).then_some((row, column))
            }).or(Some((0, 0)));
        }
        let Some((row, column)) = target else {
            continue;
        };
        group.push(widget.id.clone());
        for y in row..row + span_y {
            for x in column..column + span_x {
                occupied[y][x] = true;
            }
        }
        if occupied.iter().all(|line| line.iter().all(|cell| *cell)) {
            groups.push(std::mem::take(&mut group));
            occupied = [[false; 2]; 2];
        }
    }
    if !group.is_empty() {
        groups.push(group);
    }
    groups
}

fn generated_overflow_id(base: &str, suffix: usize, panels: &PanelNames) -> String {
    let base: String = base.chars().take(48).collect();
    let stem = format!("overflow-{base}-{suffix}");
    let mut id = stem.clone();
    let mut serial = 2;
    while panels.contains_key(&id) {
        id = format!("{stem}-{serial}");
        serial += 1;
    }
    id
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: 1,
            compact_items: vec!["media".into(), "clock".into()],
            onboarding_version: 0,
            hotkey: "Alt+Space".into(),
            spotlight_hotkey: "Control+Space".into(),
            launch_at_login: false,
            auto_update: true,
            collapsed: Size { w: 288.0, h: 32.0 },
            expanded: Size { w: 800.0, h: 510.0 },
            placement: Placement::default(),
            opacity: 0.96,
            accent: "#0a84ff".into(),
            theme: "midnight".into(),
            size_preset: "medium".into(),
            background: "plain".into(),
            panels: default_panel_names(),
            panel_order: default_panel_order(),
            panel_names: BTreeMap::new(),
            widgets: default_widgets(),
            connections: Vec::new(),
            dnd: false,
            hide_behind_windows: true,
            compact_media_controls: false,
            compact_clock_style: "digital".into(),
            windows_banners: "normal".into(),
            compact_ai_stat: "off".into(),
            ai_toasts_enabled: true,
            ai_toast_providers: Vec::new(),
            clock_typography: "rounded".into(),
            clock_hour_cycle: "12".into(),
            clock_seconds: false,
            weather_lat: None,
            weather_lon: None,
            weather_city: None,
            weather_auto_location: false,
            weather_units: "metric".into(),
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
        size: None,
        show_lyrics: None,
        slot: None,
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
            | "network"
            | "awake"
            | "reminders"
    )
}

impl Settings {
    /// Repair persisted or patched values before they can reach native window APIs.
    pub fn validated(mut self) -> Self {
        let defaults = Self::default();
        self.version = defaults.version;
        // The preset picker supplies its dimensions explicitly. Validation must
        // preserve persisted/custom sizes and partial geometry patches; resetting
        // them here also discarded the frontend's horizontal-only preset sizes.
        if !matches!(self.size_preset.as_str(), "small" | "medium" | "large") {
            self.size_preset = "medium".into();
        }
        if !matches!(
            self.background.as_str(),
            "aurora"
                | "ambient"
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
        self.panels.retain(|id, _| valid_panel_id(id));
        if self.panels.len() > MAX_PANEL_COUNT {
            let mut ordered = Vec::new();
            for id in &self.panel_order {
                if self.panels.contains_key(id) && !ordered.contains(id) {
                    ordered.push(id.clone());
                }
            }
            for id in self.panels.keys() {
                if !ordered.contains(id) {
                    ordered.push(id.clone());
                }
            }
            let keep: std::collections::HashSet<_> =
                ordered.into_iter().take(MAX_PANEL_COUNT).collect();
            self.panels.retain(|id, _| keep.contains(id));
        }
        for (id, title) in &mut self.panels {
            *title = clean_panel_title(title, id);
        }
        if self.panels.is_empty() {
            self.panels.insert("today".into(), "Today".into());
        }
        let mut order = Vec::new();
        for id in self.panel_order.drain(..) {
            if self.panels.contains_key(&id) && !order.contains(&id) {
                order.push(id);
            }
        }
        for id in self.panels.keys() {
            if !order.contains(id) {
                order.push(id.clone());
            }
        }
        self.panel_order = order;
        // Custom page names: known ids only, trimmed, control characters removed, 16 chars max.
        let known: std::collections::HashSet<String> = self.panels.keys().cloned().collect();
        self.panel_names = std::mem::take(&mut self.panel_names)
            .into_iter()
            .filter_map(|(id, name)| {
                if !known.contains(&id) {
                    return None;
                }
                let clean: String = name
                    .chars()
                    .filter(|c| !c.is_control())
                    .collect::<String>()
                    .trim()
                    .chars()
                    .take(16)
                    .collect();
                let clean = clean.trim().to_string();
                if clean.is_empty() {
                    None
                } else {
                    Some((id, clean))
                }
            })
            .collect();
        self.collapsed = self
            .collapsed
            .validated(defaults.collapsed, 200.0, 420.0, 32.0, 96.0);
        self.expanded = self
            .expanded
            .validated(defaults.expanded, 480.0, 1400.0, 320.0, 1000.0);
        // Migrate only the exact old presets; preserve custom dimensions.
        if self.size_preset == "small" {
            if self.collapsed == (Size { w: 256.0, h: 36.0 }) {
                self.collapsed.h = 38.0;
            }
            if self.expanded == (Size { w: 640.0, h: 440.0 }) {
                self.expanded.h = 560.0;
            }
        } else if self.size_preset == "large" {
            if self.collapsed == (Size { w: 384.0, h: 42.0 }) {
                self.collapsed.h = 38.0;
            }
            if self.expanded == (Size { w: 960.0, h: 640.0 }) {
                self.expanded.h = 560.0;
            }
        }
        // Round 3/4: stock presets are wide as before but a little shorter. Move only the
        // exact previous stock sizes; any custom dimensions stay as the user set them.
        self.expanded = match (self.expanded.w as i64, self.expanded.h as i64) {
            (640, 560) | (500, 420) => Size { w: 640.0, h: 490.0 },
            (800, 560) | (620, 440) => Size { w: 800.0, h: 510.0 },
            (960, 560) | (740, 450) => Size { w: 960.0, h: 520.0 },
            _ => self.expanded,
        };
        // The collapsed pill got slimmer: move only the exact old stock sizes.
        self.collapsed = match (self.collapsed.w as i64, self.collapsed.h as i64) {
            (256, 38) => Size { w: 232.0, h: 32.0 },
            (320, 38) => Size { w: 288.0, h: 32.0 },
            (384, 38) => Size { w: 344.0, h: 32.0 },
            _ => self.collapsed,
        };
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
        if self.placement.mode == "bar" && matches!(self.placement.edge.as_str(), "left" | "right")
        {
            self.placement.edge = "top".into();
        }
        if self.placement.mode == "notch" && self.placement.edge == "bottom" {
            self.placement.edge = "top".into();
        }
        if self.placement.mode == "sidebar"
            && matches!(self.placement.edge.as_str(), "top" | "bottom")
        {
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
        if !matches!(self.windows_banners.as_str(), "normal" | "quiet" | "clear") {
            self.windows_banners = "normal".into();
        }
        if !matches!(self.compact_clock_style.as_str(), "digital" | "analog") {
            self.compact_clock_style = defaults.compact_clock_style.clone();
        }
        if !matches!(
            self.compact_ai_stat.as_str(),
            "off" | "usage-left" | "response-time" | "active-count"
        ) {
            self.compact_ai_stat = defaults.compact_ai_stat.clone();
        }
        self.ai_toast_providers.retain(|id| {
            !id.is_empty()
                && id.len() <= 32
                && id
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
        });
        self.ai_toast_providers.sort();
        self.ai_toast_providers.dedup();
        self.ai_toast_providers.truncate(32);
        if !matches!(self.clock_typography.as_str(), "rounded" | "serif" | "mono") {
            self.clock_typography = "rounded".into();
        }
        if !matches!(self.clock_hour_cycle.as_str(), "12" | "24") {
            self.clock_hour_cycle = "12".into();
        }
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
        if self.spotlight_hotkey.trim().is_empty() || self.spotlight_hotkey.len() > 128 {
            self.spotlight_hotkey = defaults.spotlight_hotkey;
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
                | "mirror"
                | "radial"
                | "particles"
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
            let panel = widget
                .panel
                .as_deref()
                .filter(|id| valid_panel_id(id))
                .map(str::to_owned);
            match panel {
                Some(id) if self.panels.contains_key(&id) => widget.panel = Some(id),
                Some(id) if self.panels.len() < MAX_PANEL_COUNT => {
                    self.panels
                        .insert(id.clone(), format!("Recovered {}", self.panels.len() + 1));
                    self.panel_order.push(id.clone());
                    widget.panel = Some(id);
                }
                _ => {
                    let preferred = default_panel(&widget.kind);
                    let fallback = if self.panels.contains_key(preferred) {
                        preferred.to_string()
                    } else {
                        self.panel_order
                            .first()
                            .cloned()
                            .unwrap_or_else(|| "today".into())
                    };
                    widget.panel = Some(fallback);
                }
            }
            widget.clock_style = if widget.kind == "clock"
                && matches!(widget.clock_style.as_deref(), Some("analog" | "digital"))
            {
                widget.clock_style.clone()
            } else {
                None
            };
            widget.size = match widget.size.as_deref() {
                Some("compact" | "wide" | "tall" | "full") => widget.size.clone(),
                _ => None,
            };
            widget.show_lyrics = if widget.kind == "media" {
                Some(widget.show_lyrics.unwrap_or(false))
            } else {
                None
            };
            widget.slot = widget
                .slot
                .filter(|slot| (1..=2).contains(&slot.row) && (1..=2).contains(&slot.column));
        }
        // Fold untouched generated overflow labels back into their base page so
        // saved state can be repacked with current two-column geometry.
        // Disabled widgets stay assigned to their visible panel and are never discarded.
        let auto_pages: Vec<_> = self
            .panel_order
            .iter()
            .filter_map(|id| {
                self.panels
                    .iter()
                    .filter(|(base, _)| !base.starts_with("overflow-"))
                    .filter_map(|(base, title)| {
                        let prefix = format!("overflow-{base}-");
                        let suffix = id.strip_prefix(&prefix)?;
                        let parts: Vec<_> = suffix.split('-').collect();
                        if parts.is_empty()
                            || parts.iter().any(|part| part.parse::<usize>().is_err())
                        {
                            return None;
                        }
                        let expected = format!("{} {}", title, parts[0]);
                        (self.panels.get(id) == Some(&expected)).then(|| (id.clone(), base.clone()))
                    })
                    .max_by_key(|(_, base)| base.len())
            })
            .collect();
        for (id, base) in auto_pages {
            for widget in &mut self.widgets {
                if widget.panel.as_deref() == Some(id.as_str()) {
                    widget.panel = Some(base.clone());
                }
            }
            self.panels.remove(&id);
            self.panel_order.retain(|panel| panel != &id);
        }
        let roots = self.panel_order.clone();
        for root in roots {
            let mut members: Vec<_> = self
                .widgets
                .iter()
                .filter(|widget| widget.panel.as_deref() == Some(root.as_str()))
                .cloned()
                .collect();
            members.sort_by_key(|widget| widget.order);
            let groups = flat_panel_groups(&members);
            for (page, ids) in groups.into_iter().enumerate().skip(1) {
                if self.panels.len() >= MAX_PANEL_COUNT {
                    break;
                }
                let id = generated_overflow_id(&root, page + 1, &self.panels);
                let title = format!(
                    "{} {}",
                    self.panels
                        .get(&root)
                        .map(String::as_str)
                        .unwrap_or("Panel"),
                    page + 1
                );
                self.panels
                    .insert(id.clone(), clean_panel_title(&title, "Panel"));
                let insert_at = self
                    .panel_order
                    .iter()
                    .position(|entry| entry == &root)
                    .map(|index| index + page)
                    .unwrap_or(self.panel_order.len());
                self.panel_order
                    .insert(insert_at.min(self.panel_order.len()), id.clone());
                for widget in &mut self.widgets {
                    if ids.contains(&widget.id) {
                        widget.panel = Some(id.clone());
                    }
                }
            }
        }
        let empty_overflow: Vec<_> = self
            .panel_order
            .iter()
            .filter(|id| {
                id.starts_with("overflow-")
                    && !self
                        .widgets
                        .iter()
                        .any(|widget| widget.panel.as_deref() == Some(id.as_str()))
            })
            .cloned()
            .collect();
        for id in empty_overflow {
            self.panels.remove(&id);
            self.panel_order.retain(|panel| panel != &id);
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
        if !matches!(self.weather_units.as_str(), "metric" | "imperial") {
            self.weather_units = "metric".into();
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
        Ok(text) => serde_json::from_str::<Value>(&text)
            .map(parse_saved_settings)
            .unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

fn parse_saved_settings(mut value: Value) -> Settings {
    // Persisted partial Size objects use zero for absent axes. Restore the
    // selected/default preset's missing axes before serde, keeping custom axes.
    // This default applies only to a full saved file, never unrelated patches.
    if let Some(object) = value.as_object_mut() {
        if !matches!(
            object.get("sizePreset").and_then(Value::as_str),
            Some("small" | "medium" | "large")
        ) {
            object.insert("sizePreset".into(), serde_json::json!("medium"));
        }
    }
    fill_missing_preset_geometry(&mut value);
    serde_json::from_value::<Settings>(value)
        .unwrap_or_default()
        .validated()
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

/// Older preferences and callers can name a preset without sending dimensions.
/// Supply only absent axes; explicit custom geometry always takes precedence.
fn fill_missing_preset_geometry(value: &mut Value) {
    let Some(object) = value.as_object_mut() else {
        return;
    };
    let (width, height, pill_width) = match object.get("sizePreset").and_then(Value::as_str) {
        Some("small") => (640.0, 490.0, 232.0),
        Some("medium") => (800.0, 510.0, 288.0),
        Some("large") => (960.0, 520.0, 344.0),
        _ => return,
    };
    for (key, w, h) in [("collapsed", pill_width, 32.0), ("expanded", width, height)] {
        let geometry = object.entry(key).or_insert_with(|| serde_json::json!({}));
        if let Some(axes) = geometry.as_object_mut() {
            axes.entry("w").or_insert_with(|| serde_json::json!(w));
            axes.entry("h").or_insert_with(|| serde_json::json!(h));
        }
    }
}

/// Merge a partial JSON patch into the current Settings, returning the new value.
pub fn merge_patch(current: &Settings, patch: Value) -> Settings {
    let mut base = serde_json::to_value(current).unwrap_or(Value::Object(Default::default()));
    let mut patch = patch;
    fill_missing_preset_geometry(&mut patch);
    let replacement_panels = patch
        .as_object_mut()
        .and_then(|object| object.remove("panels"));
    // Names are replaced wholesale so that "Reset" can remove a key.
    let replacement_panel_names = patch
        .as_object_mut()
        .and_then(|object| object.remove("panelNames"));
    deep_merge(&mut base, patch);
    if let (Some(base), Some(panels)) = (base.as_object_mut(), replacement_panels) {
        base.insert("panels".into(), panels);
    }
    if let (Some(base), Some(names)) = (base.as_object_mut(), replacement_panel_names) {
        base.insert("panelNames".into(), names);
    }
    serde_json::from_value(base)
        .unwrap_or_else(|_| current.clone())
        .validated()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_run_defaults_and_location_consent_are_safe() {
        let migrated: Settings = serde_json::from_value(serde_json::json!({"version": 1})).unwrap();
        assert_eq!(migrated.onboarding_version, 0);
        assert!(!migrated.weather_auto_location);
        assert_eq!(migrated.spotlight_hotkey, "Control+Space");
        let completed: Settings =
            serde_json::from_value(serde_json::json!({"onboardingVersion": 1})).unwrap();
        assert_eq!(completed.onboarding_version, 1);
    }

    #[test]
    fn bottom_notch_migrates_but_bottom_bar_remains_available() {
        let notch = merge_patch(
            &Settings::default(),
            serde_json::json!({"placement":{"mode":"notch","edge":"bottom"}}),
        );
        assert_eq!(notch.placement.edge, "top");
        let bar = merge_patch(
            &Settings::default(),
            serde_json::json!({"placement":{"mode":"bar","edge":"bottom"}}),
        );
        assert_eq!(bar.placement.edge, "bottom");
    }

    #[test]
    fn exact_old_presets_migrate_without_overwriting_custom_sizes() {
        let old = merge_patch(
            &Settings::default(),
            serde_json::json!({"sizePreset":"small","collapsed":{"w":256,"h":36},"expanded":{"w":640,"h":440}}),
        );
        assert_eq!(old.collapsed.h, 32.0);
        assert_eq!(old.expanded, Size { w: 640.0, h: 490.0 });
        let custom = merge_patch(&old, serde_json::json!({"expanded":{"h":480}}));
        assert_eq!(custom.expanded, Size { w: 640.0, h: 480.0 });
        let preset_only = merge_patch(&custom, serde_json::json!({"sizePreset":"large"}));
        assert_eq!(preset_only.collapsed, Size { w: 344.0, h: 32.0 });
        assert_eq!(preset_only.expanded, Size { w: 960.0, h: 520.0 });
        let custom_axes = merge_patch(
            &preset_only,
            serde_json::json!({"sizePreset":"small", "expanded":{"h":480}}),
        );
        assert_eq!(custom_axes.expanded, Size { w: 640.0, h: 480.0 });
        let mut persisted = serde_json::json!({"sizePreset":"small"});
        fill_missing_preset_geometry(&mut persisted);
        let loaded = serde_json::from_value::<Settings>(persisted)
            .unwrap()
            .validated();
        assert_eq!(loaded.expanded, Size { w: 640.0, h: 490.0 });
        for preset in [Value::Null, serde_json::json!("unknown")] {
            let mut saved =
                serde_json::json!({"collapsed":{"w":310},"expanded":{"w":770},"accent":"#123456"});
            if !preset.is_null() {
                saved["sizePreset"] = preset;
            }
            let loaded = parse_saved_settings(saved);
            assert_eq!(loaded.size_preset, "medium");
            assert_eq!(loaded.collapsed, Size { w: 310.0, h: 32.0 });
            assert_eq!(loaded.expanded, Size { w: 770.0, h: 510.0 });
        }
    }

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
        assert_eq!(settings.collapsed.h, 32.0);
        assert_eq!(settings.expanded.w, 1400.0);
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
    fn legacy_panel_names_and_order_survive_dynamic_layout_migration() {
        let mut value = serde_json::to_value(Settings::default()).unwrap();
        value.as_object_mut().unwrap().remove("panelOrder");
        value["panels"] = serde_json::json!({
            "today": "My day",
            "work-notes": "Work notes",
        });
        value["widgets"] = serde_json::json!([
            { "id": "note", "kind": "notes", "enabled": true, "order": 0, "panel": "work-notes" }
        ]);

        let settings: Settings = serde_json::from_value(value).unwrap();
        let settings = settings.validated();
        assert_eq!(
            settings.panels.get("today").map(String::as_str),
            Some("My day")
        );
        assert_eq!(
            settings.panels.get("work-notes").map(String::as_str),
            Some("Work notes")
        );
        assert!(settings.panel_order.contains(&"today".to_string()));
        assert!(settings.panel_order.contains(&"work-notes".to_string()));
        assert_eq!(settings.widgets[0].panel.as_deref(), Some("work-notes"));
    }

    #[test]
    fn panel_map_patch_replaces_deleted_panels_without_recreating_them() {
        let mut current = Settings::default();
        current.widgets.clear();
        let merged = merge_patch(
            &current,
            serde_json::json!({ "panels": { "studio": "Studio" }, "panelOrder": ["studio"] }),
        );
        assert_eq!(
            merged.panels,
            BTreeMap::from([("studio".into(), "Studio".into())])
        );
        assert_eq!(merged.panel_order, vec!["studio".to_string()]);
    }

    #[test]
    fn flat_panel_migration_keeps_every_widget_and_limits_each_panel_to_one_page() {
        let widgets: Vec<_> = (0..7)
            .map(|order| WidgetConfig {
                id: format!("ai-{order}"),
                kind: "ai".into(),
                enabled: true,
                order,
                panel: Some("today".into()),
                clock_style: None,
                size: None,
                show_lyrics: None,
                slot: None,
            })
            .collect();
        let settings = Settings {
            panels: BTreeMap::from([("today".into(), "Today".into())]),
            panel_order: vec!["today".into()],
            widgets,
            ..Settings::default()
        }
        .validated();

        assert_eq!(settings.widgets.len(), 7);
        // Seven compact tiles fill two 2x2 pages, so the migration must have
        // split them across an overflow page in addition to the original one.
        assert!(settings.panel_order.len() >= 2);
        for panel in &settings.panel_order {
            let members: Vec<_> = settings
                .widgets
                .iter()
                .filter(|widget| widget.enabled && widget.panel.as_deref() == Some(panel.as_str()))
                .cloned()
                .collect();
            assert!(
                flat_panel_groups(&members).len() <= 1,
                "{panel} still needs nested pages"
            );
        }
        let ids: std::collections::HashSet<_> = settings
            .widgets
            .iter()
            .map(|widget| widget.id.as_str())
            .collect();
        assert_eq!(ids.len(), 7);
    }

    #[test]
    fn validation_repacks_generated_today_pages_into_the_editor_two_by_two_grid() {
        let make =
            |id: &str, kind: &str, order: i32, panel: &str, size: Option<&str>| WidgetConfig {
                id: id.into(),
                kind: kind.into(),
                enabled: true,
                order,
                panel: Some(panel.into()),
                clock_style: None,
                size: size.map(str::to_string),
                show_lyrics: None,
                slot: None,
            };
        let settings = Settings {
            panels: BTreeMap::from([
                ("today".into(), "Today".into()),
                ("overflow-today-2".into(), "Today 2".into()),
                ("overflow-today-2-2".into(), "Today 2".into()),
                ("overflow-today-2-2-2".into(), "Today 2".into()),
            ]),
            panel_order: vec![
                "today".into(),
                "overflow-today-2".into(),
                "overflow-today-2-2".into(),
                "overflow-today-2-2-2".into(),
            ],
            widgets: vec![
                make("media", "media", 0, "today", Some("compact")),
                make("weather", "weather", 1, "overflow-today-2", Some("wide")),
                make("focus", "focus", 2, "overflow-today-2-2", Some("compact")),
                make("calendar", "calendar", 3, "overflow-today-2-2-2", None),
            ],
            ..Settings::default()
        }
        .validated();

        assert_eq!(settings.panel_order, vec!["today", "overflow-today-2"]);
        for id in ["media", "weather", "focus"] {
            assert_eq!(
                settings
                    .widgets
                    .iter()
                    .find(|widget| widget.id == id)
                    .unwrap()
                    .panel
                    .as_deref(),
                Some("today")
            );
        }
        assert_eq!(
            settings
                .widgets
                .iter()
                .find(|widget| widget.id == "calendar")
                .unwrap()
                .panel
                .as_deref(),
            Some("overflow-today-2")
        );
        let members: Vec<_> = settings
            .widgets
            .iter()
            .filter(|widget| widget.panel.as_deref() == Some("today"))
            .cloned()
            .collect();
        assert_eq!(
            flat_panel_groups(&members),
            vec![vec![
                "media".to_string(),
                "weather".to_string(),
                "focus".to_string()
            ]]
        );
        let stable = settings.clone().validated();
        assert_eq!(stable.panel_order, settings.panel_order);
        assert_eq!(
            stable
                .widgets
                .iter()
                .map(|widget| widget.panel.clone())
                .collect::<Vec<_>>(),
            settings
                .widgets
                .iter()
                .map(|widget| widget.panel.clone())
                .collect::<Vec<_>>()
        );
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
                    size: None,
                    show_lyrics: None,
                    slot: None,
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
        for style in ["ambient", "mirror", "radial", "particles"] {
            let saved = merge_patch(
                &defaults,
                serde_json::json!({ "visualizer": { "style": style } }),
            );
            assert_eq!(
                saved.visualizer.style, style,
                "selected styles must survive native settings validation"
            );
        }
    }

    #[test]
    fn legacy_visualizer_aliases_are_migrated() {
        let orb = Settings {
            visualizer: VisualizerCfg {
                style: "orb".into(),
                ..VisualizerCfg::default()
            },
            ..Settings::default()
        }
        .validated();
        assert_eq!(orb.visualizer.style, "bloom");
        let rings = Settings {
            visualizer: VisualizerCfg {
                style: "rings".into(),
                ..VisualizerCfg::default()
            },
            ..Settings::default()
        }
        .validated();
        assert_eq!(rings.visualizer.style, "halo");
    }
}
