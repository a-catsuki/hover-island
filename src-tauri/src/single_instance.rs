//! Exactly one Hover Island at a time.
//!
//! Two copies (for example an old build started by a shortcut or a login entry, plus the
//! installed package) each draw their own island, so one shows collapsed on top of the other
//! open, and they fight over settings and the Beam port. At startup:
//! * another copy from a different file is an older or different build: the installed package
//!   wins over a loose exe, otherwise the newest launch wins;
//! * a second launch of the same file just exits, so the running one stays as it is.

#[cfg(windows)]
pub fn claim() -> bool {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use windows::core::{w, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, ERROR_ALREADY_EXISTS, HANDLE};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Threading::{
        CreateMutexW, GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW,
        TerminateProcess, WaitForSingleObject, PROCESS_ACCESS_RIGHTS, PROCESS_NAME_FORMAT,
    };

    // QUERY_LIMITED_INFORMATION | TERMINATE | SYNCHRONIZE
    const RIGHTS: PROCESS_ACCESS_RIGHTS = PROCESS_ACCESS_RIGHTS(0x1000 | 0x0001 | 0x0010_0000);

    struct Owned(HANDLE);
    impl Drop for Owned {
        fn drop(&mut self) {
            let _ = unsafe { CloseHandle(self.0) };
        }
    }
    let packaged = |path: &str| path.contains("\\windowsapps\\");

    let Ok(me) = std::env::current_exe() else { return true };
    let my_path = me.to_string_lossy().to_lowercase();
    let my_name = me
        .file_name()
        .map(|name| name.to_string_lossy().to_lowercase())
        .unwrap_or_else(|| "hover-island.exe".into());
    let my_pid = unsafe { GetCurrentProcessId() };

    if let Ok(snapshot) = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) } {
        let snapshot = Owned(snapshot);
        let mut entry = PROCESSENTRY32W::default();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut more = unsafe { Process32FirstW(snapshot.0, &mut entry) }.is_ok();
        while more {
            let end = entry.szExeFile.iter().position(|unit| *unit == 0).unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..end]).to_lowercase();
            if name == my_name && entry.th32ProcessID != my_pid {
                if let Ok(handle) = unsafe { OpenProcess(RIGHTS, false, entry.th32ProcessID) } {
                    let handle = Owned(handle);
                    let mut buffer = vec![0u16; 1024];
                    let mut length = buffer.len() as u32;
                    let path = unsafe {
                        QueryFullProcessImageNameW(handle.0, PROCESS_NAME_FORMAT(0), PWSTR(buffer.as_mut_ptr()), &mut length)
                    }
                    .ok()
                    .map(|_| OsString::from_wide(&buffer[..length as usize]).to_string_lossy().to_lowercase());
                    if let Some(path) = path {
                        if path != my_path {
                            // A loose exe never replaces the installed package.
                            if packaged(&path) && !packaged(&my_path) {
                                return false;
                            }
                            let _ = unsafe { TerminateProcess(handle.0, 0) };
                            let _ = unsafe { WaitForSingleObject(handle.0, 3000) };
                        }
                    }
                }
            }
            more = unsafe { Process32NextW(snapshot.0, &mut entry) }.is_ok();
        }
    }

    // Same file launched twice: the mutex makes the second launch step aside, race free.
    match unsafe { CreateMutexW(None, false, w!("Local\\HoverIsland.SingleInstance")) } {
        Ok(handle) => {
            let existed = windows::core::Error::from_win32().code() == ERROR_ALREADY_EXISTS.to_hresult();
            if existed {
                let _ = unsafe { CloseHandle(handle) };
                return false;
            }
            // Held for the life of the process on purpose.
            std::mem::forget(handle);
            true
        }
        Err(_) => true,
    }
}

#[cfg(not(windows))]
pub fn claim() -> bool {
    true
}
