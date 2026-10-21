//! Optional timed-lyrics lookup for the media widget.
//!
//! Requests go to LRCLIB's documented signature endpoint. Results (including
//! misses) are cached only in memory, with both a small entry limit and TTL.

use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

const MAX_BODY_BYTES: usize = 256 * 1024;
const MAX_LYRICS_CHARS: usize = 24_000;
const MAX_LINES: usize = 500;
const CACHE_LIMIT: usize = 64;
const FOUND_TTL: Duration = Duration::from_secs(12 * 60 * 60);
const MISS_TTL: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LyricsLine {
    /// Playback time in seconds.
    pub at: f64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LyricsResult {
    /// `ok`, `not_found`, `no_timed_lyrics`, `invalid_track`, `rate_limited`, or `unavailable`.
    pub status: String,
    pub provider: &'static str,
    pub lines: Vec<LyricsLine>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_seconds: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LrclibRecord {
    track_name: Option<String>,
    artist_name: Option<String>,
    duration: Option<f64>,
    synced_lyrics: Option<String>,
}

#[derive(Clone)]
struct CacheEntry {
    key: String,
    stored_at: Instant,
    ttl: Duration,
    result: LyricsResult,
}

static CACHE: Mutex<VecDeque<CacheEntry>> = Mutex::new(VecDeque::new());
static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
static REQUEST_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
#[derive(Default)]
struct RequestGate {
    last_request: Option<Instant>,
    blocked_until: Option<Instant>,
}
static REQUEST_GATE: OnceLock<tokio::sync::Mutex<RequestGate>> = OnceLock::new();

fn result(status: &str, lines: Vec<LyricsLine>) -> LyricsResult {
    LyricsResult {
        status: status.into(),
        provider: "LRCLIB",
        lines,
        retry_after_seconds: None,
    }
}

fn rate_limited(retry_after_seconds: u64) -> LyricsResult {
    LyricsResult {
        status: "rate_limited".into(),
        provider: "LRCLIB",
        lines: Vec::new(),
        retry_after_seconds: Some(retry_after_seconds.clamp(1, 60 * 60)),
    }
}

fn normalize(value: &str) -> String {
    value
        .chars()
        .flat_map(char::to_lowercase)
        .filter(|ch| ch.is_alphanumeric())
        .collect()
}

fn matching_name(requested: &str, found: &str) -> bool {
    let a = normalize(requested);
    let b = normalize(found);
    if a.is_empty() || b.is_empty() {
        return false;
    }
    if a == b {
        return true;
    }
    let shortest = a.len().min(b.len());
    let longest = a.len().max(b.len());
    shortest * 5 >= longest * 4 && (a.contains(&b) || b.contains(&a))
}

fn cache_key(track: &str, artist: &str, album: Option<&str>, duration: f64) -> String {
    format!(
        "{}|{}|{}|{}",
        normalize(track),
        normalize(artist),
        normalize(album.unwrap_or_default()),
        duration.round() as u32
    )
}

fn cached(key: &str) -> Option<LyricsResult> {
    let mut cache = CACHE.lock().ok()?;
    let index = cache.iter().position(|entry| entry.key == key)?;
    let entry = cache.remove(index)?;
    if entry.stored_at.elapsed() > entry.ttl {
        return None;
    }
    let result = entry.result.clone();
    cache.push_front(entry);
    Some(result)
}

fn remember(key: String, result: LyricsResult) {
    let ttl = if result.status == "ok" {
        FOUND_TTL
    } else {
        MISS_TTL
    };
    if let Ok(mut cache) = CACHE.lock() {
        cache.retain(|entry| entry.key != key);
        cache.push_front(CacheEntry {
            key,
            stored_at: Instant::now(),
            ttl,
            result,
        });
        while cache.len() > CACHE_LIMIT {
            cache.pop_back();
        }
    }
}

fn client() -> &'static Result<reqwest::Client, String> {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .connect_timeout(Duration::from_secs(3))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!(
                "Hover-Island/",
                env!("CARGO_PKG_VERSION"),
                " (https://github.com/a-catsuki/hover-island)"
            ))
            .build()
            .map_err(|error| error.to_string())
    })
}

async fn wait_for_request_slot() -> Result<(), u64> {
    let gate = REQUEST_GATE.get_or_init(|| tokio::sync::Mutex::new(RequestGate::default()));
    let mut state = gate.lock().await;
    let now = Instant::now();
    if let Some(blocked_until) = state.blocked_until.filter(|at| *at > now) {
        return Err(remaining_seconds(blocked_until.duration_since(now)));
    }
    state.blocked_until = None;
    let throttle_at = state.last_request.map(|at| at + Duration::from_millis(300));
    if let Some(ready_at) = throttle_at.filter(|at| *at > now) {
        tokio::time::sleep(ready_at.duration_since(now)).await;
    }
    state.last_request = Some(Instant::now());
    Ok(())
}

fn retry_after_seconds(headers: &reqwest::header::HeaderMap) -> u64 {
    let Some(value) = headers
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
    else {
        return 60;
    };
    let value = value.trim();
    let seconds = value.parse::<u64>().ok().or_else(|| {
        httpdate::parse_http_date(value).ok().map(|retry_at| {
            retry_at
                .duration_since(std::time::SystemTime::now())
                .map(remaining_seconds)
                .unwrap_or(0)
        })
    });
    let Some(seconds) = seconds else {
        return 60;
    };
    seconds.clamp(1, 60 * 60)
}

fn remaining_seconds(duration: Duration) -> u64 {
    duration.as_secs() + u64::from(duration.subsec_nanos() > 0)
}

async fn respect_retry_after(seconds: u64) {
    let delay = Duration::from_secs(seconds);
    if let Some(gate) = REQUEST_GATE.get() {
        let mut state = gate.lock().await;
        state.blocked_until = Some(Instant::now() + delay);
    }
}

fn parse_lrc(input: &str, duration: f64) -> Vec<LyricsLine> {
    if input.len() > MAX_LYRICS_CHARS {
        return Vec::new();
    }
    let mut offset = 0.0_f64;
    for line in input.lines() {
        if let Some(value) = line
            .trim()
            .strip_prefix("[offset:")
            .and_then(|value| value.strip_suffix(']'))
        {
            offset = value.parse::<f64>().unwrap_or(0.0) / 1000.0;
        }
    }

    let mut lines = Vec::new();
    for line in input.lines() {
        let mut rest = line.trim();
        let mut stamps = Vec::new();
        while let Some(after_open) = rest.strip_prefix('[') {
            let Some((stamp, after_close)) = after_open.split_once(']') else {
                break;
            };
            let Some((minutes, seconds)) = stamp.split_once(':') else {
                rest = after_close;
                continue;
            };
            let (Ok(minutes), Ok(seconds)) = (minutes.parse::<u32>(), seconds.parse::<f64>())
            else {
                rest = after_close;
                continue;
            };
            let at = (minutes as f64 * 60.0 + seconds + offset).max(0.0);
            if seconds >= 0.0 && at <= duration + 2.0 {
                stamps.push(at);
            }
            rest = after_close;
        }
        let text = rest.trim();
        if text.is_empty()
            || text.len() > 360
            || text.starts_with("[ar:")
            || text.starts_with("[ti:")
            || text.starts_with("[al:")
        {
            continue;
        }
        for at in stamps {
            lines.push(LyricsLine {
                at,
                text: text.to_owned(),
            });
            if lines.len() >= MAX_LINES {
                break;
            }
        }
        if lines.len() >= MAX_LINES {
            break;
        }
    }
    lines.sort_by(|a, b| a.at.total_cmp(&b.at));
    lines.dedup_by(|a, b| (a.at - b.at).abs() < 0.01 && a.text == b.text);
    lines
}

#[tauri::command]
pub async fn lyrics_lookup(
    track_name: String,
    artist_name: String,
    album_name: Option<String>,
    duration: f64,
) -> LyricsResult {
    let title = track_name.trim();
    let artist = artist_name.trim();
    if title.is_empty()
        || artist.is_empty()
        || title.len() > 200
        || artist.len() > 200
        || album_name.as_deref().is_some_and(|album| album.len() > 200)
        || !duration.is_finite()
        || !(1.0..=3600.0).contains(&duration)
    {
        return result("invalid_track", Vec::new());
    }

    let key = cache_key(title, artist, album_name.as_deref(), duration);
    if let Some(hit) = cached(&key) {
        return hit;
    }

    let Ok(client) = client() else {
        return result("unavailable", Vec::new());
    };
    // Keep the lock through the complete response so concurrent track changes
    // cannot create overlapping LRCLIB requests.
    let _request_guard = REQUEST_LOCK
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;
    if let Some(hit) = cached(&key) {
        return hit;
    }
    let Err(wait_seconds) = wait_for_request_slot().await else {
        let mut request = client
            .get("https://lrclib.net/api/get")
            .query(&[("track_name", title), ("artist_name", artist)])
            .query(&[("duration", duration.round().to_string())]);
        if let Some(album) = album_name
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            request = request.query(&[("album_name", album.trim())]);
        }
        let response = match request.send().await {
            Ok(response) => response,
            Err(error) => {
                eprintln!(
                    "LRCLIB transport failure: timeout={}, connect={}, request={}, body={}",
                    error.is_timeout(),
                    error.is_connect(),
                    error.is_request(),
                    error.is_body()
                );
                return result("unavailable", Vec::new());
            }
        };
        let status = response.status();
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            let retry_after = retry_after_seconds(response.headers());
            eprintln!("LRCLIB response: status=429 retry_after_seconds={retry_after}");
            respect_retry_after(retry_after).await;
            return rate_limited(retry_after);
        }
        if status == reqwest::StatusCode::NOT_FOUND {
            let found = result("not_found", Vec::new());
            remember(key, found.clone());
            return found;
        }
        if !status.is_success() {
            eprintln!("LRCLIB response: status={}", status.as_u16());
            return result("unavailable", Vec::new());
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_BODY_BYTES as u64)
        {
            eprintln!("LRCLIB response: status=200 body=oversize");
            return result("unavailable", Vec::new());
        }
        let mut response = response;
        let mut bytes = Vec::with_capacity(
            response
                .content_length()
                .unwrap_or(0)
                .min(MAX_BODY_BYTES as u64) as usize,
        );
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) if bytes.len() + chunk.len() <= MAX_BODY_BYTES => {
                    bytes.extend_from_slice(&chunk)
                }
                Ok(Some(_)) => {
                    eprintln!("LRCLIB response: status=200 body=oversize");
                    return result("unavailable", Vec::new());
                }
                Err(error) => {
                    eprintln!(
                        "LRCLIB body failure: timeout={}, connect={}, body={}",
                        error.is_timeout(),
                        error.is_connect(),
                        error.is_body()
                    );
                    return result("unavailable", Vec::new());
                }
                Ok(None) => break,
            }
        }
        let record: LrclibRecord = match serde_json::from_slice(&bytes) {
            Ok(record) => record,
            Err(_) => {
                eprintln!("LRCLIB response: status=200 body=invalid_json");
                return result("unavailable", Vec::new());
            }
        };
        let is_match = record
            .track_name
            .as_deref()
            .is_some_and(|name| matching_name(title, name))
            && record
                .artist_name
                .as_deref()
                .is_some_and(|name| matching_name(artist, name))
            && record
                .duration
                .is_some_and(|found| found.is_finite() && (found - duration).abs() <= 2.0);
        if !is_match {
            return result("not_found", Vec::new());
        }
        let lines = record
            .synced_lyrics
            .as_deref()
            .map(|text| parse_lrc(text, duration))
            .unwrap_or_default();
        let found = if lines.is_empty() {
            result("no_timed_lyrics", Vec::new())
        } else {
            result("ok", lines)
        };
        remember(key, found.clone());
        return found;
    };
    rate_limited(wait_seconds)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timed_lines_support_offsets_multiple_stamps_and_sorted_deduplication() {
        let lines=parse_lrc("[offset:500]\n[00:02.00][00:01.00]Owned fixture\n[00:01.00]Owned fixture\n[ar:Fixture]\n[99:00.00]Outside track",10.0);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].at, 1.5);
        assert_eq!(lines[1].at, 2.5);
        assert_eq!(lines[0].text, "Owned fixture");
        assert!(parse_lrc("[00:NaN]Invalid\n[00:inf]Invalid", 10.0).is_empty());
        assert!(parse_lrc(&"x".repeat(MAX_LYRICS_CHARS + 1), 10.0).is_empty());
    }

    #[test]
    fn retry_after_seconds_are_clamped_and_default_when_missing_or_invalid() {
        let headers = reqwest::header::HeaderMap::new();
        assert_eq!(retry_after_seconds(&headers), 60);
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(reqwest::header::RETRY_AFTER, "15".parse().unwrap());
        assert_eq!(retry_after_seconds(&headers), 15);
        headers.insert(reqwest::header::RETRY_AFTER, "36000".parse().unwrap());
        assert_eq!(retry_after_seconds(&headers), 3600);
        headers.insert(
            reqwest::header::RETRY_AFTER,
            "Wed, 21 Oct 2099 07:28:00 GMT".parse().unwrap(),
        );
        assert_eq!(retry_after_seconds(&headers), 3600);
        headers.insert(
            reqwest::header::RETRY_AFTER,
            "Wed, 21 Oct 2015 07:28:00 GMT".parse().unwrap(),
        );
        assert_eq!(retry_after_seconds(&headers), 1);
        headers.insert(reqwest::header::RETRY_AFTER, "invalid".parse().unwrap());
        assert_eq!(retry_after_seconds(&headers), 60);
    }

    #[test]
    fn rate_limited_result_exposes_only_a_bounded_retry_hint() {
        let found = rate_limited(60 * 60 + 1);
        assert_eq!(found.status, "rate_limited");
        assert_eq!(found.retry_after_seconds, Some(60 * 60));
        assert!(found.lines.is_empty());
    }

    #[tokio::test]
    async fn missing_metadata_is_rejected_without_a_network_request() {
        assert_eq!(
            lyrics_lookup(String::new(), "Fixture".into(), None, 10.0)
                .await
                .status,
            "invalid_track"
        );
        assert_eq!(
            lyrics_lookup("Fixture".into(), "Artist".into(), None, f64::NAN)
                .await
                .status,
            "invalid_track"
        );
    }

    #[tokio::test]
    #[ignore = "opt-in public LRCLIB lookup; reports metadata only, never lyric text"]
    async fn live_timed_lyrics_lookup_returns_bounded_sorted_lines() {
        let found =
            lyrics_lookup("The Night We Met".into(), "Lord Huron".into(), None, 208.0).await;
        if found.status == "rate_limited" {
            assert!(found
                .retry_after_seconds
                .is_some_and(|seconds| seconds <= 60 * 60));
            assert!(found.lines.is_empty());
            println!(
                "provider={}, status=rate_limited, retry_after_seconds={:?}",
                found.provider, found.retry_after_seconds
            );
        } else {
            assert_eq!(
                found.status, "ok",
                "public timed lyrics must either be available or explicitly rate-limited"
            );
            assert!(!found.lines.is_empty() && found.lines.len() <= MAX_LINES);
            assert!(found.lines.windows(2).all(|pair| pair[0].at <= pair[1].at));
            println!(
                "provider={}, status=ok, timed_line_count={}",
                found.provider,
                found.lines.len()
            );
        }
    }
}
