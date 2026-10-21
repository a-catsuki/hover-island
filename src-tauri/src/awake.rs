//! "Keep me awake": holds the PC awake until a chosen time and sounds random check-in alarms.
//!
//! One long-lived thread owns everything: it calls `SetThreadExecutionState` (that API is per
//! thread, so the same thread must set and clear it), sleeps on a condvar until the next
//! deadline and fires alarms. Alarms are emitted as `awake://alarm` for the webview to play with
//! WebAudio; if the webview does not acknowledge within 1.5 seconds (hidden, throttled, or the
//! autoplay policy blocked it) this thread plays the same sound itself, so an alarm is never
//! silent. The session end time is saved to `<app_config_dir>/awake.json` and resumed on launch.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Condvar, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::awake_core::{
    escalated_volume, plan_next_alarm, tone_wav, valid_sound, Intensity, Rng, Tone,
    FINAL_GUARD_MS, MAX_LEVEL, MAX_SESSION_MS, MIN_SESSION_MS,
};

const TICK_MS: i64 = 30_000;
const ACK_WAIT_MS: u64 = 1_500;

struct Session {
    end_ms: i64,
    started_ms: i64,
    intensity: Intensity,
    volume: f32,
    sound: String,
    next_alarm_ms: Option<i64>,
    pending_since_ms: Option<i64>,
    escalate_at_ms: i64,
    level: u32,
    alarm_count: u32,
    seq: u64,
    last_confirmed_ms: Option<i64>,
    snoozed_until_ms: Option<i64>,
    last_tick_ms: i64,
}

struct Inner {
    session: Option<Session>,
}

struct Shared {
    inner: Mutex<Inner>,
    wake: Condvar,
}

static SHARED: OnceLock<Shared> = OnceLock::new();
/// Highest alarm sequence number the webview confirmed it played.
static ACKED: AtomicU64 = AtomicU64::new(0);
static SEQ: AtomicU64 = AtomicU64::new(0);
/// True while the scheduler thread holds the execution state.
static KEEPING: AtomicBool = AtomicBool::new(false);

fn shared() -> &'static Shared {
    SHARED.get_or_init(|| Shared {
        inner: Mutex::new(Inner { session: None }),
        wake: Condvar::new(),
    })
}

fn lock() -> MutexGuard<'static, Inner> {
    shared().inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn seed() -> u64 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(1);
    nanos ^ ((std::process::id() as u64) << 32)
}

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AwakeStatus {
    pub active: bool,
    pub end_epoch_ms: i64,
    pub started_at_ms: i64,
    pub intensity: String,
    pub volume: f32,
    pub sound: String,
    pub next_alarm_at_ms: Option<i64>,
    pub pending: bool,
    pub pending_since_ms: Option<i64>,
    pub level: u32,
    pub alarm_count: u32,
    pub seq: u64,
    pub last_confirmed_at_ms: Option<i64>,
    pub snoozed_until_ms: Option<i64>,
    pub keeping_awake: bool,
    pub now_ms: i64,
}

fn status_of(session: Option<&Session>, now: i64) -> AwakeStatus {
    match session {
        None => AwakeStatus {
            intensity: "medium".into(),
            volume: 0.6,
            sound: "chimes".into(),
            now_ms: now,
            ..AwakeStatus::default()
        },
        Some(s) => AwakeStatus {
            active: true,
            end_epoch_ms: s.end_ms,
            started_at_ms: s.started_ms,
            intensity: s.intensity.as_str().into(),
            volume: s.volume,
            sound: s.sound.clone(),
            next_alarm_at_ms: if s.pending_since_ms.is_some() { None } else { s.next_alarm_ms },
            pending: s.pending_since_ms.is_some(),
            pending_since_ms: s.pending_since_ms,
            level: s.level,
            alarm_count: s.alarm_count,
            seq: s.seq,
            last_confirmed_at_ms: s.last_confirmed_ms,
            snoozed_until_ms: s.snoozed_until_ms.filter(|until| *until > now),
            keeping_awake: KEEPING.load(Ordering::Relaxed),
            now_ms: now,
        },
    }
}

fn current_status() -> AwakeStatus {
    let guard = lock();
    status_of(guard.session.as_ref(), now_ms())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AlarmPayload {
    seq: u64,
    level: u32,
    #[serde(rename = "final")]
    is_final: bool,
    /// Volume after escalation, 0 to 1.
    volume: f32,
    sound: String,
    status: AwakeStatus,
}

/* ------------------------------------------------------------- persistence */

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
    end_epoch_ms: i64,
    started_at_ms: i64,
    intensity: String,
    volume: f32,
    sound: String,
}

fn saved_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("awake.json"))
}

fn persist(app: &AppHandle) {
    let Some(path) = saved_path(app) else { return };
    let saved = {
        let guard = lock();
        guard.session.as_ref().map(|s| Saved {
            end_epoch_ms: s.end_ms,
            started_at_ms: s.started_ms,
            intensity: s.intensity.as_str().into(),
            volume: s.volume,
            sound: s.sound.clone(),
        })
    };
    match saved {
        Some(saved) => {
            if let Ok(text) = serde_json::to_string(&saved) {
                let temp = path.with_extension("json.tmp");
                if std::fs::write(&temp, text).is_ok() && std::fs::rename(&temp, &path).is_err() {
                    let _ = std::fs::remove_file(&path);
                    let _ = std::fs::rename(&temp, &path);
                }
            }
        }
        None => {
            let _ = std::fs::remove_file(&path);
        }
    }
}

fn restore(app: &AppHandle) {
    let Some(path) = saved_path(app) else { return };
    let Ok(text) = std::fs::read_to_string(&path) else { return };
    let Ok(saved) = serde_json::from_str::<Saved>(&text) else {
        let _ = std::fs::remove_file(&path);
        return;
    };
    let now = now_ms();
    let intensity = Intensity::parse(&saved.intensity);
    match intensity {
        Some(intensity) if saved.end_epoch_ms > now + 5_000 && valid_sound(&saved.sound) => {
            let mut rng = Rng::new(seed());
            let session = new_session(now, saved.end_epoch_ms, intensity, saved.volume, saved.sound, &mut rng);
            let mut guard = lock();
            guard.session = Some(Session { started_ms: saved.started_at_ms, ..session });
        }
        // Ended while the app was closed (or the file is unusable): nothing to resume.
        _ => {
            let _ = std::fs::remove_file(&path);
        }
    }
}

fn new_session(now: i64, end_ms: i64, intensity: Intensity, volume: f32, sound: String, rng: &mut Rng) -> Session {
    Session {
        end_ms,
        started_ms: now,
        intensity,
        volume: volume.clamp(0.05, 1.0),
        sound,
        next_alarm_ms: plan_next_alarm(now, end_ms, intensity, rng),
        pending_since_ms: None,
        escalate_at_ms: 0,
        level: 0,
        alarm_count: 0,
        seq: 0,
        last_confirmed_ms: None,
        snoozed_until_ms: None,
        last_tick_ms: now,
    }
}

/* ----------------------------------------------------------------- sounds */

#[cfg(windows)]
static PLAYING: Mutex<Option<Vec<u8>>> = Mutex::new(None);

/// Plays a synthesised alarm now, replacing any alarm still sounding. Returns false when it could not play.
pub fn play_tone(tone: Tone, gain: f32, repeats: u32, seed: u64) -> bool {
    let bytes = tone_wav(tone, gain, repeats, seed);
    play_wav(bytes)
}

#[cfg(windows)]
fn play_wav(bytes: Vec<u8>) -> bool {
    use windows::Win32::Foundation::HMODULE;
    use windows::Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_MEMORY, SND_NODEFAULT};
    let mut slot = PLAYING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    // The previous buffer must outlive the new PlaySoundW call (which is what stops it).
    let previous = slot.take();
    *slot = Some(bytes);
    let pointer = slot.as_ref().map(|data| data.as_ptr()).unwrap_or(std::ptr::null());
    let ok = unsafe {
        PlaySoundW(
            windows::core::PCWSTR(pointer.cast()),
            HMODULE::default(),
            SND_MEMORY | SND_ASYNC | SND_NODEFAULT,
        )
    };
    drop(previous);
    ok.as_bool()
}

#[cfg(not(windows))]
fn play_wav(bytes: Vec<u8>) -> bool {
    let _ = bytes;
    false
}

/// The Windows "exclamation" system sound, in the user's own sound scheme.
pub fn play_system_sound() -> bool {
    #[cfg(windows)]
    {
        use windows::core::w;
        use windows::Win32::Foundation::HMODULE;
        use windows::Win32::Media::Audio::{PlaySoundW, SND_ALIAS, SND_ASYNC, SND_NODEFAULT};
        let ok = unsafe {
            PlaySoundW(
                w!("SystemExclamation"),
                HMODULE::default(),
                SND_ALIAS | SND_ASYNC | SND_NODEFAULT,
            )
        };
        ok.as_bool()
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn play_alarm(sound: &str, volume: f32, level: u32, is_final: bool, seq: u64) {
    if is_final {
        play_tone(Tone::Final, volume.min(0.7), 1, seq);
        return;
    }
    if sound == "system" {
        play_system_sound();
        return;
    }
    let repeats = if level >= 3 { 3 } else if level >= 1 { 2 } else { 1 };
    play_tone(Tone::from_sound(sound), volume, repeats, seq);
}

/* -------------------------------------------------------------- execution */

fn hold_awake() -> bool {
    #[cfg(windows)]
    {
        use windows::Win32::System::Power::{
            SetThreadExecutionState, ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED,
        };
        // Returns the previous state, or 0 when the call failed.
        let previous = unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED) };
        previous.0 != 0
    }
    #[cfg(not(windows))]
    {
        true
    }
}

fn release_awake() {
    #[cfg(windows)]
    {
        use windows::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS};
        unsafe {
            SetThreadExecutionState(ES_CONTINUOUS);
        }
    }
}

/* -------------------------------------------------------------- scheduler */

enum Decision {
    /// Nothing to do until this long from now (None: until woken).
    Sleep(Option<Duration>),
    Tick,
    Alarm { seq: u64, level: u32, sound: String, volume: f32 },
    Finish { seq: u64, sound: String, volume: f32 },
}

fn next_seq() -> u64 {
    SEQ.fetch_add(1, Ordering::Relaxed) + 1
}

fn decide(inner: &mut Inner, now: i64) -> Decision {
    let Some(s) = inner.session.as_mut() else {
        return Decision::Sleep(None);
    };
    if now >= s.end_ms {
        s.seq = next_seq();
        return Decision::Finish { seq: s.seq, sound: s.sound.clone(), volume: s.volume };
    }
    if s.pending_since_ms.is_some() {
        if now >= s.escalate_at_ms {
            s.level = (s.level + 1).min(MAX_LEVEL);
            s.seq = next_seq();
            s.escalate_at_ms = now + s.intensity.confirm_secs() as i64 * 1000;
            return Decision::Alarm {
                seq: s.seq,
                level: s.level,
                sound: s.sound.clone(),
                volume: escalated_volume(s.volume, s.level),
            };
        }
    } else if let Some(at) = s.next_alarm_ms {
        if now >= at {
            s.pending_since_ms = Some(now);
            s.level = 0;
            s.alarm_count += 1;
            s.seq = next_seq();
            s.escalate_at_ms = now + s.intensity.confirm_secs() as i64 * 1000;
            s.next_alarm_ms = None;
            return Decision::Alarm { seq: s.seq, level: 0, sound: s.sound.clone(), volume: s.volume };
        }
    }
    if now - s.last_tick_ms >= TICK_MS {
        s.last_tick_ms = now;
        return Decision::Tick;
    }
    let mut wake = s.end_ms;
    if s.pending_since_ms.is_some() {
        wake = wake.min(s.escalate_at_ms);
    } else if let Some(at) = s.next_alarm_ms {
        wake = wake.min(at);
    }
    wake = wake.min(s.last_tick_ms + TICK_MS);
    let wait = (wake - now).clamp(50, TICK_MS);
    Decision::Sleep(Some(Duration::from_millis(wait as u64)))
}

fn emit_state(app: &AppHandle) {
    let _ = app.emit("awake://state", current_status());
}

fn announce_alarm(app: &AppHandle, seq: u64, level: u32, sound: &str, volume: f32, is_final: bool) {
    let payload = AlarmPayload {
        seq,
        level,
        is_final,
        volume,
        sound: sound.to_string(),
        status: current_status(),
    };
    let _ = app.emit("awake://alarm", payload);
    if sound != "system" || is_final {
        // Give the webview a moment to play its own version; fall back to a native tone.
        let mut waited = 0;
        while waited < ACK_WAIT_MS && ACKED.load(Ordering::Relaxed) < seq {
            std::thread::sleep(Duration::from_millis(100));
            waited += 100;
        }
        if ACKED.load(Ordering::Relaxed) >= seq {
            return;
        }
    }
    play_alarm(sound, volume, level, is_final, seq);
}

fn run(app: AppHandle) {
    let mut guard = lock();
    loop {
        let now = now_ms();
        let want_awake = guard.session.is_some();
        if want_awake && !KEEPING.load(Ordering::Relaxed) {
            KEEPING.store(hold_awake(), Ordering::Relaxed);
        } else if !want_awake && KEEPING.load(Ordering::Relaxed) {
            release_awake();
            KEEPING.store(false, Ordering::Relaxed);
        }
        match decide(&mut guard, now) {
            Decision::Sleep(None) => {
                guard = shared().wake.wait(guard).unwrap_or_else(|poisoned| poisoned.into_inner());
            }
            Decision::Sleep(Some(wait)) => {
                guard = shared()
                    .wake
                    .wait_timeout(guard, wait)
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .0;
            }
            Decision::Tick => {
                // Re-assert the hold in case another app cleared it, then let the UI resync.
                if KEEPING.load(Ordering::Relaxed) {
                    hold_awake();
                }
                drop(guard);
                let _ = app.emit("awake://tick", current_status());
                guard = lock();
            }
            Decision::Alarm { seq, level, sound, volume } => {
                drop(guard);
                let _ = app.emit("awake://state", current_status());
                announce_alarm(&app, seq, level, &sound, volume, false);
                guard = lock();
            }
            Decision::Finish { seq, sound, volume } => {
                let status = status_of(guard.session.as_ref(), now);
                drop(guard);
                let payload = AlarmPayload { seq, level: 0, is_final: true, volume, sound: sound.clone(), status };
                let _ = app.emit("awake://alarm", payload);
                let mut waited = 0;
                while waited < ACK_WAIT_MS && ACKED.load(Ordering::Relaxed) < seq {
                    std::thread::sleep(Duration::from_millis(100));
                    waited += 100;
                }
                if ACKED.load(Ordering::Relaxed) < seq {
                    play_alarm(&sound, volume, 0, true, seq);
                }
                guard = lock();
                guard.session = None;
                drop(guard);
                persist(&app);
                let _ = app.emit("awake://finished", current_status());
                emit_state(&app);
                guard = lock();
            }
        }
    }
}

/// Starts the scheduler thread and resumes a saved session. Call once from `setup`, after
/// `app.manage(...)`.
pub fn spawn(app: AppHandle) {
    restore(&app);
    let _ = std::thread::Builder::new()
        .name("awake-scheduler".into())
        .spawn(move || run(app));
}

/* --------------------------------------------------------------- commands */

#[tauri::command]
pub fn awake_start(
    app: AppHandle,
    end_epoch_ms: i64,
    intensity: String,
    volume: f64,
    sound: String,
) -> Result<AwakeStatus, String> {
    let now = now_ms();
    let intensity = Intensity::parse(&intensity).ok_or("Pick Gentle, Medium or Relentless.")?;
    if !valid_sound(&sound) {
        return Err("That alarm sound is not available.".into());
    }
    if !volume.is_finite() {
        return Err("Volume must be a number.".into());
    }
    if end_epoch_ms - now < MIN_SESSION_MS {
        return Err("Pick an end time at least a minute from now.".into());
    }
    if end_epoch_ms - now > MAX_SESSION_MS {
        return Err("Pick an end time within the next 18 hours.".into());
    }
    {
        let mut rng = Rng::new(seed());
        let session = new_session(now, end_epoch_ms, intensity, volume as f32, sound, &mut rng);
        lock().session = Some(session);
    }
    persist(&app);
    shared().wake.notify_all();
    let status = current_status();
    let _ = app.emit("awake://state", status.clone());
    Ok(status)
}

#[tauri::command]
pub fn awake_stop(app: AppHandle) -> Result<AwakeStatus, String> {
    lock().session = None;
    persist(&app);
    shared().wake.notify_all();
    let status = current_status();
    let _ = app.emit("awake://state", status.clone());
    Ok(status)
}

/// The user answered an alarm. `snooze_minutes` pushes the next alarm out by that long.
#[tauri::command]
pub fn awake_confirm(app: AppHandle, snooze_minutes: Option<u32>) -> Result<AwakeStatus, String> {
    {
        let mut guard = lock();
        let now = now_ms();
        let mut rng = Rng::new(seed());
        if let Some(s) = guard.session.as_mut() {
            s.pending_since_ms = None;
            s.level = 0;
            s.last_confirmed_ms = Some(now);
            let snooze = snooze_minutes.unwrap_or(0).min(60) as i64;
            if snooze > 0 {
                let until = now + snooze * 60_000;
                s.snoozed_until_ms = Some(until);
                s.next_alarm_ms = if until > s.end_ms - FINAL_GUARD_MS { None } else { Some(until) };
            } else {
                s.snoozed_until_ms = None;
                s.next_alarm_ms = plan_next_alarm(now, s.end_ms, s.intensity, &mut rng);
            }
        }
    }
    shared().wake.notify_all();
    let status = current_status();
    let _ = app.emit("awake://state", status.clone());
    Ok(status)
}

/// The webview reports that it played alarm `seq`, so the scheduler stays quiet.
#[tauri::command]
pub fn awake_audio_ack(seq: u64) {
    ACKED.fetch_max(seq, Ordering::Relaxed);
}

#[tauri::command]
pub fn awake_status() -> AwakeStatus {
    current_status()
}
