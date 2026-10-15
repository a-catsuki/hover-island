//! Safe, user-triggered Recycle Bin support for native file drops.
//!
//! Recycle authorization is sourced only from Tauri's most recent OS drag/drop
//! payload and can be consumed exactly once. Deletion is delegated to Windows
//! Shell with FOFX_RECYCLEONDELETE; there is no filesystem-delete fallback.

use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};

use serde::Serialize;

const AUTHORIZATION_TTL: Duration = Duration::from_secs(120);
const MAX_DROPPED_PATHS: usize = 128;

struct AuthorizedDrop {
    paths: Vec<String>,
    at: Instant,
}

static AUTHORIZED_DROP: Mutex<Option<AuthorizedDrop>> = Mutex::new(None);
static NATIVE_FILE_DRAG_ACTIVE: AtomicBool = AtomicBool::new(false);

pub fn set_native_file_drag_active(active: bool) {
    NATIVE_FILE_DRAG_ACTIVE.store(active, Ordering::Release);
    if active {
        if let Ok(mut authorization) = AUTHORIZED_DROP.lock() {
            *authorization = None;
        }
    }
}

pub fn native_file_drag_active() -> bool {
    NATIVE_FILE_DRAG_ACTIVE.load(Ordering::Acquire)
}

/// Remember paths delivered by the operating system for the main-window drop.
pub fn record_native_drop(paths: &[PathBuf]) {
    let values = paths
        .iter()
        .map(|path| normalize_drop_path(path))
        .collect::<Option<Vec<_>>>();
    let Ok(mut authorization) = AUTHORIZED_DROP.lock() else {
        return;
    };
    *authorization = values
        .filter(|items| !items.is_empty() && items.len() <= MAX_DROPPED_PATHS)
        .map(|paths| AuthorizedDrop {
            paths,
            at: Instant::now(),
        });
}

fn normalize_drop_path(path: &Path) -> Option<String> {
    if !path.is_absolute() {
        return None;
    }
    let mut value = path.to_str()?;
    if let Some(stripped) = value.strip_prefix(r"\\?\") {
        value = stripped;
    }
    let value = value.trim_end_matches(|character| character == '\\' || character == '/');
    if value.is_empty() {
        return None;
    }
    Some(value.to_lowercase())
}

fn claim_native_drop(paths: &[String]) -> Result<Vec<PathBuf>, String> {
    if paths.is_empty() || paths.len() > MAX_DROPPED_PATHS {
        return Err("The dropped item list is invalid.".into());
    }
    let requested = paths
        .iter()
        .map(|path| normalize_drop_path(Path::new(path)))
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| "Only absolute local file paths can be used.".to_string())?;

    let mut authorization = AUTHORIZED_DROP
        .lock()
        .map_err(|_| "Drop authorization is unavailable.".to_string())?;
    let Some(drop) = authorization.as_ref() else {
        return Err("This action requires a recent file drop onto the island.".into());
    };
    if drop.at.elapsed() > AUTHORIZATION_TTL || drop.paths != requested {
        *authorization = None;
        return Err("The dropped files are no longer authorized for this action.".into());
    }
    *authorization = None;

    let validated = paths
        .iter()
        .map(|path| validate_path(Path::new(path)))
        .collect::<Result<Vec<_>, _>>()?;
    for (index, path) in validated.iter().enumerate() {
        if validated
            .iter()
            .skip(index + 1)
            .any(|other| path_is_within(path, other) || path_is_within(other, path))
        {
            return Err("A dropped folder overlaps another selected item.".into());
        }
    }
    Ok(validated)
}

fn validate_path(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("Only absolute paths can be used.".into());
    }
    let text = path
        .to_str()
        .ok_or_else(|| "The dropped path is not valid Unicode.".to_string())?;
    if text.starts_with("\\\\") || text.starts_with("//") {
        return Err("Network paths cannot be recycled.".into());
    }

    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("Could not inspect dropped item: {error}"))?;
    if metadata.file_type().is_symlink() {
        return Err("Links and reparse points cannot be recycled this way.".into());
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Could not resolve dropped item: {error}"))?;
    if normalize_drop_path(path).as_deref() != normalize_drop_path(&canonical).as_deref() {
        return Err("Paths containing aliases or reparse points cannot be recycled.".into());
    }
    if canonical.file_name().is_none() {
        return Err("A drive root cannot be recycled.".into());
    }
    if is_protected_path(&canonical) {
        return Err("Windows and application system folders cannot be recycled.".into());
    }
    #[cfg(windows)]
    if is_network_drive(&canonical) {
        return Err("Network drives cannot be recycled.".into());
    }
    Ok(canonical)
}

fn path_is_within(path: &Path, root: &Path) -> bool {
    let Some(path) = normalize_drop_path(path) else {
        return false;
    };
    let Some(root) = normalize_drop_path(root) else {
        return false;
    };
    path == root || path.starts_with(&(root + "\\"))
}

fn is_protected_path(path: &Path) -> bool {
    let Some(normalized) = normalize_drop_path(path) else {
        return true;
    };
    let protected = [
        (std::env::var_os("WINDIR").map(PathBuf::from), true),
        (std::env::var_os("SystemRoot").map(PathBuf::from), true),
        (std::env::var_os("ProgramFiles").map(PathBuf::from), true),
        (
            std::env::var_os("ProgramFiles(x86)").map(PathBuf::from),
            true,
        ),
        (std::env::var_os("ProgramData").map(PathBuf::from), true),
        (std::env::var_os("USERPROFILE").map(PathBuf::from), false),
    ];
    protected
        .into_iter()
        .filter_map(|(root, descendants)| root.map(|root| (root, descendants)))
        .any(|(root, descendants)| {
            let root = root.canonicalize().unwrap_or(root);
            normalize_drop_path(&root).is_some_and(|root| {
                normalized == root || (descendants && normalized.starts_with(&(root + "\\")))
            })
        })
}

#[cfg(windows)]
fn is_network_drive(path: &Path) -> bool {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        core::PCWSTR,
        Win32::{Storage::FileSystem::GetDriveTypeW, System::WindowsProgramming::DRIVE_REMOTE},
    };

    let Some(root) = path.ancestors().last() else {
        return true;
    };
    let mut wide: Vec<u16> = root.as_os_str().encode_wide().collect();
    if !wide.ends_with(&[b'\\' as u16]) {
        wide.push(b'\\' as u16);
    }
    wide.push(0);
    unsafe { GetDriveTypeW(PCWSTR(wide.as_ptr())) == DRIVE_REMOTE }
}

#[derive(Debug, Clone, Serialize)]
pub struct RecycleResult {
    pub recycled: usize,
    pub failed: usize,
    pub cancelled: bool,
}

pub fn consume_drop_authorization(paths: &[String]) -> Result<Vec<PathBuf>, String> {
    claim_native_drop(paths)
}

#[tauri::command]
pub async fn recycle_dropped_paths(paths: Vec<String>) -> Result<RecycleResult, String> {
    let paths = consume_drop_authorization(&paths)?;
    #[cfg(windows)]
    {
        // Shell can show a progress/cancellation dialog. Keep its STA apartment
        // off the island's event loop so the compact feedback stays responsive.
        tokio::task::spawn_blocking(move || recycle_with_shell(&paths))
            .await
            .map_err(|_| "The Windows Recycle Bin operation stopped unexpectedly.".to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = paths;
        Err("Recycle Bin operations are supported only on Windows.".into())
    }
}

#[cfg(windows)]
fn recycle_with_shell(paths: &[PathBuf]) -> Result<RecycleResult, String> {
    use std::os::windows::ffi::OsStrExt;
    use std::sync::Arc;
    use windows::{
        core::{implement, HRESULT, PCWSTR},
        Win32::{
            System::Com::{
                CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
                COINIT_APARTMENTTHREADED,
            },
            UI::Shell::{
                FileOperation, IFileOperation, IFileOperationProgressSink,
                IFileOperationProgressSink_Impl, IShellItem, SHCreateItemFromParsingName,
                FOFX_ADDUNDORECORD, FOFX_RECYCLEONDELETE, FOF_NOCONFIRMATION, FOF_WANTNUKEWARNING,
            },
        },
    };

    #[implement(IFileOperationProgressSink)]
    struct DeleteSink {
        result: Arc<Mutex<Option<HRESULT>>>,
    }

    macro_rules! sink_noop {
        ($name:ident($($argument:ident: $argument_type:ty),* $(,)?)) => {
            fn $name(&self, $($argument: $argument_type),*) -> windows::core::Result<()> {
                let _ = ($($argument,)*);
                Ok(())
            }
        };
    }

    impl IFileOperationProgressSink_Impl for DeleteSink {
        sink_noop!(StartOperations());
        sink_noop!(FinishOperations(hrresult: HRESULT));
        sink_noop!(PreRenameItem(dwflags: u32, psiitem: Option<&IShellItem>, psznewname: &PCWSTR));
        sink_noop!(PostRenameItem(dwflags: u32, psiitem: Option<&IShellItem>, psznewname: &PCWSTR, hrrename: HRESULT, psinewlycreated: Option<&IShellItem>));
        sink_noop!(PreMoveItem(dwflags: u32, psiitem: Option<&IShellItem>, psidestinationfolder: Option<&IShellItem>, psznewname: &PCWSTR));
        sink_noop!(PostMoveItem(dwflags: u32, psiitem: Option<&IShellItem>, psidestinationfolder: Option<&IShellItem>, psznewname: &PCWSTR, hrmove: HRESULT, psinewlycreated: Option<&IShellItem>));
        sink_noop!(PreCopyItem(dwflags: u32, psiitem: Option<&IShellItem>, psidestinationfolder: Option<&IShellItem>, psznewname: &PCWSTR));
        sink_noop!(PostCopyItem(dwflags: u32, psiitem: Option<&IShellItem>, psidestinationfolder: Option<&IShellItem>, psznewname: &PCWSTR, hrcopy: HRESULT, psinewlycreated: Option<&IShellItem>));
        sink_noop!(PreDeleteItem(dwflags: u32, psiitem: Option<&IShellItem>));
        fn PostDeleteItem(
            &self,
            _dwflags: u32,
            _psiitem: Option<&IShellItem>,
            hrdelete: HRESULT,
            _psinewlycreated: Option<&IShellItem>,
        ) -> windows::core::Result<()> {
            if let Ok(mut result) = self.result.lock() {
                *result = Some(hrdelete);
            }
            Ok(())
        }
        sink_noop!(PreNewItem(dwflags: u32, psidestinationfolder: Option<&IShellItem>, psznewname: &PCWSTR));
        sink_noop!(PostNewItem(dwflags: u32, psidestinationfolder: Option<&IShellItem>, psznewname: &PCWSTR, psztemplatename: &PCWSTR, dwfileattributes: u32, hrnew: HRESULT, psinewitem: Option<&IShellItem>));
        sink_noop!(UpdateProgress(iworktotal: u32, iworksofar: u32));
        sink_noop!(ResetTimer());
        sink_noop!(PauseTimer());
        sink_noop!(ResumeTimer());
    }

    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .map_err(|error| format!("Could not initialize Windows Shell: {error}"))?;
    }
    struct ComApartment;
    impl Drop for ComApartment {
        fn drop(&mut self) {
            unsafe { CoUninitialize() }
        }
    }
    let _apartment = ComApartment;

    let mut result = RecycleResult {
        recycled: 0,
        failed: 0,
        cancelled: false,
    };
    for path in paths {
        let operation = unsafe {
            CoCreateInstance::<_, IFileOperation>(&FileOperation, None, CLSCTX_INPROC_SERVER)
        };
        let Ok(operation) = operation else {
            result.failed += 1;
            continue;
        };
        if unsafe {
            operation.SetOperationFlags(
                FOFX_RECYCLEONDELETE
                    | FOFX_ADDUNDORECORD
                    | FOF_NOCONFIRMATION
                    | FOF_WANTNUKEWARNING,
            )
        }
        .is_err()
        {
            result.failed += 1;
            continue;
        }

        // Rust canonical paths use the extended-length prefix. Shell parsing
        // names require the regular drive path for these local items.
        let text = path.to_str().ok_or_else(|| "The dropped path is not valid Unicode.".to_string())?;
        let shell_path = std::ffi::OsStr::new(text.strip_prefix(r"\\?\").unwrap_or(text));
        let mut wide: Vec<u16> = shell_path.encode_wide().collect();
        wide.push(0);
        let item =
            unsafe { SHCreateItemFromParsingName::<_, _, IShellItem>(PCWSTR(wide.as_ptr()), None) };
        let Ok(item) = item else {
            result.failed += 1;
            continue;
        };
        let observed = Arc::new(Mutex::new(None));
        let sink = DeleteSink {
            result: observed.clone(),
        };
        let sink_interface: IFileOperationProgressSink = sink.into();
        if unsafe { operation.DeleteItem(&item, &sink_interface) }.is_err() {
            result.failed += 1;
            continue;
        }
        match unsafe { operation.PerformOperations() } {
            Ok(()) => {
                let aborted = unsafe { operation.GetAnyOperationsAborted() }
                    .map(|aborted| aborted.as_bool())
                    .unwrap_or(true);
                if aborted {
                    result.cancelled = true;
                    break;
                }
                match observed.lock().ok().and_then(|status| *status) {
                    Some(status) if status.0 >= 0 && !path.try_exists().unwrap_or(true) => {
                        result.recycled += 1
                    }
                    _ => result.failed += 1,
                }
            }
            Err(error) if error.code().0 as u32 == 0x800704C7 => {
                result.cancelled = true;
                break;
            }
            Err(_) => result.failed += 1,
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "Moves one newly created disposable test file to Windows Recycle Bin"]
    async fn shell_recycles_only_an_owned_temporary_fixture() {
        let directory = std::env::temp_dir().join(format!("hover-island-recycle-smoke-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let file = directory.join("Hover Island disposable recycle test.txt");
        std::fs::write(&file, b"Disposable Hover Island recycle test fixture.\r\n").unwrap();
        record_native_drop(&[file.clone()]);
        let paths = vec![file.to_string_lossy().to_string()];
        let result = recycle_dropped_paths(paths.clone()).await.unwrap();
        assert_eq!(result.recycled, 1, "{result:?}; fixture still exists: {}", file.exists());
        assert_eq!(result.failed, 0);
        assert!(!result.cancelled);
        assert!(!file.exists(), "the owned fixture should have been recycled");
        assert!(recycle_dropped_paths(paths).await.is_err(), "drop authorization cannot be reused");
        std::fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn refuses_relative_and_network_paths() {
        assert!(validate_path(Path::new("relative.txt")).is_err());
        #[cfg(windows)]
        assert!(validate_path(Path::new(r"\\server\share\file.txt")).is_err());
    }

    #[test]
    fn native_authorization_is_one_use_and_exact() {
        let candidate = std::env::current_exe().unwrap();
        let native = normalize_drop_path(&candidate).unwrap();
        *AUTHORIZED_DROP.lock().unwrap() = Some(AuthorizedDrop {
            paths: vec![native],
            at: Instant::now(),
        });
        assert!(claim_native_drop(&[r"C:\unrelated.txt".into()]).is_err());
        assert!(AUTHORIZED_DROP.lock().unwrap().is_none());
    }

    #[test]
    fn protected_roots_are_rejected() {
        if let Some(root) = std::env::var_os("WINDIR").map(PathBuf::from) {
            assert!(is_protected_path(&root));
        }
    }
}
