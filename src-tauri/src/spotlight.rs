use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::State;

use crate::apps;
use crate::state::AppState;
use crate::types::SearchResult;

const MAX_RESULTS: usize = 10;
const MAX_FILES: usize = 6000;
const MAX_FILE_DEPTH: usize = 5;
const DEFAULT_APP_LIMIT: usize = 8;
const MAX_SCORING_QUERY_CHARS: usize = 64;

/// Directory names that are never worth indexing (build output, caches, system data).
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "appdata",
    "$recycle.bin",
    "windows",
    "programdata",
    ".cache",
    ".cargo",
    ".rustup",
    ".gradle",
    ".m2",
    ".npm",
    "__pycache__",
    ".venv",
    "venv",
    ".next",
    ".nuxt",
    ".terraform",
    ".idea",
    ".vscode",
    ".ssh",
];

/* ------------------------------ file index ------------------------------ */

fn is_junk_dir(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    SKIP_DIRS.iter().any(|skip| *skip == lower)
}

fn walk_files(
    dir: &Path,
    out: &mut Vec<(String, String)>,
    seen: &mut HashSet<String>,
    depth: usize,
) {
    if depth > MAX_FILE_DEPTH || out.len() >= MAX_FILES {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= MAX_FILES {
            return;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        // Skip symlinks to avoid cycles / duplicated trees.
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            if is_junk_dir(&name) {
                continue;
            }
            walk_files(&path, out, seen, depth + 1);
        } else {
            let path_str = path.to_string_lossy().to_string();
            if seen.insert(path_str.clone()) {
                out.push((name.to_lowercase(), path_str));
            }
        }
    }
}

/// Build an in-memory index of the user's most-relevant folders. Fast to search afterwards.
///
/// Indexes the usual shell folders plus the user's OneDrive (personal or business) when
/// present, skipping junk/system directories, deduping by full path, and capping the size.
pub fn build_file_index() -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let Some(home) = dirs::home_dir() else {
        return out;
    };

    let mut roots: Vec<PathBuf> = Vec::new();
    for folder in [
        "Desktop",
        "Documents",
        "Downloads",
        "Pictures",
        "Videos",
        "Music",
    ] {
        let dir = home.join(folder);
        if dir.is_dir() {
            roots.push(dir);
        }
    }

    // OneDrive: prefer the environment variable, then the conventional location.
    for key in ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"] {
        if let Ok(value) = std::env::var(key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                let dir = PathBuf::from(trimmed);
                if dir.is_dir() {
                    roots.push(dir);
                }
            }
        }
    }
    let conventional_onedrive = home.join("OneDrive");
    if conventional_onedrive.is_dir() {
        roots.push(conventional_onedrive);
    }

    roots.sort();
    roots.dedup();

    for root in roots {
        if out.len() >= MAX_FILES {
            break;
        }
        walk_files(&root, &mut out, &mut seen, 0);
    }

    out
}

/* ------------------------------- scoring -------------------------------- */

/// Cheap relevance score. Higher is better; `<= 0` means no match.
///
/// Ranking tiers: exact > prefix > word-boundary prefix > substring > subsequence.
/// Short names are boosted so snappy matches float to the top.
fn score(needle: &str, haystack_lower: &str) -> f64 {
    if needle.is_empty() || needle.chars().count() > MAX_SCORING_QUERY_CHARS {
        return 0.0;
    }
    if haystack_lower.is_empty() {
        return -1.0;
    }
    let hlen = haystack_lower.chars().count() as f64;
    // Prefer short, snappy names.
    let brevity = 60.0 / (hlen + 3.0);

    if haystack_lower == needle {
        return 1000.0 + brevity;
    }
    if haystack_lower.starts_with(needle) {
        return 900.0 + brevity;
    }
    if word_boundary_prefix(haystack_lower, needle) {
        return 800.0 + brevity;
    }
    if let Some(pos) = haystack_lower.find(needle) {
        return 700.0 + brevity - pos as f64 * 0.5;
    }
    if let Some(span) = subsequence_span(needle, haystack_lower) {
        return 300.0 + brevity - span as f64 * 0.2;
    }
    -1.0
}

/// True when `needle` starts a word inside `haystack` (after a non-alphanumeric boundary).
fn word_boundary_prefix(haystack: &str, needle: &str) -> bool {
    let mut boundary = true;
    for (idx, ch) in haystack.char_indices() {
        if boundary && haystack[idx..].starts_with(needle) {
            return true;
        }
        boundary = !ch.is_alphanumeric();
    }
    false
}

/// Ordered-subsequence match; returns the byte span between first and last matched char.
fn subsequence_span(needle: &str, haystack: &str) -> Option<usize> {
    let mut iter = haystack.char_indices();
    let mut first: Option<usize> = None;
    let mut last = 0usize;
    for wanted in needle.chars() {
        let mut matched = false;
        for (idx, ch) in iter.by_ref() {
            if ch == wanted {
                if first.is_none() {
                    first = Some(idx);
                }
                last = idx;
                matched = true;
                break;
            }
        }
        if !matched {
            return None;
        }
    }
    first.map(|start| last.saturating_sub(start))
}

/* ------------------------------ calculator ------------------------------ */

/// Tiny recursive-descent evaluator: + - * / % ^, parentheses, unary minus, decimals.
pub fn evaluate(expr: &str) -> Option<f64> {
    if expr.len() > 128 || expr.chars().count() > 128 {
        return None;
    }
    if expr
        .chars()
        .any(|c| !c.is_ascii_digit() && !"+-*/%^(). \t\r\n".contains(c))
    {
        return None;
    }
    let cleaned: String = expr
        .chars()
        .filter(|c| c.is_ascii_digit() || "+-*/%^(). ".contains(*c))
        .collect();
    let mut chars: Vec<char> = cleaned.chars().filter(|c| !c.is_whitespace()).collect();
    if chars.is_empty()
        || !chars.iter().any(|c| c.is_ascii_digit())
        || !chars.iter().any(|c| "+-*/%^".contains(*c))
    {
        return None;
    }
    let mut pos = 0usize;
    let value = parse_expr(&mut chars, &mut pos)?;
    if pos != chars.len() || !value.is_finite() {
        return None;
    }
    Some(value)
}

fn parse_expr(chars: &mut [char], pos: &mut usize) -> Option<f64> {
    let mut value = parse_term(chars, pos)?;
    while *pos < chars.len() {
        match chars[*pos] {
            '+' => {
                *pos += 1;
                value += parse_term(chars, pos)?;
            }
            '-' => {
                *pos += 1;
                value -= parse_term(chars, pos)?;
            }
            _ => break,
        }
    }
    Some(value)
}

fn parse_term(chars: &mut [char], pos: &mut usize) -> Option<f64> {
    let mut value = parse_power(chars, pos)?;
    while *pos < chars.len() {
        match chars[*pos] {
            '*' => {
                *pos += 1;
                value *= parse_power(chars, pos)?;
            }
            '/' => {
                *pos += 1;
                let d = parse_power(chars, pos)?;
                if d == 0.0 {
                    return None;
                }
                value /= d;
            }
            '%' => {
                *pos += 1;
                let d = parse_power(chars, pos)?;
                if d == 0.0 {
                    return None;
                }
                value %= d;
            }
            _ => break,
        }
    }
    Some(value)
}

fn parse_power(chars: &mut [char], pos: &mut usize) -> Option<f64> {
    let base = parse_unary(chars, pos)?;
    if *pos < chars.len() && chars[*pos] == '^' {
        *pos += 1;
        let exp = parse_power(chars, pos)?;
        return Some(base.powf(exp));
    }
    Some(base)
}

fn parse_unary(chars: &mut [char], pos: &mut usize) -> Option<f64> {
    if *pos < chars.len() && chars[*pos] == '-' {
        *pos += 1;
        return Some(-parse_unary(chars, pos)?);
    }
    parse_atom(chars, pos)
}

fn parse_atom(chars: &mut [char], pos: &mut usize) -> Option<f64> {
    if *pos >= chars.len() {
        return None;
    }
    if chars[*pos] == '(' {
        *pos += 1;
        let v = parse_expr(chars, pos)?;
        if *pos < chars.len() && chars[*pos] == ')' {
            *pos += 1;
            return Some(v);
        }
        return None;
    }
    let start = *pos;
    while *pos < chars.len() && (chars[*pos].is_ascii_digit() || chars[*pos] == '.') {
        *pos += 1;
    }
    if start == *pos {
        return None;
    }
    let s: String = chars[start..*pos].iter().collect();
    s.parse::<f64>().ok()
}

/* -------------------------------- search -------------------------------- */

pub fn search(
    apps: &[crate::types::InstalledApp],
    files: &[(String, String)],
    query: &str,
) -> Vec<SearchResult> {
    let raw_query = query.trim();
    let normalized_query = raw_query.to_lowercase();
    let q = if normalized_query.chars().count() > 128 {
        normalized_query.chars().take(128).collect::<String>()
    } else {
        normalized_query
    };
    let mut results: Vec<SearchResult> = Vec::new();

    // 1. Calculator
    if let Some(value) = evaluate(&q) {
        let pretty = if (value.fract()).abs() < 1e-9 {
            format!("{}", value as i64)
        } else {
            format!("{value}")
        };
        results.push(SearchResult {
            id: "calc".into(),
            title: pretty.clone(),
            subtitle: Some(format!("{query} = {pretty}  ·  Enter to copy")),
            kind: "calc".into(),
            icon: None,
            action: "copy".into(),
            target: pretty,
            score: 5000.0,
        });
    }

    // Empty query -> a small sensible default set (apps, name-sorted upstream).
    if q.is_empty() {
        for app in apps.iter().take(DEFAULT_APP_LIMIT) {
            results.push(SearchResult {
                id: format!("app:{}", app.target),
                title: app.name.clone(),
                subtitle: Some("Application".into()),
                kind: "app".into(),
                icon: app.icon.clone(),
                action: "launch".into(),
                target: app.target.clone(),
                score: 10.0,
            });
        }
        results.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        results.truncate(MAX_RESULTS);
        return results;
    }

    // 2. Apps (small preference bonus: launching apps is the common case).
    let app_hits = top_hits(
        apps.iter().filter_map(|a| {
            let s = score(&q, &a.name.to_lowercase());
            (s > 0.0).then_some((s + 40.0, a))
        }),
        6,
        |app| app.name.as_str(),
    );
    for (s, app) in app_hits {
        results.push(SearchResult {
            id: format!("app:{}", app.target),
            title: app.name.clone(),
            subtitle: Some("Application".into()),
            kind: "app".into(),
            icon: app.icon.clone(),
            action: "launch".into(),
            target: app.target.clone(),
            score: s,
        });
    }

    // 3. Files
    let file_hits = top_hits(
        files.iter().filter_map(|f| {
            let name_score = score(&q, &f.0);
            let path_score = score(&q, &f.1.to_lowercase()) - 240.0;
            let s = name_score.max(path_score);
            (s > 0.0).then_some((s, f))
        }),
        6,
        |file| file.1.as_str(),
    );
    for (s, (_, path)) in file_hits {
        let name = Path::new(path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone());
        let parent = Path::new(path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        results.push(SearchResult {
            id: format!("file:{path}"),
            title: name,
            subtitle: Some(parent),
            kind: "file".into(),
            icon: None,
            action: "open".into(),
            target: path.clone(),
            score: s,
        });
    }

    // 4. Open a URL directly
    if looks_like_url(&q) {
        let url = if raw_query
            .get(..7)
            .is_some_and(|scheme| scheme.eq_ignore_ascii_case("http://"))
        {
            format!("http://{}", &raw_query[7..])
        } else if raw_query
            .get(..8)
            .is_some_and(|scheme| scheme.eq_ignore_ascii_case("https://"))
        {
            format!("https://{}", &raw_query[8..])
        } else {
            format!("https://{raw_query}")
        };
        results.push(SearchResult {
            id: format!("url:{url}"),
            title: format!("Open {url}"),
            subtitle: Some("Website".into()),
            kind: "url".into(),
            icon: None,
            action: "open".into(),
            target: url,
            score: 900.0,
        });
    }

    // 5. Web search
    results.push(SearchResult {
        id: "web".into(),
        title: format!("Search the web for \u{201c}{query}\u{201d}"),
        subtitle: Some("Google".into()),
        kind: "web".into(),
        icon: None,
        action: "open".into(),
        target: format!("https://www.google.com/search?q={}", urlencode(raw_query)),
        score: 1.0,
    });

    results.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    results.truncate(MAX_RESULTS);
    results
}

fn looks_like_url(q: &str) -> bool {
    let candidate = q
        .strip_prefix("http://")
        .or_else(|| q.strip_prefix("https://"))
        .unwrap_or(q);
    let host = candidate.split('/').next().unwrap_or_default();
    (q.starts_with("http://")
        || q.starts_with("https://")
        || (host.contains('.') && !q.contains(char::is_whitespace) && q.len() > 3))
        && !candidate.is_empty()
}

/// Keep only the best `limit` candidates while walking the bounded index.
fn top_hits<'a, T: 'a>(
    hits: impl Iterator<Item = (f64, &'a T)>,
    limit: usize,
    key: impl Fn(&'a T) -> &'a str,
) -> Vec<(f64, &'a T)> {
    let mut best = Vec::with_capacity(limit);
    for hit in hits {
        if hit.0 <= 0.0 || !hit.0.is_finite() {
            continue;
        }
        let at = best
            .iter()
            .position(|item: &(f64, &'a T)| {
                hit.0 > item.0 || (hit.0 == item.0 && key(hit.1) < key(item.1))
            })
            .unwrap_or(best.len());
        if at < limit {
            best.insert(at, hit);
        }
        if best.len() > limit {
            best.pop();
        }
    }
    best
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            b' ' => "+".to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/* ------------------------------- commands ------------------------------- */

#[tauri::command]
pub fn spotlight_search(state: State<AppState>, query: String) -> Vec<SearchResult> {
    let apps = Arc::clone(&state.apps.lock().unwrap());
    let files = Arc::clone(&state.files.lock().unwrap());
    search(&apps, &files, &query)
}

#[tauri::command]
pub async fn spotlight_reindex(state: State<'_, AppState>) -> Result<usize, String> {
    let (apps_list, files) =
        tauri::async_runtime::spawn_blocking(|| (apps::list(), build_file_index()))
            .await
            .map_err(|error| format!("Search index refresh failed: {error}"))?;
    let count = files.len();
    *state.apps.lock().unwrap() = Arc::new(apps_list);
    *state.files.lock().unwrap() = Arc::new(files);
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::InstalledApp;

    fn app(name: &str, target: &str) -> InstalledApp {
        InstalledApp {
            id: target.into(),
            name: name.into(),
            target: target.into(),
            kind: "win32".into(),
            icon: None,
            last_used: None,
            use_count: 0,
        }
    }

    #[test]
    fn exact_and_prefix_names_rank_before_path_matches() {
        let apps = vec![app("Notepad", "a"), app("Note", "b")];
        let files = vec![
            ("notes.txt".into(), "C:/Documents/notes.txt".into()),
            ("report.txt".into(), "C:/Notes/report.txt".into()),
        ];
        let results = search(&apps, &files, "note");
        assert_eq!(results[0].title, "Note");
        assert_eq!(results[1].title, "Notepad");
        assert_eq!(results.iter().filter(|r| r.kind == "file").count(), 2);
    }

    #[test]
    fn search_is_unicode_case_insensitive_and_path_aware() {
        let files = vec![("notes.txt".into(), "C:/資料/notes.txt".into())];
        let result = search(&[], &files, "資料");
        assert!(result.iter().any(|row| row.kind == "file"));
        assert!(score("é", &"École".to_lowercase()) > 0.0);
    }

    #[test]
    fn calculator_rejects_hidden_trailing_text_and_non_finite_results() {
        assert_eq!(evaluate("2 + 3"), Some(5.0));
        assert_eq!(evaluate("2 + 3 abc"), None);
        assert_eq!(evaluate("10 / 0"), None);
        assert_eq!(evaluate("2^9999"), None);
    }

    #[test]
    fn web_search_encoding_and_url_detection_are_stable() {
        assert!(looks_like_url("https://example.com/a"));
        assert!(looks_like_url("example.com"));
        assert!(!looks_like_url("two words.example"));
        assert_eq!(urlencode("café & tea"), "caf%C3%A9+%26+tea");
        let results = search(&[], &[], "https://example.com/CaseSensitive");
        assert_eq!(
            results.iter().find(|row| row.kind == "url").unwrap().target,
            "https://example.com/CaseSensitive"
        );
    }
}
