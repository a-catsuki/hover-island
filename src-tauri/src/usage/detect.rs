//! Read-only detection of locally installed AI developer tools.
//!
//! Detection enriches recent activity from known configuration/install roots,
//! PATH matches and running process names. It never reads config contents,
//! credentials or command lines, never uploads anything, and never recursively
//! walks the whole disk. Config/PATH presence alone is not user activity.
use std::path::{Path, PathBuf};

use serde::Serialize;

const MAX_EVIDENCE: usize = 6;
const MAX_SEARCH_DIRS: usize = 512;
const MAX_GLOB_ENTRIES: usize = 512;
const MAX_ACTIVITY_ENTRIES: usize = 512;
const MAX_ACTIVITY_DEPTH: usize = 4;
const RECENT_ACTIVITY_MS: u128 = 7 * 24 * 60 * 60 * 1000;

/// One AI tool found on this PC.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedProvider {
    pub id: String,
    pub label: String,
    /// Where the strongest evidence was found: "cli", "app" or "config".
    pub kind: String,
    /// Home-relative evidence such as `~/.codex` or `codex on PATH`.
    pub evidence: Vec<String>,
    /// `true` only when a real local quota or activity source exists.
    pub supported: bool,
    /// "live-quota" and/or "local-activity"; empty when nothing local exists.
    pub capabilities: Vec<String>,
}

#[derive(Clone, Copy)]
enum Base {
    Home,
    AppData,
    LocalAppData,
}

struct ConfigLoc {
    base: Base,
    path: &'static str,
    kind: &'static str,
}

struct GlobLoc {
    base: Base,
    prefix: &'static str,
    kind: &'static str,
}

struct Candidate {
    id: &'static str,
    label: &'static str,
    configs: &'static [ConfigLoc],
    globs: &'static [GlobLoc],
    binaries: &'static [&'static str],
    path_kind: &'static str,
    supported: bool,
    capabilities: &'static [&'static str],
    process_names: &'static [&'static str],
    activity_roots: &'static [ConfigLoc],
}

const CANDIDATES: &[Candidate] = &[
    Candidate {
        id: "codex",
        label: "Codex",
        configs: &[ConfigLoc {
            base: Base::Home,
            path: ".codex",
            kind: "config",
        }],
        globs: &[],
        binaries: &["codex"],
        path_kind: "cli",
        supported: true,
        capabilities: &["live-quota", "local-activity"],
        process_names: &["codex.exe", "codex"],
        activity_roots: &[ConfigLoc {
            base: Base::Home,
            path: ".codex/sessions",
            kind: "cli",
        }],
    },
    Candidate {
        id: "claude-code",
        label: "Claude Code",
        configs: &[
            ConfigLoc {
                base: Base::Home,
                path: ".claude",
                kind: "config",
            },
            ConfigLoc {
                base: Base::Home,
                path: ".config/claude",
                kind: "config",
            },
        ],
        globs: &[],
        binaries: &["claude"],
        path_kind: "cli",
        supported: true,
        capabilities: &["local-activity"],
        process_names: &["claude.exe", "claude"],
        activity_roots: &[ConfigLoc {
            base: Base::Home,
            path: ".claude/projects",
            kind: "cli",
        }],
    },
    Candidate {
        id: "gemini",
        label: "Gemini CLI",
        configs: &[
            ConfigLoc {
                base: Base::Home,
                path: ".gemini",
                kind: "config",
            },
            ConfigLoc {
                base: Base::Home,
                path: ".config/gemini",
                kind: "config",
            },
        ],
        globs: &[],
        binaries: &["gemini"],
        path_kind: "cli",
        supported: false,
        capabilities: &[],
        process_names: &["gemini.exe", "gemini"],
        activity_roots: &[],
    },
    Candidate {
        id: "grok",
        label: "Grok",
        configs: &[
            ConfigLoc {
                base: Base::Home,
                path: ".grok",
                kind: "config",
            },
            ConfigLoc {
                base: Base::Home,
                path: ".config/grok",
                kind: "config",
            },
        ],
        globs: &[],
        binaries: &["grok"],
        path_kind: "cli",
        supported: false,
        capabilities: &[],
        process_names: &["grok.exe", "grok"],
        activity_roots: &[],
    },
    Candidate {
        id: "cursor",
        label: "Cursor",
        configs: &[
            ConfigLoc {
                base: Base::Home,
                path: ".cursor",
                kind: "config",
            },
            ConfigLoc {
                base: Base::AppData,
                path: "Cursor",
                kind: "app",
            },
        ],
        globs: &[],
        binaries: &["cursor"],
        path_kind: "app",
        supported: false,
        capabilities: &[],
        process_names: &["cursor.exe"],
        activity_roots: &[],
    },
    Candidate {
        id: "opencode",
        label: "OpenCode",
        configs: &[
            ConfigLoc {
                base: Base::Home,
                path: ".config/opencode",
                kind: "config",
            },
            ConfigLoc {
                base: Base::AppData,
                path: "opencode",
                kind: "app",
            },
        ],
        globs: &[],
        binaries: &["opencode"],
        path_kind: "cli",
        supported: false,
        capabilities: &[],
        process_names: &["opencode.exe", "opencode"],
        activity_roots: &[],
    },
    Candidate {
        id: "deepseek",
        label: "DeepSeek",
        configs: &[
            ConfigLoc {
                base: Base::Home,
                path: ".deepseek",
                kind: "config",
            },
            ConfigLoc {
                base: Base::Home,
                path: ".config/deepseek",
                kind: "config",
            },
        ],
        globs: &[],
        binaries: &["deepseek"],
        path_kind: "cli",
        supported: false,
        capabilities: &[],
        process_names: &["deepseek.exe", "deepseek"],
        activity_roots: &[],
    },
    Candidate {
        id: "github-copilot",
        label: "GitHub Copilot",
        configs: &[ConfigLoc {
            base: Base::Home,
            path: ".config/github-copilot",
            kind: "config",
        }],
        globs: &[],
        binaries: &["copilot"],
        path_kind: "cli",
        supported: false,
        capabilities: &[],
        process_names: &["copilot.exe", "copilot"],
        activity_roots: &[],
    },
    Candidate {
        id: "windsurf",
        label: "Windsurf",
        configs: &[ConfigLoc {
            base: Base::AppData,
            path: "Windsurf",
            kind: "app",
        }],
        globs: &[],
        binaries: &["windsurf"],
        path_kind: "app",
        supported: false,
        capabilities: &[],
        process_names: &["windsurf.exe"],
        activity_roots: &[],
    },
    Candidate {
        id: "zed",
        label: "Zed",
        configs: &[ConfigLoc {
            base: Base::Home,
            path: ".config/zed",
            kind: "config",
        }],
        globs: &[],
        binaries: &["zed"],
        path_kind: "app",
        supported: false,
        capabilities: &[],
        process_names: &["zed.exe", "zed"],
        activity_roots: &[],
    },
    Candidate {
        id: "aider",
        label: "Aider",
        configs: &[],
        globs: &[GlobLoc {
            base: Base::Home,
            prefix: ".aider",
            kind: "config",
        }],
        binaries: &["aider"],
        path_kind: "cli",
        supported: false,
        capabilities: &[],
        process_names: &["aider.exe", "aider"],
        activity_roots: &[],
    },
    Candidate {
        id: "ollama",
        label: "Ollama",
        configs: &[ConfigLoc {
            base: Base::Home,
            path: ".ollama",
            kind: "config",
        }],
        globs: &[],
        binaries: &["ollama"],
        path_kind: "cli",
        supported: false,
        capabilities: &[],
        process_names: &["ollama.exe", "ollama"],
        activity_roots: &[],
    },
    Candidate {
        id: "lm-studio",
        label: "LM Studio",
        configs: &[ConfigLoc {
            base: Base::LocalAppData,
            path: "LM-Studio",
            kind: "app",
        }],
        globs: &[],
        binaries: &["lms"],
        path_kind: "app",
        supported: false,
        capabilities: &[],
        process_names: &["lms.exe", "lmstudio.exe"],
        activity_roots: &[],
    },
];

struct Bases {
    home: Option<PathBuf>,
    appdata: Option<PathBuf>,
    local_appdata: Option<PathBuf>,
    search_paths: Vec<PathBuf>,
    running_processes: Vec<String>,
}

impl Bases {
    fn dir(&self, base: Base) -> Option<&Path> {
        match base {
            Base::Home => self.home.as_deref(),
            Base::AppData => self.appdata.as_deref(),
            Base::LocalAppData => self.local_appdata.as_deref(),
        }
    }

    fn label(base: Base) -> &'static str {
        match base {
            Base::Home => "~",
            Base::AppData => "%APPDATA%",
            Base::LocalAppData => "%LOCALAPPDATA%",
        }
    }
}

fn current_bases() -> Bases {
    let search_paths = std::env::var_os("PATH")
        .map(|value| {
            std::env::split_paths(&value)
                .take(MAX_SEARCH_DIRS)
                .collect()
        })
        .unwrap_or_default();
    Bases {
        home: dirs::home_dir(),
        appdata: std::env::var_os("APPDATA").map(PathBuf::from),
        local_appdata: std::env::var_os("LOCALAPPDATA").map(PathBuf::from),
        search_paths,
        running_processes: running_process_names(),
    }
}

/// Join a forward-slash separated relative path onto a base directory.
fn join_rel(base: &Path, rel: &str) -> PathBuf {
    rel.split('/')
        .fold(base.to_path_buf(), |path, part| path.join(part))
}

fn is_present_without_following_symlinks(path: &Path) -> bool {
    std::fs::symlink_metadata(path)
        .map(|meta| !meta.file_type().is_symlink())
        .unwrap_or(false)
}

/// Resolve an executable on `PATH` without spawning a shell.
fn find_on_path(search_paths: &[PathBuf], binary: &str) -> Option<PathBuf> {
    let names: Vec<String> = if cfg!(windows) {
        ["exe", "cmd", "bat", "com"]
            .iter()
            .map(|ext| format!("{binary}.{ext}"))
            .chain(std::iter::once(binary.to_string()))
            .collect()
    } else {
        vec![binary.to_string()]
    };
    for dir in search_paths.iter().take(MAX_SEARCH_DIRS) {
        for name in &names {
            let candidate = dir.join(name);
            if is_present_without_following_symlinks(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(windows)]
fn running_process_names() -> Vec<String> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let Ok(snapshot) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else {
        return Vec::new();
    };
    let mut names = Vec::new();
    let mut entry = PROCESSENTRY32W::default();
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    if unsafe { Process32FirstW(snapshot, &mut entry) }.is_ok() {
        loop {
            let end = entry
                .szExeFile
                .iter()
                .position(|unit| *unit == 0)
                .unwrap_or(entry.szExeFile.len());
            names.push(String::from_utf16_lossy(&entry.szExeFile[..end]).to_ascii_lowercase());
            if unsafe { Process32NextW(snapshot, &mut entry) }.is_err() {
                break;
            }
        }
    }
    let _ = unsafe { CloseHandle(snapshot) };
    names
}

#[cfg(not(windows))]
fn running_process_names() -> Vec<String> {
    Vec::new()
}

fn recent_activity(root: &Path) -> Option<String> {
    let mut pending = vec![(root.to_path_buf(), 0usize)];
    let mut visited = 0usize;
    let mut newest: Option<(std::time::SystemTime, PathBuf)> = None;
    while let Some((dir, depth)) = pending.pop() {
        if depth > MAX_ACTIVITY_DEPTH {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            visited += 1;
            if visited > MAX_ACTIVITY_ENTRIES {
                break;
            }
            let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
                continue;
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            let path = entry.path();
            if meta.is_dir() {
                if depth < MAX_ACTIVITY_DEPTH {
                    pending.push((path, depth + 1));
                }
                continue;
            }
            if !meta.is_file() || path.extension().map_or(true, |ext| ext != "jsonl") {
                continue;
            }
            let Ok(modified) = meta.modified() else {
                continue;
            };
            let Ok(age) = std::time::SystemTime::now().duration_since(modified) else {
                continue;
            };
            if age.as_millis() > RECENT_ACTIVITY_MS {
                continue;
            }
            if newest.as_ref().map_or(true, |(known, _)| modified > *known) {
                newest = Some((modified, path));
            }
        }
        if visited > MAX_ACTIVITY_ENTRIES {
            break;
        }
    }
    newest.map(|(_, path)| {
        path.file_name()
            .map(|name| format!("recent session log: {}", name.to_string_lossy()))
            .unwrap_or_else(|| "recent session log".into())
    })
}

fn detect_with(bases: &Bases) -> Vec<DetectedProvider> {
    let mut found = Vec::new();
    for candidate in CANDIDATES {
        let mut evidence: Vec<String> = Vec::new();
        let mut kind: Option<&'static str> = None;

        let running = candidate.process_names.iter().any(|name| {
            bases
                .running_processes
                .iter()
                .any(|running| running.eq_ignore_ascii_case(name))
        });
        if running {
            kind = Some(candidate.path_kind);
            evidence.push(format!("{} running", candidate.process_names[0]));
        }

        for activity in candidate.activity_roots {
            let Some(base_dir) = bases.dir(activity.base) else {
                continue;
            };
            let path = join_rel(base_dir, activity.path);
            if let Some(detail) = recent_activity(&path) {
                kind.get_or_insert(activity.kind);
                evidence.push(format!(
                    "{}/{} ({detail})",
                    Bases::label(activity.base),
                    activity.path
                ));
            }
        }

        // Installation/config roots and PATH entries add context after actual
        // activity is established; they never create a provider row alone.
        let has_activity = !evidence.is_empty();
        if !has_activity {
            continue;
        }

        for config in candidate.configs {
            let Some(base_dir) = bases.dir(config.base) else {
                continue;
            };
            let path = join_rel(base_dir, config.path);
            if is_present_without_following_symlinks(&path) {
                kind.get_or_insert(config.kind);
                evidence.push(format!("{}/{}", Bases::label(config.base), config.path));
            }
        }

        for glob in candidate.globs {
            let Some(base_dir) = bases.dir(glob.base) else {
                continue;
            };
            let Ok(entries) = std::fs::read_dir(base_dir) else {
                continue;
            };
            let prefix = glob.prefix.to_ascii_lowercase();
            for entry in entries.flatten().take(MAX_GLOB_ENTRIES) {
                if entry
                    .file_type()
                    .map(|kind| kind.is_symlink())
                    .unwrap_or(true)
                {
                    continue;
                }
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.to_ascii_lowercase().starts_with(&prefix) {
                    kind.get_or_insert(glob.kind);
                    evidence.push(format!("{}/{}", Bases::label(glob.base), name));
                }
            }
        }

        for binary in candidate.binaries {
            if find_on_path(&bases.search_paths, binary).is_some() {
                kind.get_or_insert(candidate.path_kind);
                evidence.push(format!("{binary} on PATH"));
                break;
            }
        }

        let mut seen = std::collections::HashSet::new();
        evidence.retain(|item| seen.insert(item.clone()));
        evidence.truncate(MAX_EVIDENCE);

        found.push(DetectedProvider {
            id: candidate.id.into(),
            label: candidate.label.into(),
            kind: kind.unwrap_or("config").into(),
            evidence,
            supported: candidate.supported,
            capabilities: candidate
                .capabilities
                .iter()
                .map(|capability| (*capability).into())
                .collect(),
        });
    }
    found
}

/// Scan known, bounded, read-only locations for installed AI tools.
pub fn detect() -> Vec<DetectedProvider> {
    detect_with(&current_bases())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "hover-island-detect-{tag}-{}-{}",
            std::process::id(),
            crate::types::now_millis()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn home_bases(home: PathBuf) -> Bases {
        Bases {
            home: Some(home),
            appdata: None,
            local_appdata: None,
            search_paths: Vec::new(),
            running_processes: Vec::new(),
        }
    }

    #[test]
    fn detects_codex_only_when_recent_session_activity_exists() {
        let home = temp_dir("codex");
        fs::create_dir_all(home.join(".codex").join("sessions").join("2026").join("10")).unwrap();
        fs::write(
            home.join(".codex")
                .join("sessions")
                .join("2026")
                .join("10")
                .join("recent.jsonl"),
            b"metadata only",
        )
        .unwrap();
        let found = detect_with(&home_bases(home.clone()));
        let codex = found
            .iter()
            .find(|provider| provider.id == "codex")
            .expect("codex is detected");
        assert!(codex.supported);
        assert_eq!(codex.kind, "cli");
        assert_eq!(codex.capabilities, vec!["live-quota", "local-activity"]);
        assert!(codex
            .evidence
            .iter()
            .any(|item| item.contains("~/.codex/sessions")));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn detects_claude_logs_as_local_activity_only() {
        let home = temp_dir("claude");
        fs::create_dir_all(home.join(".claude").join("projects").join("active")).unwrap();
        fs::write(
            home.join(".claude")
                .join("projects")
                .join("active")
                .join("recent.jsonl"),
            b"metadata only",
        )
        .unwrap();
        let found = detect_with(&home_bases(home.clone()));
        let claude = found
            .iter()
            .find(|provider| provider.id == "claude-code")
            .expect("claude-code is detected");
        assert!(claude.supported);
        assert_eq!(claude.capabilities, vec!["local-activity"]);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn path_binary_alone_does_not_create_a_provider_row() {
        let home = temp_dir("path");
        let bin = home.join("bin");
        fs::create_dir_all(&bin).unwrap();
        fs::write(bin.join("gemini"), b"#!/bin/sh\n").unwrap();
        let mut bases = home_bases(home.clone());
        bases.search_paths = vec![bin];
        let found = detect_with(&bases);
        assert!(!found.iter().any(|provider| provider.id == "gemini"));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn configuration_presence_alone_does_not_create_provider_rows() {
        let home = temp_dir("aider");
        fs::write(home.join(".aider.conf.yml"), b"model: gpt").unwrap();
        let found = detect_with(&home_bases(home.clone()));
        assert!(!found.iter().any(|provider| provider.id == "aider"));
        assert!(!found.iter().any(|provider| provider.id == "codex"));
        assert!(!found.iter().any(|provider| provider.id == "gemini"));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn evidence_is_deduplicated_and_bounded() {
        let home = temp_dir("bounded");
        fs::create_dir_all(home.join(".codex").join("sessions")).unwrap();
        fs::write(
            home.join(".codex").join("sessions").join("recent.jsonl"),
            b"metadata only",
        )
        .unwrap();
        let mut bases = home_bases(home.clone());
        bases.search_paths = vec![home.clone()];
        bases.running_processes = vec!["codex.exe".into()];
        let found = detect_with(&bases);
        for provider in &found {
            assert!(provider.evidence.len() <= MAX_EVIDENCE);
        }
        let codex = found
            .iter()
            .find(|provider| provider.id == "codex")
            .unwrap();
        let unique: std::collections::HashSet<_> = codex.evidence.iter().collect();
        assert_eq!(unique.len(), codex.evidence.len());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn active_process_is_reported_but_configured_unrelated_apps_are_not() {
        let home = temp_dir("active");
        let mut bases = home_bases(home.clone());
        bases.running_processes = vec!["cursor.exe".into()];
        let found = detect_with(&bases);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "cursor");
        assert!(!found[0].supported);
        assert!(found[0]
            .evidence
            .iter()
            .any(|item| item == "cursor.exe running"));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    #[ignore = "opt-in read-only scan of bounded local provider metadata and running processes"]
    fn live_scan_reports_provider_ids_and_sanitized_evidence_counts() {
        let found = detect();
        if found.is_empty() {
            println!("no active or recently used AI providers detected");
            return;
        }

        for provider in found {
            // Deliberately print only the stable provider id and count. Evidence
            // strings can include local paths, so keep them out of test output.
            println!(
                "provider_id={}, evidence_count={}",
                provider.id,
                provider.evidence.len()
            );
        }
    }
}
