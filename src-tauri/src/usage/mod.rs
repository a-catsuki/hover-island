//! Local AI usage monitoring. Provider quotas are shown only when Codex logs contain
//! an explicit provider rate-limit record; local token activity is labeled separately.
//!
//! Every supported provider (see `providers.rs`) gets one activity snapshot that carries
//! session counts, recent sessions and the average response time. Logs are read
//! incrementally: each file keeps a byte offset, very large files are tail-read on the
//! first visit, and files that have not changed in a day are never opened.
use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::fs::File;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use serde_json::Value;
use tauri::{AppHandle, Manager, State};

mod detect;
pub(crate) mod claude_limits;
mod claude_desktop;
pub(crate) mod providers;
use detect::DetectedProvider;

use crate::settings::{ManualUsage, Settings};
use crate::state::AppState;
use crate::types::{now_millis, UsageSnapshot};

const MAX_WALK_DEPTH: usize = 8;
const MAX_WALK_FILES: usize = 20_000;
const DAY_MS: u64 = 86_400_000;
const WEEK_MS: u64 = 7 * DAY_MS;
const MAX_JSONL_LINE_BYTES: usize = 1024 * 1024;
/// A file seen for the first time is only read from its last few MiB.
const INITIAL_TAIL_BYTES: u64 = 4 * 1024 * 1024;
/// Files older than a day are only tail-read for their last provider rate-limit record.
const QUOTA_TAIL_BYTES: u64 = 512 * 1024;
const HEAD_BYTES: usize = 128 * 1024;
const HEAD_LINES: usize = 80;
/// Files fully processed per provider and scan.
const MAX_ACTIVE_FILES: usize = 160;
/// Older files that are still opened for their title only.
const RECENT_LIGHT_FILES: usize = 12;
/// Older Codex files tail-read for the newest rate-limit record.
const QUOTA_FILES: usize = 8;
const MAX_RESPONSE_MS: u64 = 10 * 60_000;
const MAX_RESPONSE_SAMPLES: usize = 4000;
pub(crate) const ACTIVE_WINDOW_MS: u64 = 120_000;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct RateLimit {
    pub label: String,
    pub percent: f64,
    pub window: Option<String>,
    pub reset_at: Option<u64>,
    pub updated_at: u64,
}

#[derive(Default)]
struct LogFile {
    length: u64,
    modified_ms: u64,
    offset: u64,
    pending: Vec<u8>,
    discarding_oversized_line: bool,
    previous_total: Option<u64>,
    has_usage_data: bool,
    events: Vec<(u64, u64)>,
    /// Dedupe keys parallel to `events` (0 when the record has no stable id).
    event_keys: Vec<u64>,
    rate_limits: Vec<RateLimit>,
    head_done: bool,
    first_ts: Option<u64>,
    last_ts: u64,
    title: Option<String>,
    project: Option<String>,
    pending_prompt: Option<u64>,
    responses: Vec<(u64, u64)>,
    recent_ids: Vec<String>,
}

#[derive(Default)]
struct LogCache {
    files: HashMap<String, LogFile>,
}

static LOG_CACHE: OnceLock<Mutex<LogCache>> = OnceLock::new();

fn log_cache() -> std::sync::MutexGuard<'static, LogCache> {
    LOG_CACHE
        .get_or_init(|| Mutex::new(LogCache::default()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/* ------------------------------------------------------------------ walking */

#[derive(Clone, Debug)]
pub(crate) struct FileEntry {
    pub path: PathBuf,
    pub modified: u64,
    pub len: u64,
}

pub(crate) fn modified_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn skip_dir(name: &str) -> bool {
    matches!(name, "node_modules" | ".git" | "target")
}

fn walk_files(
    dir: &Path,
    out: &mut Vec<FileEntry>,
    depth: usize,
    max_depth: usize,
    accept: &dyn Fn(&Path) -> bool,
) {
    if depth > max_depth || out.len() >= MAX_WALK_FILES {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= MAX_WALK_FILES {
            return;
        }
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_symlink() {
            continue;
        }
        let path = entry.path();
        if kind.is_dir() {
            let skip = path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(skip_dir);
            if !skip {
                walk_files(&path, out, depth + 1, max_depth, accept);
            }
        } else if accept(&path) {
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            out.push(FileEntry {
                path,
                modified: modified_ms(&meta),
                len: meta.len(),
            });
        }
    }
}

/// Files below `root` (or `root` itself when it is a file) accepted by `accept`.
pub(crate) fn collect_files(
    root: &Path,
    max_depth: usize,
    accept: &dyn Fn(&Path) -> bool,
) -> Vec<FileEntry> {
    let mut out = Vec::new();
    if root.is_file() {
        if let Ok(meta) = std::fs::metadata(root) {
            out.push(FileEntry {
                path: root.to_path_buf(),
                modified: modified_ms(&meta),
                len: meta.len(),
            });
        }
        return out;
    }
    walk_files(root, &mut out, 0, max_depth, accept);
    out
}

fn is_jsonl(path: &Path) -> bool {
    path.extension()
        .and_then(|s| s.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("jsonl"))
}

/* ------------------------------------------------------------------ parsing */

fn unsigned(v: &Value) -> Option<u64> {
    v.as_u64().or_else(|| {
        v.as_f64()
            .filter(|n| n.is_finite() && *n >= 0.0)
            .map(|n| n as u64)
    })
}

fn token_total(v: &Value) -> Option<u64> {
    if let Some(total) = v.get("total_tokens").and_then(unsigned) {
        return Some(total);
    }
    let input = v.get("input_tokens").and_then(unsigned).unwrap_or(0);
    let output = v.get("output_tokens").and_then(unsigned).unwrap_or(0);
    let sum = input.saturating_add(output);
    (sum > 0).then_some(sum)
}

fn rate_limit_time(v: &Value) -> Option<u64> {
    if let Some(n) = unsigned(v) {
        return Some(if n < 1_000_000_000_000 {
            n.saturating_mul(1000)
        } else {
            n
        });
    }
    v.as_str().and_then(parse_rfc3339_millis)
}

fn parse_rate_limits(root: &Value, event_time: u64) -> Vec<RateLimit> {
    let Some(limits) = root
        .pointer("/payload/rate_limits")
        .or_else(|| root.pointer("/payload/info/rate_limits"))
    else {
        return Vec::new();
    };
    ["primary", "secondary"]
        .into_iter()
        .filter_map(|key| {
            let item = limits.get(key)?;
            let raw = item.get("used_percent")?.as_f64()?;
            if !raw.is_finite() {
                return None;
            }
            let mins = item.get("window_minutes").and_then(unsigned);
            let window = mins.map(format_window);
            let shown = match window.as_deref() {
                Some("168h") => "Weekly",
                Some(other) => other,
                None if key == "primary" => "primary window",
                None => "secondary window",
            };
            let label = format!("Codex · {shown}");
            Some(RateLimit {
                label,
                percent: (raw / 100.0).clamp(0.0, 1.0),
                window,
                reset_at: item.get("resets_at").and_then(rate_limit_time),
                updated_at: event_time,
            })
        })
        .collect()
}

fn format_window(minutes: u64) -> String {
    if minutes >= 60 && minutes % 60 == 0 {
        format!("{}h", minutes / 60)
    } else {
        format!("{minutes}m")
    }
}

fn event_time(root: &Value, fallback: u64) -> u64 {
    root.get("timestamp")
        .and_then(|v| {
            v.as_str()
                .and_then(parse_rfc3339_millis)
                .or_else(|| unsigned(v))
        })
        .unwrap_or(fallback)
}

/// Pull `"timestamp":"..."` out of a JSONL line without parsing the whole record.
pub(crate) fn quick_timestamp(line: &str) -> Option<u64> {
    const KEY: &str = "\"timestamp\":\"";
    let start = line.find(KEY)? + KEY.len();
    let rest = line.get(start..)?;
    let end = rest.find('"')?;
    parse_rfc3339_millis(rest.get(..end)?)
}

fn note_time(file: &mut LogFile, ts: u64) {
    file.first_ts = Some(file.first_ts.map_or(ts, |first| first.min(ts)));
    file.last_ts = file.last_ts.max(ts);
}

fn record_response(file: &mut LogFile, start: u64, end: u64) {
    if end < start {
        return;
    }
    let ms = end - start;
    if ms > MAX_RESPONSE_MS {
        return;
    }
    file.responses.push((end, ms));
    if file.responses.len() > MAX_RESPONSE_SAMPLES {
        let excess = file.responses.len() - MAX_RESPONSE_SAMPLES;
        file.responses.drain(..excess);
    }
}

fn push_event(file: &mut LogFile, ts: u64, tokens: u64, key: u64) {
    file.events.push((ts, tokens));
    file.event_keys.push(key);
    file.has_usage_data = true;
}

fn prune_events(file: &mut LogFile, cutoff: u64) {
    let mut events = Vec::with_capacity(file.events.len());
    let mut keys = Vec::with_capacity(file.events.len());
    for (index, event) in file.events.iter().enumerate() {
        if event.0 >= cutoff {
            events.push(*event);
            keys.push(file.event_keys.get(index).copied().unwrap_or(0));
        }
    }
    file.events = events;
    file.event_keys = keys;
    file.responses.retain(|(ts, _)| *ts >= cutoff);
}

fn remember_id(file: &mut LogFile, id: &str) {
    file.recent_ids.push(id.to_string());
    if file.recent_ids.len() > 24 {
        file.recent_ids.remove(0);
    }
}

fn hash_key(parts: &[&str]) -> u64 {
    let mut hasher = DefaultHasher::new();
    for part in parts {
        part.hash(&mut hasher);
    }
    hasher.finish().max(1)
}

/// One-line, trimmed title from free text. `None` for wrapper markup and empty prompts.
pub(crate) fn clean_title(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.starts_with('<') {
        return None;
    }
    let mut out = String::new();
    let mut last_space = false;
    for ch in trimmed.chars() {
        if ch.is_whitespace() || ch.is_control() {
            if !last_space && !out.is_empty() {
                out.push(' ');
            }
            last_space = true;
        } else {
            out.push(ch);
            last_space = false;
        }
        if out.chars().count() >= 90 {
            break;
        }
    }
    let out = out.trim().to_string();
    if out.is_empty() {
        return None;
    }
    if out.chars().count() >= 90 {
        let cut: String = out.chars().take(86).collect();
        return Some(format!("{}...", cut.trim_end()));
    }
    Some(out)
}

/// Text of a message `content` value: a string or an array of `{text}` parts.
pub(crate) fn content_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Array(parts) => parts.iter().find_map(|part| {
            if let Some(text) = part.as_str() {
                return Some(text.to_string());
            }
            part.get("text").and_then(Value::as_str).map(str::to_string)
        }),
        _ => None,
    }
}

fn folder_name(path: &str) -> Option<String> {
    let trimmed = path.trim_end_matches(['/', '\\']);
    let name = trimmed.rsplit(['/', '\\']).next()?;
    if name.is_empty() {
        None
    } else {
        Some(name.chars().take(48).collect())
    }
}

fn usage_line(line: &str, provider: &str, file: &mut LogFile, fallback_time: u64) {
    match provider {
        "codex" => codex_line(line, file, fallback_time),
        "claude-code" => claude_line(line, file, fallback_time),
        "github-copilot" => copilot_line(line, file, fallback_time),
        _ => {}
    }
}

fn codex_line(line: &str, file: &mut LogFile, fallback_time: u64) {
    // Session transcripts contain many non-usage records. Avoid JSON parsing those lines.
    if line.contains("\"type\":\"user_message\"") {
        let ts = quick_timestamp(line).unwrap_or(fallback_time);
        note_time(file, ts);
        file.pending_prompt = Some(ts);
    } else if line.contains("\"type\":\"agent_message\"") || line.contains("\"type\":\"agent_reasoning\"") {
        let ts = quick_timestamp(line).unwrap_or(fallback_time);
        note_time(file, ts);
        if let Some(start) = file.pending_prompt.take() {
            record_response(file, start, ts);
        }
    }
    if !line.contains("token_count") {
        return;
    }
    let Ok(root) = serde_json::from_str::<Value>(line) else {
        return;
    };
    let timestamp = event_time(&root, fallback_time);
    if root.pointer("/payload/type").and_then(Value::as_str) != Some("token_count") {
        return;
    }
    note_time(file, timestamp);
    let info = &root["payload"]["info"];
    let latest = info.get("last_token_usage").and_then(token_total);
    if let Some(total) = info.get("total_token_usage").and_then(token_total) {
        let delta = file
            .previous_total
            .map(|prev| total.saturating_sub(prev))
            .unwrap_or_else(|| latest.unwrap_or(0));
        file.previous_total = Some(total);
        if delta > 0 {
            push_event(file, timestamp, delta, 0);
        }
    } else if let Some(tokens) = latest.filter(|n| *n > 0) {
        push_event(file, timestamp, tokens, 0);
    }
    let rate_limits = parse_rate_limits(&root, timestamp);
    if !rate_limits.is_empty() {
        file.rate_limits = rate_limits;
    }
}

fn claude_line(line: &str, file: &mut LogFile, fallback_time: u64) {
    let user = line.contains("\"type\":\"user\"");
    let assistant = !user && line.contains("\"type\":\"assistant\"");
    if !user && !assistant {
        return;
    }
    let ts = quick_timestamp(line).unwrap_or(fallback_time);
    note_time(file, ts);
    if user {
        file.pending_prompt = Some(ts);
        return;
    }
    if let Some(start) = file.pending_prompt.take() {
        record_response(file, start, ts);
    }
    if !line.contains("usage") {
        return;
    }
    let Ok(root) = serde_json::from_str::<Value>(line) else {
        return;
    };
    if root.get("type").and_then(Value::as_str) != Some("assistant") {
        return;
    }
    // Claude Code writes one record per content block; the same reply repeats its id.
    let mut key = 0u64;
    if let Some(id) = root.pointer("/message/id").and_then(Value::as_str) {
        if file.recent_ids.iter().any(|seen| seen == id) {
            return;
        }
        remember_id(file, id);
        let request = root
            .get("requestId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        key = hash_key(&[id, request]);
    }
    let Some(usage) = root.pointer("/message/usage") else {
        return;
    };
    let input = usage
        .get("input_tokens")
        .and_then(unsigned)
        .unwrap_or(0)
        .saturating_add(
            usage
                .get("cache_read_input_tokens")
                .and_then(unsigned)
                .unwrap_or(0),
        )
        .saturating_add(
            usage
                .get("cache_creation_input_tokens")
                .and_then(unsigned)
                .unwrap_or(0),
        );
    let output = usage.get("output_tokens").and_then(unsigned).unwrap_or(0);
    let total = input.saturating_add(output);
    if total > 0 {
        push_event(file, event_time(&root, fallback_time), total, key);
    }
}

fn copilot_line(line: &str, file: &mut LogFile, fallback_time: u64) {
    let user = line.contains("\"type\":\"user.message\"");
    let assistant = !user && line.contains("\"type\":\"assistant.message\"");
    if !user && !assistant {
        return;
    }
    let ts = quick_timestamp(line).unwrap_or(fallback_time);
    note_time(file, ts);
    if user {
        file.pending_prompt = Some(ts);
    } else if let Some(start) = file.pending_prompt.take() {
        record_response(file, start, ts);
    }
}

/// Title, project and start time come from the first lines of a session file.
fn head_line(line: &str, provider: &str, file: &mut LogFile) {
    match provider {
        "claude-code" => {
            if !line.contains("\"type\":\"user\"") && file.project.is_some() {
                return;
            }
            let Ok(root) = serde_json::from_str::<Value>(line) else {
                return;
            };
            if file.project.is_none() {
                file.project = root.get("cwd").and_then(Value::as_str).and_then(folder_name);
            }
            if root.get("type").and_then(Value::as_str) == Some("user")
                && root.get("isMeta").and_then(Value::as_bool) != Some(true)
                && file.title.is_none()
            {
                file.title = root
                    .pointer("/message/content")
                    .and_then(content_text)
                    .and_then(|text| clean_title(&text));
            }
        }
        "codex" => {
            if line.contains("\"type\":\"session_meta\"") {
                if let Ok(root) = serde_json::from_str::<Value>(line) {
                    file.project = root
                        .pointer("/payload/cwd")
                        .and_then(Value::as_str)
                        .and_then(folder_name);
                }
            } else if file.title.is_none() && line.contains("\"type\":\"user_message\"") {
                if let Ok(root) = serde_json::from_str::<Value>(line) {
                    file.title = root
                        .pointer("/payload/message")
                        .and_then(Value::as_str)
                        .and_then(clean_title);
                }
            }
        }
        "github-copilot" => {
            if file.title.is_none() && line.contains("\"type\":\"user.message\"") {
                if let Ok(root) = serde_json::from_str::<Value>(line) {
                    file.title = root
                        .pointer("/data/content")
                        .and_then(content_text)
                        .and_then(|text| clean_title(&text));
                }
            }
        }
        _ => {}
    }
}

fn head_scan(path: &Path, provider: &str, file: &mut LogFile) {
    file.head_done = true;
    let Ok(handle) = File::open(path) else {
        return;
    };
    let mut buffer = Vec::new();
    if handle
        .take(HEAD_BYTES as u64)
        .read_to_end(&mut buffer)
        .is_err()
    {
        return;
    }
    for raw in buffer.split(|byte| *byte == b'\n').take(HEAD_LINES) {
        let text = String::from_utf8_lossy(raw);
        head_line(text.trim_end_matches('\r'), provider, file);
        if file.title.is_some() && file.project.is_some() {
            break;
        }
    }
}

/* ------------------------------------------------------------ incremental read */

fn update_file(path: &Path, provider: &str, file: &mut LogFile, now: u64) {
    update_file_with(path, provider, file, now, INITIAL_TAIL_BYTES);
}

fn update_file_with(path: &Path, provider: &str, file: &mut LogFile, now: u64, initial_tail: u64) {
    let Ok(metadata) = std::fs::metadata(path) else {
        return;
    };
    let len = metadata.len();
    let modified = modified_ms(&metadata);
    // A shorter file, or a same-size file with a new modification time, was rewritten.
    if len < file.length || (len == file.length && modified != file.modified_ms) {
        *file = LogFile::default();
    }
    if len == file.length {
        file.modified_ms = modified;
        return;
    }
    // First visit to a large file: only its tail matters. The partial first line is skipped.
    if file.offset == 0 && file.length == 0 && len > initial_tail {
        file.offset = len - initial_tail;
        file.discarding_oversized_line = true;
    }

    let Ok(mut file_reader) = File::open(path) else {
        return;
    };
    if file_reader.seek(SeekFrom::Start(file.offset)).is_err() {
        return;
    }
    let bytes_to_read = len.saturating_sub(file.offset);
    let mut reader = BufReader::new(file_reader).take(bytes_to_read);
    let mut line = std::mem::take(&mut file.pending);
    let mut discarding = file.discarding_oversized_line;
    loop {
        let available = match reader.fill_buf() {
            Ok(available) if available.is_empty() => break,
            Ok(available) => available,
            Err(_) => return,
        };
        let newline = available.iter().position(|byte| *byte == b'\n');
        let chunk_len = newline.unwrap_or(available.len());
        let consume_len = chunk_len + usize::from(newline.is_some());

        if discarding {
            if newline.is_some() {
                discarding = false;
            }
        } else if line.len().saturating_add(chunk_len) > MAX_JSONL_LINE_BYTES {
            line.clear();
            discarding = newline.is_none();
        } else {
            line.extend_from_slice(&available[..chunk_len]);
            if newline.is_some() {
                process_jsonl_line(&line, provider, file, modified);
                line.clear();
            }
        }
        reader.consume(consume_len);
    }
    file.pending = if discarding { Vec::new() } else { line };
    file.discarding_oversized_line = discarding;
    file.offset = len;
    file.length = len;
    file.modified_ms = modified;
    prune_events(file, now.saturating_sub(DAY_MS));
}

fn process_jsonl_line(bytes: &[u8], provider: &str, file: &mut LogFile, fallback_time: u64) {
    let line = String::from_utf8_lossy(bytes);
    usage_line(line.trim_end_matches('\r'), provider, file, fallback_time);
}

/* ------------------------------------------------------------------ scanning */

/// One session as seen by a provider scan.
#[derive(Clone, Debug, Default)]
pub(crate) struct SessionStat {
    pub id: String,
    pub title: String,
    pub project: Option<String>,
    pub started_at: Option<u64>,
    pub last_active_at: u64,
    pub tokens: Option<u64>,
}

#[derive(Default)]
pub(crate) struct ScanOut {
    pub tokens: u64,
    /// Session files of any age found on disk.
    pub files: u32,
    pub has_usage_data: bool,
    pub rate_limits: Vec<RateLimit>,
    pub sessions: Vec<SessionStat>,
    pub responses: Vec<(u64, u64)>,
    pub sessions_24h: u32,
    pub sessions_7d: u32,
    pub active_sessions: u32,
    pub last_active_at: Option<u64>,
}

impl ScanOut {
    pub(crate) fn merge(&mut self, other: ScanOut) {
        self.tokens = self.tokens.saturating_add(other.tokens);
        self.files = self.files.saturating_add(other.files);
        self.has_usage_data |= other.has_usage_data;
        for rate in other.rate_limits {
            if let Some(existing) = self.rate_limits.iter_mut().find(|r| r.label == rate.label) {
                if rate.updated_at >= existing.updated_at {
                    *existing = rate;
                }
            } else {
                self.rate_limits.push(rate);
            }
        }
        self.sessions.extend(other.sessions);
        self.responses.extend(other.responses);
        self.sessions_24h = self.sessions_24h.saturating_add(other.sessions_24h);
        self.sessions_7d = self.sessions_7d.saturating_add(other.sessions_7d);
        self.active_sessions = self.active_sessions.saturating_add(other.active_sessions);
        self.last_active_at = self.last_active_at.max(other.last_active_at);
    }

    pub(crate) fn finish(&mut self) {
        self.sessions
            .sort_by(|a, b| b.last_active_at.cmp(&a.last_active_at));
    }
}

/// Subagent transcripts are part of a parent session, not sessions of their own.
pub(crate) fn is_sidecar(path: &Path) -> bool {
    let in_subagents = path.components().any(|part| part.as_os_str() == "subagents");
    let agent_file = path
        .file_stem()
        .and_then(|s| s.to_str())
        .is_some_and(|stem| stem.starts_with("agent-"));
    in_subagents || agent_file
}

pub(crate) fn session_id(path: &Path) -> String {
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default();
    if matches!(stem, "events" | "store") {
        if let Some(parent) = path.parent().and_then(|p| p.file_name()).and_then(|n| n.to_str()) {
            return parent.to_string();
        }
    }
    stem.to_string()
}

fn scan(root: &Path, provider: &str, now: u64) -> (u64, u32, bool, Vec<RateLimit>) {
    let out = scan_jsonl(root, provider, now, &is_jsonl);
    (out.tokens, out.files, out.has_usage_data, out.rate_limits)
}

/// Incrementally read the JSONL session files below `root`.
pub(crate) fn scan_jsonl(
    root: &Path,
    provider: &str,
    now: u64,
    accept: &dyn Fn(&Path) -> bool,
) -> ScanOut {
    let mut entries = collect_files(root, MAX_WALK_DEPTH, accept);
    entries.sort_by(|a, b| b.modified.cmp(&a.modified));
    let day_cutoff = now.saturating_sub(DAY_MS);
    let week_cutoff = now.saturating_sub(WEEK_MS);
    let active_cutoff = now.saturating_sub(ACTIVE_WINDOW_MS);

    let mut out = ScanOut {
        files: entries.len().min(u32::MAX as usize) as u32,
        ..ScanOut::default()
    };

    // 0 = skip, 1 = fully processed, 2 = title (and Codex quota) only.
    let mut plan: Vec<u8> = vec![0; entries.len()];
    let mut full = 0usize;
    let mut light = 0usize;
    let mut quota = 0usize;
    for (index, entry) in entries.iter().enumerate() {
        if !is_sidecar(&entry.path) {
            if entry.modified >= week_cutoff {
                out.sessions_7d += 1;
            }
            if entry.modified >= day_cutoff {
                out.sessions_24h += 1;
            }
            if entry.modified >= active_cutoff {
                out.active_sessions += 1;
            }
            out.last_active_at = out.last_active_at.max(Some(entry.modified));
        }
        if entry.modified >= day_cutoff {
            if full < MAX_ACTIVE_FILES {
                plan[index] = 1;
                full += 1;
            }
        } else if provider == "codex" && quota < QUOTA_FILES {
            plan[index] = 2;
            quota += 1;
        } else if entry.modified >= week_cutoff && light < RECENT_LIGHT_FILES {
            plan[index] = 2;
            light += 1;
        }
    }

    let mut cache = log_cache();
    let namespace = format!("{}::{}::", provider, root.to_string_lossy());
    let key_of = |path: &Path| format!("{}{}", namespace, path.to_string_lossy());
    let live: std::collections::HashSet<String> = entries
        .iter()
        .zip(plan.iter())
        .filter(|(_, step)| **step != 0)
        .map(|(entry, _)| key_of(&entry.path))
        .collect();
    cache
        .files
        .retain(|key, _| !key.starts_with(&namespace) || live.contains(key));

    let mut seen_keys: std::collections::HashSet<u64> = std::collections::HashSet::new();
    for (entry, step) in entries.iter().zip(plan.iter()) {
        if *step == 0 {
            continue;
        }
        let file = cache.files.entry(key_of(&entry.path)).or_default();
        if *step == 1 {
            update_file(&entry.path, provider, file, now);
        } else if provider == "codex" {
            update_file_with(&entry.path, provider, file, now, QUOTA_TAIL_BYTES);
        }
        if !file.head_done {
            head_scan(&entry.path, provider, file);
        }
        out.has_usage_data |= file.has_usage_data;
        let mut session_tokens = 0u64;
        for (index, (timestamp, tokens)) in file.events.iter().enumerate() {
            if *timestamp < day_cutoff {
                continue;
            }
            let key = file.event_keys.get(index).copied().unwrap_or(0);
            if key != 0 && !seen_keys.insert(key) {
                continue;
            }
            session_tokens = session_tokens.saturating_add(*tokens);
        }
        out.tokens = out.tokens.saturating_add(session_tokens);
        out.responses
            .extend(file.responses.iter().filter(|(ts, _)| *ts >= day_cutoff).copied());
        for rate in &file.rate_limits {
            if let Some(existing) = out.rate_limits.iter_mut().find(|r| r.label == rate.label) {
                if rate.updated_at >= existing.updated_at {
                    *existing = rate.clone();
                }
            } else {
                out.rate_limits.push(rate.clone());
            }
        }
        if is_sidecar(&entry.path) || entry.modified < week_cutoff {
            continue;
        }
        let id = session_id(&entry.path);
        out.sessions.push(SessionStat {
            title: file.title.clone().unwrap_or_else(|| id.clone()),
            id,
            project: file.project.clone(),
            started_at: file.first_ts,
            last_active_at: entry.modified,
            tokens: (file.has_usage_data && session_tokens > 0).then_some(session_tokens),
        });
    }
    out.finish();
    out
}

/// Mean of the response samples in milliseconds.
pub(crate) fn mean_ms(samples: &[(u64, u64)]) -> Option<u64> {
    if samples.is_empty() {
        return None;
    }
    let total: u128 = samples.iter().map(|(_, ms)| *ms as u128).sum();
    Some((total / samples.len() as u128) as u64)
}

fn manual(cfg: &ManualUsage) -> UsageSnapshot {
    let used = cfg.used;
    let limit = cfg.limit;
    let percent = match (used, limit) {
        (Some(u), Some(l)) if l > 0 => Some((u as f64 / l as f64).clamp(0.0, 1.0)),
        _ => None,
    };
    let status = if used.is_some() || limit.is_some() {
        "ok"
    } else {
        "unknown"
    };
    UsageSnapshot {
        provider: "manual".into(),
        label: if cfg.label.is_empty() {
            "Custom".into()
        } else {
            cfg.label.clone()
        },
        status: status.into(),
        used,
        limit,
        unit: Some(if cfg.unit.is_empty() {
            "tokens".into()
        } else {
            cfg.unit.clone()
        }),
        percent,
        window: Some("manual".into()),
        detail: Some("Manually configured".into()),
        source: Some("manual".into()),
        reset_at: None,
        updated_at: now_millis(),
        activity: None,
    }
}

pub fn refresh(settings: &Settings) -> Vec<UsageSnapshot> {
    let now = now_millis();
    let mut out = Vec::new();
    for spec in providers::SPECS {
        if settings.usage.shows(spec.id) {
            out.extend(providers::snapshots(spec, now));
        }
    }
    if settings.usage.manual {
        out.push(manual(&settings.usage.manual_config));
    }
    out
}

#[tauri::command]
pub fn usage_get(state: State<AppState>) -> Vec<UsageSnapshot> {
    state.usage.lock().unwrap().clone()
}

/// Detect locally installed AI tools from known, read-only locations.
#[tauri::command]
pub fn usage_detect() -> Vec<DetectedProvider> {
    detect::detect()
}

#[tauri::command]
pub async fn usage_refresh(app: AppHandle) -> Result<Vec<UsageSnapshot>, String> {
    let settings = app.state::<AppState>().settings.lock().unwrap().clone();
    claude_limits::refresh_requested(&settings.usage).await;
    let snaps = tauri::async_runtime::spawn_blocking(move || refresh(&settings))
        .await
        .map_err(|error| format!("Usage refresh failed: {error}"))?;
    *app.state::<AppState>().usage.lock().unwrap() = snaps.clone();
    Ok(snaps)
}

pub(crate) fn parse_rfc3339_millis(value: &str) -> Option<u64> {
    // Small, dependency-free RFC3339 parser for timestamps in local event logs.
    let bytes = value.as_bytes();
    if bytes.len() < 20 || bytes.get(4) != Some(&b'-') || bytes.get(7) != Some(&b'-') {
        return None;
    }
    let number = |range: std::ops::Range<usize>| -> Option<i64> { value.get(range)?.parse().ok() };
    let year = number(0..4)?;
    let month = number(5..7)?;
    let day = number(8..10)?;
    let hour = number(11..13)?;
    let minute = number(14..16)?;
    let second = number(17..19)?;
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    let mut idx = 19;
    let mut millis = 0i64;
    if bytes.get(idx) == Some(&b'.') {
        idx += 1;
        let start = idx;
        while bytes.get(idx).is_some_and(u8::is_ascii_digit) {
            idx += 1;
        }
        if idx > start {
            let frac = &value[start..idx];
            let digits = frac.chars().take(3).collect::<String>();
            millis =
                digits.parse::<i64>().ok()? * 10i64.pow(3u32.saturating_sub(digits.len() as u32));
        }
    }
    let offset_minutes = match bytes.get(idx).copied()? {
        b'Z' | b'z' => 0,
        sign @ (b'+' | b'-') => {
            let oh = value.get(idx + 1..idx + 3)?.parse::<i64>().ok()?;
            let om = value.get(idx + 4..idx + 6)?.parse::<i64>().ok()?;
            (if sign == b'+' { 1 } else { -1 }) * (oh * 60 + om)
        }
        _ => return None,
    };
    let (y, m) = if month <= 2 {
        (year - 1, month + 12)
    } else {
        (year, month)
    };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m - 3) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    let seconds = days * 86_400 + hour * 3600 + minute * 60 + second - offset_minutes * 60;
    u64::try_from(seconds.saturating_mul(1000).saturating_add(millis)).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_codex_token_count_and_provider_rate_limits() {
        let json = r#"{"timestamp":"2026-10-13T10:30:00Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":120,"output_tokens":30,"total_tokens":150},"last_token_usage":{"input_tokens":20,"output_tokens":5,"total_tokens":25}},"rate_limits":{"primary":{"used_percent":31.5,"window_minutes":300,"resets_at":1791900000},"secondary":{"used_percent":8,"window_minutes":10080}}}}"#;
        let mut cache = LogFile::default();
        usage_line(json, "codex", &mut cache, 0);
        let event_at = parse_rfc3339_millis("2026-10-13T10:30:00Z").unwrap();
        assert_eq!(cache.events, vec![(event_at, 25)]);
        assert_eq!(cache.rate_limits.len(), 2);
        assert_eq!(cache.rate_limits[0].window.as_deref(), Some("5h"));
        assert!((cache.rate_limits[0].percent - 0.315).abs() < f64::EPSILON);
        assert_eq!(cache.rate_limits[0].reset_at, Some(1_791_900_000_000));
    }

    #[test]
    fn supports_legacy_nested_rate_limits() {
        let json = r#"{"type":"event_msg","payload":{"type":"token_count","info":{"rate_limits":{"primary":{"used_percent":12,"window_minutes":60}}}}}"#;
        let mut cache = LogFile::default();
        usage_line(json, "codex", &mut cache, 100);
        assert_eq!(cache.rate_limits.len(), 1);
        assert_eq!(cache.rate_limits[0].window.as_deref(), Some("1h"));
    }

    #[test]
    fn cumulative_codex_counts_are_differenced_instead_of_double_counted() {
        let base = r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":120},"last_token_usage":{"total_tokens":120}}}}"#;
        let next = r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":170},"last_token_usage":{"total_tokens":50}}}}"#;
        let mut cache = LogFile::default();
        usage_line(base, "codex", &mut cache, 100);
        usage_line(next, "codex", &mut cache, 200);
        assert_eq!(cache.events.iter().map(|(_, n)| n).sum::<u64>(), 170);
    }

    #[test]
    fn claude_usage_reads_assistant_usage_records_only() {
        let json = r#"{"timestamp":"2026-10-13T10:30:00Z","type":"assistant","message":{"usage":{"input_tokens":120,"cache_read_input_tokens":30,"output_tokens":20}}}"#;
        let mut cache = LogFile::default();
        usage_line(json, "claude-code", &mut cache, 0);
        assert_eq!(cache.events[0].1, 170);
    }

    #[test]
    fn claude_repeated_message_ids_are_counted_once() {
        let first = r#"{"timestamp":"2026-10-13T10:30:00Z","type":"assistant","requestId":"req_1","message":{"id":"msg_1","usage":{"input_tokens":10,"output_tokens":5}}}"#;
        let again = r#"{"timestamp":"2026-10-13T10:30:01Z","type":"assistant","requestId":"req_1","message":{"id":"msg_1","usage":{"input_tokens":10,"output_tokens":5}}}"#;
        let other = r#"{"timestamp":"2026-10-13T10:30:09Z","type":"assistant","requestId":"req_2","message":{"id":"msg_2","usage":{"input_tokens":3,"output_tokens":2}}}"#;
        let mut cache = LogFile::default();
        for line in [first, again, other] {
            usage_line(line, "claude-code", &mut cache, 0);
        }
        assert_eq!(cache.events.iter().map(|(_, n)| n).sum::<u64>(), 20);
        assert_eq!(cache.events.len(), cache.event_keys.len());
    }

    #[test]
    fn claude_response_time_is_prompt_to_first_assistant_record() {
        let user = r#"{"type":"user","timestamp":"2026-10-13T10:30:00.000Z","message":{"role":"user","content":"hi"}}"#;
        let first = r#"{"type":"assistant","timestamp":"2026-10-13T10:30:04.500Z","message":{"id":"a","content":[]}}"#;
        let second = r#"{"type":"assistant","timestamp":"2026-10-13T10:30:09.000Z","message":{"id":"a","content":[]}}"#;
        let mut cache = LogFile::default();
        for line in [user, first, second] {
            usage_line(line, "claude-code", &mut cache, 0);
        }
        assert_eq!(cache.responses.len(), 1);
        assert_eq!(cache.responses[0].1, 4500);
        assert_eq!(mean_ms(&cache.responses), Some(4500));
    }

    #[test]
    fn codex_response_time_pairs_user_and_agent_messages() {
        let user = r#"{"timestamp":"2026-10-13T10:30:00Z","type":"event_msg","payload":{"type":"user_message","message":"fix it"}}"#;
        let agent = r#"{"timestamp":"2026-10-13T10:30:07Z","type":"event_msg","payload":{"type":"agent_message","message":"done"}}"#;
        let mut cache = LogFile::default();
        usage_line(user, "codex", &mut cache, 0);
        usage_line(agent, "codex", &mut cache, 0);
        assert_eq!(cache.responses[0].1, 7000);
    }

    #[test]
    fn head_scan_reads_title_and_project() {
        let user = r#"{"type":"user","cwd":"C:\\Users\\me\\code\\island","timestamp":"2026-10-13T10:30:00Z","message":{"role":"user","content":"  Add a   toast\nfor agents "}}"#;
        let mut cache = LogFile::default();
        head_line(user, "claude-code", &mut cache);
        assert_eq!(cache.title.as_deref(), Some("Add a toast for agents"));
        assert_eq!(cache.project.as_deref(), Some("island"));
        let wrapped = r#"{"type":"user","message":{"role":"user","content":"<command-name>/clear</command-name>"}}"#;
        let mut other = LogFile::default();
        head_line(wrapped, "claude-code", &mut other);
        assert!(other.title.is_none());
    }

    #[test]
    fn timestamps_parse_with_timezone_and_fraction() {
        assert_eq!(parse_rfc3339_millis("1970-01-01T00:00:01.250Z"), Some(1250));
        assert_eq!(parse_rfc3339_millis("1970-01-01T01:00:00+01:00"), Some(0));
    }

    #[test]
    fn cache_reads_only_appended_session_lines_and_does_not_double_count() {
        use std::io::Write;

        let path = std::env::temp_dir().join(format!(
            "hover-island-usage-{}-{}.jsonl",
            std::process::id(),
            now_millis()
        ));
        let first = r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":10},"last_token_usage":{"total_tokens":10}}}}"#;
        let second = r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":20},"last_token_usage":{"total_tokens":10}}}}"#;
        std::fs::write(&path, format!("{first}\n")).unwrap();
        let mut cache = LogFile::default();
        update_file(&path, "codex", &mut cache, now_millis());
        assert_eq!(cache.events.iter().map(|(_, n)| n).sum::<u64>(), 10);

        update_file(&path, "codex", &mut cache, now_millis());
        assert_eq!(cache.events.iter().map(|(_, n)| n).sum::<u64>(), 10);

        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        writeln!(file, "{second}").unwrap();
        update_file(&path, "codex", &mut cache, now_millis());
        assert_eq!(cache.events.iter().map(|(_, n)| n).sum::<u64>(), 20);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn large_files_are_tail_read_on_first_visit() {
        let path = std::env::temp_dir().join(format!(
            "hover-island-usage-tail-{}-{}.jsonl",
            std::process::id(),
            now_millis()
        ));
        let old = r#"{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"total_tokens":1000}}}}"#;
        let recent = r#"{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"total_tokens":7}}}}"#;
        let mut body = String::new();
        for _ in 0..40 {
            body.push_str(old);
            body.push('\n');
        }
        body.push_str(recent);
        body.push('\n');
        std::fs::write(&path, body).unwrap();
        let mut cache = LogFile::default();
        // Only the last ~300 bytes are visible: the partial line is dropped, the final record survives.
        update_file_with(&path, "codex", &mut cache, now_millis(), 300);
        let total: u64 = cache.events.iter().map(|(_, n)| n).sum();
        assert!(total < 40_000, "read the whole file: {total}");
        assert_eq!(cache.events.last().map(|(_, n)| *n), Some(7));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn oversized_lines_are_skipped_and_partial_utf8_records_survive_appends() {
        use std::io::Write;

        let path = std::env::temp_dir().join(format!(
            "hover-island-usage-bounded-{}-{}.jsonl",
            std::process::id(),
            now_millis()
        ));
        std::fs::write(&path, vec![b'x'; MAX_JSONL_LINE_BYTES + 1]).unwrap();
        let mut cache = LogFile::default();
        let now = now_millis();
        update_file(&path, "codex", &mut cache, now);
        assert!(cache.discarding_oversized_line);
        assert!(cache.pending.is_empty());
        assert!(cache.events.is_empty());

        let record = r#"{"type":"event_msg","label":"Café","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":14},"last_token_usage":{"total_tokens":14}}}}"#;
        let bytes = record.as_bytes();
        let split = record.find('é').unwrap() + 'é'.len_utf8();
        let mut writer = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        writer.write_all(b"\n").unwrap();
        writer.write_all(&bytes[..split - 1]).unwrap();
        writer.flush().unwrap();
        update_file(&path, "codex", &mut cache, now_millis());
        assert!(!cache.discarding_oversized_line);
        assert!(cache.events.is_empty());

        writer.write_all(&bytes[split - 1..]).unwrap();
        writer.write_all(b"\n").unwrap();
        update_file(&path, "codex", &mut cache, now_millis());
        assert_eq!(
            cache.events.iter().map(|(_, tokens)| tokens).sum::<u64>(),
            14
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn scanning_another_provider_root_preserves_cache_and_isolates_totals() {
        use std::io::Write;

        let base = std::env::temp_dir().join(format!(
            "hover-island-usage-roots-{}-{}",
            std::process::id(),
            now_millis()
        ));
        let codex_root = base.join("codex");
        let claude_root = base.join("claude");
        std::fs::create_dir_all(&codex_root).unwrap();
        std::fs::create_dir_all(&claude_root).unwrap();
        let codex_path = codex_root.join("session.jsonl");
        let claude_path = claude_root.join("session.jsonl");
        let codex_line = r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":10},"last_token_usage":{"total_tokens":10}}}}"#;
        let claude_line =
            r#"{"type":"assistant","message":{"usage":{"input_tokens":20,"output_tokens":5}}}"#;
        writeln!(File::create(&codex_path).unwrap(), "{codex_line}").unwrap();
        writeln!(File::create(&claude_path).unwrap(), "{claude_line}").unwrap();

        let now = now_millis();
        let (codex_tokens, _, _, _) = scan(&codex_root, "codex", now);
        assert_eq!(codex_tokens, 10);
        let (claude_tokens, _, _, _) = scan(&claude_root, "claude-code", now);
        assert_eq!(claude_tokens, 25);
        let (codex_again, _, _, _) = scan(&codex_root, "codex", now);
        assert_eq!(codex_again, 10);

        let cache = log_cache();
        let codex_key = format!(
            "codex::{}::{}",
            codex_root.to_string_lossy(),
            codex_path.to_string_lossy()
        );
        let claude_key = format!(
            "claude-code::{}::{}",
            claude_root.to_string_lossy(),
            claude_path.to_string_lossy()
        );
        assert!(cache.files.contains_key(&codex_key));
        assert!(cache.files.contains_key(&claude_key));
        drop(cache);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn scan_reports_sessions_titles_and_skips_files_older_than_a_week() {
        let base = std::env::temp_dir().join(format!(
            "hover-island-usage-sessions-{}-{}",
            std::process::id(),
            now_millis()
        ));
        let project = base.join("proj");
        std::fs::create_dir_all(project.join("sub").join("subagents")).unwrap();
        let user = r#"{"type":"user","cwd":"/home/me/island","timestamp":"2026-10-13T10:30:00Z","message":{"role":"user","content":"Ship the toast"}}"#;
        let reply = r#"{"type":"assistant","timestamp":"2026-10-13T10:30:03Z","message":{"id":"m1","usage":{"input_tokens":4,"output_tokens":6}}}"#;
        std::fs::write(project.join("abc.jsonl"), format!("{user}\n{reply}\n")).unwrap();
        std::fs::write(project.join("sub").join("subagents").join("agent-1.jsonl"), format!("{reply}\n")).unwrap();
        let out = scan_jsonl(&base, "claude-code", now_millis(), &is_jsonl);
        assert_eq!(out.sessions_24h, 1, "subagent files are not sessions");
        assert_eq!(out.sessions.len(), 1);
        assert_eq!(out.sessions[0].title, "Ship the toast");
        assert_eq!(out.sessions[0].project.as_deref(), Some("island"));
        assert!(out.has_usage_data);
        assert_eq!(out.responses.len(), 0, "fixture timestamps are older than 24h");
        let _ = std::fs::remove_dir_all(base);
    }
}
