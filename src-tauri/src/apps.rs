use crate::state::AppState;
use crate::types::InstalledApp;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

const MAX_APPS: usize = 1500;
const CACHE_TTL: Duration = Duration::from_secs(60);
const ICON_TIMEOUT: Duration = Duration::from_secs(5);
const ICON_MISS_RETRY: Duration = Duration::from_secs(300);
const MAX_ICON_CACHE: usize = 96;
const MAX_ICON_CACHE_BYTES: usize = 2 * 1024 * 1024;
const MAX_ICON_WORKERS: usize = 4;

/* ------------------------------ small helpers ---------------------------- */

fn hidden_command(program: &str) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: never flash a console for a background lookup.
        command.creation_flags(0x0800_0000);
    }
    command
}

/// Runs a command and returns its stdout, or `None` if it fails or exceeds `timeout`.
fn run_with_timeout(mut command: Command, timeout: Duration) -> Option<Vec<u8>> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let child = command.spawn().ok()?;
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(child.wait_with_output());
    });
    let output = receiver.recv_timeout(timeout).ok()?.ok()?;
    output.status.success().then_some(output.stdout)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Lower-case letters and digits only, for comparing names across sources.
fn norm(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

fn u16le(data: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(data.get(at..at.checked_add(2)?)?.try_into().ok()?))
}
fn u32le(data: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(data.get(at..at.checked_add(4)?)?.try_into().ok()?))
}
fn u64le(data: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_le_bytes(data.get(at..at.checked_add(8)?)?.try_into().ok()?))
}

/// Looks like an AppUserModelId (`Package_hash!App`), never a path.
fn looks_like_aumid(target: &str) -> bool {
    target.len() <= 256
        && target.contains('!')
        && target
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '!'))
}

/* ----------------------------- shortcut targets -------------------------- */

/// Reads the local target path out of a `.lnk` file (Shell Link LinkInfo block).
/// Returns `None` for shortcuts without one, such as packaged apps and shell items.
pub fn parse_lnk_target(data: &[u8]) -> Option<String> {
    if u32le(data, 0)? != 0x4C {
        return None;
    }
    let flags = u32le(data, 0x14)?;
    let mut offset = 0x4C_usize;
    if flags & 0x1 != 0 {
        let size = u16le(data, offset)? as usize;
        offset = offset.checked_add(2)?.checked_add(size)?;
    }
    if flags & 0x2 == 0 {
        return None;
    }
    let info = offset;
    let info_size = u32le(data, info)? as usize;
    if info_size < 0x1C || info.checked_add(info_size)? > data.len() {
        return None;
    }
    let header_size = u32le(data, info.checked_add(4)?)? as usize;
    let info_flags = u32le(data, info.checked_add(8)?)?;
    if info_flags & 1 == 0 {
        return None;
    }
    let block = data.get(info..info + info_size)?;
    if header_size >= 0x24 {
        let unicode_at = u32le(block, 28)? as usize;
        if unicode_at != 0 && unicode_at < block.len() {
            let units: Vec<u16> = block[unicode_at..]
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .take_while(|unit| *unit != 0)
                .collect();
            let text = String::from_utf16_lossy(&units);
            if !text.is_empty() {
                return Some(text);
            }
        }
    }
    let base_at = u32le(block, 16)? as usize;
    if base_at == 0 || base_at >= block.len() {
        return None;
    }
    let bytes: Vec<u8> = block[base_at..]
        .iter()
        .copied()
        .take_while(|byte| *byte != 0)
        .collect();
    let text = String::from_utf8_lossy(&bytes).to_string();
    (!text.is_empty()).then_some(text)
}

fn lnk_target_of(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() > 256 * 1024 {
        return None;
    }
    parse_lnk_target(&std::fs::read(path).ok()?)
}

/* --------------------------------- inventory ------------------------------ */

fn walk(dir: &Path, out: &mut Vec<PathBuf>, depth: usize) {
    if depth > 6 || out.len() >= MAX_APPS {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= MAX_APPS {
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

fn skip_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    ["uninstall", "readme", "release notes", "documentation", "license"]
        .iter()
        .any(|word| lower.contains(word))
}

/// Start Menu shortcuts (all users and current user), each with its resolved exe when known.
fn start_menu_apps() -> Vec<(InstalledApp, Option<String>)> {
    let mut files: Vec<PathBuf> = Vec::new();
    for key in ["APPDATA", "PROGRAMDATA"] {
        if let Ok(root) = std::env::var(key) {
            walk(
                &PathBuf::from(root).join("Microsoft\\Windows\\Start Menu\\Programs"),
                &mut files,
                0,
            );
        }
    }
    files
        .into_iter()
        .filter_map(|path| {
            let name = path.file_stem()?.to_string_lossy().to_string();
            if name.is_empty() || skip_name(&name) {
                return None;
            }
            let is_url = path
                .extension()
                .and_then(|s| s.to_str())
                .map(|e| e.eq_ignore_ascii_case("url"))
                .unwrap_or(false);
            let exe = if is_url { None } else { lnk_target_of(&path) };
            let target = path.to_string_lossy().to_string();
            Some((
                InstalledApp {
                    id: target.clone(),
                    name,
                    target,
                    kind: if is_url { "url".into() } else { "win32".into() },
                    icon: None,
                    last_used: None,
                    use_count: 0,
                },
                exe.map(|value| value.to_lowercase()),
            ))
        })
        .collect()
}

/// Executable named by a registry `DisplayIcon` value (`"C:\\x\\a.exe",0`), if it exists.
fn exe_from_display_icon(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let path = if let Some(rest) = trimmed.strip_prefix('"') {
        rest.split('"').next()?.to_string()
    } else {
        match trimmed.rsplit_once(',') {
            Some((before, index)) if index.trim().trim_start_matches('-').chars().all(|c| c.is_ascii_digit()) => before.to_string(),
            _ => trimmed.to_string(),
        }
    };
    let path = path.trim().to_string();
    (path.to_lowercase().ends_with(".exe") && Path::new(&path).is_file()).then_some(path)
}

fn noisy_registry_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    ["redistributable", "visual c++", "update for", "hotfix", "security update", "runtime", "driver", "uninstall"]
        .iter()
        .any(|word| lower.contains(word))
}

/// Packaged (UWP/MSIX) apps from the Start menu and installed desktop programs from the registry.
fn native_inventory() -> (Vec<(String, String)>, Vec<(String, String)>) {
    let inventory = crate::app_inventory::read();
    let uwp = inventory.packaged.into_iter()
        .filter(|(_, id)| looks_like_aumid(id))
        .collect();
    let registry = inventory.desktop.into_iter()
        .filter_map(|(name, icon, location)| {
            if noisy_registry_name(&name) {
                return None;
            }
            let exe = exe_from_display_icon(&icon)
                .or_else(|| {
                    // No usable DisplayIcon: accept <InstallLocation>\<DisplayName>.exe.
                    let guess = Path::new(&location).join(format!("{name}.exe"));
                    guess.is_file().then(|| guess.to_string_lossy().to_string())
                })?;
            Some((name, exe))
        })
        .collect();
    (uwp, registry)
}

static EXES: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

/// Every launchable app: Start Menu shortcuts, packaged apps and registry-installed programs,
/// de-duplicated by name and executable, with Windows usage (last run, run count) attached.
/// Icons are not loaded here; ask for them lazily with `apps_icon`.
pub fn list() -> Vec<InstalledApp> {
    let mut entries = start_menu_apps();
    entries.sort_by(|a, b| a.0.name.to_lowercase().cmp(&b.0.name.to_lowercase()));
    let mut seen_names: HashSet<String> = HashSet::new();
    let mut seen_exes: HashSet<String> = HashSet::new();
    let mut apps: Vec<InstalledApp> = Vec::new();
    let mut exes: HashMap<String, String> = HashMap::new();
    for (app, exe) in entries {
        if !seen_names.insert(norm(&app.name)) {
            continue;
        }
        if let Some(exe) = exe {
            seen_exes.insert(exe.clone());
            exes.insert(app.id.clone(), exe);
        }
        apps.push(app);
    }
    let (uwp, registry) = native_inventory();
    for (name, aumid) in uwp {
        if skip_name(&name) || !seen_names.insert(norm(&name)) {
            continue;
        }
        apps.push(InstalledApp {
            id: aumid.clone(),
            name,
            target: aumid,
            kind: "uwp".into(),
            icon: None,
            last_used: None,
            use_count: 0,
        });
    }
    for (name, exe) in registry {
        let lower = exe.to_lowercase();
        if seen_exes.contains(&lower) || !seen_names.insert(norm(&name)) {
            continue;
        }
        seen_exes.insert(lower.clone());
        exes.insert(exe.clone(), lower);
        apps.push(InstalledApp {
            id: exe.clone(),
            name,
            target: exe,
            kind: "win32".into(),
            icon: None,
            last_used: None,
            use_count: 0,
        });
    }
    apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    apps.truncate(MAX_APPS);
    if let Ok(mut guard) = EXES.lock() {
        *guard = Some(exes);
    }
    let exe_map = EXES.lock().ok().and_then(|g| g.clone()).unwrap_or_default();
    apply_usage(&mut apps, &exe_map, &userassist_entries());
    apps
}

/* -------------------------------- UserAssist ------------------------------ */

#[derive(Debug, Clone, PartialEq)]
pub enum UsageTarget {
    Path(String),
    Aumid(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct UsageEntry {
    pub target: UsageTarget,
    pub last_used: Option<u64>,
    pub count: u32,
}

const USERASSIST_KEYS: [&str; 2] = [
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\UserAssist\\{CEBFF5CD-ACE2-4F4F-9178-9926F41749EA}\\Count",
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\UserAssist\\{F4E57C4B-2036-45F0-A9AB-443BCFE33D9F}\\Count",
];

fn rot13(value: &str) -> String {
    value
        .chars()
        .map(|c| match c {
            'a'..='z' => (((c as u8 - b'a') + 13) % 26 + b'a') as char,
            'A'..='Z' => (((c as u8 - b'A') + 13) % 26 + b'A') as char,
            other => other,
        })
        .collect()
}

fn env_path(key: &str) -> Option<PathBuf> {
    std::env::var_os(key).map(PathBuf::from)
}

/// KNOWNFOLDERID guid (upper-case, with braces) to a folder path.
fn known_folder(guid: &str) -> Option<PathBuf> {
    let windows = || env_path("SystemRoot").or_else(|| env_path("windir"));
    match guid {
        "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}" => windows().map(|w| w.join("System32")),
        "{D65231B0-B2F1-4857-A4CE-A8E7C6EA7D27}" => windows().map(|w| w.join("SysWOW64")),
        "{F38BF404-1D43-42F2-9305-67DE0B28FC23}" => windows(),
        "{905E63B6-C1BF-494E-B29C-65B732D3D21A}" | "{6D809377-6AF0-444B-8957-A3773F02200E}" => env_path("ProgramW6432").or_else(|| env_path("ProgramFiles")),
        "{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}" => env_path("ProgramFiles(x86)"),
        "{62AB5D82-FDC1-4DC3-A9DD-070D1D495D97}" => env_path("ProgramData"),
        "{3EB685DB-65F9-4CF6-A03A-E3EF65729F3D}" => env_path("APPDATA"),
        "{F1B32785-6FBA-4FCF-9D55-7B8E7F157091}" => env_path("LOCALAPPDATA"),
        "{5E6C858F-0E22-4760-9AFE-EA3317B67173}" => env_path("USERPROFILE"),
        "{0139D44E-6AFE-49F2-8690-3DAFCAE6FFB8}" => env_path("ProgramData").map(|p| p.join("Microsoft\\Windows\\Start Menu\\Programs")),
        "{A77F5D77-2E2B-44C3-A6A2-ABA601054A51}" => env_path("APPDATA").map(|p| p.join("Microsoft\\Windows\\Start Menu\\Programs")),
        "{A4115719-D62E-491D-AA7C-E74B8BE3B067}" => env_path("ProgramData").map(|p| p.join("Microsoft\\Windows\\Start Menu")),
        "{625B53C3-AB48-4EC1-BA1F-A1EF4146FC19}" => env_path("APPDATA").map(|p| p.join("Microsoft\\Windows\\Start Menu")),
        _ => None,
    }
}

/// Turns a decoded UserAssist value name into something an app can be matched against.
pub fn usage_target(decoded: &str) -> Option<UsageTarget> {
    let name = decoded.trim();
    if name.is_empty() || name.starts_with("UEME_") {
        return None;
    }
    if looks_like_aumid(name) {
        return Some(UsageTarget::Aumid(name.to_string()));
    }
    if let Some(rest) = name.strip_prefix('{') {
        let (guid, tail) = rest.split_once('}')?;
        let folder = known_folder(&format!("{{{}}}", guid.to_uppercase()))?;
        let tail = tail.trim_start_matches('\\');
        return (!tail.is_empty()).then(|| UsageTarget::Path(folder.join(tail).to_string_lossy().to_string()));
    }
    let lower = name.to_lowercase();
    ((lower.ends_with(".exe") || lower.ends_with(".lnk")) && (name.contains(":\\") || name.starts_with("\\\\")))
        .then(|| UsageTarget::Path(name.to_string()))
}

fn hex_bytes(hex: &str) -> Vec<u8> {
    let digits: Vec<u8> = hex.bytes().filter(|b| b.is_ascii_hexdigit()).collect();
    digits
        .chunks_exact(2)
        .filter_map(|pair| u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok())
        .collect()
}

/// Win7+ UserAssist record: run count at offset 4, last run FILETIME at offset 60.
pub fn parse_userassist_record(data: &[u8]) -> Option<(u32, Option<u64>)> {
    if data.len() < 68 {
        return None;
    }
    let count = u32le(data, 4)?;
    let filetime = u64le(data, 60)?;
    let last = if filetime == 0 {
        None
    } else {
        (filetime / 10_000).checked_sub(11_644_473_600_000)
    };
    Some((count, last))
}

/// Reads both UserAssist keys through `reg.exe` (no extra registry bindings needed).
fn userassist_entries() -> Vec<UsageEntry> {
    let mut out = Vec::new();
    for key in USERASSIST_KEYS {
        let mut command = hidden_command("reg");
        command.args(["query", key]);
        let Some(stdout) = run_with_timeout(command, Duration::from_secs(8)) else {
            continue;
        };
        let text = String::from_utf8_lossy(&stdout);
        for line in text.lines() {
            let Some((name, hex)) = line.split_once("    REG_BINARY    ") else {
                continue;
            };
            let Some(target) = usage_target(&rot13(name.trim())) else {
                continue;
            };
            let Some((count, last_used)) = parse_userassist_record(&hex_bytes(hex)) else {
                continue;
            };
            out.push(UsageEntry { target, last_used, count });
        }
    }
    out
}

fn file_name_lower(path: &str) -> Option<String> {
    let name = path.rsplit(['\\', '/']).next().unwrap_or("");
    if name.is_empty() {
        None
    } else {
        Some(name.to_lowercase())
    }
}

/// Attaches UserAssist usage to apps. Matches by shortcut path, resolved exe, AUMID, then exe name.
pub fn apply_usage(apps: &mut [InstalledApp], exes: &HashMap<String, String>, usage: &[UsageEntry]) {
    let mut by_path: HashMap<String, usize> = HashMap::new();
    let mut by_aumid: HashMap<String, usize> = HashMap::new();
    let mut by_exe_name: HashMap<String, usize> = HashMap::new();
    let mut by_name: HashMap<String, usize> = HashMap::new();
    for (index, app) in apps.iter().enumerate() {
        by_name.entry(norm(&app.name)).or_insert(index);
        if app.kind == "uwp" {
            by_aumid.insert(app.target.to_lowercase(), index);
            continue;
        }
        by_path.insert(app.target.to_lowercase(), index);
        if let Some(exe) = exes.get(&app.id) {
            by_path.entry(exe.to_lowercase()).or_insert(index);
            if let Some(name) = file_name_lower(exe) {
                by_exe_name.entry(name).or_insert(index);
            }
        }
    }
    for entry in usage {
        let index = match &entry.target {
            UsageTarget::Aumid(id) => by_aumid.get(&id.to_lowercase()).copied(),
            UsageTarget::Path(path) => by_path
                .get(&path.to_lowercase())
                .copied()
                .or_else(|| file_name_lower(path).and_then(|name| by_exe_name.get(&name).copied()))
                .or_else(|| {
                    let stem = Path::new(path).file_stem()?.to_string_lossy().to_string();
                    by_name.get(&norm(&stem)).copied()
                }),
        };
        let Some(index) = index else {
            continue;
        };
        let app = &mut apps[index];
        app.use_count = app.use_count.saturating_add(entry.count);
        app.last_used = match (app.last_used, entry.last_used) {
            (Some(a), Some(b)) => Some(a.max(b)),
            (a, b) => a.or(b),
        };
    }
}

/* ----------------------------- recent documents --------------------------- */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentFile {
    pub name: String,
    pub path: String,
    pub last_used: u64,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppUsage {
    pub id: String,
    pub last_used: Option<u64>,
    pub use_count: u32,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppsUsage {
    pub apps: Vec<AppUsage>,
    pub recent_files: Vec<RecentFile>,
}

/// Documents the user opened lately, from the Recent folder (shortcut modified time = last open).
fn recent_files(limit: usize) -> Vec<RecentFile> {
    let Some(dir) = env_path("APPDATA").map(|p| p.join("Microsoft\\Windows\\Recent")) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut links: Vec<(u64, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if !path.extension()?.to_string_lossy().eq_ignore_ascii_case("lnk") {
                return None;
            }
            let modified = entry.metadata().ok()?.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
            Some((modified.as_millis() as u64, path))
        })
        .collect();
    links.sort_by(|a, b| b.0.cmp(&a.0));
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for (last_used, link) in links.into_iter().take(limit * 4) {
        if out.len() >= limit {
            break;
        }
        let Some(target) = lnk_target_of(&link) else {
            continue;
        };
        let lower = target.to_lowercase();
        if lower.ends_with(".exe") || lower.ends_with(".lnk") || !seen.insert(lower) || !Path::new(&target).is_file() {
            continue;
        }
        let name = Path::new(&target).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        out.push(RecentFile { name, path: target, last_used });
    }
    out
}

static USAGE_CACHE: Mutex<Option<(Instant, AppsUsage)>> = Mutex::new(None);

fn usage_cached(apps: &[InstalledApp]) -> AppsUsage {
    if let Ok(guard) = USAGE_CACHE.lock() {
        if let Some((at, usage)) = guard.as_ref() {
            if at.elapsed() < CACHE_TTL {
                return usage.clone();
            }
        }
    }
    let mut copy: Vec<InstalledApp> = apps.to_vec();
    for app in copy.iter_mut() {
        app.last_used = None;
        app.use_count = 0;
    }
    let exes = EXES.lock().ok().and_then(|g| g.clone()).unwrap_or_default();
    apply_usage(&mut copy, &exes, &userassist_entries());
    let usage = AppsUsage {
        apps: copy
            .into_iter()
            .filter(|app| app.last_used.is_some() || app.use_count > 0)
            .map(|app| AppUsage { id: app.id, last_used: app.last_used, use_count: app.use_count })
            .collect(),
        recent_files: recent_files(40),
    };
    if let Ok(mut guard) = USAGE_CACHE.lock() {
        *guard = Some((Instant::now(), usage.clone()));
    }
    usage
}

/* ---------------------------------- icons -------------------------------- */

enum IconEntry {
    Hit(String),
    Miss(Instant),
}

static ICONS: Mutex<Option<crate::bounded_cache::BoundedCache<IconEntry>>> = Mutex::new(None);
static ICON_WORKERS: AtomicUsize = AtomicUsize::new(0);

struct IconSlot;
impl IconSlot {
    fn acquire() -> Option<IconSlot> {
        for _ in 0..240 {
            if ICON_WORKERS.fetch_add(1, Ordering::SeqCst) < MAX_ICON_WORKERS {
                return Some(IconSlot);
            }
            ICON_WORKERS.fetch_sub(1, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(25));
        }
        None
    }
}
impl Drop for IconSlot {
    fn drop(&mut self) {
        ICON_WORKERS.fetch_sub(1, Ordering::SeqCst);
    }
}

fn icon_px(requested: u32) -> i32 {
    match requested {
        0..=24 => 24,
        25..=40 => 40,
        41..=56 => 56,
        57..=80 => 80,
        81..=112 => 112,
        _ => 160,
    }
}

fn icon_for(app: &InstalledApp, px: i32) -> Option<String> {
    let key = format!("{}|{}", app.id, px);
    if let Ok(mut guard) = ICONS.lock() {
        match guard.as_mut().and_then(|cache| cache.get(&key)) {
            Some(IconEntry::Hit(icon)) => return Some(icon.clone()),
            Some(IconEntry::Miss(at)) if at.elapsed() < ICON_MISS_RETRY => return None,
            _ => {}
        }
    }
    let parsing_name = if app.kind == "uwp" {
        format!("shell:AppsFolder\\{}", app.target)
    } else {
        app.target.clone()
    };
    let icon = IconSlot::acquire()
        .and_then(|_slot| crate::notification_icon::shell_icon_sized(&parsing_name, px, ICON_TIMEOUT));
    if let Ok(mut guard) = ICONS.lock() {
        let cache = guard.get_or_insert_with(||crate::bounded_cache::BoundedCache::new(MAX_ICON_CACHE,MAX_ICON_CACHE_BYTES));
        cache.insert(
            key,
            match &icon {
                Some(icon) => IconEntry::Hit(icon.clone()),
                None => IconEntry::Miss(Instant::now()),
            },
            icon.as_ref().map_or(0,String::capacity),
        );
    }
    icon
}

/* --------------------------------- launching ------------------------------ */

pub fn launch(app: &AppHandle, target: &str) -> Result<(), String> {
    if looks_like_aumid(target) {
        // Packaged apps start through the Apps folder, not by path.
        return Command::new("explorer.exe")
            .arg(format!("shell:AppsFolder\\{target}"))
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string());
    }
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

static LAST_REFRESH: Mutex<Option<Instant>> = Mutex::new(None);

/// Rescans installed apps (at most once a minute) so new installs show up without a restart.
#[tauri::command]
pub async fn apps_refresh(state: State<'_, AppState>) -> Result<Vec<InstalledApp>, String> {
    let fresh_enough = LAST_REFRESH
        .lock()
        .map(|guard| guard.as_ref().is_some_and(|at| at.elapsed() < CACHE_TTL))
        .unwrap_or(true);
    if !fresh_enough {
        if let Ok(mut guard) = LAST_REFRESH.lock() {
            *guard = Some(Instant::now());
        }
        let apps = tauri::async_runtime::spawn_blocking(list)
            .await
            .map_err(|_| "Could not scan installed apps.".to_string())?;
        *state.apps.lock().map_err(|_| "App list is unavailable.".to_string())? = Arc::new(apps);
    }
    let current = state.apps.lock().map_err(|_| "App list is unavailable.".to_string())?.as_ref().clone();
    Ok(current)
}

/// Windows usage (UserAssist run counts and last run, Recent documents), cached for a minute.
#[tauri::command]
pub async fn apps_usage(state: State<'_, AppState>) -> Result<AppsUsage, String> {
    let apps = Arc::clone(&*state.apps.lock().map_err(|_| "App list is unavailable.".to_string())?);
    tauri::async_runtime::spawn_blocking(move || usage_cached(&apps))
        .await
        .map_err(|_| "Could not read app usage.".to_string())
}

/// Logo for one app from `apps_list`, as a PNG data URL (`None` when Windows has none).
/// Only ids from the app list are accepted. Results are cached and the lookup times out after 5 s.
#[tauri::command]
pub async fn apps_icon(state: State<'_, AppState>, id: String, size: Option<u32>) -> Result<Option<String>, String> {
    let app = {
        let apps = state.apps.lock().map_err(|_| "App list is unavailable.".to_string())?;
        apps.iter().find(|app| app.id == id).cloned()
    };
    let Some(app) = app else {
        return Ok(None);
    };
    let px = icon_px(size.unwrap_or(56));
    tauri::async_runtime::spawn_blocking(move || icon_for(&app, px))
        .await
        .map_err(|_| "Could not load the app icon.".to_string())
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

#[cfg(test)]
mod inventory_tests {
    use super::*;

    fn app(name: &str, target: &str, kind: &str) -> InstalledApp {
        InstalledApp { id: target.into(), name: name.into(), target: target.into(), kind: kind.into(), icon: None, last_used: None, use_count: 0 }
    }

    #[test]
    fn rot13_and_hex_decode_userassist_names_and_records() {
        assert_eq!(rot13("Zvpebfbsg.Jvaqbjf.Rkcybere"), "Microsoft.Windows.Explorer");
        let mut data = vec![0u8; 72];
        data[4..8].copy_from_slice(&7u32.to_le_bytes());
        let filetime: u64 = (1_700_000_000_000u64 + 11_644_473_600_000) * 10_000;
        data[60..68].copy_from_slice(&filetime.to_le_bytes());
        let hex: String = data.iter().map(|b| format!("{b:02X}")).collect();
        assert_eq!(parse_userassist_record(&hex_bytes(&hex)), Some((7, Some(1_700_000_000_000))));
        assert_eq!(parse_userassist_record(&[0u8; 16]), None);
    }

    #[test]
    fn usage_names_become_paths_or_aumids() {
        assert_eq!(usage_target("Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"), Some(UsageTarget::Aumid("Microsoft.WindowsCalculator_8wekyb3d8bbwe!App".into())));
        assert_eq!(usage_target("C:\\Tools\\a.exe"), Some(UsageTarget::Path("C:\\Tools\\a.exe".into())));
        assert_eq!(usage_target("UEME_CTLSESSION"), None);
        assert_eq!(usage_target("Microsoft.Windows.Explorer"), None);
    }

    #[test]
    fn usage_matches_by_path_exe_name_and_aumid_and_sums_counts() {
        let mut apps = vec![
            app("Editor", "C:\\Start\\Editor.lnk", "win32"),
            app("Calculator", "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App", "uwp"),
        ];
        let mut exes = HashMap::new();
        exes.insert("C:\\Start\\Editor.lnk".to_string(), "c:\\program files\\editor\\ed.exe".to_string());
        let usage = vec![
            UsageEntry { target: UsageTarget::Path("D:\\portable\\ED.EXE".into()), last_used: Some(10), count: 2 },
            UsageEntry { target: UsageTarget::Path("C:\\Program Files\\Editor\\ed.exe".into()), last_used: Some(30), count: 3 },
            UsageEntry { target: UsageTarget::Aumid("microsoft.windowscalculator_8wekyb3d8bbwe!app".into()), last_used: None, count: 4 },
        ];
        apply_usage(&mut apps, &exes, &usage);
        assert_eq!((apps[0].use_count, apps[0].last_used), (5, Some(30)));
        assert_eq!((apps[1].use_count, apps[1].last_used), (4, None));
    }

    #[test]
    fn lnk_parser_reads_unicode_and_ansi_local_paths_and_rejects_junk() {
        // Header (0x4C) + LinkInfo with a local base path, no ID list.
        let mut data = vec![0u8; 0x4C];
        data[0..4].copy_from_slice(&0x4Cu32.to_le_bytes());
        data[0x14..0x18].copy_from_slice(&0x2u32.to_le_bytes());
        let path = b"C:\\Apps\\run.exe\0";
        let mut info = vec![0u8; 0x1C];
        info[4..8].copy_from_slice(&0x1Cu32.to_le_bytes());
        info[8..12].copy_from_slice(&1u32.to_le_bytes());
        info[16..20].copy_from_slice(&0x1Cu32.to_le_bytes());
        info.extend_from_slice(path);
        let size = info.len() as u32;
        info[0..4].copy_from_slice(&size.to_le_bytes());
        data.extend_from_slice(&info);
        assert_eq!(parse_lnk_target(&data), Some("C:\\Apps\\run.exe".to_string()));
        assert_eq!(parse_lnk_target(&[1, 2, 3]), None);
        assert_eq!(parse_lnk_target(&data[..0x50]), None);
    }

    #[test]
    fn aumid_and_display_icon_checks() {
        assert!(looks_like_aumid("Pkg.Name_abc!App"));
        assert!(!looks_like_aumid("C:\\x\\a!.exe"));
        assert!(!looks_like_aumid("plain"));
        assert_eq!(icon_px(10), 24);
        assert_eq!(icon_px(64), 80);
        assert_eq!(icon_px(999), 160);
    }
}
