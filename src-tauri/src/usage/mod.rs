//! Local AI usage monitoring. Provider quotas are shown only when Codex logs contain
//! an explicit provider rate-limit record; local token activity is labeled separately.
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use serde_json::Value;
use tauri::{AppHandle, Manager, State};

mod detect;
use detect::DetectedProvider;

use crate::settings::{ManualUsage, Settings};
use crate::state::AppState;
use crate::types::{now_millis, UsageSnapshot};

const MAX_WALK_DEPTH: usize = 8;
const DAY_MS: u64 = 86_400_000;
const MAX_JSONL_LINE_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, PartialEq)]
struct RateLimit {
    label: String,
    percent: f64,
    window: Option<String>,
    reset_at: Option<u64>,
    updated_at: u64,
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
    rate_limits: Vec<RateLimit>,
}

#[derive(Default)]
struct LogCache {
    files: HashMap<String, LogFile>,
}

static LOG_CACHE: OnceLock<Mutex<LogCache>> = OnceLock::new();

fn walk_files(dir: &Path, out: &mut Vec<PathBuf>, depth: usize) {
    if depth > MAX_WALK_DEPTH || out.len() >= 20_000 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= 20_000 {
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
            walk_files(&path, out, depth + 1);
        } else if path
            .extension()
            .and_then(|s| s.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("jsonl"))
        {
            out.push(path);
        }
    }
}

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
            let label = match key {
                "primary" => format!("Codex · {}", window.as_deref().unwrap_or("primary window")),
                _ => format!(
                    "Codex · {}",
                    window.as_deref().unwrap_or("secondary window")
                ),
            };
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

fn usage_line(line: &str, provider: &str, file: &mut LogFile, fallback_time: u64) {
    // Session transcripts contain many non-usage records. Avoid JSON parsing those lines.
    match provider {
        "codex" if !line.contains("token_count") => return,
        "claude-code" if !(line.contains("assistant") && line.contains("usage")) => return,
        _ => {}
    }
    let Ok(root) = serde_json::from_str::<Value>(line) else {
        return;
    };
    let timestamp = event_time(&root, fallback_time);
    if provider == "codex" {
        if root.pointer("/payload/type").and_then(Value::as_str) != Some("token_count") {
            return;
        }
        let info = &root["payload"]["info"];
        let latest = info.get("last_token_usage").and_then(token_total);
        if let Some(total) = info.get("total_token_usage").and_then(token_total) {
            let delta = file
                .previous_total
                .map(|prev| total.saturating_sub(prev))
                .unwrap_or_else(|| latest.unwrap_or(0));
            file.previous_total = Some(total);
            if delta > 0 {
                file.events.push((timestamp, delta));
                file.has_usage_data = true;
            }
        } else if let Some(tokens) = latest.filter(|n| *n > 0) {
            file.events.push((timestamp, tokens));
            file.has_usage_data = true;
        }
        let rate_limits = parse_rate_limits(&root, timestamp);
        if !rate_limits.is_empty() {
            file.rate_limits = rate_limits;
        }
    } else if provider == "claude-code" {
        let is_assistant = root.get("type").and_then(Value::as_str) == Some("assistant");
        if !is_assistant {
            return;
        }
        if let Some(usage) = root.pointer("/message/usage") {
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
                file.events.push((timestamp, total));
                file.has_usage_data = true;
            }
        }
    }
}

fn update_file(path: &Path, provider: &str, file: &mut LogFile, now: u64) {
    let Ok(metadata) = std::fs::metadata(path) else {
        return;
    };
    let len = metadata.len();
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    // A shorter file, or a same-size file with a new modification time, was rewritten.
    if len < file.length || (len == file.length && modified != file.modified_ms) {
        *file = LogFile::default();
    }
    if len == file.length {
        file.modified_ms = modified;
        return;
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
                process_jsonl_line(&line, provider, file, modified.max(now));
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
    let cutoff = now.saturating_sub(DAY_MS);
    file.events.retain(|(ts, _)| *ts >= cutoff);
}

fn process_jsonl_line(bytes: &[u8], provider: &str, file: &mut LogFile, fallback_time: u64) {
    let line = String::from_utf8_lossy(bytes);
    usage_line(line.trim_end_matches('\r'), provider, file, fallback_time);
}

fn scan(root: &Path, provider: &str, now: u64) -> (u64, u32, bool, Vec<RateLimit>) {
    let mut paths = Vec::new();
    walk_files(root, &mut paths, 0);
    let mut cache = LOG_CACHE
        .get_or_init(|| Mutex::new(LogCache::default()))
        .lock()
        .unwrap();
    let namespace = format!("{}::{}::", provider, root.to_string_lossy());
    let live: std::collections::HashSet<String> = paths
        .iter()
        .map(|p| format!("{}{}", namespace, p.to_string_lossy()))
        .collect();
    cache
        .files
        .retain(|key, _| !key.starts_with(&namespace) || live.contains(key));
    for path in &paths {
        let key = format!("{}{}", namespace, path.to_string_lossy());
        update_file(path, provider, cache.files.entry(key).or_default(), now);
    }
    let mut recent = 0u64;
    let mut has_usage_data = false;
    let mut rate_limits: Vec<RateLimit> = Vec::new();
    let cutoff = now.saturating_sub(DAY_MS);
    for (_key, f) in cache
        .files
        .iter()
        .filter(|(key, _)| key.starts_with(&namespace))
    {
        has_usage_data |= f.has_usage_data;
        for (timestamp, tokens) in &f.events {
            if *timestamp >= cutoff {
                recent = recent.saturating_add(*tokens);
            }
        }
        for rate in &f.rate_limits {
            if let Some(existing) = rate_limits.iter_mut().find(|r| r.label == rate.label) {
                if rate.updated_at >= existing.updated_at {
                    *existing = rate.clone();
                }
            } else {
                rate_limits.push(rate.clone());
            }
        }
    }
    (
        recent,
        paths.len().min(u32::MAX as usize) as u32,
        has_usage_data,
        rate_limits,
    )
}

fn unknown(provider: &str, label: &str, detail: &str) -> UsageSnapshot {
    UsageSnapshot {
        provider: provider.into(),
        label: label.into(),
        status: "unknown".into(),
        used: None,
        limit: None,
        unit: None,
        percent: None,
        window: None,
        detail: Some(detail.into()),
        source: None,
        reset_at: None,
        updated_at: now_millis(),
    }
}

fn local_activity_with_limits(
    provider: &str,
    label: &str,
    root: Option<PathBuf>,
) -> (UsageSnapshot, Vec<RateLimit>) {
    let Some(root) = root else {
        return (
            unknown(provider, label, "home directory not found"),
            Vec::new(),
        );
    };
    if !root.exists() {
        return (unknown(provider, label, "no local logs found"), Vec::new());
    }
    let now = now_millis();
    let (tokens, files, has_data, limits) = scan(&root, provider, now);
    if files == 0 {
        return (unknown(provider, label, "no session logs found"), limits);
    }
    if !has_data {
        return (
            unknown(
                provider,
                label,
                "session logs do not contain readable token usage records",
            ),
            limits,
        );
    }
    (
        UsageSnapshot {
            provider: provider.into(),
            label: format!("{label} local activity"),
            status: "ok".into(),
            used: Some(tokens),
            limit: None,
            unit: Some("tokens".into()),
            percent: None,
            window: Some("24h".into()),
            detail: Some(format!(
                "Tokens recorded in local logs across {files} session files"
            )),
            source: Some("local-logs".into()),
            reset_at: None,
            updated_at: now,
        },
        limits,
    )
}

fn local_activity(provider: &str, label: &str, root: Option<PathBuf>) -> UsageSnapshot {
    local_activity_with_limits(provider, label, root).0
}

fn codex() -> Vec<UsageSnapshot> {
    let root = dirs::home_dir().map(|h| h.join(".codex").join("sessions"));
    let (local, limits) = local_activity_with_limits("codex", "Codex", root);
    let mut out = vec![local];
    out.extend(limits.into_iter().map(|limit| UsageSnapshot {
        provider: "codex".into(),
        label: limit.label,
        status: "ok".into(),
        used: None,
        limit: None,
        unit: Some("%".into()),
        percent: Some(limit.percent),
        window: limit.window,
        detail: Some("Provider-reported rate limit".into()),
        source: Some("official-rate-limit".into()),
        reset_at: limit.reset_at,
        updated_at: limit.updated_at,
    }));
    out
}

fn claude_code() -> UsageSnapshot {
    let root = dirs::home_dir().map(|h| h.join(".claude").join("projects"));
    local_activity("claude-code", "Claude Code", root)
}

fn cursor() -> UsageSnapshot {
    let Some(home) = dirs::home_dir() else {
        return unknown("cursor", "Cursor", "home directory not found");
    };
    if home.join(".cursor").exists() {
        unknown("cursor", "Cursor", "Cursor does not expose local usage")
    } else {
        unknown("cursor", "Cursor", "Cursor not detected")
    }
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
    }
}

pub fn refresh(settings: &Settings) -> Vec<UsageSnapshot> {
    let mut out = Vec::new();
    if settings.usage.codex {
        out.extend(codex());
    }
    if settings.usage.claude_code {
        out.push(claude_code());
    }
    if settings.usage.cursor {
        out.push(cursor());
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
    let snaps = tauri::async_runtime::spawn_blocking(move || refresh(&settings))
        .await
        .map_err(|error| format!("Usage refresh failed: {error}"))?;
    *app.state::<AppState>().usage.lock().unwrap() = snaps.clone();
    Ok(snaps)
}

fn parse_rfc3339_millis(value: &str) -> Option<u64> {
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

        let cache = LOG_CACHE.get().unwrap().lock().unwrap();
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
}
