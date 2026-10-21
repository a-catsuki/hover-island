use crate::state::AppState;
use crate::types::InstalledApp;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

fn walk(dir: &Path, out: &mut Vec<PathBuf>, depth: usize) {
    if depth > 6 || out.len() >= 1500 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= 1500 {
            return;
        }
        let path = entry.path();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            walk(&path, out, depth + 1);
        } else if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
            let ext = ext.to_ascii_lowercase();
            if ext == "lnk" || ext == "url" {
                out.push(path);
            }
        }
    }
}

pub fn list() -> Vec<InstalledApp> {
    let mut files: Vec<PathBuf> = Vec::new();
    if let Ok(appdata) = std::env::var("APPDATA") {
        walk(
            &PathBuf::from(&appdata).join("Microsoft\\Windows\\Start Menu\\Programs"),
            &mut files,
            0,
        );
    }
    if let Ok(programdata) = std::env::var("PROGRAMDATA") {
        walk(
            &PathBuf::from(&programdata).join("Microsoft\\Windows\\Start Menu\\Programs"),
            &mut files,
            0,
        );
    }

    let mut apps: Vec<InstalledApp> = files
        .into_iter()
        .filter_map(|path| {
            let name = path.file_stem()?.to_string_lossy().to_string();
            if name.is_empty() {
                return None;
            }
            let is_url = path
                .extension()
                .and_then(|s| s.to_str())
                .map(|e| e.eq_ignore_ascii_case("url"))
                .unwrap_or(false);
            let target = path.to_string_lossy().to_string();
            Some(InstalledApp {
                id: target.clone(),
                name,
                target,
                kind: if is_url {
                    "url".into()
                } else {
                    "desktop".into()
                },
                icon: None,
            })
        })
        .collect();

    apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    apps.dedup_by(|a, b| a.name.eq_ignore_ascii_case(&b.name));
    apps.truncate(400);
    apps
}

pub fn launch(app: &AppHandle, target: &str) -> Result<(), String> {
    let path = Path::new(target);
    if target.trim().is_empty() || !path.exists() || (!path.is_file() && !path.is_dir()) {
        return Err("The selected file or application is unavailable".into());
    }
    app.opener()
        .open_path(target.to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

pub fn open_url(app: &AppHandle, url: &str) -> Result<(), String> {
    let trimmed = url.trim();
    let authority = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
        .ok_or_else(|| "Only HTTP and HTTPS addresses can be opened".to_string())?
        .split(|c| c == '/' || c == '?' || c == '#')
        .next()
        .unwrap_or_default();
    if authority.is_empty()
        || authority.contains('\\')
        || trimmed.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err("Only HTTP and HTTPS addresses can be opened".into());
    }
    app.opener()
        .open_url(url.to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

/* ------------------------------- commands ------------------------------- */

#[tauri::command]
pub fn apps_list(state: State<AppState>) -> Vec<InstalledApp> {
    state.apps.lock().unwrap().as_ref().clone()
}

#[tauri::command]
pub fn apps_launch(app: AppHandle, target: String) -> Result<(), String> {
    launch(&app, &target)
}

#[tauri::command]
pub fn apps_open_url(app: AppHandle, url: String) -> Result<(), String> {
    open_url(&app, &url)
}

fn web_app_url(input: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(input.trim())
        .map_err(|_| "Enter a valid website address".to_string())?;
    if !matches!(url.scheme(), "https" | "http")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Use an HTTP or HTTPS website address".into());
    }
    Ok(url.to_string())
}

#[tauri::command]
pub fn apps_open_web_app(app: AppHandle, url: String) -> Result<(), String> {
    let url = web_app_url(&url)?;
    // Reuse the user's regular browser profile. Account sign-in stays in that browser.
    #[cfg(windows)]
    {
        let mut roots = Vec::new();
        for key in ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"] {
            if let Ok(root) = std::env::var(key) {
                roots.push(PathBuf::from(root));
            }
        }
        for suffix in [
            "BraveSoftware/Brave-Browser/Application/brave.exe",
            "Google/Chrome/Application/chrome.exe",
            "Microsoft/Edge/Application/msedge.exe",
        ] {
            for root in &roots {
                let binary = root.join(suffix);
                if binary.is_file() {
                    std::process::Command::new(binary)
                        .arg(format!("--app={url}"))
                        .spawn()
                        .map_err(|error| error.to_string())?;
                    return Ok(());
                }
            }
        }
    }
    open_url(&app, &url)
}

#[cfg(test)]
mod web_app_tests {
    use super::web_app_url;
    #[test]
    fn web_app_launch_accepts_web_origins_and_rejects_commands_and_embedded_credentials() {
        assert_eq!(
            web_app_url("HTTPS://mail.google.com").unwrap(),
            "https://mail.google.com/"
        );
        assert!(web_app_url("file:///C:/private").is_err());
        assert!(web_app_url("https://user:password@example.com").is_err());
        assert!(web_app_url("cmd.exe /c example").is_err());
    }
}
