//! Read-only reset announcements sourced from codex-reset.com's public feed.
//!
//! This module reports community/maintainer announcements; it does not read,
//! predict, or mutate account usage. Only announced feed events with a
//! verifiable X status URL are exposed.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

const FEED_URL: &str = "https://codex-reset.com/api/feed";
const MAX_FEED_BYTES: usize = 512 * 1024;
const MAX_EVENTS: usize = 64;
const REFRESH_INTERVAL: Duration = Duration::from_secs(15 * 60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(12);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ResetKind {
    Global,
    Banked,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResetWatchEvent {
    pub id: String,
    pub kind: ResetKind,
    pub title: String,
    pub published_at: i64,
    pub source_url: String,
    pub reported_by: String,
    /// An explicit future announcement, never evidence of an account refill.
    pub upcoming: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetWatchSnapshot {
    pub events: Vec<ResetWatchEvent>,
    /// Time this app last checked the endpoint, in Unix milliseconds.
    pub last_checked_at: i64,
    /// Machine-readable upstream feed URL.
    pub source: String,
    /// Upstream `fetched_at`, in Unix milliseconds. This is distinct from the
    /// local check time so a successful HTTP response cannot mask stale data.
    pub source_updated_at: Option<i64>,
    pub stale: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Feed {
    #[serde(default)]
    stale: bool,
    fetched_at: Option<String>,
    #[serde(default)]
    events: Vec<FeedEvent>,
}

#[derive(Debug, Deserialize)]
struct FeedEvent {
    id: serde_json::Value,
    group: Option<String>,
    scope: Option<String>,
    reset_kind: Option<String>,
    announcement_state: Option<String>,
    #[serde(default)]
    reason_tags: Vec<String>,
    summary: Option<String>,
    url: Option<String>,
    announced_at: Option<String>,
    source_label: Option<String>,
}

struct Cache {
    snapshot: Option<ResetWatchSnapshot>,
    checked_at: Option<Duration>,
}

fn cache() -> &'static Mutex<Cache> {
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    CACHE.get_or_init(|| {
        Mutex::new(Cache {
            snapshot: None,
            checked_at: None,
        })
    })
}

fn client() -> &'static Result<reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .user_agent(
                "HoverIsland/0.1.0 (reset announcement reader; source: https://codex-reset.com/)",
            )
            .build()
            .map_err(|e| format!("Could not initialize reset feed client: {e}"))
    })
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

fn monotonic_now() -> Duration {
    static START: OnceLock<std::time::Instant> = OnceLock::new();
    START.get_or_init(std::time::Instant::now).elapsed()
}

/// Return the cached snapshot and refresh at most once every 15 minutes.
#[tauri::command]
pub async fn reset_watch_get(force: Option<bool>) -> ResetWatchSnapshot {
    let mut cache = cache().lock().await;
    if let (Some(snapshot), Some(last)) = (&cache.snapshot, cache.checked_at) {
        let minimum = if force.unwrap_or(false) {
            Duration::from_secs(15)
        } else {
            REFRESH_INTERVAL
        };
        if monotonic_now().saturating_sub(last) < minimum {
            return snapshot.clone();
        }
    }

    let checked_at = monotonic_now();
    let result = fetch_snapshot().await;
    cache.checked_at = Some(checked_at);
    match result {
        Ok(mut fresh) => {
            fresh.last_checked_at = now_ms();
            cache.snapshot = Some(fresh.clone());
            fresh
        }
        Err(error) => {
            if let Some(previous) = cache.snapshot.as_mut() {
                previous.last_checked_at = now_ms();
                previous.stale = true;
                previous.error = Some(error);
                previous.clone()
            } else {
                let snapshot = ResetWatchSnapshot {
                    events: Vec::new(),
                    last_checked_at: now_ms(),
                    source: FEED_URL.to_string(),
                    source_updated_at: None,
                    stale: true,
                    error: Some(error),
                };
                cache.snapshot = Some(snapshot.clone());
                snapshot
            }
        }
    }
}

async fn fetch_snapshot() -> Result<ResetWatchSnapshot, String> {
    let client = client().as_ref().map_err(Clone::clone)?;
    let mut response = client
        .get(FEED_URL)
        .send()
        .await
        .map_err(|_| "Could not reach the reset announcement feed.".to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "Reset announcement feed returned HTTP {}.",
            response.status().as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_FEED_BYTES as u64)
    {
        return Err("Reset announcement feed exceeded the size limit.".to_string());
    }

    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Could not read the reset announcement feed.".to_string())?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_FEED_BYTES {
            return Err("Reset announcement feed exceeded the size limit.".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    let feed: Feed = serde_json::from_slice(&bytes)
        .map_err(|_| "Reset announcement feed had an invalid response.".to_string())?;
    let source_updated_at = feed.fetched_at.as_deref().and_then(parse_rfc3339_millis);
    let now = now_ms();
    let source_too_old = source_updated_at
        .map(|updated| now.saturating_sub(updated) > REFRESH_INTERVAL.as_millis() as i64)
        .unwrap_or(true);
    let events = normalize_events(feed.events);

    Ok(ResetWatchSnapshot {
        events,
        last_checked_at: now,
        source: FEED_URL.to_string(),
        source_updated_at,
        stale: feed.stale || source_too_old,
        error: None,
    })
}

fn normalize_events(records: Vec<FeedEvent>) -> Vec<ResetWatchEvent> {
    let mut seen = HashSet::new();
    let mut events = records
        .into_iter()
        .filter_map(|record| {
            let upcoming = record.summary.as_deref().is_some_and(explicit_future_reset);
            let kind = match record.group.as_deref()? {
                "reset"
                    if record.scope.as_deref() == Some("global")
                        && (record.announcement_state.as_deref() == Some("announced")
                            || upcoming) =>
                {
                    ResetKind::Global
                }
                "credits"
                    if record.reset_kind.as_deref() == Some("banked")
                        || record.reason_tags.iter().any(|tag| tag == "banked") =>
                {
                    // Cohort-specific banked grants are still useful
                    // announcements, and the feed represents them with
                    // linked X archives rather than announcement_state.
                    ResetKind::Banked
                }
                _ => return None,
            };
            let id = match &record.id {
                serde_json::Value::String(value) => value.clone(),
                serde_json::Value::Number(value) => value.to_string(),
                _ => return None,
            };
            if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            let source_url = record.url?;
            if !valid_status_url(&source_url, &id) {
                return None;
            }
            let title = record.summary?.trim().to_string();
            if title.is_empty() || title.len() > 500 {
                return None;
            }
            let published_at = parse_rfc3339_millis(record.announced_at.as_deref()?)?;
            if !seen.insert(id.clone()) {
                return None;
            }
            let reported_by = record
                .source_label
                .filter(|label| !label.trim().is_empty())
                .unwrap_or_else(|| "codex-reset.com community feed".to_string());
            Some(ResetWatchEvent {
                id,
                kind,
                title,
                published_at,
                source_url,
                reported_by,
                upcoming,
            })
        })
        .collect::<Vec<_>>();
    events.sort_by(|a, b| b.published_at.cmp(&a.published_at));
    events.truncate(MAX_EVENTS);
    events
}

fn explicit_future_reset(summary: &str) -> bool {
    let text = summary.trim().to_ascii_lowercase();
    // The upstream live lane can lag behind its archive classifier. Preserve
    // explicit Tibo announcements while rejecting vague "Day N / Reset" posts.
    [
        "global reset landing",
        "global reset by ",
        "global reset tomorrow",
        "global reset tonight",
    ]
    .iter()
    .any(|prefix| text.starts_with(prefix))
}

fn valid_status_url(url: &str, id: &str) -> bool {
    [
        "https://x.com/thsottiaux/status/",
        "https://twitter.com/thsottiaux/status/",
    ]
    .iter()
    .any(|prefix| {
        url.strip_prefix(prefix)
            .is_some_and(|tail| tail.split(['?', '#']).next() == Some(id))
    })
}

/// Parse an RFC3339 UTC timestamp without pulling a date library into the app.
/// Supports `Z` and numeric offsets, with optional fractional seconds.
fn parse_rfc3339_millis(value: &str) -> Option<i64> {
    let (date, time) = value.split_once('T').or_else(|| value.split_once('t'))?;
    let mut d = date.split('-');
    let year: i64 = d.next()?.parse().ok()?;
    let month: u32 = d.next()?.parse().ok()?;
    let day: u32 = d.next()?.parse().ok()?;
    if d.next().is_some() || !(1..=12).contains(&month) || day == 0 || day > month_days(year, month)
    {
        return None;
    }

    let zone_pos = time.find(['Z', 'z', '+', '-']).unwrap_or(time.len());
    let clock = &time[..zone_pos];
    let zone = &time[zone_pos..];
    let (hms, fraction) = clock
        .split_once('.')
        .or_else(|| clock.split_once(','))
        .map(|(a, b)| (a, Some(b)))
        .unwrap_or((clock, None));
    let mut t = hms.split(':');
    let hour: i64 = t.next()?.parse().ok()?;
    let minute: i64 = t.next()?.parse().ok()?;
    let second: i64 = t.next()?.parse().ok()?;
    if t.next().is_some() || hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let millis = match fraction {
        None => 0,
        Some(f) => {
            if f.is_empty() || !f.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            let first_three = &f[..f.len().min(3)];
            let parsed: i64 = first_three.parse().ok()?;
            parsed * 10_i64.pow((3usize.saturating_sub(first_three.len())) as u32)
        }
    };
    let offset_seconds = if zone.eq_ignore_ascii_case("z") {
        0
    } else {
        let sign = if zone.starts_with('+') {
            1i64
        } else if zone.starts_with('-') {
            -1
        } else {
            return None;
        };
        let z = &zone[1..];
        let (oh, om) = if let Some((h, m)) = z.split_once(':') {
            (h.parse::<i64>().ok()?, m.parse::<i64>().ok()?)
        } else if z.len() == 4 {
            (z[..2].parse::<i64>().ok()?, z[2..].parse::<i64>().ok()?)
        } else {
            return None;
        };
        if oh > 23 || om > 59 {
            return None;
        }
        sign * (oh * 3600 + om * 60)
    };
    let days = days_from_civil(year, month, day);
    Some(((days * 86_400 + hour * 3600 + minute * 60 + second - offset_seconds) * 1000) + millis)
}

fn month_days(year: i64, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap(year) => 29,
        2 => 28,
        _ => 0,
    }
}

fn is_leap(year: i64) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

// Howard Hinnant's civil-calendar conversion; epoch is 1970-01-01.
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = year - i64::from(month <= 2);
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = month as i64 + if month > 2 { -3 } else { 9 };
    let doy = (153 * mp + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(id: &str, group: &str, reset_kind: Option<&str>, state: &str) -> FeedEvent {
        FeedEvent {
            id: serde_json::Value::String(id.to_string()),
            group: Some(group.to_string()),
            scope: Some("global".to_string()),
            reset_kind: reset_kind.map(str::to_string),
            announcement_state: Some(state.to_string()),
            summary: Some(format!("Announcement {id}")),
            url: Some(format!("https://x.com/thsottiaux/status/{id}")),
            announced_at: Some("2026-10-13T12:34:56.789Z".to_string()),
            source_label: Some("Tibo Reset Tracker".to_string()),
            reason_tags: if group == "credits" {
                vec!["banked".to_string()]
            } else {
                Vec::new()
            },
        }
    }

    #[test]
    fn only_announced_global_and_linked_banked_posts_are_returned() {
        let mut no_post = record("123", "reset", None, "announced");
        no_post.url = None;
        let mut mismatch = record("124", "reset", None, "announced");
        mismatch.url = Some("https://x.com/thsottiaux/status/999".to_string());
        let mut personal = record("125", "reset", None, "announced");
        personal.scope = Some("personal".to_string());
        let mut cohort_banked = record("126", "credits", Some("banked"), "");
        cohort_banked.scope = Some("paid".to_string());
        cohort_banked.announcement_state = None;
        let mut no_banked_source = record("127", "credits", Some("banked"), "");
        no_banked_source.url = None;
        let events = normalize_events(vec![
            record("120", "reset", None, "announced"),
            record("121", "credits", Some("banked"), "announced"),
            record("122", "reset", None, "candidate"),
            record("123", "reset", None, "announced"),
            mismatch,
            personal,
            cohort_banked,
            no_banked_source,
            record("120", "reset", None, "announced"),
        ]);
        // ID 123 first appears in a URL-less monitoring row, then as a valid
        // source-linked announcement. The malformed row must not poison the
        // later valid record during deduplication.
        assert_eq!(events.len(), 4);
        assert_eq!(events[0].kind, ResetKind::Global);
        assert_eq!(events[1].kind, ResetKind::Banked);
        assert_ne!(events[1].kind, events[0].kind);
        assert!(events
            .iter()
            .any(|event| event.id == "126" && event.kind == ResetKind::Banked));
        assert!(events
            .iter()
            .any(|event| event.id == "123" && event.kind == ResetKind::Global));
    }

    #[test]
    fn maps_real_feed_shapes_for_global_and_banked_records() {
        // Representative rows from /api/feed: global announcements set
        // announcement_state; verified banked X archives carry reset_kind
        // and reason_tags instead.
        let rows: Vec<FeedEvent> = serde_json::from_str(
            r#"[
              {
                "id":"2109812360596865224","group":"reset","scope":"global",
                "reset_kind":"hard","announcement_state":"announced","reason_tags":[],
                "summary":"Global reset announcement","url":"https://x.com/thsottiaux/status/2109812360596865224",
                "announced_at":"2026-10-13T05:03:51Z","source_label":"Verified archive"
              },
              {
                "id":"2107913674593644711","group":"credits","scope":"global",
                "reset_kind":"banked","banked_state":"unknown","reason_tags":["milestone","banked"],
                "summary":"One banked reset loaded into paid accounts","url":"https://x.com/thsottiaux/status/2107913674593644711",
                "announced_at":"2026-10-07T19:19:17Z","source_label":"Verified archive"
              }
            ]"#,
        )
        .unwrap();
        let events = normalize_events(rows);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].kind, ResetKind::Global);
        assert_eq!(events[1].kind, ResetKind::Banked);
        assert_eq!(events[1].id, "2107913674593644711");
    }

    #[test]
    fn validates_timestamp_fraction_offsets_and_dates() {
        let utc = parse_rfc3339_millis("2026-10-13T12:34:56.789Z").unwrap();
        assert_eq!(utc % 1000, 789);
        assert_eq!(
            parse_rfc3339_millis("2026-10-13T14:34:56.789+02:00"),
            Some(utc)
        );
        assert_eq!(parse_rfc3339_millis("2026-02-29T00:00:00Z"), None);
        assert_eq!(parse_rfc3339_millis("bad"), None);
        assert_eq!(parse_rfc3339_millis("2026-10-13T12:34:56"), None);
    }

    #[test]
    fn explicit_upcoming_announcements_survive_delayed_feed_classification() {
        let mut upcoming = record("130", "reset", None, "none");
        upcoming.summary = Some("Global reset landing by EOD PST time. Enjoy".into());
        let events = normalize_events(vec![upcoming, record("131", "reset", None, "none")]);
        assert_eq!(events.len(), 1);
        assert!(events[0].upcoming);
        assert!(!explicit_future_reset("No global reset tomorrow"));
        assert!(!explicit_future_reset("Day 8 / Reset"));
    }

    #[test]
    fn validates_only_exact_thsottiaux_status_links() {
        assert!(valid_status_url(
            "https://x.com/thsottiaux/status/123?ref=feed",
            "123"
        ));
        assert!(valid_status_url(
            "https://twitter.com/thsottiaux/status/123",
            "123"
        ));
        assert!(!valid_status_url("https://x.com/other/status/123", "123"));
        assert!(!valid_status_url(
            "https://x.com/thsottiaux/status/1234",
            "123"
        ));
        assert!(!valid_status_url(
            "http://x.com/thsottiaux/status/123",
            "123"
        ));
    }
}
