//! Live AI agent events for the notch.
//!
//! Three sources feed one Tauri event, `ai://activity`:
//! 1. Session logs of Claude Code, Codex, Copilot CLI, Gemini CLI and OpenCode are polled
//!    (cheaply, every 2 seconds, only while AI toasts are on) and turned into
//!    started / progress / question / completed / failed events.
//! 2. A local-only HTTP endpoint (127.0.0.1, random port saved to a file, bearer token)
//!    accepts `POST /agent-event` from hooks, which are exact where log inference guesses.
//! 3. An opt-in installer previews, backs up and applies hook entries in the tools' own
//!    config files. Nothing is ever changed without a preview that the user confirmed.
use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Query, State as AxumState};
use axum::http::{header, HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::Router;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::state::AppState;
use crate::types::now_millis;
use crate::usage::providers::{self, Dirs, Parser};
use crate::usage::{clean_title, collect_files, content_text, is_sidecar, modified_ms, quick_timestamp};

const EVENT_NAME: &str = "ai://activity";
const MARK: &str = "src=hover-island";
const WALK_EVERY_MS: u64 = 6_000;
const TRACK_WINDOW_MS: u64 = 30 * 60_000;
const MAX_TRACKERS: usize = 24;
const QUIET_COMPLETE_MS: u64 = 6_000;
const TOUCH_COMPLETE_MS: u64 = 12_000;
const PROGRESS_EVERY_MS: u64 = 30_000;
const WAITING_FORGET_MS: u64 = 15 * 60_000;
const HOOK_AUTHORITY_MS: u64 = 15 * 60_000;
const MAX_READ_PER_TICK: usize = 1024 * 1024;
const MAX_LINE: usize = 2 * 1024 * 1024;
const MAX_CATCHUP: u64 = 2 * 1024 * 1024;
const MAX_GEMINI_BYTES: u64 = 8 * 1024 * 1024;
const PREVIEW_VALID_MS: u64 = 15 * 60_000;
const RECENT_LIMIT: usize = 40;

/* ------------------------------------------------------------------ payload */

/// The payload of the `ai://activity` Tauri event.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentEvent {
    /// started | progress | question | completed | failed
    pub kind: String,
    /// Provider id such as `claude-code`, `codex`, `gemini`.
    pub provider: String,
    pub title: String,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    pub ts: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// "log" for inferred events, "hook" for events posted by a tool.
    pub source: String,
}

fn valid_kind(kind: &str) -> bool {
    matches!(kind, "started" | "progress" | "question" | "completed" | "failed")
}

/// Collapse whitespace and cut to `max` characters.
fn snippet(text: &str, max: usize) -> String {
    let mut out = String::new();
    let mut space = false;
    for ch in text.trim().chars() {
        if ch.is_whitespace() || ch.is_control() {
            if !space && !out.is_empty() {
                out.push(' ');
            }
            space = true;
        } else {
            out.push(ch);
            space = false;
        }
    }
    if out.chars().count() > max {
        let cut: String = out.chars().take(max.saturating_sub(3)).collect();
        return format!("{}...", cut.trim_end());
    }
    out
}

/// Codex names each thread itself and records it in `session_index.jsonl`
/// (`{"id": "...", "thread_name": "..."}`). That is the title its own app
/// shows, so it beats anything we can guess from the log.
fn codex_thread_name(session: &str) -> Option<String> {
    let id = session.get(session.len().checked_sub(36)?..)?;
    if id.len() != 36 || !id.contains('-') {
        return None;
    }
    let path = dirs::home_dir()?.join(".codex").join("session_index.jsonl");
    let mut file = File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let window = 1_048_576u64;
    if len > window {
        file.seek(SeekFrom::Start(len - window)).ok()?;
    }
    let mut text = String::new();
    std::io::Read::read_to_string(&mut file, &mut text).ok()?;
    let mut found = None;
    for line in text.lines() {
        if !line.contains(id) {
            continue;
        }
        let Ok(root) = serde_json::from_str::<Value>(line) else { continue };
        if root.get("id").and_then(Value::as_str) == Some(id) {
            if let Some(name) = root.get("thread_name").and_then(Value::as_str).map(str::trim).filter(|n| !n.is_empty()) {
                found = Some(snippet(name, 90));
            }
        }
    }
    found
}

/// Codex chat folders are named after the first message (`can-you-take-a-look-at`).
/// Shown as a title that reads like a sentence instead of a slug.
fn humanize_slug(name: &str) -> String {
    let words: Vec<&str> = name.split('-').filter(|w| !w.is_empty()).collect();
    let slug = words.len() >= 3
        && !name.contains(char::is_whitespace)
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !slug {
        return name.to_string();
    }
    let mut text = words.join(" ");
    if let Some(first) = text.get(..1) {
        text = first.to_uppercase() + &text[1..];
    }
    text
}

fn label_of(provider: &str) -> String {
    providers::spec_for(provider)
        .map(|spec| spec.label.to_string())
        .unwrap_or_else(|| provider.to_string())
}

/* ------------------------------------------------------------- service state */

static STARTED: AtomicBool = AtomicBool::new(false);
static RECENT: Mutex<VecDeque<AgentEvent>> = Mutex::new(VecDeque::new());
static HOOK_SEEN: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
static HOOK_TASKS: OnceLock<Mutex<HashMap<String, (u64, String)>>> = OnceLock::new();
static LAST_SENT: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
static ENDPOINT: Mutex<Option<Endpoint>> = Mutex::new(None);
static PREVIEWS: OnceLock<Mutex<HashMap<String, (u64, u64)>>> = OnceLock::new();

#[derive(Clone)]
struct Endpoint {
    port: u16,
    token: String,
}

struct ServerHandle {
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn hook_map() -> &'static Mutex<HashMap<String, Instant>> {
    HOOK_SEEN.get_or_init(|| Mutex::new(HashMap::new()))
}

fn hook_recent(provider: &str) -> bool {
    lock(hook_map())
        .get(provider)
        .is_some_and(|seen| seen.elapsed() < Duration::from_millis(HOOK_AUTHORITY_MS))
}

#[derive(Clone, Default)]
struct Cfg {
    enabled: bool,
    providers: Vec<String>,
    usage: crate::settings::UsageCfg,
}

impl Cfg {
    fn allows(&self, provider: &str) -> bool {
        // A tool switched off under Usage is off everywhere, alerts included.
        self.usage.shows(provider) && (self.providers.is_empty() || self.providers.iter().any(|p| p == provider))
    }
}

fn read_cfg(app: &AppHandle) -> Cfg {
    let state = app.state::<AppState>();
    let settings = lock(&state.settings);
    Cfg {
        enabled: settings.ai_toasts_enabled,
        providers: settings.ai_toast_providers.clone(),
        usage: settings.usage.clone(),
    }
}

/// Gate, dedupe, remember and emit one event.
fn deliver(app: &AppHandle, event: AgentEvent) {
    if !valid_kind(&event.kind) {
        return;
    }
    let cfg = read_cfg(app);
    if !cfg.enabled || !cfg.allows(&event.provider) {
        return;
    }
    // A tool with working hooks is authoritative; the log guess would only duplicate it.
    if event.source == "log" && hook_recent(&event.provider) {
        return;
    }
    let key = format!(
        "{}|{}|{}",
        event.provider,
        event.session_id.as_deref().unwrap_or(""),
        event.kind
    );
    {
        let mut last = lock(LAST_SENT.get_or_init(|| Mutex::new(HashMap::new())));
        if event.kind != "progress" {
            if let Some(previous) = last.get(&key) {
                if event.ts.saturating_sub(*previous) < 1500 {
                    return;
                }
            }
        }
        last.insert(key, event.ts);
        if last.len() > 400 {
            last.clear();
        }
    }
    {
        let mut recent = lock(&RECENT);
        recent.push_back(event.clone());
        while recent.len() > RECENT_LIMIT {
            recent.pop_front();
        }
    }
    let _ = app.emit(EVENT_NAME, &event);
}

/* --------------------------------------------------------------- signals */

#[derive(Clone, Debug, PartialEq)]
enum Signal {
    Prompt { ts: Option<u64>, text: Option<String> },
    ToolUse { ts: Option<u64>, name: String },
    ToolResult { ts: Option<u64> },
    Text { ts: Option<u64>, text: String },
    Done { ts: Option<u64>, text: String },
    Error { ts: Option<u64>, text: String },
    Aborted,
    Question { ts: Option<u64>, text: String },
    Plan { done: u32, total: u32 },
}

fn plan_from_todos(items: &[Value], status_key: &str) -> Option<Signal> {
    if items.is_empty() {
        return None;
    }
    let done = items
        .iter()
        .filter(|item| {
            item.get(status_key)
                .and_then(Value::as_str)
                .is_some_and(|s| s == "completed")
        })
        .count();
    Some(Signal::Plan {
        done: done as u32,
        total: items.len() as u32,
    })
}

fn classify_claude(line: &str) -> Vec<Signal> {
    let user = line.contains("\"type\":\"user\"");
    let assistant = !user && line.contains("\"type\":\"assistant\"");
    if (!user && !assistant) || line.contains("\"isSidechain\":true") {
        return Vec::new();
    }
    let ts = quick_timestamp(line);
    if user {
        if line.contains("\"type\":\"tool_result\"") {
            return vec![Signal::ToolResult { ts }];
        }
        let Ok(root) = serde_json::from_str::<Value>(line) else {
            return Vec::new();
        };
        if root.get("isMeta").and_then(Value::as_bool) == Some(true) {
            return Vec::new();
        }
        let text = root.pointer("/message/content").and_then(content_text);
        if text
            .as_deref()
            .is_some_and(|t| t.contains("Request interrupted by user"))
        {
            return vec![Signal::Aborted];
        }
        if text.as_deref().is_some_and(|t| t.trim_start().starts_with('<')) {
            return Vec::new();
        }
        return vec![Signal::Prompt {
            ts,
            text: text.map(|t| snippet(&t, 90)).filter(|t| !t.is_empty()),
        }];
    }
    let Ok(root) = serde_json::from_str::<Value>(line) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    if root.get("isApiErrorMessage").and_then(Value::as_bool) == Some(true) {
        let text = root
            .pointer("/message/content")
            .and_then(content_text)
            .unwrap_or_else(|| "API error".into());
        return vec![Signal::Error { ts, text: snippet(&text, 120) }];
    }
    if let Some(items) = root.pointer("/message/content").and_then(Value::as_array) {
        for item in items {
            match item.get("type").and_then(Value::as_str) {
                Some("text") => {
                    let text = item.get("text").and_then(Value::as_str).unwrap_or_default();
                    out.push(Signal::Text { ts, text: snippet(text, 140) });
                }
                Some("tool_use") => {
                    let name = item.get("name").and_then(Value::as_str).unwrap_or("tool");
                    match name {
                        "AskUserQuestion" => {
                            let q = item
                                .pointer("/input/questions/0/question")
                                .and_then(Value::as_str)
                                .unwrap_or("Claude has a question");
                            out.push(Signal::Question { ts, text: snippet(q, 120) });
                        }
                        "ExitPlanMode" => out.push(Signal::Question {
                            ts,
                            text: "Plan ready to review".into(),
                        }),
                        "TodoWrite" => {
                            if let Some(todos) = item.pointer("/input/todos").and_then(Value::as_array) {
                                out.extend(plan_from_todos(todos, "status"));
                            }
                        }
                        _ => out.push(Signal::ToolUse { ts, name: name.to_string() }),
                    }
                }
                _ => {}
            }
        }
    }
    out
}

fn classify_codex(line: &str) -> Vec<Signal> {
    let ts = quick_timestamp(line);
    let payload_text = |pointer: &str| -> Option<String> {
        serde_json::from_str::<Value>(line)
            .ok()?
            .pointer(pointer)
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    if line.contains("\"type\":\"user_message\"") {
        let text = payload_text("/payload/message").map(|t| snippet(&t, 90));
        return vec![Signal::Prompt { ts, text: text.filter(|t| !t.is_empty()) }];
    }
    if line.contains("\"type\":\"agent_message\"") {
        let text = payload_text("/payload/message").unwrap_or_default();
        return vec![Signal::Text { ts, text: snippet(&text, 140) }];
    }
    if line.contains("\"type\":\"task_complete\"") || line.contains("\"type\":\"turn_complete\"") {
        let text = payload_text("/payload/last_agent_message").unwrap_or_default();
        return vec![Signal::Done { ts, text: snippet(&text, 140) }];
    }
    if line.contains("\"type\":\"turn_aborted\"") {
        return vec![Signal::Aborted];
    }
    if line.contains("\"type\":\"error\"") || line.contains("\"type\":\"stream_error\"") {
        let text = payload_text("/payload/message").unwrap_or_else(|| "Codex hit an error".into());
        return vec![Signal::Error { ts, text: snippet(&text, 120) }];
    }
    if line.contains("approval_request") {
        return vec![Signal::Question { ts, text: "Approval needed".into() }];
    }
    let call = line.contains("\"type\":\"function_call\"")
        || line.contains("\"type\":\"local_shell_call\"")
        || line.contains("\"type\":\"custom_tool_call\"");
    if call {
        let Ok(root) = serde_json::from_str::<Value>(line) else {
            return Vec::new();
        };
        let name = root
            .pointer("/payload/name")
            .and_then(Value::as_str)
            .unwrap_or("shell")
            .to_string();
        if name == "update_plan" {
            let args = root.pointer("/payload/arguments").and_then(Value::as_str).unwrap_or("{}");
            if let Ok(parsed) = serde_json::from_str::<Value>(args) {
                if let Some(plan) = parsed.get("plan").and_then(Value::as_array) {
                    return plan_from_todos(plan, "status").into_iter().collect();
                }
            }
            return Vec::new();
        }
        return vec![Signal::ToolUse { ts, name }];
    }
    if line.contains("\"type\":\"function_call_output\"") || line.contains("\"type\":\"custom_tool_call_output\"") {
        return vec![Signal::ToolResult { ts }];
    }
    Vec::new()
}

fn classify_copilot(line: &str) -> Vec<Signal> {
    let Ok(root) = serde_json::from_str::<Value>(line) else {
        return Vec::new();
    };
    let ts = root
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(crate::usage::parse_rfc3339_millis);
    let kind = root.get("type").and_then(Value::as_str).unwrap_or_default();
    let text = root
        .pointer("/data/content")
        .and_then(content_text)
        .unwrap_or_default();
    match kind {
        "user.message" => vec![Signal::Prompt {
            ts,
            text: Some(snippet(&text, 90)).filter(|t| !t.is_empty()),
        }],
        "assistant.message" => vec![Signal::Text { ts, text: snippet(&text, 140) }],
        "assistant.turn_end" | "session.idle" => vec![Signal::Done { ts, text: String::new() }],
        "tool.execution_start" => {
            let name = root
                .pointer("/data/toolName")
                .or_else(|| root.pointer("/data/name"))
                .and_then(Value::as_str)
                .unwrap_or("tool");
            vec![Signal::ToolUse { ts, name: name.to_string() }]
        }
        "tool.execution_complete" => vec![Signal::ToolResult { ts }],
        "session.error" | "error" => {
            let message = root.pointer("/data/message").and_then(Value::as_str).unwrap_or("Copilot hit an error");
            vec![Signal::Error { ts, text: snippet(message, 120) }]
        }
        other if other.contains("permission") && other.contains("request") => {
            vec![Signal::Question { ts, text: "Permission needed".into() }]
        }
        _ => Vec::new(),
    }
}

/// How long a tool may stay unanswered before it probably waits for approval.
fn question_after_ms(tool: &str) -> Option<u64> {
    match tool {
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => Some(8_000),
        "WebFetch" | "WebSearch" => Some(15_000),
        "Bash" | "shell" | "local_shell" | "exec_command" | "run_shell_command" => Some(20_000),
        name if name.starts_with("mcp__") => Some(20_000),
        _ => None,
    }
}

/* ------------------------------------------------------------ session state */

#[derive(Clone, Copy, Debug, PartialEq)]
enum Phase {
    Idle,
    Working,
    Waiting,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Last {
    None,
    Prompt,
    Text,
    ToolUse,
    ToolResult,
}

struct SessionState {
    provider: String,
    id: String,
    project: Option<String>,
    task: String,
    phase: Phase,
    last: Last,
    started_at: u64,
    started_wall: u64,
    last_log_ts: u64,
    last_seen: u64,
    last_progress: u64,
    tool: Option<(String, u64)>,
    question_sent: bool,
    percent: Option<u8>,
    last_text: String,
}

impl SessionState {
    fn new(provider: &str, id: &str, project: Option<String>) -> Self {
        Self {
            provider: provider.to_string(),
            id: id.to_string(),
            project,
            task: String::new(),
            phase: Phase::Idle,
            last: Last::None,
            started_at: 0,
            started_wall: 0,
            last_log_ts: 0,
            last_seen: 0,
            last_progress: 0,
            tool: None,
            question_sent: false,
            percent: None,
            last_text: String::new(),
        }
    }

    fn title(&self) -> String {
        if self.provider == "codex" {
            if let Some(name) = codex_thread_name(&self.id) {
                return name;
            }
        }
        if !self.task.is_empty() {
            return self.task.clone();
        }
        self.project.as_deref().map(humanize_slug).unwrap_or_else(|| label_of(&self.provider))
    }

    fn event(&self, kind: &str, detail: String, now: u64) -> AgentEvent {
        AgentEvent {
            kind: kind.into(),
            provider: self.provider.clone(),
            title: self.title(),
            detail,
            percent: None,
            duration_ms: None,
            ts: now,
            session_id: Some(self.id.clone()),
            source: "log".into(),
        }
    }

    fn project_or_label(&self) -> String {
        self.project.clone().unwrap_or_else(|| label_of(&self.provider))
    }

    fn resume(&mut self, ts: Option<u64>, now: u64) {
        if self.phase == Phase::Idle {
            self.phase = Phase::Working;
            self.started_at = ts.unwrap_or(0);
            self.started_wall = now;
            self.question_sent = false;
            self.last_progress = now;
        } else if self.phase == Phase::Waiting {
            self.phase = Phase::Working;
            self.question_sent = false;
        }
    }

    fn complete(&mut self, now: u64, detail: Option<String>, out: &mut Vec<AgentEvent>) {
        if self.phase == Phase::Idle {
            return;
        }
        let duration = if self.started_at > 0 && self.last_log_ts >= self.started_at {
            self.last_log_ts - self.started_at
        } else {
            now.saturating_sub(self.started_wall)
        };
        let detail = detail
            .filter(|d| !d.is_empty())
            .or_else(|| Some(self.last_text.clone()).filter(|d| !d.is_empty()))
            .unwrap_or_else(|| self.project_or_label());
        let mut event = self.event("completed", detail, now);
        event.duration_ms = Some(duration);
        out.push(event);
        self.phase = Phase::Idle;
        self.last = Last::None;
        self.tool = None;
        self.percent = None;
    }

    fn apply(&mut self, signal: Signal, now: u64, out: &mut Vec<AgentEvent>) {
        self.last_seen = now;
        let stamp = |ts: &Option<u64>, me: &mut Self| {
            if let Some(ts) = ts {
                me.last_log_ts = me.last_log_ts.max(*ts);
            }
        };
        match signal {
            Signal::Prompt { ts, text } => {
                stamp(&ts, self);
                self.task = text.unwrap_or_default();
                self.phase = Phase::Working;
                self.started_at = ts.unwrap_or(0);
                self.started_wall = now;
                self.last_progress = now;
                self.last = Last::Prompt;
                self.tool = None;
                self.question_sent = false;
                self.percent = None;
                self.last_text.clear();
                let detail = self.project_or_label();
                out.push(self.event("started", detail, now));
            }
            Signal::ToolUse { ts, name } => {
                stamp(&ts, self);
                self.resume(ts, now);
                self.last = Last::ToolUse;
                self.tool = Some((name, now));
            }
            Signal::ToolResult { ts } => {
                stamp(&ts, self);
                self.resume(ts, now);
                self.last = Last::ToolResult;
                self.tool = None;
            }
            Signal::Text { ts, text } => {
                stamp(&ts, self);
                self.resume(ts, now);
                self.last = Last::Text;
                if !text.is_empty() {
                    self.last_text = text;
                }
            }
            Signal::Done { ts, text } => {
                stamp(&ts, self);
                self.complete(now, Some(text), out);
            }
            Signal::Error { ts, text } => {
                stamp(&ts, self);
                if self.phase != Phase::Idle {
                    out.push(self.event("failed", text, now));
                    self.phase = Phase::Idle;
                    self.last = Last::None;
                    self.tool = None;
                }
            }
            Signal::Aborted => {
                // The user stopped it themselves; that is not news.
                self.phase = Phase::Idle;
                self.last = Last::None;
                self.tool = None;
            }
            Signal::Question { ts, text } => {
                stamp(&ts, self);
                self.resume(ts, now);
                self.phase = Phase::Waiting;
                self.question_sent = true;
                out.push(self.event("question", text, now));
            }
            Signal::Plan { done, total } => {
                self.resume(None, now);
                let percent = if total == 0 { 0 } else { ((done * 100) / total).min(100) as u8 };
                if self.percent != Some(percent) {
                    self.percent = Some(percent);
                    self.last_progress = now;
                    let detail = format!("{done} of {total} steps done");
                    let mut event = self.event("progress", detail, now);
                    event.percent = Some(f64::from(percent));
                    out.push(event);
                }
            }
        }
    }

    /// Time based inference: approval waits, quiet completion, periodic progress.
    fn tick(&mut self, now: u64, quiet_ms: u64, out: &mut Vec<AgentEvent>) {
        match self.phase {
            Phase::Idle => {}
            Phase::Waiting => {
                if now.saturating_sub(self.last_seen) > WAITING_FORGET_MS {
                    self.phase = Phase::Idle;
                }
            }
            Phase::Working => {
                if let Some((name, since)) = self.tool.clone() {
                    if let Some(limit) = question_after_ms(&name) {
                        if !self.question_sent && now.saturating_sub(since) >= limit {
                            self.question_sent = true;
                            self.phase = Phase::Waiting;
                            out.push(self.event("question", format!("Waiting for approval: {name}"), now));
                            return;
                        }
                    }
                } else if self.last == Last::Text && now.saturating_sub(self.last_seen) >= quiet_ms {
                    self.complete(now, None, out);
                    return;
                }
                if now.saturating_sub(self.last_progress) >= PROGRESS_EVERY_MS {
                    self.last_progress = now;
                    let detail = match &self.tool {
                        Some((name, _)) => format!("Using {name}"),
                        None => "Working".to_string(),
                    };
                    let mut event = self.event("progress", detail, now);
                    event.percent = self.percent.map(f64::from);
                    out.push(event);
                }
            }
        }
    }
}

/* ---------------------------------------------------------------- trackers */

struct Tracker {
    parser: Parser,
    path: PathBuf,
    offset: u64,
    modified: u64,
    pending: Vec<u8>,
    discarding: bool,
    msgs_seen: usize,
    state: SessionState,
}

impl Tracker {
    fn new(provider: &str, parser: Parser, path: &Path, offset: u64, discarding: bool, modified: u64) -> Self {
        let id = crate::usage::session_id(path);
        let mut tracker = Self {
            parser,
            path: path.to_path_buf(),
            offset,
            modified,
            pending: Vec::new(),
            discarding,
            msgs_seen: 0,
            state: SessionState::new(provider, &id, None),
        };
        if parser == Parser::Gemini || parser == Parser::OpenCode {
            tracker.state.project = None;
        }
        tracker
    }

    fn feed_line(&mut self, line: &str, now: u64, out: &mut Vec<AgentEvent>) {
        let signals = match self.parser {
            Parser::Claude => classify_claude(line),
            Parser::Codex => classify_codex(line),
            Parser::Copilot => classify_copilot(line),
            _ => Vec::new(),
        };
        if self.state.project.is_none() && (self.parser == Parser::Claude || self.parser == Parser::Codex) {
            if let Some(cwd) = cwd_of(line) {
                self.state.project = Some(cwd);
            }
        }
        for signal in signals {
            self.state.apply(signal, now, out);
        }
    }

    fn read_appended(&mut self, len: u64, now: u64, out: &mut Vec<AgentEvent>) {
        let Ok(mut file) = File::open(&self.path) else {
            return;
        };
        if file.seek(SeekFrom::Start(self.offset)).is_err() {
            return;
        }
        let mut buffer = Vec::new();
        let want = (len.saturating_sub(self.offset)).min(MAX_READ_PER_TICK as u64);
        if file.take(want).read_to_end(&mut buffer).is_err() {
            return;
        }
        self.offset += buffer.len() as u64;
        let mut data = buffer.as_slice();
        if self.discarding {
            match data.iter().position(|b| *b == b'\n') {
                Some(pos) => {
                    self.discarding = false;
                    data = &data[pos + 1..];
                }
                None => return,
            }
        }
        self.pending.extend_from_slice(data);
        while let Some(pos) = self.pending.iter().position(|b| *b == b'\n') {
            let raw: Vec<u8> = self.pending.drain(..=pos).collect();
            let text = String::from_utf8_lossy(&raw);
            let line = text.trim_end_matches(['\n', '\r']);
            if !line.is_empty() {
                self.feed_line(line, now, out);
            }
        }
        if self.pending.len() > MAX_LINE {
            self.pending.clear();
            self.discarding = true;
        }
    }

    fn read_gemini(&mut self, now: u64, out: &mut Vec<AgentEvent>) {
        let Ok(meta) = std::fs::metadata(&self.path) else {
            return;
        };
        if meta.len() > MAX_GEMINI_BYTES {
            return;
        }
        let Ok(bytes) = std::fs::read(&self.path) else {
            return;
        };
        let Ok(root) = serde_json::from_slice::<Value>(&bytes) else {
            return;
        };
        let Some(messages) = root.get("messages").and_then(Value::as_array) else {
            return;
        };
        for message in messages.iter().skip(self.msgs_seen) {
            let ts = message
                .get("timestamp")
                .and_then(Value::as_str)
                .and_then(crate::usage::parse_rfc3339_millis);
            let text = message.get("content").and_then(content_text).unwrap_or_default();
            match message.get("type").and_then(Value::as_str) {
                Some("user") => self.state.apply(
                    Signal::Prompt { ts, text: Some(snippet(&text, 90)).filter(|t| !t.is_empty()) },
                    now,
                    out,
                ),
                Some("gemini") => {
                    let waiting = message
                        .get("toolCalls")
                        .and_then(Value::as_array)
                        .is_some_and(|calls| {
                            calls.iter().any(|call| {
                                call.get("status").and_then(Value::as_str) == Some("awaiting_approval")
                            })
                        });
                    self.state.apply(Signal::Text { ts, text: snippet(&text, 140) }, now, out);
                    if waiting {
                        self.state.apply(
                            Signal::Question { ts, text: "Approval needed".into() },
                            now,
                            out,
                        );
                    }
                }
                Some("error") => self.state.apply(Signal::Error { ts, text: snippet(&text, 120) }, now, out),
                _ => {}
            }
        }
        self.msgs_seen = messages.len();
    }

    fn touch_opencode(&mut self, now: u64, out: &mut Vec<AgentEvent>) {
        if self.state.phase == Phase::Idle {
            if let Some(bytes) = std::fs::read(&self.path).ok().filter(|b| b.len() < 256 * 1024) {
                if let Ok(root) = serde_json::from_slice::<Value>(&bytes) {
                    let title = root.get("title").and_then(Value::as_str).and_then(clean_title);
                    self.state.project = root
                        .get("directory")
                        .and_then(Value::as_str)
                        .and_then(|d| d.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next().map(str::to_string));
                    self.state.apply(Signal::Prompt { ts: Some(now), text: title }, now, out);
                }
            }
        }
        self.state.apply(Signal::Text { ts: Some(now), text: String::new() }, now, out);
    }

    fn poll(&mut self, now: u64, out: &mut Vec<AgentEvent>) {
        let Ok(meta) = std::fs::metadata(&self.path) else {
            return;
        };
        let len = meta.len();
        let modified = modified_ms(&meta);
        let quiet = match self.parser {
            Parser::OpenCode => TOUCH_COMPLETE_MS,
            _ => QUIET_COMPLETE_MS,
        };
        match self.parser {
            Parser::Gemini => {
                if modified != self.modified {
                    self.modified = modified;
                    self.read_gemini(now, out);
                }
            }
            Parser::OpenCode => {
                if modified != self.modified {
                    self.modified = modified;
                    self.touch_opencode(now, out);
                }
            }
            _ => {
                self.modified = modified;
                if len > self.offset {
                    self.read_appended(len, now, out);
                } else if len < self.offset {
                    self.offset = len;
                    self.pending.clear();
                }
            }
        }
        self.state.tick(now, quiet, out);
    }
}

fn cwd_of(line: &str) -> Option<String> {
    for key in ["\"cwd\":\""] {
        let start = line.find(key)? + key.len();
        let rest = line.get(start..)?;
        let end = rest.find('"')?;
        let raw = rest.get(..end)?.replace("\\\\", "/");
        let name = raw.trim_end_matches('/').rsplit('/').next()?.to_string();
        if !name.is_empty() {
            return Some(name.chars().take(48).collect());
        }
    }
    None
}

struct Watcher {
    trackers: Vec<Tracker>,
    known: HashMap<PathBuf, u64>,
    last_walk: u64,
    started: bool,
}

impl Watcher {
    fn new() -> Self {
        Self {
            trackers: Vec::new(),
            known: HashMap::new(),
            last_walk: 0,
            started: false,
        }
    }

    fn reset(&mut self) {
        self.trackers.clear();
        self.known.clear();
        self.started = false;
        self.last_walk = 0;
    }

    fn discover(&mut self, now: u64, cfg: &Cfg, dirs: &Dirs) {
        for spec in providers::SPECS {
            let watchable = matches!(
                spec.parser,
                Parser::Claude | Parser::Codex | Parser::Copilot | Parser::Gemini | Parser::OpenCode
            );
            if !watchable || !cfg.allows(spec.id) {
                continue;
            }
            for root in providers::session_roots(spec, dirs) {
                for entry in collect_files(&root, spec.depth, &spec.accept) {
                    if is_sidecar(&entry.path) {
                        continue;
                    }
                    let hot = now.saturating_sub(entry.modified) <= TRACK_WINDOW_MS;
                    let previous = self.known.insert(entry.path.clone(), entry.len);
                    if !hot || self.trackers.iter().any(|t| t.path == entry.path) {
                        continue;
                    }
                    if self.trackers.len() >= MAX_TRACKERS {
                        break;
                    }
                    let json_kind = matches!(spec.parser, Parser::Gemini | Parser::OpenCode);
                    let mut offset = if !self.started {
                        entry.len
                    } else {
                        match previous {
                            Some(p) if p <= entry.len => p,
                            _ => 0,
                        }
                    };
                    let mut discarding = false;
                    if !json_kind && entry.len.saturating_sub(offset) > MAX_CATCHUP {
                        offset = entry.len - 256 * 1024;
                        discarding = true;
                    }
                    let mut tracker = Tracker::new(spec.id, spec.parser, &entry.path, offset, discarding, entry.modified);
                    if json_kind && !self.started {
                        // Existing history is the baseline. Mark it as already seen.
                        tracker.baseline_json();
                    }
                    self.trackers.push(tracker);
                }
            }
        }
        if self.known.len() > 60_000 {
            self.known.clear();
        }
        self.started = true;
        self.last_walk = now;
    }

    fn tick(&mut self, now: u64, cfg: &Cfg, dirs: &Dirs, out: &mut Vec<AgentEvent>) {
        if !self.started || now.saturating_sub(self.last_walk) >= WALK_EVERY_MS {
            self.discover(now, cfg, dirs);
        }
        for tracker in &mut self.trackers {
            tracker.poll(now, out);
        }
        self.trackers.retain(|t| {
            t.state.phase != Phase::Idle || now.saturating_sub(t.modified) <= TRACK_WINDOW_MS
        });
    }
}

impl Tracker {
    fn baseline_json(&mut self) {
        if self.parser == Parser::Gemini {
            if let Ok(bytes) = std::fs::read(&self.path) {
                if let Ok(root) = serde_json::from_slice::<Value>(&bytes) {
                    self.msgs_seen = root
                        .get("messages")
                        .and_then(Value::as_array)
                        .map_or(0, Vec::len);
                }
            }
        }
    }
}

/* ------------------------------------------------------------------ service */

/// Start the background service once. Safe to call repeatedly.
pub fn start(app: AppHandle) {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || run(app));
}

fn shutting_down(app: &AppHandle) -> bool {
    app.state::<AppState>().shutdown.load(Ordering::Relaxed)
}

fn run(app: AppHandle) {
    let mut watcher = Watcher::new();
    let mut server: Option<ServerHandle> = None;
    let dirs = Dirs::current();
    loop {
        if shutting_down(&app) {
            break;
        }
        let cfg = read_cfg(&app);
        if cfg.enabled {
            if server.is_none() {
                server = start_server(&app);
            }
            let mut events = Vec::new();
            watcher.tick(now_millis(), &cfg, &dirs, &mut events);
            for event in events {
                deliver(&app, event);
            }
        } else {
            if let Some(mut handle) = server.take() {
                if let Some(tx) = handle.shutdown.take() {
                    let _ = tx.send(());
                }
                *lock(&ENDPOINT) = None;
            }
            watcher.reset();
        }
        let slices = if cfg.enabled { 2 } else { 5 };
        for _ in 0..slices {
            if shutting_down(&app) {
                break;
            }
            std::thread::sleep(Duration::from_secs(1));
        }
    }
    if let Some(mut handle) = server.take() {
        if let Some(tx) = handle.shutdown.take() {
            let _ = tx.send(());
        }
    }
    *lock(&ENDPOINT) = None;
}

/* --------------------------------------------------------------- HTTP hooks */

fn endpoint_file(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    Some(dir.join("agent-events.json"))
}

fn new_token() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

fn start_server(app: &AppHandle) -> Option<ServerHandle> {
    let file = endpoint_file(app);
    let previous: Option<Value> = file
        .as_ref()
        .and_then(|path| std::fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok());
    let preferred = previous
        .as_ref()
        .and_then(|v| v.get("port"))
        .and_then(Value::as_u64)
        .and_then(|p| u16::try_from(p).ok())
        .filter(|p| *p >= 1024);
    let token = previous
        .as_ref()
        .and_then(|v| v.get("token"))
        .and_then(Value::as_str)
        .filter(|t| t.len() >= 32)
        .map(str::to_string)
        .unwrap_or_else(new_token);
    let listener = preferred
        .and_then(|port| std::net::TcpListener::bind(("127.0.0.1", port)).ok())
        .or_else(|| std::net::TcpListener::bind(("127.0.0.1", 0)).ok())?;
    listener.set_nonblocking(true).ok()?;
    let port = listener.local_addr().ok()?.port();
    if let Some(path) = &file {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(path, json!({ "port": port, "token": token }).to_string());
    }
    *lock(&ENDPOINT) = Some(Endpoint { port, token: token.clone() });

    let ctx = Arc::new(ServerCtx { app: app.clone(), token, port });
    let router = router(ctx);
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    tauri::async_runtime::spawn(async move {
        let Ok(listener) = tokio::net::TcpListener::from_std(listener) else {
            return;
        };
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await;
    });
    Some(ServerHandle { shutdown: Some(tx) })
}

struct ServerCtx {
    app: AppHandle,
    token: String,
    port: u16,
}

fn router(ctx: Arc<ServerCtx>) -> Router {
    Router::new()
        .route("/agent-event", post(post_event))
        .route("/health", get(health))
        .layer(DefaultBodyLimit::max(64 * 1024))
        .with_state(ctx)
}

type Reply = (StatusCode, [(header::HeaderName, &'static str); 1], &'static str);

fn reply(status: StatusCode, body: &'static str) -> Reply {
    (status, [(header::CONTENT_TYPE, "application/json")], body)
}

fn same_secret(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn authorized(ctx: &ServerCtx, headers: &HeaderMap) -> bool {
    let host_ok = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|host| host == format!("127.0.0.1:{}", ctx.port) || host == format!("localhost:{}", ctx.port));
    let token_ok = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .is_some_and(|given| same_secret(given, &ctx.token));
    host_ok && token_ok
}

async fn health(AxumState(ctx): AxumState<Arc<ServerCtx>>, headers: HeaderMap) -> Reply {
    if !authorized(&ctx, &headers) {
        return reply(StatusCode::UNAUTHORIZED, "{\"error\":\"unauthorized\"}");
    }
    reply(StatusCode::OK, "{\"ok\":true}")
}

async fn post_event(
    AxumState(ctx): AxumState<Arc<ServerCtx>>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    body: Bytes,
) -> Reply {
    if !authorized(&ctx, &headers) {
        return reply(StatusCode::UNAUTHORIZED, "{\"error\":\"unauthorized\"}");
    }
    let value: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let provider = query.get("provider").map(String::as_str).unwrap_or_default();
    let hook = query.get("hook").map(String::as_str).unwrap_or_default();
    match event_from_hook(provider, hook, &value, now_millis()) {
        Some(event) => {
            lock(hook_map()).insert(event.provider.clone(), Instant::now());
            deliver(&ctx.app, event);
            reply(StatusCode::OK, "{}")
        }
        None => reply(StatusCode::OK, "{}"),
    }
}

fn str_at<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// Turn a hook payload into an event. Pure apart from the start-time bookkeeping.
fn event_from_hook(provider: &str, hook: &str, body: &Value, now: u64) -> Option<AgentEvent> {
    let provider: String = provider
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(32)
        .collect();
    if provider.is_empty() {
        return None;
    }
    // Already in our own shape.
    if let Some(kind) = body.get("kind").and_then(Value::as_str) {
        if valid_kind(kind) {
            return Some(AgentEvent {
                kind: kind.into(),
                provider,
                title: snippet(str_at(body, "title"), 90),
                detail: snippet(str_at(body, "detail"), 140),
                percent: body.get("percent").and_then(Value::as_f64).filter(|p| p.is_finite()).map(|p| p.clamp(0.0, 100.0)),
                duration_ms: body.get("durationMs").and_then(Value::as_u64),
                ts: now,
                session_id: body.get("sessionId").and_then(Value::as_str).map(|s| snippet(s, 64)),
                source: "hook".into(),
            });
        }
    }
    let name = if hook.is_empty() { str_at(body, "hook_event_name") } else { hook };
    let name = if name.is_empty() { str_at(body, "type") } else { name };
    let lower = name.to_ascii_lowercase();
    let session = ["session_id", "conversation_id", "thread-id", "turn-id"]
        .iter()
        .map(|key| str_at(body, key))
        .find(|s| !s.is_empty())
        .unwrap_or("default")
        .to_string();
    let cwd = body.get("cwd").and_then(Value::as_str).and_then(|c| {
        c.replace('\\', "/").trim_end_matches('/').rsplit('/').next().map(str::to_string)
    });
    let key = format!("{provider}:{session}");
    let tasks = HOOK_TASKS.get_or_init(|| Mutex::new(HashMap::new()));
    let project = cwd.as_deref().map(humanize_slug).unwrap_or_else(|| label_of(&provider));
    let make = |kind: &str, title: String, detail: String, duration: Option<u64>| AgentEvent {
        kind: kind.into(),
        provider: provider.clone(),
        title,
        detail,
        percent: None,
        duration_ms: duration,
        ts: now,
        session_id: Some(session.clone()),
        source: "hook".into(),
    };
    match lower.as_str() {
        "userpromptsubmit" | "beforeagent" | "beforesubmitprompt" => {
            let prompt = snippet(str_at(body, "prompt"), 90);
            let title = if prompt.is_empty() { project.clone() } else { prompt };
            let mut map = lock(tasks);
            if map.len() > 200 {
                map.clear();
            }
            map.insert(key, (now, title.clone()));
            Some(make("started", title, project, None))
        }
        "notification" | "permissionrequest" => {
            let title = lock(tasks).get(&key).map(|t| t.1.clone()).unwrap_or(project);
            let message = snippet(str_at(body, "message"), 140);
            let detail = if message.is_empty() { "Needs your input".to_string() } else { message };
            Some(make("question", title, detail, None))
        }
        "stop" | "afteragent" | "agent-turn-complete" | "subagentstop_never" => {
            let status = str_at(body, "status");
            let started = lock(tasks).remove(&key);
            let title = (provider == "codex").then(|| codex_thread_name(&session)).flatten()
                .or_else(|| started.as_ref().map(|t| t.1.clone()))
                .or_else(|| {
                    body.get("input-messages")
                        .and_then(Value::as_array)
                        .and_then(|m| m.first())
                        .and_then(Value::as_str)
                        .map(|s| snippet(s, 90))
                })
                .unwrap_or_else(|| project.clone());
            let duration = started.map(|t| now.saturating_sub(t.0));
            let last = snippet(str_at(body, "last-assistant-message"), 140);
            let detail = if last.is_empty() { project } else { last };
            match status {
                "error" => Some(make("failed", title, detail, duration)),
                "aborted" => None,
                _ => Some(make("completed", title, detail, duration)),
            }
        }
        "posttooluse" | "pretooluse" => {
            let tool = snippet(str_at(body, "tool_name"), 40);
            let title = lock(tasks).get(&key).map(|t| t.1.clone()).unwrap_or(project);
            Some(make("progress", title, if tool.is_empty() { "Working".into() } else { format!("Using {tool}") }, None))
        }
        _ => None,
    }
}

/* ---------------------------------------------------------------- commands */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointInfo {
    pub enabled: bool,
    pub running: bool,
    pub port: Option<u16>,
}

#[tauri::command]
pub fn agent_events_info(app: AppHandle) -> EndpointInfo {
    let cfg = read_cfg(&app);
    let endpoint = lock(&ENDPOINT).clone();
    EndpointInfo {
        enabled: cfg.enabled,
        running: endpoint.is_some(),
        port: endpoint.map(|e| e.port),
    }
}

#[tauri::command]
pub fn agent_events_recent() -> Vec<AgentEvent> {
    lock(&RECENT).iter().cloned().collect()
}

/* ------------------------------------------------------------ hook installer */

#[derive(Clone, Copy, PartialEq)]
enum Shape {
    /// `hooks: { Event: [ { hooks: [ { type, command } ] } ] }`
    Nested,
    /// `hooks: { event: [ { command } ] }` plus `version`
    Flat,
    /// `notify = [ ... ]` in config.toml
    CodexToml,
}

struct HookTarget {
    id: &'static str,
    label: &'static str,
    shape: Shape,
    /// Path of the config file relative to the home folder.
    file: &'static str,
    events: &'static [&'static str],
}

const TARGETS: &[HookTarget] = &[
    HookTarget {
        id: "claude-code",
        label: "Claude Code",
        shape: Shape::Nested,
        file: ".claude/settings.json",
        events: &["UserPromptSubmit", "Notification", "Stop"],
    },
    HookTarget {
        id: "codex",
        label: "Codex",
        shape: Shape::CodexToml,
        file: ".codex/config.toml",
        events: &["agent-turn-complete"],
    },
    HookTarget {
        id: "gemini",
        label: "Gemini CLI",
        shape: Shape::Nested,
        file: ".gemini/settings.json",
        events: &["BeforeAgent", "AfterAgent", "Notification"],
    },
    HookTarget {
        id: "cursor",
        label: "Cursor",
        shape: Shape::Flat,
        file: ".cursor/hooks.json",
        events: &["beforeSubmitPrompt", "stop"],
    },
];

fn target_for(id: &str) -> Result<&'static HookTarget, String> {
    TARGETS
        .iter()
        .find(|t| t.id == id)
        .ok_or_else(|| "Hooks are not available for this tool.".to_string())
}

fn hook_url(endpoint: &Endpoint, provider: &str, event: &str) -> String {
    format!(
        "http://127.0.0.1:{}/agent-event?{MARK}&provider={provider}&hook={event}",
        endpoint.port
    )
}

fn hook_command(endpoint: &Endpoint, provider: &str, event: &str, quiet_shell: bool) -> String {
    let base = format!(
        "curl.exe -s -m 2 -X POST -H \"Authorization: Bearer {}\" -H \"Content-Type: application/json\" --data-binary @- \"{}\"",
        endpoint.token,
        hook_url(endpoint, provider, event)
    );
    if quiet_shell {
        format!("{base} >/dev/null 2>&1 || true")
    } else {
        base
    }
}

fn is_ours(command: &str) -> bool {
    command.contains(MARK)
}

fn remove_ours_nested(arr: &mut Vec<Value>) {
    arr.retain(|entry| {
        let inner = entry.get("hooks").and_then(Value::as_array);
        !inner.is_some_and(|hooks| {
            hooks
                .iter()
                .any(|h| h.get("command").and_then(Value::as_str).is_some_and(is_ours))
        })
    });
}

fn remove_ours_flat(arr: &mut Vec<Value>) {
    arr.retain(|entry| !entry.get("command").and_then(Value::as_str).is_some_and(is_ours));
}

/// Apply or remove our hook entries in a parsed JSON config.
fn edit_json(root: &mut Value, target: &HookTarget, endpoint: Option<&Endpoint>) -> Result<(), String> {
    if !root.is_object() {
        return Err("The settings file is not a JSON object. Not changed.".into());
    }
    let obj = root.as_object_mut().ok_or("Unexpected settings format.")?;
    if endpoint.is_some() || obj.contains_key("hooks") {
        let hooks = obj.entry("hooks").or_insert_with(|| json!({}));
        let hooks = hooks
            .as_object_mut()
            .ok_or("The hooks entry is not an object. Not changed.")?;
        for event in target.events {
            let list = hooks.entry(event.to_string()).or_insert_with(|| json!([]));
            let list = list
                .as_array_mut()
                .ok_or("A hooks entry is not a list. Not changed.")?;
            match target.shape {
                Shape::Flat => remove_ours_flat(list),
                _ => remove_ours_nested(list),
            }
            if let Some(endpoint) = endpoint {
                let quiet = target.shape == Shape::Nested;
                let command = hook_command(endpoint, target.id, event, quiet);
                if target.shape == Shape::Flat {
                    list.push(json!({ "command": command }));
                } else {
                    list.push(json!({ "hooks": [ { "type": "command", "command": command } ] }));
                }
            }
        }
        let empty_events: Vec<String> = hooks
            .iter()
            .filter(|(_, v)| v.as_array().is_some_and(Vec::is_empty))
            .map(|(k, _)| k.clone())
            .collect();
        for key in empty_events {
            hooks.remove(&key);
        }
        if hooks.is_empty() {
            obj.remove("hooks");
        }
    }
    if target.shape == Shape::Flat && endpoint.is_some() && !obj.contains_key("version") {
        obj.insert("version".into(), json!(1));
    }
    Ok(())
}

fn toml_line_is_table(line: &str) -> bool {
    line.trim_start().starts_with('[')
}

fn toml_notify_line(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed.starts_with("notify") && trimmed["notify".len()..].trim_start().starts_with('=')
}

fn codex_notify_value(endpoint: &Endpoint) -> String {
    let url = hook_url(endpoint, "codex", "agent-turn-complete");
    let args = [
        "curl.exe".to_string(),
        "-s".into(),
        "-m".into(),
        "2".into(),
        "-X".into(),
        "POST".into(),
        "-H".into(),
        format!("Authorization: Bearer {}", endpoint.token),
        "-H".into(),
        "Content-Type: application/json".into(),
        url,
        "--data-binary".into(),
    ];
    let quoted: Vec<String> = args
        .iter()
        .map(|a| format!("\"{}\"", a.replace('\\', "\\\\").replace('"', "\\\"")))
        .collect();
    format!("notify = [{}]", quoted.join(", "))
}

/// Edit Codex's config.toml as text so the user's comments and layout survive.
fn edit_toml(text: &str, endpoint: Option<&Endpoint>) -> Result<String, String> {
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    let first_table = lines.iter().position(|l| toml_line_is_table(l)).unwrap_or(lines.len());
    let existing = lines[..first_table].iter().position(|l| toml_notify_line(l));
    let comment = "# hover-island: agent events (removed from Hover Island settings)";
    if let Some(index) = existing {
        if !is_ours(&lines[index]) {
            return Err("Codex already has a notify command. Hover Island will not replace it.".into());
        }
        lines.remove(index);
        let mut at = index;
        if index > 0 && lines[index - 1].trim() == comment {
            lines.remove(index - 1);
            at = index - 1;
        }
        // Drop the spacer line this installer added after its block.
        if at < lines.len() && lines[at].trim().is_empty() && at > 0 && lines[at - 1].trim().is_empty() {
            lines.remove(at);
        }
    }
    if let Some(endpoint) = endpoint {
        let first_table = lines.iter().position(|l| toml_line_is_table(l)).unwrap_or(lines.len());
        let block = vec![comment.to_string(), codex_notify_value(endpoint)];
        let at = first_table;
        for (offset, line) in block.into_iter().enumerate() {
            lines.insert(at + offset, line);
        }
        if at + 2 < lines.len() && !lines[at + 2].trim().is_empty() {
            lines.insert(at + 2, String::new());
        }
    }
    let mut out = lines.join("\n");
    if !out.ends_with('\n') {
        out.push('\n');
    }
    Ok(out)
}

/// Line diff with two lines of context, prefixed `+`, `-` or a space.
fn line_diff(old: &str, new: &str) -> Result<String, String> {
    let a: Vec<&str> = old.lines().collect();
    let b: Vec<&str> = new.lines().collect();
    if a.len() > 2000 || b.len() > 2000 {
        return Err("The config file is too large to preview.".into());
    }
    let (n, m) = (a.len(), b.len());
    let mut table = vec![vec![0u16; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            table[i][j] = if a[i] == b[j] {
                table[i + 1][j + 1] + 1
            } else {
                table[i + 1][j].max(table[i][j + 1])
            };
        }
    }
    let mut ops: Vec<(char, &str)> = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < n && j < m {
        if a[i] == b[j] {
            ops.push((' ', a[i]));
            i += 1;
            j += 1;
        } else if table[i + 1][j] >= table[i][j + 1] {
            ops.push(('-', a[i]));
            i += 1;
        } else {
            ops.push(('+', b[j]));
            j += 1;
        }
    }
    while i < n {
        ops.push(('-', a[i]));
        i += 1;
    }
    while j < m {
        ops.push(('+', b[j]));
        j += 1;
    }
    let keep: Vec<bool> = (0..ops.len())
        .map(|index| {
            let lo = index.saturating_sub(2);
            let hi = (index + 2).min(ops.len().saturating_sub(1));
            ops[lo..=hi].iter().any(|(sign, _)| *sign != ' ')
        })
        .collect();
    let mut out = String::new();
    let mut skipped = false;
    for (index, (sign, text)) in ops.iter().enumerate() {
        if keep[index] {
            out.push(*sign);
            out.push(' ');
            out.push_str(text);
            out.push('\n');
            skipped = false;
        } else if !skipped {
            out.push_str("...\n");
            skipped = true;
        }
    }
    Ok(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookPreview {
    pub provider: String,
    pub label: String,
    pub path: String,
    pub exists: bool,
    /// Our hooks were present before this change.
    pub installed: bool,
    pub changed: bool,
    pub applied: bool,
    pub diff: String,
    pub backup_path: Option<String>,
    pub events: Vec<String>,
    pub note: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookStatus {
    pub provider: String,
    pub label: String,
    pub path: String,
    pub available: bool,
    pub installed: bool,
    /// Installed, but pointing at an older port or token.
    pub stale: bool,
}

fn config_path(target: &HookTarget) -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not find your home folder.")?;
    Ok(target.file.split('/').fold(home, |path, part| path.join(part)))
}

fn hash_text(text: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut hasher);
    hasher.finish()
}

/// Returns (old text, new text) for installing or removing hooks.
fn plan_change(target: &HookTarget, path: &Path, install: bool) -> Result<(String, String), String> {
    let endpoint = lock(&ENDPOINT).clone();
    if install && endpoint.is_none() {
        return Err("Turn on AI toasts first so Hover Island can listen for hook events.".into());
    }
    let old = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(_) => return Err("Could not read the config file.".into()),
    };
    let endpoint_ref = if install { endpoint.as_ref() } else { None };
    let new = if target.shape == Shape::CodexToml {
        edit_toml(&old, endpoint_ref)?
    } else {
        let mut root: Value = if old.trim().is_empty() {
            json!({})
        } else {
            serde_json::from_str(&old).map_err(|_| "The settings file is not valid JSON. Not changed.".to_string())?
        };
        edit_json(&mut root, target, endpoint_ref)?;
        let mut text = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
        text.push('\n');
        text
    };
    Ok((old, new))
}

fn backup_path_for(path: &Path, now: u64) -> PathBuf {
    let mut name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".hover-island.bak");
    let first = path.with_file_name(&name);
    if !first.exists() {
        return first;
    }
    let mut other = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    other.push(format!(".hover-island-{now}.bak"));
    path.with_file_name(other)
}

fn change_hooks(provider: &str, install: bool, dry_run: bool) -> Result<HookPreview, String> {
    let target = target_for(provider)?;
    let path = config_path(target)?;
    let parent_ok = path.parent().is_some_and(Path::is_dir);
    if !parent_ok {
        return Err(format!("{} does not look installed (no config folder).", target.label));
    }
    let (old, new) = plan_change(target, &path, install)?;
    let changed = old != new;
    let digest = hash_text(&new);
    let key = format!("{}:{}", if install { "install" } else { "remove" }, target.id);
    let now = now_millis();
    let previews = PREVIEWS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut preview = HookPreview {
        provider: target.id.into(),
        label: target.label.into(),
        path: path.to_string_lossy().into_owned(),
        exists: path.exists(),
        installed: old.contains(MARK),
        changed,
        applied: false,
        diff: line_diff(&old, &new)?,
        backup_path: None,
        events: target.events.iter().map(|e| e.to_string()).collect(),
        note: if target.shape == Shape::Nested || target.shape == Shape::Flat {
            Some("Uses curl.exe, which ships with Windows 10 and later. Keys in the file may be re-ordered.".into())
        } else {
            Some("Codex only reports finished turns.".into())
        },
    };
    if dry_run {
        lock(previews).insert(key, (now, digest));
        return Ok(preview);
    }
    // Writing requires a recent preview of exactly this result.
    let seen = lock(previews).get(&key).copied();
    match seen {
        Some((at, hash)) if hash == digest && now.saturating_sub(at) <= PREVIEW_VALID_MS => {}
        _ => return Err("Review the change first, then confirm it. The file may have changed since the preview.".into()),
    }
    if !changed {
        lock(previews).remove(&key);
        return Ok(preview);
    }
    if path.exists() {
        let backup = backup_path_for(&path, now);
        std::fs::copy(&path, &backup).map_err(|_| "Could not back up the original file. Nothing was changed.".to_string())?;
        preview.backup_path = Some(backup.to_string_lossy().into_owned());
    }
    let mut temp_name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    temp_name.push(".hover-island.tmp");
    let temp = path.with_file_name(temp_name);
    std::fs::write(&temp, new.as_bytes()).map_err(|_| "Could not write the config file.".to_string())?;
    if std::fs::rename(&temp, &path).is_err() {
        let _ = std::fs::remove_file(&temp);
        return Err("Could not replace the config file. The original is untouched.".into());
    }
    lock(previews).remove(&key);
    preview.applied = true;
    Ok(preview)
}

/// Preview (`dry_run = true`) or apply adding Hover Island's hooks to a tool's config.
#[tauri::command]
pub fn agent_hooks_install(provider: String, dry_run: bool) -> Result<HookPreview, String> {
    change_hooks(&provider, true, dry_run)
}

/// Preview or apply removing Hover Island's hooks. Other entries are left alone.
#[tauri::command]
pub fn agent_hooks_uninstall(provider: String, dry_run: bool) -> Result<HookPreview, String> {
    change_hooks(&provider, false, dry_run)
}

#[tauri::command]
pub fn agent_hooks_status() -> Vec<HookStatus> {
    let endpoint = lock(&ENDPOINT).clone();
    TARGETS
        .iter()
        .map(|target| {
            let path = config_path(target).unwrap_or_default();
            let available = path.parent().is_some_and(Path::is_dir);
            let text = std::fs::read_to_string(&path).unwrap_or_default();
            let installed = text.contains(MARK);
            let stale = installed
                && endpoint
                    .as_ref()
                    .is_some_and(|e| !text.contains(&e.token) || !text.contains(&format!("127.0.0.1:{}/", e.port)));
            HookStatus {
                provider: target.id.into(),
                label: target.label.into(),
                path: path.to_string_lossy().into_owned(),
                available,
                installed,
                stale,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(state: &mut SessionState, signals: Vec<Signal>, now: u64) -> Vec<AgentEvent> {
        let mut out = Vec::new();
        for signal in signals {
            state.apply(signal, now, &mut out);
        }
        out
    }

    #[test]
    fn claude_prompt_tool_and_completion_timeline() {
        let user = r#"{"type":"user","cwd":"C:\\code\\island","timestamp":"2026-10-19T10:00:00.000Z","message":{"role":"user","content":"Fix the toast"}}"#;
        let tool = r#"{"type":"assistant","timestamp":"2026-10-19T10:00:02.000Z","message":{"content":[{"type":"tool_use","name":"Edit","input":{}}]}}"#;
        let result = r#"{"type":"user","timestamp":"2026-10-19T10:00:03.000Z","message":{"content":[{"type":"tool_result","tool_use_id":"x"}]}}"#;
        let text = r#"{"type":"assistant","timestamp":"2026-10-19T10:01:10.000Z","message":{"content":[{"type":"text","text":"All done."}]}}"#;
        let mut state = SessionState::new("claude-code", "s1", Some("island".into()));
        let mut events = Vec::new();
        for (line, now) in [(user, 1_000u64), (tool, 3_000), (result, 4_000), (text, 70_000)] {
            for signal in classify_claude(line) {
                state.apply(signal, now, &mut events);
            }
        }
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "started");
        assert_eq!(events[0].title, "Fix the toast");
        state.tick(70_000 + QUIET_COMPLETE_MS, QUIET_COMPLETE_MS, &mut events);
        let done = events.last().unwrap();
        assert_eq!(done.kind, "completed");
        assert_eq!(done.duration_ms, Some(70_000));
        assert_eq!(done.detail, "All done.");
    }

    #[test]
    fn unanswered_edit_tool_becomes_a_question_once() {
        let mut state = SessionState::new("claude-code", "s", None);
        run(&mut state, vec![Signal::Prompt { ts: Some(1), text: Some("go".into()) }], 0);
        run(&mut state, vec![Signal::ToolUse { ts: Some(2), name: "Edit".into() }], 1_000);
        let mut out = Vec::new();
        state.tick(5_000, QUIET_COMPLETE_MS, &mut out);
        assert!(out.is_empty());
        state.tick(10_000, QUIET_COMPLETE_MS, &mut out);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].kind, "question");
        state.tick(20_000, QUIET_COMPLETE_MS, &mut out);
        assert_eq!(out.len(), 1, "no repeat");
        run(&mut state, vec![Signal::ToolResult { ts: Some(3) }], 21_000);
        assert_eq!(state.phase, Phase::Working);
    }

    #[test]
    fn read_tools_never_look_like_questions() {
        let mut state = SessionState::new("claude-code", "s", None);
        run(&mut state, vec![Signal::Prompt { ts: Some(1), text: None }], 0);
        run(&mut state, vec![Signal::ToolUse { ts: Some(2), name: "Read".into() }], 100);
        let mut out = Vec::new();
        state.tick(25_000, QUIET_COMPLETE_MS, &mut out);
        assert!(out.iter().all(|e| e.kind != "question"));
    }

    #[test]
    fn todo_list_gives_known_percent() {
        let line = r#"{"type":"assistant","timestamp":"2026-10-19T10:00:02.000Z","message":{"content":[{"type":"tool_use","name":"TodoWrite","input":{"todos":[{"status":"completed"},{"status":"in_progress"},{"status":"pending"},{"status":"pending"}]}}]}}"#;
        let signals = classify_claude(line);
        assert_eq!(signals, vec![Signal::Plan { done: 1, total: 4 }]);
        let mut state = SessionState::new("claude-code", "s", None);
        let events = run(&mut state, signals, 5);
        assert_eq!(events[0].kind, "progress");
        assert_eq!(events[0].percent, Some(25.0));
    }

    #[test]
    fn ask_user_question_is_immediate() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"AskUserQuestion","input":{"questions":[{"question":"Which file?"}]}}]}}"#;
        let mut state = SessionState::new("claude-code", "s", None);
        let events = run(&mut state, classify_claude(line), 5);
        assert_eq!(events.last().unwrap().kind, "question");
        assert_eq!(events.last().unwrap().detail, "Which file?");
    }

    #[test]
    fn api_errors_fail_and_interrupts_are_silent() {
        let mut state = SessionState::new("claude-code", "s", None);
        run(&mut state, vec![Signal::Prompt { ts: Some(1), text: None }], 0);
        let err = r#"{"type":"assistant","isApiErrorMessage":true,"message":{"content":[{"type":"text","text":"API Error: 529 overloaded"}]}}"#;
        let events = run(&mut state, classify_claude(err), 1);
        assert_eq!(events[0].kind, "failed");
        let mut other = SessionState::new("claude-code", "s", None);
        run(&mut other, vec![Signal::Prompt { ts: Some(1), text: None }], 0);
        let stop = r#"{"type":"user","message":{"content":[{"type":"text","text":"[Request interrupted by user]"}]}}"#;
        assert!(run(&mut other, classify_claude(stop), 1).is_empty());
        assert_eq!(other.phase, Phase::Idle);
    }

    #[test]
    fn codex_turn_lifecycle() {
        let user = r#"{"timestamp":"2026-10-19T10:00:00Z","type":"event_msg","payload":{"type":"user_message","message":"Refactor widgets"}}"#;
        let call = r#"{"timestamp":"2026-10-19T10:00:01Z","type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{}"}}"#;
        let out = r#"{"timestamp":"2026-10-19T10:00:02Z","type":"response_item","payload":{"type":"function_call_output","output":"x"}}"#;
        let done = r#"{"timestamp":"2026-10-19T10:00:40Z","type":"event_msg","payload":{"type":"task_complete","last_agent_message":"Refactored."}}"#;
        let mut state = SessionState::new("codex", "c1", Some("island".into()));
        let mut events = Vec::new();
        for (line, now) in [(user, 0u64), (call, 1_000), (out, 2_000), (done, 40_000)] {
            for signal in classify_codex(line) {
                state.apply(signal, now, &mut events);
            }
        }
        let kinds: Vec<&str> = events.iter().map(|e| e.kind.as_str()).collect();
        assert_eq!(kinds, vec!["started", "completed"]);
        assert_eq!(events[1].duration_ms, Some(40_000));
    }

    #[test]
    fn codex_plan_updates_report_percent() {
        let line = r#"{"type":"response_item","payload":{"type":"function_call","name":"update_plan","arguments":"{\"plan\":[{\"step\":\"a\",\"status\":\"completed\"},{\"step\":\"b\",\"status\":\"pending\"}]}"}}"#;
        assert_eq!(classify_codex(line), vec![Signal::Plan { done: 1, total: 2 }]);
    }

    #[test]
    fn hook_payloads_map_to_events_with_duration() {
        let start = json!({"session_id":"abc","cwd":"C:\\code\\island","prompt":"Build the thing","hook_event_name":"UserPromptSubmit"});
        let e = event_from_hook("claude-code", "UserPromptSubmit", &start, 1_000).unwrap();
        assert_eq!((e.kind.as_str(), e.title.as_str(), e.detail.as_str()), ("started", "Build the thing", "island"));
        let note = json!({"session_id":"abc","message":"Claude needs your permission to use Bash"});
        let q = event_from_hook("claude-code", "Notification", &note, 2_000).unwrap();
        assert_eq!(q.kind, "question");
        assert_eq!(q.title, "Build the thing");
        let stop = json!({"session_id":"abc"});
        let d = event_from_hook("claude-code", "Stop", &stop, 61_000).unwrap();
        assert_eq!(d.kind, "completed");
        assert_eq!(d.duration_ms, Some(60_000));
        let codex = json!({"type":"agent-turn-complete","turn-id":"t","input-messages":["Do it"],"last-assistant-message":"Done."});
        let c = event_from_hook("codex", "agent-turn-complete", &codex, 5).unwrap();
        assert_eq!((c.kind.as_str(), c.title.as_str(), c.detail.as_str()), ("completed", "Do it", "Done."));
        let own = json!({"kind":"progress","title":"x","detail":"y","percent":150});
        assert_eq!(event_from_hook("opencode", "event", &own, 1).unwrap().percent, Some(100.0));
        assert!(event_from_hook("", "Stop", &stop, 1).is_none());
        assert!(event_from_hook("claude-code", "SessionEnd", &stop, 1).is_none());
    }

    fn endpoint() -> Endpoint {
        Endpoint { port: 43210, token: "t".repeat(40) }
    }

    #[test]
    fn json_install_preserves_other_hooks_and_remove_restores() {
        let target = target_for("claude-code").unwrap();
        let mut root: Value = serde_json::from_str(
            r#"{"model":"x","hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo mine"}]}]}}"#,
        )
        .unwrap();
        let original = root.clone();
        edit_json(&mut root, target, Some(&endpoint())).unwrap();
        let stop = root["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2);
        assert!(root["hooks"]["Notification"][0]["hooks"][0]["command"].as_str().unwrap().contains(MARK));
        // Re-installing replaces ours instead of stacking.
        edit_json(&mut root, target, Some(&endpoint())).unwrap();
        assert_eq!(root["hooks"]["Stop"].as_array().unwrap().len(), 2);
        edit_json(&mut root, target, None).unwrap();
        assert_eq!(root, original);
    }

    #[test]
    fn json_install_into_empty_file_and_remove_leaves_no_hooks() {
        let target = target_for("cursor").unwrap();
        let mut root = json!({});
        edit_json(&mut root, target, Some(&endpoint())).unwrap();
        assert_eq!(root["version"], 1);
        assert!(root["hooks"]["stop"][0]["command"].as_str().unwrap().contains("curl.exe"));
        edit_json(&mut root, target, None).unwrap();
        assert!(root.get("hooks").is_none());
    }

    #[test]
    fn toml_notify_is_added_before_tables_and_removed_cleanly() {
        let original = "model = \"gpt-5\"\n\n[projects.x]\ntrust = true\n";
        let added = edit_toml(original, Some(&endpoint())).unwrap();
        let notify_at = added.find("notify =").unwrap();
        assert!(notify_at < added.find("[projects.x]").unwrap());
        assert!(added.contains(MARK));
        let removed = edit_toml(&added, None).unwrap();
        assert_eq!(removed.trim_end(), original.trim_end());
        let theirs = "notify = [\"notify-send\"]\n";
        assert!(edit_toml(theirs, Some(&endpoint())).is_err());
    }

    #[test]
    fn diff_shows_only_changes_with_context() {
        let diff = line_diff("a\nb\nc\nd\ne\nf\ng\nh\n", "a\nb\nc\nd\nX\nf\ng\nh\n").unwrap();
        assert!(diff.contains("- e\n"));
        assert!(diff.contains("+ X\n"));
        assert!(diff.contains("...\n") || diff.lines().count() < 12);
    }

    #[test]
    fn apply_requires_a_matching_preview_and_makes_a_backup() {
        let home = std::env::temp_dir().join(format!("hover-island-hooks-{}-{}", std::process::id(), now_millis()));
        let claude = home.join(".claude");
        std::fs::create_dir_all(&claude).unwrap();
        let file = claude.join("settings.json");
        std::fs::write(&file, "{\"model\":\"x\"}\n").unwrap();
        *lock(&ENDPOINT) = Some(endpoint());
        let target = target_for("claude-code").unwrap();
        // Same pipeline as change_hooks, against a temp file.
        let (old, new) = plan_change(target, &file, true).unwrap();
        assert!(old != new);
        let backup = backup_path_for(&file, 1);
        std::fs::copy(&file, &backup).unwrap();
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), old);
        assert!(backup.to_string_lossy().ends_with(".hover-island.bak"));
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn chat_folder_slugs_read_like_titles() {
        assert_eq!(humanize_slug("can-you-take-a-look-at"), "Can you take a look at");
        assert_eq!(humanize_slug("island"), "island");
        assert_eq!(humanize_slug("hover-island"), "hover-island");
        assert_eq!(humanize_slug("My-Project-Name"), "My-Project-Name");
    }

    #[test]
    fn secrets_compare_in_full() {
        assert!(same_secret("abc", "abc"));
        assert!(!same_secret("abc", "abd"));
        assert!(!same_secret("abc", "abcd"));
    }
}
