//! The AI tools Hover Island can read local activity from, and where each keeps its sessions.
//!
//! Every provider is optional: a missing folder simply means "not installed". Nothing here
//! writes to disk, opens credentials or talks to the network.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde_json::Value;

use super::{
    clean_title, collect_files, content_text, mean_ms, modified_ms, parse_rfc3339_millis,
    scan_jsonl, session_id, FileEntry, ScanOut, SessionStat, ACTIVE_WINDOW_MS, DAY_MS, WEEK_MS,
};
use crate::types::{ActivityInfo, RecentSession, UsageSnapshot};

const MAX_JSON_BYTES: u64 = 8 * 1024 * 1024;
const MAX_SMALL_JSON_BYTES: u64 = 256 * 1024;
const MAX_PARSED_SESSIONS: usize = 60;
const MAX_MESSAGE_FILES: usize = 400;
const RECENT_LIMIT: usize = 6;
const MAX_HOME_ENTRIES: usize = 600;

#[derive(Clone, Copy)]
pub(crate) enum Base {
    Home,
    AppData,
    LocalAppData,
}

pub(crate) struct Loc {
    pub base: Base,
    pub rel: &'static str,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Parser {
    Codex,
    Claude,
    Copilot,
    Gemini,
    OpenCode,
    Mtime,
}

pub(crate) struct Spec {
    pub id: &'static str,
    pub label: &'static str,
    pub parser: Parser,
    /// Folders that hold one file per session.
    pub roots: &'static [Loc],
    /// Single files whose modification time shows the tool was used.
    pub markers: &'static [Loc],
    /// Presence of any of these means the tool is installed.
    pub installed: &'static [Loc],
    /// Home folder entries starting with this prefix also mean installed (Aider).
    pub home_prefix: Option<&'static str>,
    /// Which files below a root are sessions.
    pub accept: fn(&Path) -> bool,
    pub depth: usize,
    /// Environment variable that relocates the tool's data folder, plus the sub path inside it.
    pub env_dir: Option<(&'static str, &'static str)>,
    /// Shown when the tool is installed but exposes nothing readable.
    pub note: &'static str,
}

fn has_ext(path: &Path, ext: &str) -> bool {
    path.extension()
        .and_then(|s| s.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case(ext))
}

fn file_name(path: &Path) -> &str {
    path.file_name().and_then(|n| n.to_str()).unwrap_or_default()
}

fn accept_jsonl(path: &Path) -> bool {
    has_ext(path, "jsonl")
}

fn accept_copilot(path: &Path) -> bool {
    file_name(path).eq_ignore_ascii_case("events.jsonl")
}

fn accept_gemini(path: &Path) -> bool {
    file_name(path).starts_with("session-") && (has_ext(path, "json") || has_ext(path, "jsonl"))
}

fn accept_opencode(path: &Path) -> bool {
    file_name(path).starts_with("ses_") && has_ext(path, "json")
}

fn accept_cursor(path: &Path) -> bool {
    if file_name(path).eq_ignore_ascii_case("store.db") {
        return true;
    }
    let transcript = path
        .components()
        .any(|part| part.as_os_str() == "agent-transcripts");
    transcript
        && ["txt", "md", "json", "jsonl"]
            .iter()
            .any(|ext| has_ext(path, ext))
}

fn accept_nothing(_: &Path) -> bool {
    false
}

pub(crate) const SPECS: &[Spec] = &[
    Spec {
        id: "codex",
        label: "Codex",
        parser: Parser::Codex,
        roots: &[Loc { base: Base::Home, rel: ".codex/sessions" }],
        markers: &[],
        installed: &[Loc { base: Base::Home, rel: ".codex" }],
        home_prefix: None,
        accept: accept_jsonl,
        depth: 8,
        env_dir: Some(("CODEX_HOME", "sessions")),
        note: "Installed. No Codex sessions yet.",
    },
    Spec {
        id: "claude-code",
        label: "Claude Code",
        parser: Parser::Claude,
        roots: &[
            Loc { base: Base::Home, rel: ".claude/projects" },
            Loc { base: Base::Home, rel: ".config/claude/projects" },
        ],
        markers: &[],
        installed: &[
            Loc { base: Base::Home, rel: ".claude" },
            Loc { base: Base::Home, rel: ".config/claude" },
        ],
        home_prefix: None,
        accept: accept_jsonl,
        depth: 8,
        env_dir: Some(("CLAUDE_CONFIG_DIR", "projects")),
        note: "Installed. No Claude Code sessions yet.",
    },
    Spec {
        id: "gemini",
        label: "Gemini CLI",
        parser: Parser::Gemini,
        roots: &[Loc { base: Base::Home, rel: ".gemini/tmp" }],
        markers: &[],
        installed: &[
            Loc { base: Base::Home, rel: ".gemini" },
            Loc { base: Base::Home, rel: ".config/gemini" },
        ],
        home_prefix: None,
        accept: accept_gemini,
        depth: 4,
        env_dir: None,
        note: "Installed. No Gemini CLI chats yet.",
    },
    Spec {
        id: "cursor",
        label: "Cursor",
        parser: Parser::Mtime,
        roots: &[
            Loc { base: Base::Home, rel: ".cursor/projects" },
            Loc { base: Base::Home, rel: ".cursor/chats" },
        ],
        markers: &[],
        installed: &[
            Loc { base: Base::Home, rel: ".cursor" },
            Loc { base: Base::AppData, rel: "Cursor" },
            Loc { base: Base::LocalAppData, rel: "Programs/cursor" },
        ],
        home_prefix: None,
        accept: accept_cursor,
        depth: 5,
        env_dir: None,
        note: "Installed. Cursor does not keep readable usage on disk.",
    },
    Spec {
        id: "opencode",
        label: "OpenCode",
        parser: Parser::OpenCode,
        roots: &[
            Loc { base: Base::Home, rel: ".local/share/opencode/storage/session" },
            Loc { base: Base::AppData, rel: "opencode/storage/session" },
        ],
        markers: &[
            Loc { base: Base::Home, rel: ".local/share/opencode/opencode.db" },
            Loc { base: Base::Home, rel: ".local/share/opencode/opencode.db-wal" },
        ],
        installed: &[
            Loc { base: Base::Home, rel: ".local/share/opencode" },
            Loc { base: Base::Home, rel: ".config/opencode" },
            Loc { base: Base::AppData, rel: "opencode" },
        ],
        home_prefix: None,
        accept: accept_opencode,
        depth: 3,
        env_dir: Some(("XDG_DATA_HOME", "opencode/storage/session")),
        note: "Installed. No OpenCode sessions yet.",
    },
    Spec {
        id: "github-copilot",
        label: "GitHub Copilot",
        parser: Parser::Copilot,
        roots: &[Loc { base: Base::Home, rel: ".copilot/session-state" }],
        markers: &[],
        installed: &[
            Loc { base: Base::Home, rel: ".copilot" },
            Loc { base: Base::Home, rel: ".config/github-copilot" },
        ],
        home_prefix: None,
        accept: accept_copilot,
        depth: 3,
        env_dir: None,
        note: "Installed. No Copilot CLI sessions yet.",
    },
    Spec {
        id: "aider",
        label: "Aider",
        parser: Parser::Mtime,
        roots: &[],
        markers: &[
            Loc { base: Base::Home, rel: ".aider.chat.history.md" },
            Loc { base: Base::Home, rel: ".aider.input.history" },
            Loc { base: Base::Home, rel: ".aider/analytics.jsonl" },
        ],
        installed: &[Loc { base: Base::Home, rel: ".aider" }],
        home_prefix: Some(".aider"),
        accept: accept_nothing,
        depth: 1,
        env_dir: None,
        note: "Installed. Aider keeps history in each project folder.",
    },
];

pub(crate) fn spec_for(id: &str) -> Option<&'static Spec> {
    SPECS.iter().find(|spec| spec.id == id)
}

/* -------------------------------------------------------------------- paths */

#[derive(Clone, Default)]
pub(crate) struct Dirs {
    pub home: Option<PathBuf>,
    pub appdata: Option<PathBuf>,
    pub local_appdata: Option<PathBuf>,
}

impl Dirs {
    pub(crate) fn current() -> Self {
        Self {
            home: dirs::home_dir(),
            appdata: std::env::var_os("APPDATA").map(PathBuf::from),
            local_appdata: std::env::var_os("LOCALAPPDATA").map(PathBuf::from),
        }
    }

    fn dir(&self, base: Base) -> Option<&Path> {
        match base {
            Base::Home => self.home.as_deref(),
            Base::AppData => self.appdata.as_deref(),
            Base::LocalAppData => self.local_appdata.as_deref(),
        }
    }

    pub(crate) fn join(&self, loc: &Loc) -> Option<PathBuf> {
        let base = self.dir(loc.base)?;
        Some(join_rel(base, loc.rel))
    }
}

fn join_rel(base: &Path, rel: &str) -> PathBuf {
    rel.split('/')
        .fold(base.to_path_buf(), |path, part| path.join(part))
}

fn push_unique(list: &mut Vec<PathBuf>, path: PathBuf) {
    if !list.contains(&path) {
        list.push(path);
    }
}

/// Session folders for a provider, including an environment override such as `CODEX_HOME`.
pub(crate) fn session_roots(spec: &Spec, dirs: &Dirs) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some((var, sub)) = spec.env_dir {
        if let Some(value) = std::env::var_os(var).filter(|v| !v.is_empty()) {
            push_unique(&mut out, join_rel(Path::new(&value), sub));
        }
    }
    for loc in spec.roots {
        if let Some(path) = dirs.join(loc) {
            push_unique(&mut out, path);
        }
    }
    out
}

fn marker_paths(spec: &Spec, dirs: &Dirs) -> Vec<PathBuf> {
    spec.markers.iter().filter_map(|loc| dirs.join(loc)).collect()
}

/// Folders and files whose recent changes show the tool was used. Used by detection too.
pub(crate) fn activity_paths(id: &str, dirs: &Dirs) -> Vec<PathBuf> {
    let Some(spec) = spec_for(id) else {
        return Vec::new();
    };
    let mut out = session_roots(spec, dirs);
    for path in marker_paths(spec, dirs) {
        push_unique(&mut out, path);
    }
    out
}

fn home_has_prefix(dirs: &Dirs, prefix: &str) -> bool {
    let Some(home) = dirs.home.as_deref() else {
        return false;
    };
    let Ok(entries) = std::fs::read_dir(home) else {
        return false;
    };
    entries.flatten().take(MAX_HOME_ENTRIES).any(|entry| {
        entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.to_ascii_lowercase().starts_with(prefix))
    })
}

pub(crate) fn is_installed(spec: &Spec, dirs: &Dirs) -> bool {
    let present = |path: PathBuf| std::fs::symlink_metadata(path).is_ok();
    spec.installed
        .iter()
        .filter_map(|loc| dirs.join(loc))
        .any(present)
        || session_roots(spec, dirs).into_iter().any(present)
        || marker_paths(spec, dirs).into_iter().any(present)
        || spec
            .home_prefix
            .is_some_and(|prefix| home_has_prefix(dirs, prefix))
}

/* -------------------------------------------------------------- scan helpers */

fn tally(entries: &[FileEntry], now: u64, out: &mut ScanOut) {
    let day = now.saturating_sub(DAY_MS);
    let week = now.saturating_sub(WEEK_MS);
    let active = now.saturating_sub(ACTIVE_WINDOW_MS);
    out.files = out.files.saturating_add(entries.len().min(u32::MAX as usize) as u32);
    for entry in entries {
        if entry.modified >= week {
            out.sessions_7d += 1;
        }
        if entry.modified >= day {
            out.sessions_24h += 1;
        }
        if entry.modified >= active {
            out.active_sessions += 1;
        }
        out.last_active_at = out.last_active_at.max(Some(entry.modified));
    }
}

fn folder_of(path: &str) -> Option<String> {
    let trimmed = path.trim_end_matches(['/', '\\']);
    let name = trimmed.rsplit(['/', '\\']).next()?;
    (!name.is_empty()).then(|| name.chars().take(48).collect())
}

fn time_value(value: &Value) -> Option<u64> {
    if let Some(text) = value.as_str() {
        return parse_rfc3339_millis(text);
    }
    let number = value
        .as_u64()
        .or_else(|| value.as_f64().filter(|n| n.is_finite() && *n >= 0.0).map(|n| n as u64))?;
    Some(if number < 1_000_000_000_000 { number * 1000 } else { number })
}

fn read_limited(path: &Path, max: u64) -> Option<Vec<u8>> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() > max {
        return None;
    }
    std::fs::read(path).ok()
}

/// Activity from files whose names are the only readable signal.
fn mtime_scan(spec: &Spec, dirs: &Dirs, now: u64) -> ScanOut {
    let mut entries: Vec<FileEntry> = Vec::new();
    for root in session_roots(spec, dirs) {
        entries.extend(collect_files(&root, spec.depth, &spec.accept));
    }
    entries.sort_by(|a, b| b.modified.cmp(&a.modified));
    let mut out = ScanOut::default();
    tally(&entries, now, &mut out);
    let week = now.saturating_sub(WEEK_MS);
    for entry in entries.iter().filter(|e| e.modified >= week).take(MAX_PARSED_SESSIONS) {
        let id = session_id(&entry.path);
        let title = if file_name(&entry.path).eq_ignore_ascii_case("store.db") {
            "Agent chat".to_string()
        } else {
            clean_title(&id).unwrap_or_else(|| id.clone())
        };
        out.sessions.push(SessionStat {
            id,
            title,
            project: None,
            started_at: None,
            last_active_at: entry.modified,
            tokens: None,
        });
    }
    // Marker files show use without being sessions.
    let mut marker_hits: Vec<FileEntry> = Vec::new();
    for path in marker_paths(spec, dirs) {
        if let Ok(meta) = std::fs::metadata(&path) {
            if meta.is_file() {
                marker_hits.push(FileEntry {
                    path,
                    modified: modified_ms(&meta),
                    len: meta.len(),
                });
            }
        }
    }
    let active = now.saturating_sub(ACTIVE_WINDOW_MS);
    for marker in &marker_hits {
        out.last_active_at = out.last_active_at.max(Some(marker.modified));
        if marker.modified >= active {
            out.active_sessions = out.active_sessions.max(1);
        }
    }
    out.finish();
    out
}

/* -------------------------------------------------------------------- Gemini */

#[derive(Clone, Default)]
struct JsonSummary {
    len: u64,
    modified: u64,
    started_at: Option<u64>,
    title: Option<String>,
    project: Option<String>,
    tokens: Vec<(u64, u64)>,
    responses: Vec<(u64, u64)>,
}

static JSON_CACHE: OnceLock<Mutex<HashMap<String, JsonSummary>>> = OnceLock::new();

fn json_cache() -> std::sync::MutexGuard<'static, HashMap<String, JsonSummary>> {
    JSON_CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Summarize a Gemini CLI chat file: `{ startTime, messages: [{ type, timestamp, content, tokens }] }`.
fn parse_gemini(bytes: &[u8]) -> Option<JsonSummary> {
    let root: Value = serde_json::from_slice(bytes).ok()?;
    let messages = root.get("messages")?.as_array()?;
    let mut out = JsonSummary {
        started_at: root.get("startTime").and_then(time_value),
        ..JsonSummary::default()
    };
    let mut pending: Option<u64> = None;
    for message in messages {
        let ts = message.get("timestamp").and_then(time_value);
        match message.get("type").and_then(Value::as_str) {
            Some("user") => {
                pending = ts;
                if out.title.is_none() {
                    out.title = message
                        .get("content")
                        .and_then(content_text)
                        .and_then(|text| clean_title(&text));
                }
            }
            Some("gemini") => {
                if let (Some(start), Some(end)) = (pending.take(), ts) {
                    if end >= start && end - start <= 600_000 {
                        out.responses.push((end, end - start));
                    }
                }
                let total = message
                    .pointer("/tokens/total")
                    .and_then(Value::as_u64)
                    .filter(|n| *n > 0);
                if let (Some(total), Some(at)) = (total, ts) {
                    out.tokens.push((at, total));
                }
            }
            _ => {}
        }
    }
    Some(out)
}

fn gemini_scan(spec: &Spec, dirs: &Dirs, now: u64) -> ScanOut {
    let mut entries: Vec<FileEntry> = Vec::new();
    for root in session_roots(spec, dirs) {
        entries.extend(collect_files(&root, spec.depth, &spec.accept));
    }
    entries.sort_by(|a, b| b.modified.cmp(&a.modified));
    let mut out = ScanOut::default();
    tally(&entries, now, &mut out);
    let day = now.saturating_sub(DAY_MS);
    let week = now.saturating_sub(WEEK_MS);
    let mut cache = json_cache();
    let live: std::collections::HashSet<String> = entries
        .iter()
        .filter(|e| e.modified >= week)
        .take(MAX_PARSED_SESSIONS)
        .map(|e| e.path.to_string_lossy().into_owned())
        .collect();
    cache.retain(|key, _| !key.starts_with("gemini::") || live.contains(&key["gemini::".len()..]));
    for entry in entries.iter().filter(|e| e.modified >= week).take(MAX_PARSED_SESSIONS) {
        let key = format!("gemini::{}", entry.path.to_string_lossy());
        let id = session_id(&entry.path);
        let stale = cache
            .get(&key)
            .map_or(true, |s| s.len != entry.len || s.modified != entry.modified);
        if stale && has_ext(&entry.path, "json") {
            let parsed = if entry.len <= MAX_JSON_BYTES {
                read_limited(&entry.path, MAX_JSON_BYTES).and_then(|bytes| parse_gemini(&bytes))
            } else {
                None
            };
            let mut summary = parsed.unwrap_or_default();
            summary.len = entry.len;
            summary.modified = entry.modified;
            cache.insert(key.clone(), summary);
        }
        let summary = cache.get(&key).cloned().unwrap_or_default();
        let session_tokens: u64 = summary
            .tokens
            .iter()
            .filter(|(ts, _)| *ts >= day)
            .map(|(_, n)| *n)
            .sum();
        if !summary.tokens.is_empty() {
            out.has_usage_data = true;
        }
        out.tokens = out.tokens.saturating_add(session_tokens);
        out.responses
            .extend(summary.responses.iter().filter(|(ts, _)| *ts >= day).copied());
        out.sessions.push(SessionStat {
            title: summary.title.clone().unwrap_or_else(|| "Gemini chat".into()),
            id,
            project: summary.project.clone(),
            started_at: summary.started_at,
            last_active_at: entry.modified,
            tokens: (session_tokens > 0).then_some(session_tokens),
        });
    }
    out.finish();
    out
}

/* ------------------------------------------------------------------ OpenCode */

#[derive(Clone, Default)]
struct OpenCodeSession {
    len: u64,
    modified: u64,
    title: Option<String>,
    directory: Option<String>,
    created: Option<u64>,
    updated: Option<u64>,
}

#[derive(Clone, Default)]
struct OpenCodeMessage {
    len: u64,
    modified: u64,
    role: String,
    created: Option<u64>,
    completed: Option<u64>,
    tokens: u64,
}

#[derive(Default)]
struct OpenCodeCache {
    sessions: HashMap<String, OpenCodeSession>,
    messages: HashMap<String, OpenCodeMessage>,
}

static OPENCODE_CACHE: OnceLock<Mutex<OpenCodeCache>> = OnceLock::new();

fn opencode_cache() -> std::sync::MutexGuard<'static, OpenCodeCache> {
    OPENCODE_CACHE
        .get_or_init(|| Mutex::new(OpenCodeCache::default()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn parse_opencode_session(bytes: &[u8]) -> OpenCodeSession {
    let Ok(root) = serde_json::from_slice::<Value>(bytes) else {
        return OpenCodeSession::default();
    };
    OpenCodeSession {
        title: root
            .get("title")
            .and_then(Value::as_str)
            .and_then(clean_title),
        directory: root
            .get("directory")
            .and_then(Value::as_str)
            .and_then(folder_of),
        created: root.pointer("/time/created").and_then(time_value),
        updated: root.pointer("/time/updated").and_then(time_value),
        ..OpenCodeSession::default()
    }
}

fn parse_opencode_message(bytes: &[u8]) -> OpenCodeMessage {
    let Ok(root) = serde_json::from_slice::<Value>(bytes) else {
        return OpenCodeMessage::default();
    };
    let tokens = root.get("tokens");
    let count = |pointer: &str| -> u64 {
        tokens
            .and_then(|t| t.pointer(pointer))
            .and_then(Value::as_u64)
            .unwrap_or(0)
    };
    OpenCodeMessage {
        role: root
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        created: root.pointer("/time/created").and_then(time_value),
        completed: root.pointer("/time/completed").and_then(time_value),
        tokens: count("/input")
            .saturating_add(count("/output"))
            .saturating_add(count("/reasoning"))
            .saturating_add(count("/cache/read"))
            .saturating_add(count("/cache/write")),
        ..OpenCodeMessage::default()
    }
}

fn opencode_scan(spec: &Spec, dirs: &Dirs, now: u64) -> ScanOut {
    let roots = session_roots(spec, dirs);
    let mut entries: Vec<(FileEntry, PathBuf)> = Vec::new();
    for root in &roots {
        // .../storage/session/<project>/ses_x.json  ->  messages in .../storage/message/<ses_x>/
        let message_root = root.parent().map(|storage| storage.join("message"));
        for entry in collect_files(root, spec.depth, &spec.accept) {
            if let Some(message_root) = &message_root {
                entries.push((entry, message_root.clone()));
            }
        }
    }
    entries.sort_by(|a, b| b.0.modified.cmp(&a.0.modified));
    let plain: Vec<FileEntry> = entries.iter().map(|(e, _)| e.clone()).collect();
    let mut out = ScanOut::default();
    tally(&plain, now, &mut out);
    let day = now.saturating_sub(DAY_MS);
    let week = now.saturating_sub(WEEK_MS);

    let mut cache = opencode_cache();
    let mut message_budget = MAX_MESSAGE_FILES;
    for (entry, message_root) in entries
        .iter()
        .filter(|(e, _)| e.modified >= week)
        .take(MAX_PARSED_SESSIONS)
    {
        let key = entry.path.to_string_lossy().into_owned();
        let stale = cache
            .sessions
            .get(&key)
            .map_or(true, |s| s.len != entry.len || s.modified != entry.modified);
        if stale {
            let mut parsed = read_limited(&entry.path, MAX_SMALL_JSON_BYTES)
                .map(|bytes| parse_opencode_session(&bytes))
                .unwrap_or_default();
            parsed.len = entry.len;
            parsed.modified = entry.modified;
            cache.sessions.insert(key.clone(), parsed);
        }
        let session = cache.sessions.get(&key).cloned().unwrap_or_default();
        let id = session_id(&entry.path);
        let mut session_tokens = 0u64;
        if entry.modified >= day && message_budget > 0 {
            let mut pairs: Vec<(u64, String, Option<u64>, u64)> = Vec::new();
            let message_dir = message_root.join(&id);
            for message in collect_files(&message_dir, 1, &|p: &Path| has_ext(p, "json"))
                .into_iter()
                .filter(|m| m.modified >= day)
            {
                if message_budget == 0 {
                    break;
                }
                message_budget -= 1;
                let message_key = message.path.to_string_lossy().into_owned();
                let message_stale = cache
                    .messages
                    .get(&message_key)
                    .map_or(true, |m| m.len != message.len || m.modified != message.modified);
                if message_stale {
                    let mut parsed = read_limited(&message.path, MAX_SMALL_JSON_BYTES)
                        .map(|bytes| parse_opencode_message(&bytes))
                        .unwrap_or_default();
                    parsed.len = message.len;
                    parsed.modified = message.modified;
                    cache.messages.insert(message_key.clone(), parsed);
                }
                if let Some(parsed) = cache.messages.get(&message_key) {
                    if let Some(created) = parsed.created {
                        pairs.push((created, parsed.role.clone(), parsed.completed, parsed.tokens));
                    }
                }
            }
            pairs.sort_by_key(|pair| pair.0);
            let mut prompt: Option<u64> = None;
            for (created, role, completed, tokens) in pairs {
                if role == "user" {
                    prompt = Some(created);
                } else if role == "assistant" {
                    if tokens > 0 && created >= day {
                        session_tokens = session_tokens.saturating_add(tokens);
                    }
                    if let (Some(start), Some(end)) = (prompt.take(), completed) {
                        if end >= start && end - start <= 600_000 && end >= day {
                            out.responses.push((end, end - start));
                        }
                    }
                }
            }
        }
        if session_tokens > 0 {
            out.has_usage_data = true;
            out.tokens = out.tokens.saturating_add(session_tokens);
        }
        out.sessions.push(SessionStat {
            title: session.title.clone().unwrap_or_else(|| "OpenCode session".into()),
            id,
            project: session.directory.clone(),
            started_at: session.created,
            last_active_at: entry.modified.max(session.updated.unwrap_or(0)),
            tokens: (session_tokens > 0).then_some(session_tokens),
        });
    }
    let live: std::collections::HashSet<String> = entries
        .iter()
        .map(|(e, _)| e.path.to_string_lossy().into_owned())
        .collect();
    cache.sessions.retain(|key, _| live.contains(key));
    if cache.messages.len() > 4 * MAX_MESSAGE_FILES {
        cache.messages.clear();
    }
    drop(cache);

    // The newer SQLite store only shows that something happened.
    let active = now.saturating_sub(ACTIVE_WINDOW_MS);
    for path in marker_paths(spec, dirs) {
        if let Ok(meta) = std::fs::metadata(&path) {
            let modified = modified_ms(&meta);
            out.last_active_at = out.last_active_at.max(Some(modified));
            if modified >= active {
                out.active_sessions = out.active_sessions.max(1);
            }
        }
    }
    out.finish();
    out
}

/* --------------------------------------------------------------- Claude stats */

struct ClaudeStats {
    sessions_7d: u32,
    tokens_7d: u64,
    last_day_ms: Option<u64>,
}

/// `~/.claude/stats-cache.json` totals, used when no transcripts are on disk.
fn claude_stats(dirs: &Dirs, now: u64) -> Option<ClaudeStats> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(value) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|v| !v.is_empty()) {
        candidates.push(Path::new(&value).join("stats-cache.json"));
    }
    if let Some(home) = &dirs.home {
        candidates.push(home.join(".claude").join("stats-cache.json"));
        candidates.push(home.join(".config").join("claude").join("stats-cache.json"));
    }
    let bytes = candidates
        .iter()
        .find_map(|path| read_limited(path, 2 * 1024 * 1024))?;
    let root: Value = serde_json::from_slice(&bytes).ok()?;
    let cutoff = now.saturating_sub(WEEK_MS + DAY_MS);
    let day_start = |entry: &Value| -> Option<u64> {
        let date = entry.get("date")?.as_str()?;
        parse_rfc3339_millis(&format!("{date}T00:00:00Z"))
    };
    let mut stats = ClaudeStats {
        sessions_7d: 0,
        tokens_7d: 0,
        last_day_ms: None,
    };
    for entry in root.get("dailyActivity")?.as_array()? {
        let Some(start) = day_start(entry) else { continue };
        if start < cutoff {
            continue;
        }
        let sessions = entry.get("sessionCount").and_then(Value::as_u64).unwrap_or(0);
        stats.sessions_7d = stats.sessions_7d.saturating_add(sessions.min(u32::MAX as u64) as u32);
        if sessions > 0 || entry.get("messageCount").and_then(Value::as_u64).unwrap_or(0) > 0 {
            stats.last_day_ms = stats.last_day_ms.max(Some(start + DAY_MS - 1));
        }
    }
    if let Some(days) = root.get("dailyModelTokens").and_then(Value::as_array) {
        for entry in days {
            let Some(start) = day_start(entry) else { continue };
            if start < cutoff {
                continue;
            }
            if let Some(models) = entry.get("tokensByModel").and_then(Value::as_object) {
                for value in models.values() {
                    stats.tokens_7d = stats.tokens_7d.saturating_add(value.as_u64().unwrap_or(0));
                }
            }
        }
    }
    Some(stats)
}

/* ------------------------------------------------------------------ snapshots */

struct Collected {
    scan: ScanOut,
    window: &'static str,
    from_stats: bool,
}

fn collect(spec: &Spec, dirs: &Dirs, now: u64) -> Collected {
    let mut from_stats = false;
    let mut window = "24h";
    let mut scan = match spec.parser {
        Parser::Codex | Parser::Claude | Parser::Copilot => {
            let mut merged = ScanOut::default();
            for root in session_roots(spec, dirs) {
                if root.is_dir() {
                    merged.merge(scan_jsonl(&root, spec.id, now, &spec.accept));
                }
            }
            merged.finish();
            merged
        }
        Parser::Gemini => gemini_scan(spec, dirs, now),
        Parser::OpenCode => opencode_scan(spec, dirs, now),
        Parser::Mtime => mtime_scan(spec, dirs, now),
    };
    if spec.parser == Parser::Claude && scan.files == 0 {
        if let Some(stats) = claude_stats(dirs, now) {
            from_stats = true;
            window = "7d";
            scan.sessions_7d = stats.sessions_7d;
            scan.tokens = stats.tokens_7d;
            scan.has_usage_data = stats.tokens_7d > 0;
            scan.last_active_at = stats.last_day_ms;
        }
    }
    Collected {
        scan,
        window,
        from_stats,
    }
}

fn plural(count: u32, one: &str, many: &str) -> String {
    format!("{count} {}", if count == 1 { one } else { many })
}

pub(crate) fn activity_info(scan: &ScanOut, now: u64) -> ActivityInfo {
    let active = now.saturating_sub(ACTIVE_WINDOW_MS);
    ActivityInfo {
        installed: true,
        sessions_24h: scan.sessions_24h,
        sessions_7d: scan.sessions_7d,
        last_active_at: scan.last_active_at,
        avg_response_ms: mean_ms(&scan.responses),
        responses_24h: scan.responses.len().min(u32::MAX as usize) as u32,
        active_now: scan.active_sessions > 0,
        active_sessions: scan.active_sessions,
        recent: scan
            .sessions
            .iter()
            .take(RECENT_LIMIT)
            .map(|session| RecentSession {
                id: session.id.clone(),
                title: session.title.clone(),
                project: session.project.clone(),
                started_at: session.started_at,
                last_active_at: session.last_active_at,
                tokens: session.tokens,
                active: session.last_active_at >= active,
            })
            .collect(),
    }
}

/// Snapshots for one provider: an activity row, plus provider-reported quota rows for Codex.
/// Returns nothing when the tool is not installed.
pub(crate) fn snapshots(spec: &Spec, now: u64) -> Vec<UsageSnapshot> {
    let dirs = Dirs::current();
    snapshots_in(spec, &dirs, now)
}

pub(crate) fn snapshots_in(spec: &Spec, dirs: &Dirs, now: u64) -> Vec<UsageSnapshot> {
    if !is_installed(spec, dirs) {
        return Vec::new();
    }
    let Collected {
        scan,
        window,
        from_stats,
    } = collect(spec, dirs, now);
    let week = now.saturating_sub(WEEK_MS);
    let recently_used = scan.sessions_7d > 0 || scan.last_active_at.is_some_and(|t| t >= week);
    // For Claude Code the plan limits matter, not how many tokens went through.
    let has_tokens = scan.has_usage_data && spec.id != "claude-code";
    let limits_problem = (spec.id == "claude-code").then(super::claude_limits::problem).flatten();
    let detail = if let Some(problem) = limits_problem {
        problem.to_string()
    } else if from_stats {
        format!("{} this week, from Claude Code stats", plural(scan.sessions_7d, "session", "sessions"))
    } else if has_tokens {
        format!("Tokens recorded in local logs across {} session files", scan.files)
    } else if scan.sessions_24h > 0 {
        format!("{} in the last 24 hours", plural(scan.sessions_24h, "session", "sessions"))
    } else if recently_used {
        format!("{} this week", plural(scan.sessions_7d.max(1), "session", "sessions"))
    } else {
        spec.note.to_string()
    };
    let activity = activity_info(&scan, now);
    let mut out = vec![UsageSnapshot {
        provider: spec.id.into(),
        label: if has_tokens {
            format!("{} local activity", spec.label)
        } else {
            spec.label.into()
        },
        status: (if recently_used || has_tokens { "ok" } else { "unknown" }).into(),
        used: has_tokens.then_some(scan.tokens),
        unit: has_tokens.then(|| "tokens".to_string()),
        window: Some(window.into()),
        detail: Some(detail),
        source: Some("local-logs".into()),
        updated_at: now,
        activity: Some(activity),
        ..UsageSnapshot::default()
    }];
    if spec.id == "claude-code" {
        out.extend(super::claude_limits::cached().into_iter().map(|limit| UsageSnapshot {
            provider: "claude-code".into(),
            label: limit.label,
            status: "ok".into(),
            unit: Some("%".into()),
            percent: Some(limit.percent),
            window: limit.window,
            detail: Some("Reported by Claude".into()),
            source: Some("official-rate-limit".into()),
            reset_at: limit.reset_at,
            updated_at: limit.updated_at,
            ..UsageSnapshot::default()
        }));
    }
    if spec.parser == Parser::Codex {
        out.extend(scan.rate_limits.into_iter().map(|limit| UsageSnapshot {
            provider: "codex".into(),
            label: limit.label,
            status: "ok".into(),
            unit: Some("%".into()),
            percent: Some(limit.percent),
            window: limit.window,
            detail: Some("Provider-reported rate limit".into()),
            source: Some("official-rate-limit".into()),
            reset_at: limit.reset_at,
            updated_at: limit.updated_at,
            ..UsageSnapshot::default()
        }));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::now_millis;
    use std::fs;

    fn temp_home(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "hover-island-providers-{tag}-{}-{}",
            std::process::id(),
            now_millis()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn dirs_for(home: &Path) -> Dirs {
        Dirs {
            home: Some(home.to_path_buf()),
            appdata: None,
            local_appdata: None,
        }
    }

    #[test]
    fn missing_folders_mean_not_installed() {
        let home = temp_home("empty");
        let dirs = dirs_for(&home);
        for spec in SPECS {
            assert!(!is_installed(spec, &dirs), "{} should be absent", spec.id);
            assert!(snapshots_in(spec, &dirs, now_millis()).is_empty());
        }
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn every_provider_with_a_folder_is_listed_even_without_sessions() {
        let home = temp_home("idle");
        for dir in [".codex", ".claude", ".gemini", ".cursor", ".local/share/opencode", ".copilot"] {
            fs::create_dir_all(join_rel(&home, dir)).unwrap();
        }
        fs::write(home.join(".aider.chat.history.md"), b"# aider").unwrap();
        let dirs = dirs_for(&home);
        let now = now_millis();
        let listed: Vec<&str> = SPECS
            .iter()
            .filter(|spec| !snapshots_in(spec, &dirs, now).is_empty())
            .map(|spec| spec.id)
            .collect();
        assert_eq!(
            listed,
            vec!["codex", "claude-code", "gemini", "cursor", "opencode", "github-copilot", "aider"]
        );
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn gemini_chat_gives_title_tokens_and_response_time() {
        let home = temp_home("gemini");
        let chats = home.join(".gemini").join("tmp").join("abc123").join("chats");
        fs::create_dir_all(&chats).unwrap();
        let now = now_millis();
        let iso = |ms: u64| -> String {
            // Build an RFC3339 string from epoch millis for the fixture.
            let secs = ms / 1000;
            let days = secs / 86_400;
            let rem = secs % 86_400;
            let (mut y, mut d) = (1970u64, days);
            loop {
                let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
                let len = if leap { 366 } else { 365 };
                if d < len { break; }
                d -= len;
                y += 1;
            }
            let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
            let months = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
            let mut m = 0;
            while d >= months[m] { d -= months[m]; m += 1; }
            format!("{y:04}-{:02}-{:02}T{:02}:{:02}:{:02}.000Z", m + 1, d + 1, rem / 3600, rem % 3600 / 60, rem % 60)
        };
        let body = format!(
            r#"{{"sessionId":"s1","startTime":"{a}","messages":[{{"type":"user","timestamp":"{a}","content":[{{"text":"Explain the notch"}}]}},{{"type":"gemini","timestamp":"{b}","content":"ok","tokens":{{"total":321}}}}]}}"#,
            a = iso(now - 60_000),
            b = iso(now - 56_000)
        );
        fs::write(chats.join("session-2026-10-19-abc.json"), body).unwrap();
        let dirs = dirs_for(&home);
        let spec = spec_for("gemini").unwrap();
        let snaps = snapshots_in(spec, &dirs, now);
        assert_eq!(snaps.len(), 1);
        let snap = &snaps[0];
        assert_eq!(snap.status, "ok");
        assert_eq!(snap.used, Some(321));
        let activity = snap.activity.as_ref().unwrap();
        assert_eq!(activity.sessions_24h, 1);
        assert_eq!(activity.avg_response_ms, Some(4000));
        assert_eq!(activity.recent[0].title, "Explain the notch");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn opencode_sessions_are_listed_with_titles() {
        let home = temp_home("opencode");
        let session = home
            .join(".local/share/opencode/storage/session/global");
        fs::create_dir_all(&session).unwrap();
        fs::write(
            session.join("ses_abc.json"),
            br#"{"id":"ses_abc","title":"Refactor widgets","directory":"/home/me/island","time":{"created":1760000000000,"updated":1760000100000}}"#,
        )
        .unwrap();
        let dirs = dirs_for(&home);
        let spec = spec_for("opencode").unwrap();
        let snaps = snapshots_in(spec, &dirs, now_millis());
        let activity = snaps[0].activity.as_ref().unwrap();
        assert_eq!(activity.sessions_24h, 1);
        assert_eq!(activity.recent[0].title, "Refactor widgets");
        assert_eq!(activity.recent[0].project.as_deref(), Some("island"));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn copilot_and_cursor_sessions_are_counted_by_modification_time() {
        let home = temp_home("copilot");
        let state = home.join(".copilot/session-state/11111111-aaaa");
        fs::create_dir_all(&state).unwrap();
        fs::write(
            state.join("events.jsonl"),
            "{\"type\":\"user.message\",\"timestamp\":\"2026-10-19T01:00:00.000Z\",\"data\":{\"content\":\"hello copilot\"}}\n",
        )
        .unwrap();
        let chat = home.join(".cursor/chats/hash/uuid-1");
        fs::create_dir_all(&chat).unwrap();
        fs::write(chat.join("store.db"), b"sqlite").unwrap();
        let dirs = dirs_for(&home);
        let now = now_millis();
        let copilot = snapshots_in(spec_for("github-copilot").unwrap(), &dirs, now);
        let info = copilot[0].activity.as_ref().unwrap();
        assert_eq!(info.sessions_24h, 1);
        assert_eq!(info.recent[0].title, "hello copilot");
        assert_eq!(info.recent[0].id, "11111111-aaaa");
        let cursor = snapshots_in(spec_for("cursor").unwrap(), &dirs, now);
        assert_eq!(cursor[0].activity.as_ref().unwrap().sessions_24h, 1);
        assert_eq!(cursor[0].status, "ok");
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn claude_stats_cache_fills_in_when_transcripts_are_missing() {
        let home = temp_home("stats");
        let claude = home.join(".claude");
        fs::create_dir_all(&claude).unwrap();
        let now = now_millis();
        // Use today's UTC date from the same arithmetic the parser inverts.
        let today = {
            let days = now / 86_400_000;
            let (mut y, mut d) = (1970u64, days);
            loop {
                let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
                let len = if leap { 366 } else { 365 };
                if d < len { break; }
                d -= len;
                y += 1;
            }
            let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
            let months = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
            let mut m = 0;
            while d >= months[m] { d -= months[m]; m += 1; }
            format!("{y:04}-{:02}-{:02}", m + 1, d + 1)
        };
        fs::write(
            claude.join("stats-cache.json"),
            format!(
                r#"{{"dailyActivity":[{{"date":"{today}","messageCount":12,"sessionCount":3,"toolCallCount":4}}],"dailyModelTokens":[{{"date":"{today}","tokensByModel":{{"claude-x":1500,"claude-y":500}}}}]}}"#
            ),
        )
        .unwrap();
        let dirs = dirs_for(&home);
        let snaps = snapshots_in(spec_for("claude-code").unwrap(), &dirs, now);
        let snap = &snaps[0];
        assert_eq!(snap.status, "ok");
        assert_eq!(snap.used, Some(2000));
        assert_eq!(snap.window.as_deref(), Some("7d"));
        assert_eq!(snap.activity.as_ref().unwrap().sessions_7d, 3);
        let _ = fs::remove_dir_all(home);
    }
}
