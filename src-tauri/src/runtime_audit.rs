//! Opt-in, local-only memory regression run: --memory-check <absolute-report.json>.
//! No debugger port, working-set trimming, camera images or face signatures.
use tauri::{AppHandle, Manager};

#[cfg(windows)]
fn probe_frames(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let script = r#"(() => {
          let began, last, frames = 0, total = 0, worst = 0, slow = 0;
          const tick = now => {
            began ??= now;
            if (last !== undefined) { const dt = now - last; frames++; total += dt; worst = Math.max(worst, dt); if (dt > 34) slow++; }
            last = now;
            if (now - began < 3000) requestAnimationFrame(tick);
            else window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'memory-check://frames', payload: {
              view: 'VIEW_LABEL', frames, meanMs: total / Math.max(1, frames), worstMs: worst, slowFrames: slow,
              width: innerWidth, height: innerHeight, scale: devicePixelRatio
            }}).catch(() => {});
          }; requestAnimationFrame(tick);
        })()"#.replace("VIEW_LABEL", label);
        let _ = window.eval(script);
    }
}

fn output_path() -> Option<std::path::PathBuf> {
    let mut args = std::env::args_os();
    while let Some(arg) = args.next() {
        if arg == "--memory-check" {
            let path = std::path::PathBuf::from(args.next()?);
            return (path.is_absolute()
                && path.extension().is_some_and(|e| e == "json")
                && path.parent()?.is_dir())
            .then_some(path);
        }
    }
    None
}

pub fn running() -> bool {
    static REQUESTED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *REQUESTED.get_or_init(|| output_path().is_some())
}

#[cfg(windows)]
mod measured {
    use serde::Serialize;
    use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows::Win32::System::Threading::{
        GetCurrentProcessId, GetProcessTimes, OpenProcess, PROCESS_QUERY_INFORMATION,
        PROCESS_VM_READ,
    };

    struct Owned(HANDLE);
    impl Drop for Owned {
        fn drop(&mut self) {
            let _ = unsafe { CloseHandle(self.0) };
        }
    }
    // PROCESS_MEMORY_COUNTERS_EX2, including Windows 10/11's private working set.
    #[repr(C)]
    #[derive(Default)]
    struct Counters {
        cb: u32,
        faults: u32,
        peak_ws: usize,
        ws: usize,
        peak_paged: usize,
        paged: usize,
        peak_nonpaged: usize,
        nonpaged: usize,
        pagefile: usize,
        peak_pagefile: usize,
        private_commit: usize,
        private_ws: usize,
        shared_commit: u64,
    }
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Process {
        pub pid: u32,
        pub name: String,
        pub private_working_set_bytes: u64,
        pub private_commit_bytes: u64,
        pub cpu_time_100ns: u64,
    }
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Sample {
        pub elapsed_ms: u64,
        pub phase: String,
        pub complete: bool,
        pub expanded: bool,
        pub ambient_present: bool,
        pub settings_present: bool,
        pub private_working_set_bytes: u64,
        pub private_commit_bytes: u64,
        pub processes: Vec<Process>,
    }
    pub fn snapshot(elapsed_ms: u64, phase: &str) -> Result<Sample, String> {
        let list = Owned(
            unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }
                .map_err(|e| e.to_string())?,
        );
        let mut row = PROCESSENTRY32W::default();
        row.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut rows = Vec::new();
        let mut more = unsafe { Process32FirstW(list.0, &mut row) }.is_ok();
        while more {
            let end = row
                .szExeFile
                .iter()
                .position(|c| *c == 0)
                .unwrap_or(row.szExeFile.len());
            rows.push((
                row.th32ProcessID,
                row.th32ParentProcessID,
                String::from_utf16_lossy(&row.szExeFile[..end]),
            ));
            more = unsafe { Process32NextW(list.0, &mut row) }.is_ok();
        }
        let mut owned = std::collections::HashSet::from([unsafe { GetCurrentProcessId() }]);
        loop {
            let before = owned.len();
            for (pid, parent, _) in &rows {
                if owned.contains(parent) {
                    owned.insert(*pid);
                }
            }
            if before == owned.len() {
                break;
            }
        }
        let mut processes = Vec::new();
        let mut complete = true;
        for (pid, _, name) in rows.into_iter().filter(|(pid, _, _)| owned.contains(pid)) {
            let Ok(handle) =
                (unsafe { OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid) })
            else {
                complete = false;
                continue;
            };
            let handle = Owned(handle);
            let mut memory = Counters::default();
            memory.cb = std::mem::size_of::<Counters>() as u32;
            if unsafe {
                K32GetProcessMemoryInfo(
                    handle.0,
                    (&mut memory as *mut Counters).cast::<PROCESS_MEMORY_COUNTERS>(),
                    memory.cb,
                )
            }
            .as_bool()
            {
                let (mut created, mut exited, mut kernel, mut user) = (
                    FILETIME::default(),
                    FILETIME::default(),
                    FILETIME::default(),
                    FILETIME::default(),
                );
                let _ = unsafe {
                    GetProcessTimes(handle.0, &mut created, &mut exited, &mut kernel, &mut user)
                };
                let ticks =
                    |t: FILETIME| ((t.dwHighDateTime as u64) << 32) | t.dwLowDateTime as u64;
                processes.push(Process {
                    pid,
                    name,
                    private_working_set_bytes: memory.private_ws as u64,
                    private_commit_bytes: memory.private_commit as u64,
                    cpu_time_100ns: ticks(kernel) + ticks(user),
                });
            } else {
                complete = false;
            }
        }
        Ok(Sample {
            elapsed_ms,
            phase: phase.into(),
            complete,
            expanded: false,
            ambient_present: false,
            settings_present: false,
            private_working_set_bytes: processes.iter().map(|p| p.private_working_set_bytes).sum(),
            private_commit_bytes: processes.iter().map(|p| p.private_commit_bytes).sum(),
            processes,
        })
    }
}

pub fn start(app: &AppHandle) {
    let Some(path) = output_path() else {
        return;
    };
    #[cfg(windows)]
    {
        use tauri::Listener;
        let frame_reports = std::sync::Arc::new(std::sync::Mutex::new(Vec::<serde_json::Value>::new()));
        let receiver = frame_reports.clone();
        let listener = app.listen("memory-check://frames", move |event| {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(event.payload()) {
                if let Ok(mut reports) = receiver.lock() { if reports.len() < 8 { reports.push(value); } }
            }
        });
        let app = app.clone();
        let _ = std::thread::Builder::new().name("hover-memory-check".into()).stack_size(512*1024).spawn(move || {
            let began=std::time::Instant::now(); let mut samples=Vec::new(); let mut errors=Vec::new(); let mut sampling_errors=Vec::new();
            let mut capture = |phase: &str, seconds: u64| {
                let until=std::time::Instant::now()+std::time::Duration::from_secs(seconds);
                while std::time::Instant::now()<until {
                    match measured::snapshot(began.elapsed().as_millis() as u64,phase) {
                        Ok(mut sample)=>{
                            sample.expanded=app.state::<crate::state::AppState>().expanded.load(std::sync::atomic::Ordering::Relaxed);
                            sample.ambient_present=app.get_webview_window("ambient").is_some();
                            sample.settings_present=app.get_webview_window("settings").is_some();
                            samples.push(sample);
                        },Err(error)=>sampling_errors.push(error)
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
            };
            capture("startup-collapsed",6);
            if let Err(error)=crate::window::apply_expanded(&app,true) { errors.push(error.to_string()); }
            probe_frames(&app,"main"); capture("expanded",8);
            let _=crate::window::apply_expanded(&app,false); capture("collapsed-after-expansion",5);
            if let Err(error)=crate::window::open_settings(&app,None) { errors.push(error.to_string()); }
            capture("settings",8);
            if let Some(window)=app.get_webview_window("settings") { let _=window.close(); }
            capture("settings-closed",5);
            crate::ambient::prepare_for_audit(&app); capture("face-preparation",8);
            if let Err(error)=crate::ambient::show_for_audit(&app) { errors.push(error); }
            probe_frames(&app,"ambient");
            capture("ambient",8);
            crate::ambient::close(&app); capture("ambient-closed",10);
            for _ in 0..3 {
                let _=crate::window::apply_expanded(&app,true); capture("repeat-expanded",2);
                let _=crate::window::apply_expanded(&app,false); capture("repeat-collapsed",2);
            }
            errors.extend(sampling_errors);
            let peak=samples.iter().filter(|s|s.complete).map(|s|s.private_working_set_bytes).max();
            let complete=!samples.is_empty() && samples.iter().all(|s|s.complete) && errors.is_empty();
            app.unlisten(listener);
            let result=serde_json::json!({"version":env!("CARGO_PKG_VERSION"),"finished":true,
                "executable":std::env::current_exe().ok(),"configDirectory":app.path().app_config_dir().ok(),
                "faceEnrolled":crate::face::is_enrolled(&app),"logicalProcessors":std::thread::available_parallelism().map(|p|p.get()).ok(),
                "basis":"Complete owned process tree, 100 ms samples of private resident memory; private commit separate. No working-set trimming or forced GC.",
                "measurementComplete":complete,"frameReports":frame_reports.lock().ok().map(|r|r.clone()),
                "peakPrivateWorkingSetBytes":peak,"budgetBytes":200*1024*1024u64,"withinBudget":complete && peak.is_some_and(|p|p<=200*1024*1024),
                "errors":errors,"samples":samples});
            if let Ok(json)=serde_json::to_vec_pretty(&result) { let _=std::fs::write(path,json); }
        });
    }
    #[cfg(not(windows))]
    let _ = (app, path);
}
