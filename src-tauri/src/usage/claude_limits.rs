//! Claude plan limits (5-hour session and weekly) for Claude Code.
//!
//! Claude Code's own logs only hold token counts, which say nothing about how much of
//! a plan is left. Anthropic reports that on the same usage endpoint Claude Code's
//! `/usage` command reads, authorized with the sign-in Claude Code already stored in
//! `~/.claude/.credentials.json`. The token is read from disk for each request, is
//! only ever sent to api.anthropic.com, is never written anywhere and is never
//! refreshed here (Claude Code does that itself). Turn it off under Settings, AI.

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
/// A report older than this is dropped rather than shown as current.
const MAX_AGE_MS: u64 = 3 * 60 * 60 * 1000;

static CACHE: Mutex<Vec<RateLimit>> = Mutex::new(Vec::new());

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

fn token() -> Option<String> {
    let path = dirs::home_dir()?.join(".claude").join(".credentials.json");
    let text = std::fs::read_to_string(path).ok()?;
    let root: Value = serde_json::from_str(&text).ok()?;
    let oauth = root.get("claudeAiOauth")?;
    if let Some(expires) = oauth.get("expiresAt").and_then(Value::as_u64) {
        if expires <= now_millis() {
            return None;
        }
    }
    oauth.get("accessToken").and_then(Value::as_str).map(str::to_string)
}

/// `{"five_hour": {"utilization": 37.0, "resets_at": "..."}, "seven_day": {...}}`
pub(crate) fn parse(root: &Value, now: u64) -> Vec<RateLimit> {
    [("five_hour", "Claude · 5h", "5h"), ("seven_day", "Claude · Weekly", "168h")]
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
    Backoff,
}

async fn fetch(client: &reqwest::Client) -> Outcome {
    let Some(token) = token() else { return Outcome::Skip };
    let response = client
        .get(ENDPOINT)
        .bearer_auth(token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("accept", "application/json")
        .send()
        .await;
    let Ok(response) = response else { return Outcome::Skip };
    if response.status().as_u16() == 429 {
        return Outcome::Backoff;
    }
    if !response.status().is_success() {
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
            if on {
                match fetch(&client).await {
                    Outcome::Ok(limits) => *CACHE.lock().unwrap_or_else(|p| p.into_inner()) = limits,
                    Outcome::Backoff => wait = BACKOFF,
                    Outcome::Skip => {}
                }
            } else {
                CACHE.lock().unwrap_or_else(|p| p.into_inner()).clear();
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
}
