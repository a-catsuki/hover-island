//! Claude plan limits (5-hour session and weekly) for Claude Code.
//!
//! Claude Code's own logs only hold token counts, which say nothing about how much of
//! a plan is left. There are two sources, best first:
//!
//! 1. Claude Code itself, like Codex. It hands `rate_limits` to its status line command
//!    after every reply. With Hover Island's Claude Code hooks installed, that command
//!    posts the JSON to the local agent-event endpoint, which calls [`store_reported`].
//! 2. The usage endpoint Claude Code's `/usage` command reads, authorized with the
//!    sign-in Claude Code stored in `~/.claude/.credentials.json`. The token is read
//!    from disk for each request, is only ever sent to api.anthropic.com, is never
//!    written anywhere and is never refreshed here (Claude Code does that itself), so
//!    it stops working once the token expires until Claude Code is used again.
//!
//! Turn it off under Settings, AI.

use std::sync::Mutex;
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Manager};

use super::{parse_rfc3339_millis, RateLimit};
use crate::state::AppState;
use crate::types::now_millis;

const ENDPOINT: &str = "https://api.anthropic.com/api/oauth/usage";
const POLL: Duration = Duration::from_secs(300);
const BACKOFF: Duration = Duration::from_secs(900);
/// Without a usable token only a file is read, so look again soon: Claude Code
/// writes a fresh token as soon as it is opened.
const NO_TOKEN_POLL: Duration = Duration::from_secs(60);
/// A report older than this is dropped rather than shown as current.
const MAX_AGE_MS: u64 = 3 * 60 * 60 * 1000;
/// While Claude Code reports through its status line, the endpoint is not asked.
const REPORTED_FRESH_MS: u64 = 15 * 60 * 1000;

static CACHE: Mutex<Vec<RateLimit>> = Mutex::new(Vec::new());
static REPORTED_AT: Mutex<u64> = Mutex::new(0);
static PROBLEM: Mutex<Option<&'static str>> = Mutex::new(None);

/// The latest limits the poller fetched, empty when there are none.
pub(crate) fn cached() -> Vec<RateLimit> {
    let now = now_millis();
    CACHE
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .iter()
        .filter(|limit| now.saturating_sub(limit.updated_at) <= MAX_AGE_MS)
        .cloned()
        .collect()
}

/// Why no limits are showing, when that is known. Shown as the Claude Code row's detail.
pub(crate) fn problem() -> Option<&'static str> {
    if !cached().is_empty() {
        return None;
    }
    *PROBLEM.lock().unwrap_or_else(|p| p.into_inner())
}

fn set_problem(problem: Option<&'static str>) {
    *PROBLEM.lock().unwrap_or_else(|p| p.into_inner()) = problem;
}

fn store(limits: Vec<RateLimit>) {
    if !limits.is_empty() {
        set_problem(None);
        *CACHE.lock().unwrap_or_else(|p| p.into_inner()) = limits;
    }
}

/// Limits Claude Code reported through its status line (see the module docs).
pub(crate) fn store_reported(body: &Value) {
    let now = now_millis();
    let limits = parse_status_line(body, now);
    if !limits.is_empty() {
        *REPORTED_AT.lock().unwrap_or_else(|p| p.into_inner()) = now;
        store(limits);
    }
}

fn reported_recently() -> bool {
    let at = *REPORTED_AT.lock().unwrap_or_else(|p| p.into_inner());
    at > 0 && now_millis().saturating_sub(at) <= REPORTED_FRESH_MS
}

fn config_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(std::path::PathBuf::from)
        .filter(|dir| dir.is_dir())
        .or_else(|| dirs::home_dir().map(|home| home.join(".claude")))
}

enum Token {
    Ok(String),
    Missing,
    Expired,
}

fn token() -> Token {
    let Some(path) = config_dir().map(|dir| dir.join(".credentials.json")) else { return Token::Missing };
    let Some(root) = std::fs::read_to_string(path).ok().and_then(|text| serde_json::from_str::<Value>(&text).ok()) else {
        return Token::Missing;
    };
    let Some(oauth) = root.get("claudeAiOauth") else { return Token::Missing };
    if let Some(expires) = oauth.get("expiresAt").and_then(Value::as_u64) {
        if expires <= now_millis() {
            return Token::Expired;
        }
    }
    match oauth.get("accessToken").and_then(Value::as_str) {
        Some(token) if !token.is_empty() => Token::Ok(token.to_string()),
        _ => Token::Missing,
    }
}

/// Claude Code's status line input:
/// `{"rate_limits": {"five_hour": {"used_percentage": 37, "resets_at": 1791900000}, "seven_day": {...}}}`
pub(crate) fn parse_status_line(root: &Value, now: u64) -> Vec<RateLimit> {
    let Some(limits) = root.get("rate_limits") else { return Vec::new() };
    WINDOWS
        .into_iter()
        .filter_map(|(key, label, window)| {
            let item = limits.get(key)?;
            let used = item.get("used_percentage").or_else(|| item.get("utilization"))?.as_f64()?;
            if !used.is_finite() {
                return None;
            }
            Some(RateLimit {
                label: label.into(),
                percent: (used / 100.0).clamp(0.0, 1.0),
                window: Some(window.into()),
                reset_at: item.get("resets_at").and_then(reset_time),
                updated_at: now,
            })
        })
        .collect()
}

/// Unix seconds, unix milliseconds or an RFC 3339 string.
fn reset_time(value: &Value) -> Option<u64> {
    if let Some(text) = value.as_str() {
        return parse_rfc3339_millis(text);
    }
    let n = value.as_f64().filter(|n| n.is_finite() && *n > 0.0)? as u64;
    Some(if n < 100_000_000_000 { n * 1000 } else { n })
}

const WINDOWS: [(&str, &str, &str); 2] = [("five_hour", "Claude · 5h", "5h"), ("seven_day", "Claude · Weekly", "168h")];

/// `{"five_hour": {"utilization": 37.0, "resets_at": "..."}, "seven_day": {...}}`
pub(crate) fn parse(root: &Value, now: u64) -> Vec<RateLimit> {
    WINDOWS
        .into_iter()
        .filter_map(|(key, label, window)| {
            let item = root.get(key)?;
            let used = item.get("utilization")?.as_f64()?;
            if !used.is_finite() {
                return None;
            }
            Some(RateLimit {
                label: label.into(),
                percent: (used / 100.0).clamp(0.0, 1.0),
                window: Some(window.into()),
                reset_at: item.get("resets_at").and_then(Value::as_str).and_then(parse_rfc3339_millis),
                updated_at: now,
            })
        })
        .collect()
}

enum Outcome {
    Ok(Vec<RateLimit>),
    Skip,
    NoToken,
    Backoff,
}

async fn fetch(client: &reqwest::Client) -> Outcome {
    let token = match token() {
        Token::Ok(token) => token,
        Token::Missing => {
            set_problem(Some("Sign in to Claude Code with a Claude plan to see limits."));
            return Outcome::NoToken;
        }
        Token::Expired => {
            set_problem(Some("Claude Code sign-in expired. Open Claude Code once to refresh it."));
            return Outcome::NoToken;
        }
    };
    let response = client
        .get(ENDPOINT)
        .bearer_auth(token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("accept", "application/json")
        .send()
        .await;
    let Ok(response) = response else { return Outcome::Skip };
    let status = response.status().as_u16();
    if status == 429 {
        set_problem(Some("Claude is rate limiting usage checks. Trying again soon."));
        return Outcome::Backoff;
    }
    if status == 401 || status == 403 {
        set_problem(Some("Claude Code sign-in expired. Open Claude Code once to refresh it."));
        return Outcome::NoToken;
    }
    if !(200..300).contains(&status) {
        set_problem(Some("Claude usage is unavailable right now."));
        return Outcome::Skip;
    }
    match response.json::<Value>().await {
        Ok(root) => Outcome::Ok(parse(&root, now_millis())),
        Err(_) => Outcome::Skip,
    }
}

pub fn spawn_poller(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let Ok(client) = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .user_agent(concat!("hover-island/", env!("CARGO_PKG_VERSION")))
            .build()
        else {
            return;
        };
        tokio::time::sleep(Duration::from_secs(4)).await;
        loop {
            let settings = app.state::<AppState>().settings.lock().unwrap().clone();
            let on = settings.usage.claude_code && settings.usage.claude_live_limits && !settings.usage.hidden.iter().any(|id| id == "claude-code");
            let mut wait = POLL;
            if !on {
                CACHE.lock().unwrap_or_else(|p| p.into_inner()).clear();
                set_problem(None);
            } else if !reported_recently() {
                match fetch(&client).await {
                    Outcome::Ok(limits) => store(limits),
                    Outcome::Backoff => wait = BACKOFF,
                    Outcome::NoToken => wait = NO_TOKEN_POLL,
                    Outcome::Skip => {}
                }
            }
            tokio::time::sleep(wait).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_session_and_weekly_windows() {
        let root = json!({
            "five_hour": {"utilization": 37.5, "resets_at": "2026-10-21T08:00:00.000000+00:00"},
            "seven_day": {"utilization": 120.0, "resets_at": null},
            "seven_day_opus": null
        });
        let limits = parse(&root, 5);
        assert_eq!(limits.len(), 2);
        assert_eq!(limits[0].label, "Claude · 5h");
        assert!((limits[0].percent - 0.375).abs() < 1e-9);
        assert!(limits[0].reset_at.is_some());
        assert_eq!(limits[1].window.as_deref(), Some("168h"));
        assert_eq!(limits[1].percent, 1.0);
        assert_eq!(limits[1].reset_at, None);
    }

    #[test]
    fn reads_limits_claude_code_hands_its_status_line() {
        let root = json!({
            "session_id": "abc",
            "rate_limits": {
                "five_hour": {"used_percentage": 42, "resets_at": 1791900000},
                "seven_day": {"used_percentage": 7.5, "resets_at": 1792400000000u64}
            }
        });
        let limits = parse_status_line(&root, 9);
        assert_eq!(limits.len(), 2);
        assert!((limits[0].percent - 0.42).abs() < 1e-9);
        assert_eq!(limits[0].reset_at, Some(1_791_900_000_000));
        assert_eq!(limits[1].reset_at, Some(1_792_400_000_000));
        assert_eq!(limits[1].window.as_deref(), Some("168h"));
        assert!(parse_status_line(&json!({"model": {}}), 9).is_empty());
    }
}
