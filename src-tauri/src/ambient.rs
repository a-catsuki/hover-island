//! Ambient mode: after the PC has been idle for a while, show a full-screen clock, now-playing
//! and weather page. Any keyboard or mouse input closes it again. Idle time comes from
//! `GetLastInputInfo`, so it needs no hooks and reads nothing about what is typed.
//!
//! With soft lock on, input does not close the page: the page asks for `ambient_unlock`, which
//! runs Windows Hello. This is a privacy screen, not a security boundary (Ctrl+Alt+Del still
//! works), so after `lock_after_minutes` more away the real Windows lock takes over. When a face
//! is enrolled the page tries webcam face unlock first (see `face.rs`) and keeps Hello as the
//! fallback, like a passcode.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::webview::{PermissionKind, PermissionResponse};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WindowEvent};

use crate::state::AppState;

const LABEL: &str = "ambient";
/// Input that happens this soon after opening is the user's own click or key, not a wake-up.
const OPEN_GRACE: Duration = Duration::from_millis(1500);
/// How long before the Windows screen saver would start that ambient mode takes over.
const SAVER_LEAD_MS: u64 = 20_000;
/// SIMD models need seconds, not a permanently resident renderer. Prepare just before use.
const PREWARM_LEAD_MS: u64 = 8_000;

/// True while ambient mode wants the screen saver and display sleep held off.
static HOLD_DISPLAY: AtomicBool = AtomicBool::new(false);

/// Seconds until Windows would start its screen saver, or `None` when it is switched off.
#[cfg(windows)]
fn screensaver_timeout_ms() -> Option<u64> {
    use windows::Win32::UI::WindowsAndMessaging::{
        SystemParametersInfoW, SPI_GETSCREENSAVEACTIVE, SPI_GETSCREENSAVETIMEOUT,
        SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
    };
    let mut active: u32 = 0;
    let mut seconds: u32 = 0;
    // SAFETY: both out-pointers are valid u32 values that live for the calls.
    unsafe {
        SystemParametersInfoW(SPI_GETSCREENSAVEACTIVE, 0, Some(&mut active as *mut u32 as *mut _), SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0)).ok()?;
        if active == 0 {
            return None;
        }
        SystemParametersInfoW(SPI_GETSCREENSAVETIMEOUT, 0, Some(&mut seconds as *mut u32 as *mut _), SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0)).ok()?;
    }
    (seconds > 0).then(|| u64::from(seconds) * 1000)
}

#[cfg(not(windows))]
fn screensaver_timeout_ms() -> Option<u64> {
    None
}

/// Keeps the display (and with it the screen saver timer) from running out while ambient mode is
/// on screen. The execution state belongs to one thread, so a small thread owns it.
#[cfg(windows)]
fn spawn_display_holder() {
    use windows::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS, ES_DISPLAY_REQUIRED};
    let _ = std::thread::Builder::new().name("ambient-display-hold".into()).spawn(|| {
        let mut holding = false;
        loop {
            let want = HOLD_DISPLAY.load(Ordering::Relaxed);
            if want != holding {
                // SAFETY: plain Win32 call with documented flag values.
                unsafe {
                    SetThreadExecutionState(if want { ES_CONTINUOUS | ES_DISPLAY_REQUIRED } else { ES_CONTINUOUS });
                }
                holding = want;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    });
}

#[cfg(not(windows))]
fn spawn_display_holder() {}

/// The open page needs Windows Hello before it closes.
static LOCKED: AtomicBool = AtomicBool::new(false);
static LOCK_SESSION: AtomicU64 = AtomicU64::new(0);
/// A Hello prompt is showing, so a second key press must not open another.
static VERIFYING: AtomicBool = AtomicBool::new(false);
/// The page is the face enrollment flow: input never closes it and it never locks.
static ENROLLING: AtomicBool = AtomicBool::new(false);
/// The window is on screen. Closing releases its model heap and compositor surfaces.
static SHOWN: AtomicBool = AtomicBool::new(false);
/// The existing window, shown or kept warm, holds the ambient page rather than enrollment.
static AMBIENT_PAGE: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Ambient { soft_lock: bool },
    Enroll,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UnlockOutcome {
    /// Hello confirmed the user; the page closed.
    Verified,
    /// The user dismissed the prompt, or one is already showing.
    Cancelled,
    /// Hello is not set up, so Windows locked for real instead.
    Locked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Hello {
    Verified,
    Cancelled,
    Unavailable,
}

/// Blocks until the user answers, so run it off the async runtime.
#[cfg(windows)]
pub(crate) fn hello_verify(hwnd: isize) -> Hello {
    use windows::core::{factory, HSTRING};
    use windows::Foundation::IAsyncOperation;
    use windows::Security::Credentials::UI::{
        UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability,
    };
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::WinRT::IUserConsentVerifierInterop;

    let available = UserConsentVerifier::CheckAvailabilityAsync().and_then(|operation| operation.get());
    if available != Ok(UserConsentVerifierAvailability::Available) {
        return Hello::Unavailable;
    }
    // Desktop apps must name an owner window, or the prompt opens behind the full-screen page.
    let result = factory::<UserConsentVerifier, IUserConsentVerifierInterop>().and_then(|interop| {
        // SAFETY: `hwnd` is the live ambient window; the message outlives the call.
        let operation: IAsyncOperation<UserConsentVerificationResult> = unsafe {
            interop.RequestVerificationForWindowAsync(HWND(hwnd), &HSTRING::from("Unlock Hover Island"))?
        };
        operation.get()
    });
    match result {
        Ok(UserConsentVerificationResult::Verified) => Hello::Verified,
        Ok(_) => Hello::Cancelled,
        // A broken prompt must not trap the user behind the page.
        Err(_) => Hello::Unavailable,
    }
}

#[cfg(not(windows))]
pub(crate) fn hello_verify(_hwnd: isize) -> Hello {
    Hello::Unavailable
}

#[cfg(windows)]
fn lock_workstation() {
    use windows::Win32::System::Shutdown::LockWorkStation;
    // SAFETY: no arguments; it only asks Windows to switch to the lock screen.
    if let Err(error) = unsafe { LockWorkStation() } {
        eprintln!("Could not lock the PC: {error}");
    }
}

#[cfg(not(windows))]
fn lock_workstation() {}

/// Hand over to the real Windows lock. The page closes so the desktop is what you return to.
fn lock_pc(app: &AppHandle) {
    lock_workstation();
    close(app);
}

#[cfg(windows)]
fn idle_millis() -> Option<u64> {
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    let mut info = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    // SAFETY: `info` is a correctly sized LASTINPUTINFO that lives for the call.
    unsafe {
        if !GetLastInputInfo(&mut info).as_bool() {
            return None;
        }
        Some(u64::from(GetTickCount().wrapping_sub(info.dwTime)))
    }
}

#[cfg(not(windows))]
fn idle_millis() -> Option<u64> {
    None
}

fn is_open(app: &AppHandle) -> bool {
    SHOWN.load(Ordering::Acquire) && app.get_webview_window(LABEL).is_some()
}

/// Prepare face recognition shortly before ambient mode is due.
fn keep_warm(app: &AppHandle) -> bool {
    let soft_lock = app
        .state::<AppState>()
        .settings
        .lock()
        .map(|settings| settings.ambient.soft_lock)
        .unwrap_or(false);
    soft_lock && crate::face::is_enrolled(app)
}

/// Builds the ambient page hidden, so it is ready the moment it is needed.
fn build(app: &AppHandle, visible: bool) -> Result<tauri::WebviewWindow, String> {
    let window = tauri::WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("ambient.html".into()))
        .title("Hover Island Ambient")
        .decorations(false)
        .resizable(false)
        // A prepared page has no visuals. Do not allocate a hidden full-screen swap chain.
        .inner_size(1.0, 1.0)
        .always_on_top(true)
        .skip_taskbar(true)
        .transparent(false)
        .background_color(tauri::window::Color(5, 6, 10, 255))
        .disable_drag_drop_handler()
        // Face unlock reads frames in this page only; without this WebView2 asks every time.
        .on_permission_request(|_, kind| match kind {
            PermissionKind::Camera => PermissionResponse::Allow,
            _ => PermissionResponse::Default,
        })
        .visible(visible)
        .build()
        .map_err(|error| format!("Could not open ambient mode: {error}"))?;
    // Alt+F4 must not skip Hello. `close` uses `destroy` or `hide`, which do not ask.
    window.on_window_event(|event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            if LOCKED.load(Ordering::Acquire) {
                api.prevent_close();
            }
        }
    });
    crate::runtime_memory::set_ambient_active(app, visible);
    Ok(window)
}

/// Builds the hidden ambient page ahead of time when face unlock will want it.
fn prewarm(app: &AppHandle) {
    if app.get_webview_window(LABEL).is_some() || !keep_warm(app) {
        return;
    }
    ENROLLING.store(false, Ordering::Release);
    if build(app, false).is_ok() {
        AMBIENT_PAGE.store(true, Ordering::Release);
    }
}

pub(crate) fn prepare_for_audit(app: &AppHandle) { prewarm(app); }
pub(crate) fn show_for_audit(app: &AppHandle) -> Result<(),String> {
    open(app,Mode::Ambient { soft_lock: soft_lock_enabled(app) })
}

pub(crate) fn is_locked() -> bool {
    LOCKED.load(Ordering::Acquire)
}

pub(crate) fn lock_session() -> u64 {
    LOCK_SESSION.load(Ordering::Acquire)
}

pub(crate) fn is_enrolling() -> bool {
    ENROLLING.load(Ordering::Acquire)
}

/// Raw handle of a window, for owning a Hello prompt. Tauri links a newer `windows` crate.
pub(crate) fn window_hwnd(app: &AppHandle, label: &str) -> isize {
    app.get_webview_window(label)
        .and_then(|window| window.hwnd().ok())
        .map(|handle| handle.0 as isize)
        .unwrap_or(0)
}

fn open(app: &AppHandle, mode: Mode) -> Result<(), String> {
    if is_open(app) {
        if mode == Mode::Enroll && !is_enrolling() {
            // Replace a showing ambient page; enrollment was asked for from Settings.
            close(app);
        } else {
            return Ok(());
        }
    }
    let warm = app.get_webview_window(LABEL);
    let reuse = warm.as_ref().is_some_and(|_| AMBIENT_PAGE.load(Ordering::Acquire) && mode != Mode::Enroll);
    if !reuse {
        if let Some(window) = warm {
            let _ = window.destroy();
        }
    }
    LOCK_SESSION.fetch_add(1, Ordering::AcqRel);
    LOCKED.store(matches!(mode, Mode::Ambient { soft_lock: true }), Ordering::Release);
    ENROLLING.store(mode == Mode::Enroll, Ordering::Release);
    crate::face::reset_attempts();
    let window = match app.get_webview_window(LABEL) {
        Some(window) if reuse => {
            window
        }
        _ => match build(app, false) { Ok(window) => window, Err(error) => { close(app); return Err(error); } },
    };
    AMBIENT_PAGE.store(mode != Mode::Enroll, Ordering::Release);
    if let Err(error) = window.set_fullscreen(true) { close(app); return Err(error.to_string()); }
    SHOWN.store(true, Ordering::Release);
    if let Err(error) = window.show() {
        close(app);
        return Err(error.to_string());
    }
    let _ = window.emit("ambient://shown", ());
    crate::runtime_memory::set_ambient_covering(app, true);
    crate::runtime_memory::set_ambient_active(app, true);
    let _ = window.set_focus();
    Ok(())
}

pub(crate) fn close(app: &AppHandle) {
    LOCK_SESSION.fetch_add(1, Ordering::AcqRel);
    LOCKED.store(false, Ordering::Release);
    ENROLLING.store(false, Ordering::Release);
    SHOWN.store(false, Ordering::Release);
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.emit("ambient://hidden", ());
        AMBIENT_PAGE.store(false, Ordering::Release);
        let _ = window.destroy();
    }
    crate::runtime_memory::set_ambient_covering(app, false);
    crate::runtime_memory::release_native_caches();
}

/// An interrupted idle stretch must not leave its prepared model renderer resident.
fn discard_prepared(app: &AppHandle) {
    if !SHOWN.load(Ordering::Acquire) && !is_enrolling() {
        if let Some(window) = app.get_webview_window(LABEL) {
            AMBIENT_PAGE.store(false, Ordering::Release);
            let _ = window.destroy();
            crate::runtime_memory::release_native_caches();
        }
    }
}

/// Polls twice a second while ambient mode is on, and once every few seconds otherwise.
pub fn spawn(app: AppHandle) {
    spawn_display_holder();
    // The explicitly requested local audit drives these phases itself and never locks Windows.
    if crate::runtime_audit::running() { return; }
    tauri::async_runtime::spawn(async move {
        let mut opened_at: Option<Instant> = None;
        let mut prewarm_tried = false;
        loop {
            let cfg = app
                .state::<AppState>()
                .settings
                .lock()
                .map(|settings| settings.ambient.clone())
                .ok();
            let Some(cfg) = cfg else {
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            };
            let open_now = is_open(&app);
            if !open_now {
                opened_at = None;
                // A kept page that is no longer wanted (soft lock or ambient turned off) goes.
                if (!cfg.enabled || !cfg.soft_lock) && !is_enrolling() {
                    if let Some(window) = app.get_webview_window(LABEL) {
                        AMBIENT_PAGE.store(false, Ordering::Release);
                        let _ = window.destroy();
                    }
                }
            }
            HOLD_DISPLAY.store(open_now && cfg.take_over_screensaver, Ordering::Relaxed);
            // Start ahead of the Windows screen saver, so ambient mode is what shows instead of it.
            let mut threshold = u64::from(cfg.idle_minutes) * 60_000;
            if cfg.take_over_screensaver {
                if let Some(saver) = screensaver_timeout_ms() {
                    threshold = threshold.min(saver.saturating_sub(SAVER_LEAD_MS).max(10_000));
                }
            }
            if let Some(idle) = idle_millis() {
                if open_now && is_enrolling() {
                    // Enrollment ends from the page itself.
                } else if open_now {
                    let since_open = opened_at.get_or_insert_with(Instant::now).elapsed();
                    let since_open_ms = since_open.as_millis() as u64;
                    // Away time counts from the page opening or the last input, whichever is later.
                    let away = idle.min(since_open_ms);
                    if cfg.lock_after_minutes > 0 && away >= u64::from(cfg.lock_after_minutes) * 60_000 {
                        lock_pc(&app);
                        opened_at = None;
                    } else if LOCKED.load(Ordering::Acquire) {
                        // The page itself asks for Hello on input.
                    } else if since_open > OPEN_GRACE && idle + OPEN_GRACE.as_millis() as u64 + 200 < since_open_ms {
                        // Input after the grace period means the user is back.
                        close(&app);
                        opened_at = None;
                    }
                } else if cfg.enabled && idle >= threshold {
                    if open(&app, Mode::Ambient { soft_lock: cfg.soft_lock }).is_ok() {
                        opened_at = Some(Instant::now());
                    }
                } else if cfg.enabled && cfg.soft_lock && idle >= threshold.saturating_sub(PREWARM_LEAD_MS) {
                    // Once per idle stretch: checking enrollment reads the face store.
                    if !prewarm_tried {
                        prewarm_tried = true;
                        prewarm(&app);
                    }
                } else {
                    prewarm_tried = false;
                    discard_prepared(&app);
                }
            }
            let wait = if open_now || cfg.enabled { 700 } else { 4000 };
            tokio::time::sleep(Duration::from_millis(wait)).await;
        }
    });
}

fn soft_lock_enabled(app: &AppHandle) -> bool {
    app.state::<AppState>()
        .settings
        .lock()
        .map(|settings| settings.ambient.soft_lock)
        .unwrap_or(false)
}

#[tauri::command]
pub async fn ambient_open(app: AppHandle) -> Result<(), String> {
    open(&app, Mode::Ambient { soft_lock: soft_lock_enabled(&app) })
}

pub(crate) fn open_enroll(app: &AppHandle) -> Result<(), String> {
    open(app, Mode::Enroll)
}

/// Which flow the page should draw.
#[tauri::command]
pub async fn ambient_mode() -> &'static str {
    if is_enrolling() {
        "enroll"
    } else if !SHOWN.load(Ordering::Acquire) {
        "prewarm"
    } else {
        "ambient"
    }
}

/// Called by the page on a key press or click while soft-locked.
#[tauri::command]
pub async fn ambient_unlock(app: AppHandle) -> Result<UnlockOutcome, String> {
    if !LOCKED.load(Ordering::Acquire) {
        close(&app);
        return Ok(UnlockOutcome::Verified);
    }
    if VERIFYING.swap(true, Ordering::AcqRel) {
        return Ok(UnlockOutcome::Cancelled);
    }
    let hwnd = window_hwnd(&app, LABEL);
    let hello = tauri::async_runtime::spawn_blocking(move || hello_verify(hwnd))
        .await
        .unwrap_or(Hello::Unavailable);
    VERIFYING.store(false, Ordering::Release);
    Ok(match hello {
        Hello::Verified => {
            close(&app);
            UnlockOutcome::Verified
        }
        Hello::Cancelled => UnlockOutcome::Cancelled,
        Hello::Unavailable => {
            lock_pc(&app);
            UnlockOutcome::Locked
        }
    })
}

#[tauri::command]
pub async fn ambient_close(app: AppHandle) -> Result<(), String> {
    close(&app);
    Ok(())
}
