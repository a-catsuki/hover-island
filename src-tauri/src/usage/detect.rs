//! Read-only detection of locally installed AI developer tools.
//!
//! Detection only checks for the presence of known configuration directories,
//! `.aider*` entries in the home directory, and executables on `PATH`. It never
//! reads file contents, never uploads anything, never follows symlinks, and
//! silently ignores permission errors. `supported` is `true` only when an
//! existing local quota or activity source is actually parsed elsewhere in this
//! module tree (Codex rate limits + local logs, Claude Code local logs).
use std::path::{Path, PathBuf};

use serde::Serialize;

const MAX_EVIDENCE: usize = 6;
const MAX_SEARCH_DIRS: usize = 512;
const MAX_GLOB_ENTRIES: usize = 512;

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
}

const CANDIDATES: &[Candidate] = &[
    Candidate {
        id: "codex",
        label: "Codex",
        configs: &[ConfigLoc { base: Base::Home, path: ".codex", kind: "config" }],
        globs: &[],
        binaries: &["codex"],
        path_kind: "cli",
        supported: true,
        capabilities: &["live-quota", "local-activity"],
    },
    Candidate {
        id: "claude-code",
        label: "Claude Code",
        configs: &[
            ConfigLoc { base: Base::Home, path: ".claude", kind: "config" },
            ConfigLoc { base: Base::Home, path: ".config/claude", kind: "config" },
        ],
        globs: &[],
        binaries: &["claude"],
        path_kind: "cli",
        supported: true,
        capabilities: &["local-activity"],
    },
    Candidate {
        id: "gemini",
        label: "Gemini CLI",
        configs: &[
            ConfigLoc { base: Base::Home, path: ".gemini", kind: "config" },
            ConfigLoc { base: Base::Home, path: ".config/gemini", kind: "config" },
        ],
        globs: &[],
        binaries: &["gemini"],
        path_kind: "cli",
        supported: false,
        capabilities: &[],
    },
    Candidate {
        id: "grok",
        label: "Grok",
        configs: &[
            ConfigLoc { base: Base::Home, path: ".grok", kind: "config" },
            ConfigLoc { base: Base::Home, path: ".config/grok", kind: "config" },
        ],
        globs: &[],
        binaries: &["grok"],
        path_kind: "cli",
        supported: false,
        capabilities: &[],
    },
    Candidate {
        id: "cursor",
        label: "Cursor",
        configs: &[
            ConfigLoc { base: Base::Home, path: ".cursor", kind: "config" },
            ConfigLoc { base: Base::AppData, path: "Cursor", kind: "app" },
        ],
        globs: &[],
        binaries: &["cursor"],
        path_kind: "app",
        supported: false,
        capabilities: &[],
    },
    Candidate {
        id: "opencode",
        label: "OpenCode",
        configs: &[
            ConfigLoc { base: Base::Home, path: ".config/opencode", kind: "config" },
            ConfigLoc { base: Base::AppData, path: "opencode", kind: "app" },
        ],
        globs: &[],
        binaries: &["opencode"],
        path_kind: "cli",
        supported: false,
        capabilities: &[],
    },
    Candidate {
        id: "deepseek",
        label: "DeepSeek",
        configs: &[
            ConfigLoc { base: Base::Home, path: ".deepseek", kind: "config" },
            ConfigLoc { base: Base::Home, path: ".config/deepseek", kind: "config" },
        ],
        globs: &[],
        binaries: &["deepseek"],
        path_kind: "cli",
        supported: false,
        capabilities: &[],
    },
    Candidate {
        id: "github-copilot",
        label: "GitHub Copilot",
        configs: &[ConfigLoc { base: Base::Home, path: ".config/github-copilot", kind: "config" }],
        globs: &[],
        binaries: &["copilot"],
        path_kind: "cli",
        supported: false,
        capabilities: &[],
    },
    Candidate {
        id: "windsurf",
        label: "Windsurf",
        configs: &[ConfigLoc { base: Base::AppData, path: "Windsurf", kind: "app" }],
        globs: &[],
        binaries: &["windsurf"],
        path_kind: "app",
        supported: false,
        capabilities: &[],
    },
    Candidate {
        id: "zed",
        label: "Zed",
        configs: &[ConfigLoc { base: Base::Home, path: ".config/zed", kind: "config" }],
        globs: &[],
        binaries: &["zed"],
        path_kind: "app",
        supported: false,
        capabilities: &[],
    },
    Candidate {
        id: "aider",
        label: "Aider",
        configs: &[],
        globs: &[GlobLoc { base: Base::Home, prefix: ".aider", kind: "config" }],
        binaries: &["aider"],
        path_kind: "cli",
        supported: false,
        capabilities: &[],
    },
    Candidate {
        id: "ollama",
        label: "Ollama",
        configs: &[ConfigLoc { base: Base::Home, path: ".ollama", kind: "config" }],
        globs: &[],
        binaries: &["ollama"],
        path_kind: "cli",
        supported: false,
        capabilities: &[],
    },
    Candidate {
        id: "lm-studio",
        label: "LM Studio",
        configs: &[ConfigLoc { base: Base::LocalAppData, path: "LM-Studio", kind: "app" }],
        globs: &[],
        binaries: &["lms"],
        path_kind: "app",
        supported: false,
        capabilities: &[],
    },
];

struct Bases {
    home: Option<PathBuf>,
    appdata: Option<PathBuf>,
    local_appdata: Option<PathBuf>,
    search_paths: Vec<PathBuf>,
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
    }
}

/// Join a forward-slash separated relative path onto a base directory.
fn join_rel(base: &Path, rel: &str) -> PathBuf {
    rel.split('/')
        .fold(base.to_path_buf(), |path, part| path.join(part))
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
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn detect_with(bases: &Bases) -> Vec<DetectedProvider> {
    let mut found = Vec::new();
    for candidate in CANDIDATES {
        let mut evidence: Vec<String> = Vec::new();
        let mut kind: Option<&'static str> = None;

        for config in candidate.configs {
            let Some(base_dir) = bases.dir(config.base) else {
                continue;
            };
            let path = join_rel(base_dir, config.path);
            if path.is_dir() || path.is_file() {
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

        if evidence.is_empty() {
            continue;
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
        }
    }

    #[test]
    fn detects_codex_config_dir_as_supported() {
        let home = temp_dir("codex");
        fs::create_dir_all(home.join(".codex")).unwrap();
        let found = detect_with(&home_bases(home.clone()));
        let codex = found
            .iter()
            .find(|provider| provider.id == "codex")
            .expect("codex is detected");
        assert!(codex.supported);
        assert_eq!(codex.kind, "config");
        assert_eq!(codex.capabilities, vec!["live-quota", "local-activity"]);
        assert!(codex.evidence.iter().any(|item| item == "~/.codex"));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn detects_claude_logs_as_local_activity_only() {
        let home = temp_dir("claude");
        fs::create_dir_all(home.join(".claude")).unwrap();
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
    fn detects_path_binary_without_config() {
        let home = temp_dir("path");
        let bin = home.join("bin");
        fs::create_dir_all(&bin).unwrap();
        fs::write(bin.join("gemini"), b"#!/bin/sh\n").unwrap();
        let mut bases = home_bases(home.clone());
        bases.search_paths = vec![bin];
        let found = detect_with(&bases);
        let gemini = found
            .iter()
            .find(|provider| provider.id == "gemini")
            .expect("gemini is detected");
        assert_eq!(gemini.kind, "cli");
        assert!(!gemini.supported);
        assert!(gemini.capabilities.is_empty());
        assert!(gemini.evidence.iter().any(|item| item == "gemini on PATH"));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn absent_providers_are_omitted_and_aider_globs_match() {
        let home = temp_dir("aider");
        fs::write(home.join(".aider.conf.yml"), b"model: gpt").unwrap();
        let found = detect_with(&home_bases(home.clone()));
        assert!(found.iter().any(|provider| provider.id == "aider"));
        assert!(!found.iter().any(|provider| provider.id == "codex"));
        assert!(!found.iter().any(|provider| provider.id == "gemini"));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn evidence_is_deduplicated_and_bounded() {
        let home = temp_dir("bounded");
        fs::create_dir_all(home.join(".codex")).unwrap();
        fs::create_dir_all(home.join(".config").join("claude")).unwrap();
        fs::write(home.join(".aider.conf.yml"), b"x").unwrap();
        let mut bases = home_bases(home.clone());
        bases.search_paths = vec![home.clone()];
        let found = detect_with(&bases);
        for provider in &found {
            assert!(provider.evidence.len() <= MAX_EVIDENCE);
        }
        let codex = found.iter().find(|provider| provider.id == "codex").unwrap();
        let unique: std::collections::HashSet<_> = codex.evidence.iter().collect();
        assert_eq!(unique.len(), codex.evidence.len());
        let _ = fs::remove_dir_all(home);
    }
}
