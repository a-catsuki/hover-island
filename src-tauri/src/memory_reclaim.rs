//! Explicit, preview-first reclaim of selected background process working sets.
//! This never kills, suspends, changes startup state, or purges application data.

use serde::Serialize;
use tauri::Emitter;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReclaimProgress {
    pub total: usize,
    pub completed: usize,
    pub released_working_set_bytes: u64,
    pub skipped: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryCandidate {
    pub id: String,
    pub name: String,
    pub working_set_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReclaimResult {
    pub id: String,
    pub name: String,
    pub released_working_set_bytes: u64,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn memory_scan() -> Result<Vec<MemoryCandidate>, String> {
    tauri::async_runtime::spawn_blocking(platform::scan)
        .await
        .map_err(|error| format!("Memory scan worker failed: {error}"))?
}

#[tauri::command]
pub async fn memory_reclaim(
    app: tauri::AppHandle,
    ids: Vec<String>,
) -> Result<Vec<ReclaimResult>, String> {
    if ids.is_empty() || ids.len() > 8 {
        return Err("Select between one and eight background apps.".into());
    }
    let unique: std::collections::HashSet<_> = ids.iter().collect();
    if unique.len() != ids.len() {
        return Err("Each background app can only be selected once.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        platform::reclaim(ids, |progress| {
            let _ = app.emit("memory://progress", progress);
        })
    })
    .await
    .map_err(|error| format!("Memory reclaim worker failed: {error}"))?
}

fn reclaimable_process_name(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    !matches!(
        name.as_str(),
        "system"
            | "registry"
            | "smss.exe"
            | "csrss.exe"
            | "wininit.exe"
            | "services.exe"
            | "lsass.exe"
            | "winlogon.exe"
            | "svchost.exe"
            | "fontdrvhost.exe"
            | "dwm.exe"
            | "sihost.exe"
            | "taskhostw.exe"
            | "securityhealthservice.exe"
            | "securityhealthsystray.exe"
            | "msmpeng.exe"
            | "nissrv.exe"
            | "mousocoreworker.exe"
            | "trustedinstaller.exe"
            | "audiodg.exe"
            | "spoolsv.exe"
            | "runtimebroker.exe"
            | "searchhost.exe"
            | "searchindexer.exe"
            | "textinputhost.exe"
            | "ctfmon.exe"
            | "explorer.exe"
            | "hover-island.exe"
            | "spotify.exe"
            | "itunes.exe"
            | "music.ui.exe"
            | "mpv.exe"
            | "potplayer64.exe"
            | "foobar2000.exe"
            | "musicbee.exe"
            | "amazonmusic.exe"
            | "tidal.exe"
            | "plex.exe"
            | "vlc.exe"
            | "wmplayer.exe"
            | "groove.exe"
            | "obs64.exe"
            | "obs32.exe"
            | "zoom.exe"
            | "teams.exe"
            | "ms-teams.exe"
            | "discord.exe"
            | "slack.exe"
            | "chrome.exe"
            | "msedge.exe"
            | "firefox.exe"
            | "brave.exe"
            | "opera.exe"
            | "code.exe"
            | "devenv.exe"
            | "webex.exe"
            | "skype.exe"
            | "avastsvc.exe"
            | "avguard.exe"
            | "avgsvc.exe"
            | "mbamservice.exe"
            | "mcshield.exe"
            | "nortonsecurity.exe"
            | "csfalconservice.exe"
    )
}

fn measured_working_set_delta(before: u64, after: u64) -> u64 {
    before.saturating_sub(after)
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{
        measured_working_set_delta, reclaimable_process_name, MemoryCandidate, ReclaimProgress,
        ReclaimResult,
    };
    use sha2::{Digest, Sha256};
    use std::collections::{HashMap, HashSet};
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, BOOL, FILETIME, HANDLE, LPARAM};
    use windows::Win32::Security::{
        GetLengthSid, GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER,
    };
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::ProcessStatus::{
        K32EmptyWorkingSet, K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows::Win32::System::RemoteDesktop::ProcessIdToSessionId;
    use windows::Win32::System::Threading::{
        GetCurrentProcess, GetCurrentProcessId, GetProcessTimes, IsProcessCritical, OpenProcess,
        OpenProcessToken, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
        PROCESS_QUERY_INFORMATION, PROCESS_SET_QUOTA,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetForegroundWindow, GetWindowThreadProcessId, IsWindowVisible,
    };

    // The upstream-inspired one-tap action includes modest idle apps too; the
    // stronger user/session/visibility/critical checks, not a high size threshold,
    // are the safety boundary.
    const MIN_WORKING_SET_BYTES: u64 = 8 * 1024 * 1024;
    const MAX_CANDIDATES: usize = 64;
    const MAX_BATCH: usize = 8;
    const SCAN_COOLDOWN: Duration = Duration::from_secs(5);
    const RECLAIM_COOLDOWN: Duration = Duration::from_secs(15);
    const CACHE_TTL: Duration = Duration::from_secs(90);

    #[derive(Clone)]
    struct Identity {
        pid: u32,
        creation_time: u64,
        name: String,
        working_set: u64,
    }

    #[derive(Default)]
    struct Cache {
        entries: HashMap<String, Identity>,
        scanned_at: Option<Instant>,
        reclaimed_at: Option<Instant>,
        candidates: Vec<MemoryCandidate>,
    }

    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();

    struct OwnedHandle(HANDLE);
    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            let _ = unsafe { CloseHandle(self.0) };
        }
    }

    fn open_process(pid: u32, reclaim: bool) -> Result<OwnedHandle, String> {
        let rights = PROCESS_QUERY_INFORMATION
            | if reclaim {
                PROCESS_SET_QUOTA
            } else {
                windows::Win32::System::Threading::PROCESS_ACCESS_RIGHTS(0)
            };
        unsafe { OpenProcess(rights, false, pid) }
            .map(OwnedHandle)
            .map_err(|error| format!("Could not inspect process: {error}"))
    }

    fn filetime_u64(value: FILETIME) -> u64 {
        ((value.dwHighDateTime as u64) << 32) | value.dwLowDateTime as u64
    }

    fn creation_time(process: HANDLE) -> Result<u64, String> {
        let mut created = FILETIME::default();
        let mut exited = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        unsafe { GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user) }
            .map_err(|error| format!("Could not verify process identity: {error}"))?;
        Ok(filetime_u64(created))
    }

    fn working_set(process: HANDLE) -> Result<u64, String> {
        let mut counters = PROCESS_MEMORY_COUNTERS::default();
        counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        let ok: BOOL = unsafe { K32GetProcessMemoryInfo(process, &mut counters, counters.cb) };
        if !ok.as_bool() {
            return Err("Windows could not read this process's working set.".into());
        }
        Ok(counters.WorkingSetSize as u64)
    }

    fn process_image_name(process: HANDLE) -> Result<String, String> {
        let mut buffer = vec![0u16; 1024];
        let mut length = buffer.len() as u32;
        unsafe {
            QueryFullProcessImageNameW(
                process,
                PROCESS_NAME_FORMAT(0),
                PWSTR(buffer.as_mut_ptr()),
                &mut length,
            )
        }
        .map_err(|error| format!("Could not verify process path: {error}"))?;
        Ok(OsString::from_wide(&buffer[..length as usize])
            .to_string_lossy()
            .into_owned())
    }

    fn token_sid(process: HANDLE) -> Result<Vec<u8>, String> {
        let mut token = HANDLE::default();
        unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) }
            .map_err(|error| format!("Could not verify process owner: {error}"))?;
        let token = OwnedHandle(token);
        let mut storage = vec![0u64; 128];
        let mut needed = 0u32;
        unsafe {
            GetTokenInformation(
                token.0,
                TokenUser,
                Some(storage.as_mut_ptr().cast()),
                (storage.len() * std::mem::size_of::<u64>()) as u32,
                &mut needed,
            )
        }
        .map_err(|error| format!("Could not read process owner: {error}"))?;
        let user = unsafe { &*(storage.as_ptr().cast::<TOKEN_USER>()) };
        let size = unsafe { GetLengthSid(user.User.Sid) } as usize;
        if size == 0 || size > 256 {
            return Err("Windows returned an invalid process owner.".into());
        }
        Ok(unsafe { std::slice::from_raw_parts(user.User.Sid.0.cast::<u8>(), size) }.to_vec())
    }

    fn same_user(process: HANDLE, current_sid: &[u8]) -> bool {
        let Ok(candidate_sid) = token_sid(process) else {
            return false;
        };
        if candidate_sid.len() != current_sid.len() {
            return false;
        }
        candidate_sid.as_slice() == current_sid
    }

    fn session_id(pid: u32) -> Option<u32> {
        let mut value = 0;
        unsafe { ProcessIdToSessionId(pid, &mut value) }.ok()?;
        Some(value)
    }

    fn visible_processes() -> HashSet<u32> {
        unsafe extern "system" fn callback(
            hwnd: windows::Win32::Foundation::HWND,
            lparam: LPARAM,
        ) -> BOOL {
            if unsafe { IsWindowVisible(hwnd) }.as_bool() {
                let mut pid = 0u32;
                unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
                if pid != 0 {
                    let ids = unsafe { &mut *(lparam.0 as *mut HashSet<u32>) };
                    ids.insert(pid);
                }
            }
            BOOL(1)
        }
        let mut ids = HashSet::new();
        let param = LPARAM((&mut ids as *mut HashSet<u32>) as isize);
        let _ = unsafe { EnumWindows(Some(callback), param) };
        let foreground = unsafe { GetForegroundWindow() };
        if foreground.0 != 0 {
            let mut pid = 0;
            unsafe { GetWindowThreadProcessId(foreground, Some(&mut pid)) };
            if pid != 0 {
                ids.insert(pid);
            }
        }
        ids
    }

    fn process_name(entry: &PROCESSENTRY32W) -> String {
        let end = entry
            .szExeFile
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(entry.szExeFile.len());
        String::from_utf16_lossy(&entry.szExeFile[..end])
    }

    fn process_rows() -> Result<Vec<(u32, u32, String)>, String> {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }
            .map_err(|error| format!("Could not list background processes: {error}"))?;
        let snapshot = OwnedHandle(snapshot);
        let mut entry = PROCESSENTRY32W::default();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        unsafe { Process32FirstW(snapshot.0, &mut entry) }
            .map_err(|error| format!("Could not read process list: {error}"))?;
        let mut rows = Vec::new();
        loop {
            rows.push((
                entry.th32ProcessID,
                entry.th32ParentProcessID,
                process_name(&entry),
            ));
            match unsafe { Process32NextW(snapshot.0, &mut entry) } {
                Ok(()) => {}
                Err(_) => break,
            }
        }
        Ok(rows)
    }

    fn protect_visible_process_trees(rows: &[(u32, u32, String)]) -> HashSet<u32> {
        let mut protected = visible_processes();
        protected.insert(unsafe { GetCurrentProcessId() });
        for (pid, _, name) in rows {
            if !reclaimable_process_name(name) {
                protected.insert(*pid);
            }
        }
        loop {
            let before = protected.len();
            for (pid, parent, _) in rows {
                if protected.contains(parent) {
                    protected.insert(*pid);
                }
            }
            if protected.len() == before {
                break;
            }
        }
        protected
    }

    fn inspect(
        pid: u32,
        name: String,
        session: u32,
        current_sid: &[u8],
        visible: &HashSet<u32>,
    ) -> Result<Identity, String> {
        if pid < 4
            || pid == unsafe { GetCurrentProcessId() }
            || visible.contains(&pid)
            || !reclaimable_process_name(&name)
        {
            return Err("Process is protected or visible.".into());
        }
        if session_id(pid) != Some(session) {
            return Err("Process is outside the current user session.".into());
        }
        let process = open_process(pid, false)?;
        if !same_user(process.0, current_sid) {
            return Err("Process does not belong to the current user.".into());
        }
        let path = process_image_name(process.0)?;
        let windows_dir = std::env::var("WINDIR").unwrap_or_else(|_| String::from("C:\\Windows"));
        if path.to_lowercase().starts_with(&windows_dir.to_lowercase()) {
            return Err("Windows system processes are excluded.".into());
        }
        Ok(Identity {
            pid,
            creation_time: creation_time(process.0)?,
            name,
            working_set: working_set(process.0)?,
        })
    }

    fn validate_final_handle(
        process: HANDLE,
        pid: u32,
        identity: &Identity,
        session: u32,
        current_sid: &[u8],
    ) -> Result<(), String> {
        if creation_time(process)? != identity.creation_time {
            return Err("Process identity changed since the preview.".into());
        }
        if session_id(pid) != Some(session) || !same_user(process, current_sid) {
            return Err("Process is no longer in the current user session.".into());
        }
        let path = process_image_name(process)?;
        let file_name = std::path::Path::new(&path)
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("Could not verify the selected process path.")?;
        if !file_name.eq_ignore_ascii_case(&identity.name) {
            return Err("Process name changed since the preview.".into());
        }
        let windows_dir = std::env::var("WINDIR").unwrap_or_else(|_| String::from("C:\\Windows"));
        if path.to_lowercase().starts_with(&windows_dir.to_lowercase()) {
            return Err("Windows system processes are excluded.".into());
        }
        let mut critical = BOOL(0);
        unsafe { IsProcessCritical(process, &mut critical) }
            .map_err(|_| "Could not verify whether this process is critical.".to_string())?;
        if critical.as_bool() {
            return Err("Windows critical processes are protected.".into());
        }
        Ok(())
    }

    fn current_sid() -> Result<Vec<u8>, String> {
        token_sid(unsafe { GetCurrentProcess() })
    }

    fn scan_processes() -> Result<Vec<Identity>, String> {
        let session =
            session_id(unsafe { GetCurrentProcessId() }).ok_or("Could not read current session")?;
        let sid = current_sid()?;
        let process_rows = process_rows()?;
        // Protect every child process owned by a visible/foreground app. This avoids
        // trimming a background renderer or helper while its app window is in use.
        let protected = protect_visible_process_trees(&process_rows);
        let mut candidates = Vec::new();
        for (pid, _, name) in process_rows {
            if protected.contains(&pid) {
                continue;
            }
            if let Ok(identity) = inspect(pid, name, session, &sid, &protected) {
                if identity.working_set >= MIN_WORKING_SET_BYTES {
                    candidates.push(identity);
                }
            }
        }
        candidates.sort_by_key(|item| std::cmp::Reverse(item.working_set));
        candidates.truncate(MAX_CANDIDATES);
        Ok(candidates)
    }

    fn candidate_id(identity: &Identity) -> String {
        let mut hasher = Sha256::new();
        hasher.update(identity.pid.to_le_bytes());
        hasher.update(identity.creation_time.to_le_bytes());
        hasher.update(identity.name.as_bytes());
        hasher.finalize()[..12]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    pub(super) fn scan() -> Result<Vec<MemoryCandidate>, String> {
        let cache = CACHE.get_or_init(|| Mutex::new(Cache::default()));
        {
            let guard = cache
                .lock()
                .map_err(|_| "Memory preview is unavailable.".to_string())?;
            if let Some(at) = guard.scanned_at {
                if at.elapsed() < SCAN_COOLDOWN {
                    return Ok(guard.candidates.clone());
                }
            }
        }
        let identities = scan_processes()?;
        let mut entries = HashMap::new();
        let candidates = identities
            .into_iter()
            .map(|identity| {
                let id = candidate_id(&identity);
                let candidate = MemoryCandidate {
                    id: id.clone(),
                    name: identity.name.clone(),
                    working_set_bytes: identity.working_set,
                };
                entries.insert(id, identity);
                candidate
            })
            .collect::<Vec<_>>();
        let mut guard = cache
            .lock()
            .map_err(|_| "Memory preview is unavailable.".to_string())?;
        guard.entries = entries;
        guard.candidates = candidates.clone();
        guard.scanned_at = Some(Instant::now());
        Ok(candidates)
    }

    pub(super) fn reclaim(
        ids: Vec<String>,
        on_progress: impl Fn(ReclaimProgress),
    ) -> Result<Vec<ReclaimResult>, String> {
        if ids.len() > MAX_BATCH {
            return Err("Select at most eight apps per reclaim.".into());
        }
        let cache = CACHE.get_or_init(|| Mutex::new(Cache::default()));
        let identities = {
            let mut guard = cache
                .lock()
                .map_err(|_| "Memory preview is unavailable.".to_string())?;
            if guard
                .reclaimed_at
                .is_some_and(|at| at.elapsed() < RECLAIM_COOLDOWN)
            {
                return Err("Wait a few seconds before another reclaim operation.".into());
            }
            if guard.scanned_at.map_or(true, |at| at.elapsed() > CACHE_TTL) {
                return Err("The preview expired. Scan again before reclaiming.".into());
            }
            let mut identities = Vec::new();
            for id in ids {
                let identity = guard
                    .entries
                    .get(&id)
                    .cloned()
                    .ok_or("One selected process is no longer in the preview. Scan again.")?;
                identities.push((id, identity));
            }
            guard.reclaimed_at = Some(Instant::now());
            identities
        };
        let session =
            session_id(unsafe { GetCurrentProcessId() }).ok_or("Could not read current session")?;
        let sid = current_sid()?;
        let rows = process_rows()?;
        let visible = protect_visible_process_trees(&rows);
        let mut results = Vec::with_capacity(identities.len());
        let mut progress = ReclaimProgress {
            total: identities.len(),
            completed: 0,
            released_working_set_bytes: 0,
            skipped: 0,
        };
        on_progress(progress.clone());
        for (id, old) in identities {
            let result = (|| -> Result<u64, String> {
                let current = inspect(old.pid, old.name.clone(), session, &sid, &visible)?;
                if current.creation_time != old.creation_time {
                    return Err("Process identity changed since the preview.".into());
                }
                let process = open_process(current.pid, true)?;
                validate_final_handle(process.0, current.pid, &old, session, &sid)?;
                if protect_visible_process_trees(&process_rows()?).contains(&current.pid) {
                    return Err("This process or its app is now visible or protected.".into());
                }
                let before = working_set(process.0)?;
                let ok = unsafe { K32EmptyWorkingSet(process.0) };
                if !ok.as_bool() {
                    return Err("Windows refused to trim this process working set.".into());
                }
                let after = working_set(process.0)?;
                Ok(measured_working_set_delta(before, after))
            })();
            results.push(match result {
                Ok(delta) => ReclaimResult {
                    id,
                    name: old.name,
                    released_working_set_bytes: delta,
                    error: None,
                },
                Err(error) => ReclaimResult {
                    id,
                    name: old.name,
                    released_working_set_bytes: 0,
                    error: Some(error.chars().take(160).collect()),
                },
            });
            if let Some(result) = results.last() {
                progress.completed += 1;
                progress.released_working_set_bytes += result.released_working_set_bytes;
                progress.skipped += usize::from(result.error.is_some());
                on_progress(progress.clone());
            }
        }
        Ok(results)
    }

    #[cfg(test)]
    mod smoke_tests {
        #[test]
        #[ignore = "read-only Windows process-list smoke check; does not trim processes"]
        fn windows_memory_preview_is_bounded_and_uses_stable_ids() {
            let candidates = super::scan().expect("read-only process preview should succeed");
            assert!(candidates.len() <= super::MAX_CANDIDATES);
            let mut ids = std::collections::HashSet::new();
            for candidate in &candidates {
                assert!(!candidate.id.is_empty());
                assert!(ids.insert(&candidate.id), "candidate IDs must be unique");
                assert!(candidate.working_set_bytes >= super::MIN_WORKING_SET_BYTES);
            }
            println!(
                "Read-only memory preview returned {} candidates.",
                candidates.len()
            );
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod platform {
    use super::{MemoryCandidate, ReclaimProgress, ReclaimResult};
    pub(super) fn scan() -> Result<Vec<MemoryCandidate>, String> {
        Err("Working-set reclaim is available only on Windows.".into())
    }
    pub(super) fn reclaim(
        _: Vec<String>,
        _: impl Fn(ReclaimProgress),
    ) -> Result<Vec<ReclaimResult>, String> {
        Err("Working-set reclaim is available only on Windows.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::{measured_working_set_delta, reclaimable_process_name};

    #[test]
    fn system_security_ui_and_media_processes_are_not_candidates() {
        for name in [
            "MsMpEng.exe",
            "lsass.exe",
            "explorer.exe",
            "Hover-Island.exe",
            "Spotify.exe",
        ] {
            assert!(!reclaimable_process_name(name), "{name} must be excluded");
        }
        assert!(reclaimable_process_name("ExampleTool.exe"));
    }

    #[test]
    fn measured_reclaim_never_reports_negative_working_set_changes() {
        assert_eq!(measured_working_set_delta(500, 300), 200);
        assert_eq!(measured_working_set_delta(300, 500), 0);
    }
}
