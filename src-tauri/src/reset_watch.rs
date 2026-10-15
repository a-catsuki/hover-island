//! Read-only global and banked reset announcements from codex-resets.com.
//!
//! The upstream site's public Markdown document is the primary, machine-readable
//! archive. This module never reads or predicts account-specific quota.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

const FEED_URL: &str = "https://codex-resets.com/index.md";
const SOURCE_URL: &str = "https://codex-resets.com/";
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
#[serde(rename_all = "snake_case")]
pub enum ResetStatus {
    Landed,
    Announced,
    Expected,
    AwaitingConfirmation,
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
    pub status: ResetStatus,
    /// Estimated landing time from explicit announcement wording, in Unix ms.
    pub landing_at: Option<i64>,
    /// Compatibility convenience for consumers that only need a broad state.
    pub upcoming: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetWatchSnapshot {
    pub events: Vec<ResetWatchEvent>,
    pub last_checked_at: i64,
    pub source: String,
    pub source_updated_at: Option<i64>,
    pub stale: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
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
                "HoverIsland/0.1.0 (reset announcements; source: https://codex-resets.com/)",
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
                    source: SOURCE_URL.into(),
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
        .map_err(|_| "Could not reach the Codex Resets announcement page.".to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "Codex Resets returned HTTP {}.",
            response.status().as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_FEED_BYTES as u64)
    {
        return Err("Codex Resets response exceeded the size limit.".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Could not read the Codex Resets announcement page.".to_string())?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_FEED_BYTES {
            return Err("Codex Resets response exceeded the size limit.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let markdown = std::str::from_utf8(&bytes)
        .map_err(|_| "Codex Resets response was not valid UTF-8.".to_string())?;
    let events = parse_markdown(markdown, now_ms());
    if events.is_empty() {
        return Err("Codex Resets did not provide any valid linked announcements.".into());
    }
    let source_updated_at = events.first().map(|event| event.published_at);
    Ok(ResetWatchSnapshot {
        events,
        last_checked_at: now_ms(),
        source: SOURCE_URL.into(),
        source_updated_at,
        stale: false,
        error: None,
    })
}

fn parse_markdown(markdown: &str, now: i64) -> Vec<ResetWatchEvent> {
    let lines = markdown.lines().collect::<Vec<_>>();
    let mut records = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        let Some((published_at, kind)) = parse_heading(lines[index]) else {
            index += 1;
            continue;
        };
        index += 1;
        let mut title_lines = Vec::new();
        let mut url = None;
        while index < lines.len() && !lines[index].starts_with("### ") {
            let line = lines[index].trim();
            if let Some(quote) = line.strip_prefix("> ") {
                if !quote.is_empty() {
                    title_lines.push(quote.trim());
                }
            } else if let Some(link) = line.strip_prefix("[View announcement](") {
                url = link.strip_suffix(')').map(str::to_string);
            }
            index += 1;
        }
        let title = title_lines
            .join(" ")
            .trim()
            .chars()
            .take(500)
            .collect::<String>();
        let Some(source_url) = url else {
            continue;
        };
        let Some(id) = status_id(&source_url) else {
            continue;
        };
        if title.is_empty() {
            continue;
        }
        records.push((id, kind, title, published_at, source_url));
    }

    // Prefer the first (newest, full) entry if a post is repeated by the archive.
    let mut seen = HashSet::new();
    let mut events = records
        .into_iter()
        .filter_map(|(id, kind, title, published_at, source_url)| {
            if !seen.insert(id.clone()) {
                return None;
            }
            let (status, landing_at) = event_status(&title, published_at, now);
            let upcoming = matches!(status, ResetStatus::Announced | ResetStatus::Expected);
            Some(ResetWatchEvent {
                id,
                kind,
                title,
                published_at,
                source_url,
                reported_by: "Tibo · Codex Resets".into(),
                status,
                landing_at,
                upcoming,
            })
        })
        .collect::<Vec<_>>();
    events.sort_by(|a, b| b.published_at.cmp(&a.published_at));
    events.truncate(MAX_EVENTS);
    events
}

fn parse_heading(line: &str) -> Option<(i64, ResetKind)> {
    let value = line.strip_prefix("### `")?;
    let (timestamp, kind) = value.split_once("` · ")?;
    let kind = match kind.trim_end_matches('*') {
        "Regular reset" => ResetKind::Global,
        "Banked reset" => ResetKind::Banked,
        _ => return None,
    };
    Some((parse_rfc3339_millis(timestamp)?, kind))
}

fn status_id(url: &str) -> Option<String> {
    let tail = url
        .strip_prefix("https://x.com/thsottiaux/status/")
        .or_else(|| url.strip_prefix("https://twitter.com/thsottiaux/status/"))?;
    let id = tail.split(['?', '#', ')']).next()?;
    if id.is_empty() || !id.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some(id.to_string())
}

fn explicit_future_reset(summary: &str) -> bool {
    let text = summary.to_ascii_lowercase();
    [
        "landing in ",
        "lands in ",
        "will land",
        "should land",
        "landing over ",
        "reset incoming",
        "will reset",
        "resetting usage",
    ]
    .iter()
    .any(|phrase| text.contains(phrase))
}

fn event_status(summary: &str, published_at: i64, now: i64) -> (ResetStatus, Option<i64>) {
    if confirmed_landed(summary) {
        return (ResetStatus::Landed, None);
    }
    let landing_at = parse_relative_estimate(summary, published_at)
        .or_else(|| parse_anchored_estimate(summary, published_at));
    if !explicit_future_reset(summary) && landing_at.is_none() {
        return (ResetStatus::Landed, None);
    }
    match landing_at {
        Some(estimated) if estimated > now => (ResetStatus::Expected, Some(estimated)),
        Some(estimated) => (ResetStatus::AwaitingConfirmation, Some(estimated)),
        None => (ResetStatus::Announced, None),
    }
}

fn parse_relative_estimate(summary: &str, published_at: i64) -> Option<i64> {
    let words = summary.to_ascii_lowercase();
    let tokens = words
        .split_whitespace()
        .map(|token| token.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '.'))
        .collect::<Vec<_>>();
    for window in tokens.windows(3) {
        let (number, unit) = if window[0] == "in" || window[0] == "next" {
            (window[1], window[2])
        } else {
            continue;
        };
        let Some(amount) = number.parse::<f64>().ok() else {
            continue;
        };
        let multiplier = match unit.trim_end_matches('s') {
            "minute" | "min" => 60_000.0,
            "hour" | "hr" => 3_600_000.0,
            _ => continue,
        };
        let duration = (amount * multiplier).round();
        if !duration.is_finite() || duration <= 0.0 || duration > 7.0 * 24.0 * 60.0 * 60.0 * 1000.0
        {
            return None;
        }
        return published_at.checked_add(duration as i64);
    }
    None
}

fn parse_anchored_estimate(summary: &str, published_at: i64) -> Option<i64> {
    let tokens = summary
        .split_whitespace()
        .map(|token| {
            token.trim_matches(|c: char| {
                !c.is_ascii_alphanumeric() && c != ':' && c != '+' && c != '-' && c != '.'
            })
        })
        .collect::<Vec<_>>();
    for (index, token) in tokens.iter().enumerate() {
        if !token.eq_ignore_ascii_case("at") {
            continue;
        }
        let Some(time_token) = tokens.get(index + 1) else {
            continue;
        };
        let mut clock = time_token.to_string();
        let mut zone_index = index + 2;
        if tokens
            .get(zone_index)
            .is_some_and(|part| matches!(part.to_ascii_lowercase().as_str(), "am" | "pm"))
        {
            clock.push_str(tokens[zone_index]);
            zone_index += 1;
        }
        let Some(zone) = tokens.get(zone_index) else {
            continue;
        };
        let (date, _, _) = civil_date_from_epoch_ms(published_at);
        let Some((hour, minute)) = parse_clock(&clock) else {
            continue;
        };
        let Some(offset) = timezone_offset_seconds(zone, &date) else {
            continue;
        };
        let sign = if offset < 0 { '-' } else { '+' };
        let absolute_offset = offset.unsigned_abs();
        let zone = format!(
            "{sign}{:02}:{:02}",
            absolute_offset / 3600,
            absolute_offset % 3600 / 60
        );
        let time = format!("{date}T{hour:02}:{minute:02}:00{zone}");
        let Some(mut estimate) = parse_rfc3339_millis(&time) else {
            continue;
        };
        if estimate <= published_at {
            let Some(next_day) = estimate.checked_add(24 * 60 * 60 * 1000) else {
                continue;
            };
            estimate = next_day;
        }
        return Some(estimate);
    }
    None
}

fn parse_clock(value: &str) -> Option<(u32, u32)> {
    let lower = value.to_ascii_lowercase();
    let (clock, meridiem) = if let Some(value) = lower.strip_suffix("am") {
        (value, Some("am"))
    } else if let Some(value) = lower.strip_suffix("pm") {
        (value, Some("pm"))
    } else {
        (lower.as_str(), None)
    };
    let (hour, minute) = if let Some((hour, minute)) = clock.split_once(':') {
        (hour.parse::<u32>().ok()?, minute.parse::<u32>().ok()?)
    } else {
        (clock.parse::<u32>().ok()?, 0)
    };
    if minute > 59 {
        return None;
    }
    let hour = match meridiem {
        Some("am") if (1..=12).contains(&hour) => hour % 12,
        Some("pm") if (1..=12).contains(&hour) => hour % 12 + 12,
        Some(_) => return None,
        None if hour <= 23 => hour,
        None => return None,
    };
    Some((hour, minute))
}

fn timezone_offset_seconds(zone: &str, date: &str) -> Option<i64> {
    match zone.to_ascii_uppercase().as_str() {
        "UTC" | "GMT" | "Z" => Some(0),
        "PST" => Some(-8 * 3600),
        "PDT" => Some(-7 * 3600),
        "MST" => Some(-7 * 3600),
        "MDT" => Some(-6 * 3600),
        "CST" => Some(-6 * 3600),
        "CDT" => Some(-5 * 3600),
        "EST" => Some(-5 * 3600),
        "EDT" => Some(-4 * 3600),
        "PT" => Some(if us_daylight_time(date)? {
            -7 * 3600
        } else {
            -8 * 3600
        }),
        "MT" => Some(if us_daylight_time(date)? {
            -6 * 3600
        } else {
            -7 * 3600
        }),
        "CT" => Some(if us_daylight_time(date)? {
            -5 * 3600
        } else {
            -6 * 3600
        }),
        "ET" => Some(if us_daylight_time(date)? {
            -4 * 3600
        } else {
            -5 * 3600
        }),
        "IST" => Some(5 * 3600 + 1800),
        value if value.starts_with('+') || value.starts_with('-') => {
            let sign = if value.starts_with('+') { 1 } else { -1 };
            let rest = &value[1..];
            let (hour, minute) = rest.split_once(':')?;
            let hour = hour.parse::<i64>().ok()?;
            let minute = minute.parse::<i64>().ok()?;
            if hour > 23 || minute > 59 {
                return None;
            }
            Some(sign * (hour * 3600 + minute * 60))
        }
        _ => None,
    }
}

fn us_daylight_time(date: &str) -> Option<bool> {
    let mut parts = date.split('-');
    let year = parts.next()?.parse::<i64>().ok()?;
    let month = parts.next()?.parse::<u32>().ok()?;
    let day = parts.next()?.parse::<u32>().ok()?;
    if parts.next().is_some() {
        return None;
    }
    let march_start = 1 + (7 - weekday(days_from_civil(year, 3, 1)) as u32) % 7 + 7;
    let november_end = 1 + (7 - weekday(days_from_civil(year, 11, 1)) as u32) % 7;
    Some(
        (month > 3 && month < 11)
            || (month == 3 && day >= march_start)
            || (month == 11 && day < november_end),
    )
}

fn weekday(days_since_epoch: i64) -> i64 {
    (days_since_epoch + 4).rem_euclid(7)
}

fn civil_date_from_epoch_ms(value: i64) -> (String, u32, u32) {
    let days = value.div_euclid(86_400_000);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (
        format!("{year:04}-{month:02}-{day:02}"),
        month as u32,
        day as u32,
    )
}

fn confirmed_landed(summary: &str) -> bool {
    let text = summary.to_ascii_lowercase();
    [
        "done and dusted",
        "it's done",
        "it is done",
        "all propagated",
        "reset all propagated",
        "all reset for everyone",
        "have reset",
        "reset button pressed",
        "confirmed landed",
        "limits have been reset",
    ]
    .iter()
    .any(|phrase| text.contains(phrase))
}

/// Parse an RFC3339 UTC timestamp without pulling a date library into the app.
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
            let first = &f[..f.len().min(3)];
            first.parse::<i64>().ok()? * 10_i64.pow((3usize.saturating_sub(first.len())) as u32)
        }
    };
    let offset_seconds = if zone.eq_ignore_ascii_case("z") {
        0
    } else {
        let sign = if zone.starts_with('+') {
            1
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

    #[test]
    fn parses_landed_latest_event_and_utc_offset_as_one_canonical_x_event() {
        let markdown = "# Codex Resets\n\n### `2026-10-15T06:28:13.000Z` · Regular reset\n\n> Done and dusted\n\n[View announcement](https://x.com/thsottiaux/status/2110618732666257557)\n\n### `2026-10-15T11:58:13+05:30` · Regular reset\n\n> Done and dusted\n\n[View announcement](https://twitter.com/thsottiaux/status/2110618732666257557)\n";
        let events = parse_markdown(
            markdown,
            parse_rfc3339_millis("2026-10-15T07:00:00Z").unwrap(),
        );
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, "2110618732666257557");
        assert_eq!(events[0].title, "Done and dusted");
        assert_eq!(
            events[0].published_at,
            parse_rfc3339_millis("2026-10-15T06:28:13Z").unwrap()
        );
        assert_eq!(events[0].status, ResetStatus::Landed);
        assert_eq!(events[0].landing_at, None);
    }

    #[test]
    fn relative_estimate_is_expected_until_then_awaits_confirmation() {
        let published = parse_rfc3339_millis("2026-10-15T06:00:00Z").unwrap();
        let now = parse_rfc3339_millis("2026-10-15T08:00:00Z").unwrap();
        let future = "### `2026-10-15T06:00:00Z` · Regular reset\n\n> Global reset landing in 3 hours\n\n[View announcement](https://x.com/thsottiaux/status/123)\n";
        let event = &parse_markdown(future, now)[0];
        assert_eq!(event.status, ResetStatus::Expected);
        assert_eq!(event.landing_at, Some(published + 3 * 60 * 60 * 1000));
        assert!(event.upcoming);
        let past = parse_markdown(
            future,
            parse_rfc3339_millis("2026-10-15T10:00:00Z").unwrap(),
        );
        assert_eq!(past[0].status, ResetStatus::AwaitingConfirmation);
        assert_eq!(past[0].landing_at, Some(published + 3 * 60 * 60 * 1000));
        let landed = "### `2026-10-15T06:00:00Z` · Regular reset\n\n> Global reset landing in 3 hours. Done and dusted.\n\n[View announcement](https://x.com/thsottiaux/status/124)\n";
        assert_eq!(parse_markdown(landed, now)[0].status, ResetStatus::Landed);
    }

    #[test]
    fn anchored_timezone_time_is_normalized_to_utc() {
        let published = parse_rfc3339_millis("2026-10-15T06:00:00Z").unwrap();
        let text = "Global reset landing at 8:00 PM PT";
        let estimate = parse_anchored_estimate(text, published).unwrap();
        assert_eq!(
            estimate,
            parse_rfc3339_millis("2026-10-16T03:00:00Z").unwrap()
        );
    }

    #[test]
    fn parser_accepts_only_linked_global_or_banked_announcements() {
        let markdown = "### `2026-10-15T06:28:13Z` · Regular reset\n\n> Done and dusted\n\n[View announcement](https://x.com/thsottiaux/status/123)\n### `2026-10-15T06:29:13Z` · Banked reset\n\n> Grant added\n\n[View announcement](https://x.com/thsottiaux/status/124)\n### `2026-10-15T06:30:13Z` · Forecast\n\n> Reset soon\n\n[View announcement](https://x.com/thsottiaux/status/125)\n### `2026-10-15T06:31:13Z` · Regular reset\n\n> Missing link\n";
        let events = parse_markdown(markdown, now_ms());
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].kind, ResetKind::Banked);
        assert_eq!(events[1].kind, ResetKind::Global);
    }

    #[test]
    fn parses_rfc3339_fraction_offsets_and_invalid_dates() {
        let utc = parse_rfc3339_millis("2026-10-13T12:34:56.789Z").unwrap();
        assert_eq!(utc % 1000, 789);
        assert_eq!(
            parse_rfc3339_millis("2026-10-13T14:34:56.789+02:00"),
            Some(utc)
        );
        assert_eq!(parse_rfc3339_millis("2026-02-29T00:00:00Z"), None);
        assert_eq!(parse_rfc3339_millis("bad"), None);
    }

    #[tokio::test]
    #[ignore = "opt-in read-only live fetch of codex-resets.com/index.md"]
    async fn live_archive_fetch_reports_latest_announcement_metadata() {
        let snapshot = fetch_snapshot()
            .await
            .expect("the public Codex Resets archive is reachable and parseable");
        let latest = snapshot
            .events
            .first()
            .expect("archive has a linked announcement");
        let title = latest
            .title
            .chars()
            .filter(|character| !character.is_control())
            .take(96)
            .collect::<String>();

        assert!(!title.trim().is_empty(), "latest announcement has a title");
        assert!(
            latest.published_at > 0,
            "latest announcement has a UTC timestamp"
        );
        println!(
            "latest announcement: status={:?}, published_at_unix_ms={}, title={}",
            latest.status, latest.published_at, title
        );
    }
}
