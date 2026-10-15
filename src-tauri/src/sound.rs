//! Original short notification tones. No Apple sound assets are distributed.
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

static LAST_PLAYED: Mutex<Option<Instant>> = Mutex::new(None);
static SOFT: OnceLock<Vec<u8>> = OnceLock::new();
static GLASS: OnceLock<Vec<u8>> = OnceLock::new();

fn tone(kind: &str) -> Vec<u8> {
    let rate = 22_050u32;
    let count = (rate as f64 * 0.62) as usize;
    let mut bytes = Vec::with_capacity(44 + count * 2);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36u32 + count as u32 * 2).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&rate.to_le_bytes());
    bytes.extend_from_slice(&(rate * 2).to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&16u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&(count as u32 * 2).to_le_bytes());
    let base = if kind == "glass" { 1046.5 } else { 783.99 };
    for index in 0..count {
        let t = index as f64 / rate as f64;
        let mut sample = 0.0;
        for (delay, multiplier, gain) in [(0.0, 1.0, 0.16), (0.075, 1.5, 0.11), (0.0, 2.01, 0.035)] {
            let age = t - delay;
            if age >= 0.0 {
                let attack = (age / 0.008).min(1.0);
                sample += (age * base * multiplier * std::f64::consts::TAU).sin()
                    * (-age * 8.0).exp() * attack * gain;
            }
        }
        let fade = ((0.62 - t) / 0.04).clamp(0.0, 1.0);
        bytes.extend_from_slice(&((sample * fade * i16::MAX as f64) as i16).to_le_bytes());
    }
    bytes
}

#[tauri::command]
pub fn play_alert_sound(app: tauri::AppHandle, kind: Option<String>) -> Result<(), String> {
    let prefs = app.state::<crate::state::AppState>().settings.lock().map_err(|_| "Sound preferences unavailable")?.clone();
    if prefs.dnd || !prefs.notifications.enabled { return Ok(()); }
    let kind = kind.as_deref().unwrap_or(&prefs.notifications.sound);
    if kind == "off" { return Ok(()); }
    if !matches!(kind, "soft" | "glass") { return Err("Unknown alert sound".into()); }
    let mut last = LAST_PLAYED.lock().map_err(|_| "Sound is unavailable")?;
    if last.is_some_and(|at| at.elapsed() < Duration::from_millis(1500)) { return Ok(()); }
    *last = Some(Instant::now());
    let bytes = if kind == "glass" { GLASS.get_or_init(|| tone("glass")) } else { SOFT.get_or_init(|| tone("soft")) };
    #[cfg(windows)] {
        use windows::core::PCWSTR;
        use windows::Win32::Foundation::HMODULE;
        use windows::Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_MEMORY, SND_NODEFAULT, SND_SYSTEM};
        // OnceLock owns the WAV for the process lifetime, including asynchronous playback.
        let ok = unsafe { PlaySoundW(PCWSTR(bytes.as_ptr().cast()), HMODULE::default(), SND_MEMORY | SND_ASYNC | SND_NODEFAULT | SND_SYSTEM) };
        if !ok.as_bool() { return Err("Windows could not play the alert sound".into()); }
    }
    #[cfg(not(windows))] { let _ = bytes; }
    Ok(())
}

/// Fires the same alert pipeline a real connection uses (chime + notch peek +
/// collapsed badge) so the user can verify alerts end to end from Settings.
#[tauri::command]
pub fn send_test_alert(app: tauri::AppHandle) -> Result<(), String> {
    {
        let prefs = app.state::<crate::state::AppState>().settings.lock().map_err(|_| "Sound preferences unavailable")?.clone();
        if prefs.dnd { return Err("Do Not Disturb is on, so the test alert is silent".into()); }
        if !prefs.notifications.enabled { return Err("Notifications are turned off".into()); }
    }
    play_alert_sound(app.clone(), None)?;
    let _ = app.emit("alert://test", ());
    Ok(())
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn original_chimes_are_bounded_pcm_waves() {
        for kind in ["soft", "glass"] {
            let bytes = tone(kind);
            assert_eq!(&bytes[..4], b"RIFF");
            assert_eq!(&bytes[8..12], b"WAVE");
            assert_eq!(u32::from_le_bytes(bytes[40..44].try_into().unwrap()) as usize, bytes.len()-44);
            let samples:Vec<_> = bytes[44..].chunks_exact(2).map(|s| i16::from_le_bytes([s[0],s[1]])).collect();
            assert!(samples.iter().any(|sample| sample.abs() > 100));
            assert!(samples.iter().all(|sample| sample.abs() < i16::MAX / 2));
            assert!(samples.last().unwrap().abs() < 10);
        }
    }
}
