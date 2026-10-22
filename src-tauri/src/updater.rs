//! In-app updates for the signed MSIX build.
//!
//! The site publishes `updates/latest.json` next to the package. A check compares its version
//! with the running one; an install downloads the package, verifies its SHA-256, then hands it
//! to a one-shot scheduled task. The task runs outside the package, so Windows can replace the
//! app underneath it without killing the installer, and it reopens Hover Island afterwards.
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

use crate::types::now_millis;

const SITE: &str = "https://hover-island.vercel.app/";
const MANIFEST_URL: &str = "https://hover-island.vercel.app/updates/latest.json";
const MAX_MANIFEST_BYTES: usize = 64 * 1024;
const MAX_PACKAGE_BYTES: u64 = 300 * 1024 * 1024;
const TASK_NAME: &str = "HoverIslandUpdate";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: String,
    url: String,
    sha256: String,
    #[serde(default)]
    notes: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub current: String,
    pub latest: Option<String>,
    pub available: bool,
    pub notes: String,
    pub checked_at: u64,
    pub error: Option<String>,
}

static LAST_MANIFEST: Mutex<Option<Manifest>> = Mutex::new(None);
static INSTALLING: Mutex<bool> = Mutex::new(false);

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("Hover-Island/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("update client")
    })
}

/// "0.1.5" or "0.1.5.2" into four numbers. Anything else is not a version.
fn parse_version(text: &str) -> Option<[u64; 4]> {
    let mut out = [0u64; 4];
    let mut count = 0;
    for part in text.trim().trim_start_matches('v').split('.') {
        if count >= 4 || part.is_empty() || part.len() > 5 {
            return None;
        }
        out[count] = part.parse().ok()?;
        count += 1;
    }
    if count >= 2 {
        Some(out)
    } else {
        None
    }
}

fn is_newer(latest: &str, current: &str) -> bool {
    match (parse_version(latest), parse_version(current)) {
        (Some(latest), Some(current)) => latest > current,
        _ => false,
    }
}

fn valid_package_url(url: &str) -> bool {
    url.starts_with(SITE) && url.ends_with(".msix") && !url.contains("..") && !url.contains('\\')
}

fn valid_sha256(text: &str) -> bool {
    text.len() == 64 && text.chars().all(|c| c.is_ascii_hexdigit())
}

fn current_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

async fn fetch_manifest() -> Result<Manifest, String> {
    let response = client()
        .get(MANIFEST_URL)
        .header("Cache-Control", "no-cache")
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|_| "Couldn't reach the update server.".to_string())?;
    if !response.status().is_success() {
        return Err("No update information is published yet.".into());
    }
    let mut body: Vec<u8> = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "The update server stopped responding.".to_string())?;
        if body.len() + chunk.len() > MAX_MANIFEST_BYTES {
            return Err("The update information was too large.".into());
        }
        body.extend_from_slice(&chunk);
    }
    let manifest: Manifest =
        serde_json::from_slice(&body).map_err(|_| "The update information was unreadable.".to_string())?;
    if parse_version(&manifest.version).is_none() || !valid_package_url(&manifest.url) || !valid_sha256(&manifest.sha256) {
        return Err("The update information was invalid.".into());
    }
    Ok(manifest)
}

/// Looks for a newer build. Never fails loudly: problems come back in `error`.
pub async fn check(app: &AppHandle) -> UpdateStatus {
    let current = current_version(app);
    let mut status = UpdateStatus {
        current: current.clone(),
        latest: None,
        available: false,
        notes: String::new(),
        checked_at: now_millis(),
        error: None,
    };
    match fetch_manifest().await {
        Ok(manifest) => {
            status.available = is_newer(&manifest.version, &current);
            status.latest = Some(manifest.version.clone());
            status.notes = manifest.notes.chars().take(600).collect();
            if let Ok(mut slot) = LAST_MANIFEST.lock() {
                *slot = if status.available { Some(manifest) } else { None };
            }
        }
        Err(message) => status.error = Some(message),
    }
    status
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> UpdateStatus {
    let status = check(&app).await;
    let _ = app.emit("updater://status", &status);
    status
}

fn download_dir() -> Result<PathBuf, String> {
    // Not %TEMP%: packaged apps get AppData writes redirected, and the installer task
    // runs outside the package, so it would never see the file.
    let profile = std::env::var_os("USERPROFILE").ok_or("Couldn't find your user folder.")?;
    let dir = PathBuf::from(profile).join("Downloads").join("Hover Island Updates");
    std::fs::create_dir_all(&dir).map_err(|_| "Couldn't create the download folder.".to_string())?;
    Ok(dir)
}

async fn download(app: &AppHandle, manifest: &Manifest) -> Result<PathBuf, String> {
    let dir = download_dir()?;
    let path = dir.join(format!("HoverIsland-{}.msix", manifest.version));
    let response = client()
        .get(&manifest.url)
        .timeout(Duration::from_secs(900))
        .send()
        .await
        .map_err(|_| "The download couldn't start.".to_string())?;
    if !response.status().is_success() {
        return Err("The update package isn't available.".into());
    }
    let total = response.content_length().unwrap_or(0);
    if total > MAX_PACKAGE_BYTES {
        return Err("The update package is larger than expected.".into());
    }
    let mut file = tokio::fs::File::create(&path)
        .await
        .map_err(|_| "Couldn't save the update.".to_string())?;
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut last_percent = 0u64;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "The download was interrupted.".to_string())?;
        received += chunk.len() as u64;
        if received > MAX_PACKAGE_BYTES {
            return Err("The update package is larger than expected.".into());
        }
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|_| "Couldn't save the update.".to_string())?;
        if total > 0 {
            let percent = received * 100 / total;
            if percent >= last_percent + 2 {
                last_percent = percent;
                let _ = app.emit("updater://progress", percent);
            }
        }
    }
    file.flush().await.map_err(|_| "Couldn't save the update.".to_string())?;
    drop(file);
    let digest = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    if !digest.eq_ignore_ascii_case(&manifest.sha256) {
        let _ = std::fs::remove_file(&path);
        return Err("The download didn't match its checksum, so it wasn't installed.".into());
    }
    Ok(path)
}

fn script_for(package: &std::path::Path) -> String {
    let package = package.to_string_lossy().replace('\'', "''");
    format!(
        "Start-Sleep -Seconds 2\r\n\
         $ErrorActionPreference = 'Stop'\r\n\
         try {{ Add-AppxPackage -Path '{package}' -ForceUpdateFromAnyVersion -ForceApplicationShutdown }}\r\n\
         catch {{ $_.Exception.Message | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'last-error.txt') }}\r\n\
         $p = Get-AppxPackage -Name com.hoverisland.app | Select-Object -First 1\r\n\
         if ($p) {{ Start-Process explorer.exe ('shell:AppsFolder\\' + $p.PackageFamilyName + '!HoverIsland') }}\r\n\
         schtasks.exe /Delete /TN {TASK_NAME} /F | Out-Null\r\n"
    )
}

#[cfg(windows)]
fn hidden(command: &mut std::process::Command) -> &mut std::process::Command {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x0800_0000)
}

#[cfg(windows)]
fn launch_installer(script: &std::path::Path) -> Result<(), String> {
    let run = format!(
        "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"{}\"",
        script.display()
    );
    let created = hidden(
        std::process::Command::new("schtasks.exe").args([
            "/Create", "/TN", TASK_NAME, "/SC", "ONCE", "/ST", "00:00", "/F", "/TR", run.as_str(),
        ]),
    )
    .status()
    .map(|status| status.success())
    .unwrap_or(false);
    if created {
        let started = hidden(std::process::Command::new("schtasks.exe").args(["/Run", "/TN", TASK_NAME]))
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if started {
            return Ok(());
        }
    }
    // Fallback: run it directly. Windows may end it with the app, but it usually finishes.
    hidden(std::process::Command::new("powershell.exe").args([
        "-NoProfile",
        "-WindowStyle",
        "Hidden",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
    ]).arg(script))
    .spawn()
    .map(|_| ())
    .map_err(|_| "Couldn't start the installer.".to_string())
}

#[cfg(not(windows))]
fn launch_installer(_script: &std::path::Path) -> Result<(), String> {
    Err("Updates install on Windows only.".into())
}

#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    {
        let mut busy = INSTALLING.lock().map_err(|_| "Update state is unavailable.".to_string())?;
        if *busy {
            return Err("An update is already installing.".into());
        }
        *busy = true;
    }
    let result = install(&app).await;
    if result.is_err() {
        if let Ok(mut busy) = INSTALLING.lock() {
            *busy = false;
        }
    }
    result
}

async fn install(app: &AppHandle) -> Result<(), String> {
    let known = LAST_MANIFEST.lock().ok().and_then(|slot| slot.clone());
    let manifest = match known {
        Some(manifest) => manifest,
        None => {
            let fresh = fetch_manifest().await?;
            if !is_newer(&fresh.version, &current_version(app)) {
                return Err("You're already up to date.".into());
            }
            fresh
        }
    };
    let package = download(app, &manifest).await?;
    let script = package.with_file_name("apply-update.ps1");
    std::fs::write(&script, script_for(&package)).map_err(|_| "Couldn't prepare the installer.".to_string())?;
    let _ = app.emit("updater://progress", 100u64);
    launch_installer(&script)
}

/// Checks once a day while the app runs, starting shortly after launch. A newer build is
/// announced to the windows; nothing downloads or installs without a click.
pub fn spawn_auto_check(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(45)).await;
        loop {
            let enabled = {
                use tauri::Manager;
                app.state::<crate::state::AppState>()
                    .settings
                    .lock()
                    .map(|settings| settings.auto_update)
                    .unwrap_or(true)
            };
            if enabled {
                let status = check(&app).await;
                if status.available {
                    let _ = app.emit("updater://status", &status);
                }
            }
            tokio::time::sleep(Duration::from_secs(24 * 60 * 60)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_across_three_and_four_parts() {
        assert!(is_newer("0.1.6", "0.1.5"));
        assert!(is_newer("0.1.5.3", "0.1.5"));
        assert!(is_newer("v0.2", "0.1.9"));
        assert!(!is_newer("0.1.5", "0.1.5"));
        assert!(!is_newer("0.1.4", "0.1.5"));
        assert!(!is_newer("garbage", "0.1.5"));
        assert!(parse_version("1.2.3.4.5").is_none());
    }

    #[test]
    fn only_site_packages_with_real_hashes_are_accepted() {
        assert!(valid_package_url("https://hover-island.vercel.app/updates/HoverIsland-0.1.6.msix"));
        assert!(!valid_package_url("https://evil.example/HoverIsland.msix"));
        assert!(!valid_package_url("https://hover-island.vercel.app/updates/../x.msix"));
        assert!(!valid_package_url("https://hover-island.vercel.app/updates/x.exe"));
        assert!(valid_sha256(&"a".repeat(64)));
        assert!(!valid_sha256("abc"));
    }

    #[test]
    fn installer_script_quotes_the_package_path() {
        let script = script_for(std::path::Path::new("C:\\Users\\O'Neil\\x.msix"));
        assert!(script.contains("O''Neil"));
        assert!(script.contains("Add-AppxPackage"));
        assert!(script.contains("-ForceApplicationShutdown"));
    }
}
