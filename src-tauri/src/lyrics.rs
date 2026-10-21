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
/// `/api/get` already filters on duration (about 2 s); players report slightly different lengths.
const GET_DURATION_TOLERANCE: f64 = 3.0;
const SEARCH_DURATION_TOLERANCE: f64 = 5.0;

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
    /// False when the lines are plain (unsynchronised) lyrics: every `at` is 0 and must not be followed in time.
    pub timed: bool,
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
    plain_lyrics: Option<String>,
    instrumental: Option<bool>,
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
        timed: false,
        retry_after_seconds: None,
    }
}

fn rate_limited(retry_after_seconds: u64) -> LyricsResult {
    LyricsResult {
        status: "rate_limited".into(),
        provider: "LRCLIB",
        lines: Vec::new(),
        timed: false,
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

/// Removes enhanced-LRC word stamps such as `<00:12.50>` from a lyric line.
fn strip_word_stamps(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('<') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('>') {
            Some(end)
                if after[..end]
                    .chars()
                    .all(|ch| ch.is_ascii_digit() || ch == ':' || ch == '.') =>
            {
                rest = &after[end + 1..];
            }
            _ => {
                out.push('<');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Parses LRC text. Supports several stamps per line, `[mm:ss.xx]`, `[mm:ss.xxx]`,
/// `[mm:ss:xx]` and `[mm:ss]`, and the `[offset:ms]` tag (positive values show lyrics
/// earlier, as the LRC convention says). Blank stamped lines are kept as instrumental
/// gaps so the previous lyric does not stay highlighted through a break.
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
            offset = value
                .trim()
                .parse::<f64>()
                .ok()
                .filter(|value| value.is_finite())
                .unwrap_or(0.0)
                / 1000.0;
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
            rest = after_close;
            let Some((minutes, seconds)) = stamp.split_once(':') else {
                continue;
            };
            // `[01:02:50]` writes the fraction after a colon.
            let seconds = seconds.replace(':', ".");
            let (Ok(minutes), Ok(seconds)) = (minutes.trim().parse::<u32>(), seconds.trim().parse::<f64>())
            else {
                continue;
            };
            let at = (minutes as f64 * 60.0 + seconds - offset).max(0.0);
            if seconds.is_finite() && seconds >= 0.0 && at <= duration + 2.0 {
                stamps.push(at);
            }
        }
        if stamps.is_empty() {
            continue;
        }
        let text = strip_word_stamps(rest.trim());
        if text.len() > 360 {
            continue;
        }
        for at in stamps {
            lines.push(LyricsLine {
                at,
                text: text.clone(),
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
    // One gap marker is enough, and a leading gap carries no information.
    lines.dedup_by(|a, b| a.text.is_empty() && b.text.is_empty());
    while lines.first().is_some_and(|line| line.text.is_empty()) {
        lines.remove(0);
    }
    lines
}

/// Unsynchronised lyrics: every line gets `at = 0`; the caller marks the result untimed.
fn parse_plain(input: &str) -> Vec<LyricsLine> {
    if input.len() > MAX_LYRICS_CHARS {
        return Vec::new();
    }
    let mut lines: Vec<LyricsLine> = Vec::new();
    for line in input.lines() {
        let text = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if text.len() > 360 || (text.is_empty() && lines.last().map_or(true, |last| last.text.is_empty())) {
            continue;
        }
        lines.push(LyricsLine { at: 0.0, text });
        if lines.len() >= MAX_LINES {
            break;
        }
    }
    while lines.last().is_some_and(|line| line.text.is_empty()) {
        lines.pop();
    }
    lines
}

/// "Song (feat. X) - Remastered 2011" -> "Song".
fn clean_title(value: &str) -> String {
    let mut out = String::new();
    let mut depth = 0usize;
    for ch in value.chars() {
        match ch {
            '(' | '[' => depth += 1,
            ')' | ']' => depth = depth.saturating_sub(1),
            _ if depth == 0 => out.push(ch),
            _ => {}
        }
    }
    let head = out.split(" - ").next().unwrap_or("").trim().to_string();
    if head.is_empty() {
        value.trim().to_string()
    } else {
        head
    }
}

fn title_matches(requested: &str, found: &str) -> bool {
    matching_name(requested, found) || matching_name(&clean_title(requested), &clean_title(found))
}

/// Artists often differ by credits ("A", "A, B", "A & B"), so containment either way is enough.
fn artist_matches(requested: &str, found: &str) -> bool {
    if matching_name(requested, found) {
        return true;
    }
    let a = normalize(requested);
    let b = normalize(found);
    a.len() >= 3 && b.len() >= 3 && (a.contains(&b) || b.contains(&a))
}

fn record_matches(record: &LrclibRecord, title: &str, artist: &str, duration: f64, tolerance: f64) -> bool {
    record.track_name.as_deref().is_some_and(|name| title_matches(title, name))
        && record.artist_name.as_deref().is_some_and(|name| artist_matches(artist, name))
        && record
            .duration
            .is_some_and(|found| found.is_finite() && (found - duration).abs() <= tolerance)
}

fn record_result(record: &LrclibRecord, duration: f64) -> LyricsResult {
    if record.instrumental.unwrap_or(false) {
        return result("no_timed_lyrics", Vec::new());
    }
    let timed = record
        .synced_lyrics
        .as_deref()
        .map(|text| parse_lrc(text, duration))
        .unwrap_or_default();
    if !timed.is_empty() {
        let mut found = result("ok", timed);
        found.timed = true;
        return found;
    }
    let plain = record
        .plain_lyrics
        .as_deref()
        .map(parse_plain)
        .unwrap_or_default();
    if plain.is_empty() {
        result("no_timed_lyrics", Vec::new())
    } else {
        result("ok", plain)
    }
}

/// Best search hit: names must match, the duration must be close, synced lyrics win ties.
fn best_record<'a>(records: &'a [LrclibRecord], title: &str, artist: &str, duration: f64) -> Option<&'a LrclibRecord> {
    // A player that reports no length (some Apple Music builds) matches on names alone.
    let tolerance = if duration >= 1.0 { SEARCH_DURATION_TOLERANCE } else { f64::INFINITY };
    records
        .iter()
        .filter(|record| record_matches(record, title, artist, duration, tolerance))
        .min_by(|a, b| {
            let score = |record: &LrclibRecord| {
                let synced = record.synced_lyrics.as_deref().is_some_and(|text| !text.trim().is_empty());
                let plain = record.plain_lyrics.as_deref().is_some_and(|text| !text.trim().is_empty());
                let penalty = if synced { 0.0 } else if plain { 100.0 } else { 1000.0 };
                penalty + (record.duration.unwrap_or(0.0) - duration).abs()
            };
            score(a).total_cmp(&score(b))
        })
}

/// Sends a request and maps transport errors, 429 and unexpected statuses to a result.
/// 200 and 404 come back as `Ok` so the caller can tell a miss from a failure.
async fn send_checked(request: reqwest::RequestBuilder) -> Result<reqwest::Response, LyricsResult> {
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
            return Err(result("unavailable", Vec::new()));
        }
    };
    let status = response.status();
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        let retry_after = retry_after_seconds(response.headers());
        eprintln!("LRCLIB response: status=429 retry_after_seconds={retry_after}");
        respect_retry_after(retry_after).await;
        return Err(rate_limited(retry_after));
    }
    if status != reqwest::StatusCode::NOT_FOUND && !status.is_success() {
        eprintln!("LRCLIB response: status={}", status.as_u16());
        return Err(result("unavailable", Vec::new()));
    }
    Ok(response)
}

async fn read_limited(mut response: reqwest::Response) -> Result<Vec<u8>, LyricsResult> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_BODY_BYTES as u64)
    {
        eprintln!("LRCLIB response: status=200 body=oversize");
        return Err(result("unavailable", Vec::new()));
    }
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
                return Err(result("unavailable", Vec::new()));
            }
            Err(error) => {
                eprintln!(
                    "LRCLIB body failure: timeout={}, connect={}, body={}",
                    error.is_timeout(),
                    error.is_connect(),
                    error.is_body()
                );
                return Err(result("unavailable", Vec::new()));
            }
            Ok(None) => return Ok(bytes),
        }
    }
}

/// Exact signature lookup first, then a search for tracks whose metadata differs slightly.
async fn lookup_remote(
    client: &reqwest::Client,
    title: &str,
    artist: &str,
    album: Option<&str>,
    duration: f64,
) -> Result<LyricsResult, LyricsResult> {
    if let Err(wait) = wait_for_request_slot().await {
        return Err(rate_limited(wait));
    }
    if duration < 1.0 {
        return search_remote(client, title, artist, duration).await;
    }
    let mut request = client
        .get("https://lrclib.net/api/get")
        .query(&[("track_name", title), ("artist_name", artist)])
        .query(&[("duration", duration.round().to_string())]);
    if let Some(album) = album.map(str::trim).filter(|value| !value.is_empty()) {
        request = request.query(&[("album_name", album)]);
    }
    let response = send_checked(request).await?;
    if response.status().is_success() {
        let bytes = read_limited(response).await?;
        let record: LrclibRecord = serde_json::from_slice(&bytes).map_err(|_| {
            eprintln!("LRCLIB response: status=200 body=invalid_json");
            result("unavailable", Vec::new())
        })?;
        if record_matches(&record, title, artist, duration, GET_DURATION_TOLERANCE) {
            let first = record_result(&record, duration);
            // Timed lyrics (or a real instrumental) are the answer. Plain lyrics are only a fallback:
            // another LRCLIB entry for the same song often carries the timing.
            if first.timed || record.instrumental.unwrap_or(false) {
                return Ok(first);
            }
            return match search_remote(client, title, artist, duration).await {
                Ok(found) if found.timed => Ok(found),
                _ => Ok(first),
            };
        }
    }
    // Not found, or found something that is not this track: search by name.
    search_remote(client, title, artist, duration).await
}

async fn search_records(
    client: &reqwest::Client,
    query: &[(&str, &str)],
) -> Result<Vec<LrclibRecord>, LyricsResult> {
    if let Err(wait) = wait_for_request_slot().await {
        return Err(rate_limited(wait));
    }
    let response = send_checked(client.get("https://lrclib.net/api/search").query(query)).await?;
    if !response.status().is_success() {
        return Ok(Vec::new());
    }
    let bytes = read_limited(response).await?;
    serde_json::from_slice(&bytes).map_err(|_| {
        eprintln!("LRCLIB response: status=200 body=invalid_json");
        result("unavailable", Vec::new())
    })
}

async fn search_remote(
    client: &reqwest::Client,
    title: &str,
    artist: &str,
    duration: f64,
) -> Result<LyricsResult, LyricsResult> {
    let search_title = clean_title(title);
    let span = if duration >= 1.0 { duration } else { 3600.0 };
    let has_timed = |records: &[LrclibRecord]| {
        best_record(records, title, artist, duration)
            .is_some_and(|record| record.synced_lyrics.as_deref().is_some_and(|text| !text.trim().is_empty()))
    };
    let mut records = search_records(client, &[("track_name", search_title.as_str()), ("artist_name", artist)]).await?;
    if !has_timed(&records) {
        // A free-text search finds entries whose title or artist is spelled a little differently.
        let free = format!("{search_title} {artist}");
        if let Ok(more) = search_records(client, &[("q", free.as_str())]).await {
            records.extend(more);
        }
    }
    Ok(match best_record(&records, title, artist, duration) {
        Some(record) => record_result(record, span),
        None => result("not_found", Vec::new()),
    })
}

/// Apple Music for Windows reports the artist as "Artist \u{2014} Album" and often leaves the
/// album empty. Split that apart, and drop "- Single" / "- EP" suffixes from albums.
fn split_artist(artist: &str, album: Option<&str>) -> (String, Option<String>) {
    let (name, tail) = match artist.find(" \u{2014} ").or_else(|| artist.find(" \u{2013} ")) {
        Some(at) => (artist[..at].trim(), Some(artist[at + 5..].trim())),
        None => (artist.trim(), None),
    };
    let album = album
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or(tail.filter(|value| !value.is_empty()))
        .map(|value| {
            let lower = value.to_lowercase();
            for suffix in [" - single", " - ep"] {
                if lower.ends_with(suffix) {
                    return value[..value.len() - suffix.len()].trim().to_string();
                }
            }
            value.to_string()
        });
    (name.to_string(), album)
}

#[tauri::command]
pub async fn lyrics_lookup(
    track_name: String,
    artist_name: String,
    album_name: Option<String>,
    duration: f64,
) -> LyricsResult {
    let title = track_name.trim();
    let (artist_owned, album_owned) = split_artist(artist_name.trim(), album_name.as_deref());
    let artist = artist_owned.as_str();
    let album_name = album_owned;
    let duration = if duration.is_finite() && duration >= 1.0 { duration } else { 0.0 };
    if title.is_empty()
        || artist.is_empty()
        || title.len() > 200
        || artist.len() > 200
        || album_name.as_deref().is_some_and(|album| album.len() > 200)
        || duration > 3600.0
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
    match lookup_remote(client, title, artist, album_name.as_deref(), duration).await {
        Ok(found) => {
            remember(key, found.clone());
            found
        }
        Err(failure) => failure,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timed_lines_support_offsets_multiple_stamps_and_sorted_deduplication() {
        let lines=parse_lrc("[offset:500]\n[00:02.00][00:01.00]Owned fixture\n[00:01.00]Owned fixture\n[ar:Fixture]\n[99:00.00]Outside track",10.0);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].at, 0.5, "a positive offset shows lyrics earlier");
        assert_eq!(lines[1].at, 1.5);
        assert_eq!(lines[0].text, "Owned fixture");
        assert!(parse_lrc("[00:NaN]Invalid\n[00:inf]Invalid", 10.0).is_empty());
        assert!(parse_lrc(&"x".repeat(MAX_LYRICS_CHARS + 1), 10.0).is_empty());
    }

    #[test]
    fn lrc_variants_word_stamps_and_gaps_are_handled() {
        let lines = parse_lrc("[00:01:50]<00:01.50>Hello <00:02.00>there\n[00:05.123]\n[00:06.5]Next", 20.0);
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0].at, 1.5);
        assert_eq!(lines[0].text, "Hello there");
        assert_eq!(lines[1].text, "", "blank stamped line is an instrumental gap");
        assert!((lines[1].at - 5.123).abs() < 1e-9);
        assert_eq!(lines[2].at, 6.5);
    }

    #[test]
    fn titles_artists_and_search_hits_match_loosely_but_by_duration() {
        assert_eq!(clean_title("Closer (feat. Halsey) - Radio Edit"), "Closer");
        assert!(title_matches("Closer", "Closer - Remastered 2020"));
        assert!(artist_matches("The Chainsmokers", "The Chainsmokers, Halsey"));
        assert!(!artist_matches("Adele", "Coldplay"));
        let record = |name: &str, duration: f64, synced: Option<&str>| LrclibRecord {
            track_name: Some(name.into()),
            artist_name: Some("The Chainsmokers".into()),
            duration: Some(duration),
            synced_lyrics: synced.map(Into::into),
            plain_lyrics: Some("plain".into()),
            instrumental: None,
        };
        let records = vec![
            record("Closer", 300.0, Some("[00:01.00]x")),
            record("Closer", 244.0, None),
            record("Closer", 245.0, Some("[00:01.00]x")),
        ];
        let best = best_record(&records, "Closer", "The Chainsmokers", 244.0).unwrap();
        assert_eq!(best.duration, Some(245.0), "synced wins within tolerance, far durations are ignored");
        assert!(best_record(&records, "Other song", "The Chainsmokers", 244.0).is_none());
    }

    #[test]
    fn apple_music_artist_and_album_are_split() {
        assert_eq!(
            split_artist("Slow Mornings \u{2014} Quiet Hours - Single", None),
            ("Slow Mornings".to_string(), Some("Quiet Hours".to_string()))
        );
        assert_eq!(split_artist("Plain Artist", Some("  ")), ("Plain Artist".to_string(), None));
    }

    #[test]
    fn plain_lyrics_are_untimed() {
        let lines = parse_plain("one\n\n\ntwo\n");
        assert_eq!(lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>(), ["one", "", "two"]);
        let found = record_result(
            &LrclibRecord {
                track_name: None,
                artist_name: None,
                duration: None,
                synced_lyrics: None,
                plain_lyrics: Some("one\ntwo".into()),
                instrumental: None,
            },
            100.0,
        );
        assert_eq!(found.status, "ok");
        assert!(!found.timed);
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
            lyrics_lookup("Fixture".into(), "  ".into(), None, f64::NAN)
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
