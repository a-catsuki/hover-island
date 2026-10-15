use std::cell::RefCell;
use std::sync::Mutex;

use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession, GlobalSystemMediaTransportControlsSessionManager,
    GlobalSystemMediaTransportControlsSessionMediaProperties,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
};
use windows::Storage::Streams::DataReader;

use crate::types::NowPlaying;

/// (title|artist, data-url or "" for a known miss). Avoids re-reading art every second.
static THUMB_CACHE: Mutex<Option<(String, String)>> = Mutex::new(None);

// WinRT requires the calling thread to have a COM apartment. Tauri worker threads and our
// own background thread do NOT have one by default, which made every media call fail silently.
thread_local! {
    static COM: () = {
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
    };
    static SESSION_MANAGER: RefCell<Option<GlobalSystemMediaTransportControlsSessionManager>> = const { RefCell::new(None) };
}

fn ensure_com() {
    COM.with(|_| {});
}

fn session_manager() -> windows::core::Result<GlobalSystemMediaTransportControlsSessionManager> {
    SESSION_MANAGER.with(|slot| {
        if let Some(manager) = slot.borrow().as_ref() {
            return Ok(manager.clone());
        }
        let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()?.get()?;
        *slot.borrow_mut() = Some(manager.clone());
        Ok(manager)
    })
}

fn es<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

pub fn get() -> Option<NowPlaying> {
    get_checked().ok().flatten()
}

pub fn get_checked() -> Result<Option<NowPlaying>, String> {
    ensure_com();
    let manager = session_manager().map_err(es)?;
    // Windows reports an error when no session is active. Keep that normal state
    // distinct from failures reading the selected session's playback metadata.
    let session = match manager.GetCurrentSession() {
        Ok(session) => session,
        Err(_) => return Ok(None),
    };
    let props = session
        .TryGetMediaPropertiesAsync()
        .map_err(es)?
        .get()
        .map_err(es)?;

    let title = props.Title().map_err(es)?.to_string();
    let artist = props.Artist().map_err(es)?.to_string();
    let album = props.AlbumTitle().ok().map(|h| h.to_string());

    let playback = session.GetPlaybackInfo().map_err(es)?;
    let status = status_str(playback.PlaybackStatus().map_err(es)?);
    let controls = playback.Controls().ok();
    let can_play = controls
        .as_ref()
        .and_then(|c| c.IsPlayEnabled().ok())
        .unwrap_or(false);
    let can_pause = controls
        .as_ref()
        .and_then(|c| c.IsPauseEnabled().ok())
        .unwrap_or(false);
    let can_skip_next = controls
        .as_ref()
        .and_then(|c| c.IsNextEnabled().ok())
        .unwrap_or(false);
    let can_skip_previous = controls
        .as_ref()
        .and_then(|c| c.IsPreviousEnabled().ok())
        .unwrap_or(false);

    let timeline = timeline(&session, controls.as_ref());
    let thumbnail = thumb_cached(&props, &title, &artist);

    Ok(Some(NowPlaying {
        title,
        artist,
        album,
        thumbnail,
        status,
        position: timeline.position,
        duration: timeline.duration,
        can_play,
        can_pause,
        can_skip_next,
        can_skip_previous,
        can_seek: timeline.can_seek,
        seek_min: timeline.seek_min,
        seek_max: timeline.seek_max,
        source_app: session.SourceAppUserModelId().ok().map(|h| h.to_string()),
    }))
}

fn thumb_cached(
    props: &GlobalSystemMediaTransportControlsSessionMediaProperties,
    title: &str,
    artist: &str,
) -> Option<String> {
    let key = format!("{title}\u{1}{artist}");
    if let Ok(cache) = THUMB_CACHE.lock() {
        if let Some((k, v)) = cache.as_ref() {
            if *k == key {
                return if v.is_empty() { None } else { Some(v.clone()) };
            }
        }
    }
    let data = read_thumbnail(props);
    if let Ok(mut cache) = THUMB_CACHE.lock() {
        *cache = Some((key, data.clone().unwrap_or_default()));
    }
    data
}

fn read_thumbnail(
    props: &GlobalSystemMediaTransportControlsSessionMediaProperties,
) -> Option<String> {
    let reference = props.Thumbnail().ok()?;
    let stream = reference.OpenReadAsync().ok()?.get().ok()?;
    let size = stream.Size().ok()? as usize;
    if size == 0 || size > 8_000_000 {
        return None;
    }
    let input = stream.GetInputStreamAt(0).ok()?;
    let reader = DataReader::CreateDataReader(&input).ok()?;

    let mut buf: Vec<u8> = Vec::with_capacity(size);
    let mut remaining = size;
    while remaining > 0 {
        let want = remaining.min(64 * 1024) as u32;
        let loaded = reader.LoadAsync(want).ok()?.get().ok()? as usize;
        if loaded == 0 {
            break;
        }
        let start = buf.len();
        buf.resize(start + loaded, 0);
        reader.ReadBytes(&mut buf[start..]).ok()?;
        remaining = remaining.saturating_sub(loaded);
    }
    if buf.is_empty() {
        return None;
    }
    use base64::Engine;
    Some(format!(
        "data:{};base64,{}",
        sniff_mime(&buf),
        base64::engine::general_purpose::STANDARD.encode(&buf)
    ))
}

fn sniff_mime(buf: &[u8]) -> &'static str {
    if buf.starts_with(&[0x89, b'P', b'N', b'G']) {
        "image/png"
    } else if buf.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg"
    } else if buf.starts_with(b"GIF8") {
        "image/gif"
    } else if buf.len() > 12 && &buf[0..4] == b"RIFF" && &buf[8..12] == b"WEBP" {
        "image/webp"
    } else {
        "image/jpeg"
    }
}

fn status_str(s: PlaybackStatus) -> String {
    if s == PlaybackStatus::Playing {
        "playing".to_string()
    } else if s == PlaybackStatus::Paused {
        "paused".to_string()
    } else {
        "stopped".to_string()
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct Timeline {
    start: f64,
    position: Option<f64>,
    duration: Option<f64>,
    seek_min: Option<f64>,
    seek_max: Option<f64>,
    can_seek: bool,
}

fn ticks_to_seconds(ticks: i64) -> f64 {
    ticks as f64 / 10_000_000.0
}

fn timeline(
    session: &GlobalSystemMediaTransportControlsSession,
    controls: Option<
        &windows::Media::Control::GlobalSystemMediaTransportControlsSessionPlaybackControls,
    >,
) -> Timeline {
    let Ok(t) = session.GetTimelineProperties() else {
        return Timeline::default();
    };
    let (Ok(start), Ok(end), Ok(position), Ok(min_seek), Ok(max_seek)) = (
        t.StartTime(),
        t.EndTime(),
        t.Position(),
        t.MinSeekTime(),
        t.MaxSeekTime(),
    ) else {
        return Timeline::default();
    };
    let playback_position_enabled = controls
        .and_then(|c| c.IsPlaybackPositionEnabled().ok())
        .unwrap_or(false);
    timeline_from_ticks(
        start.Duration,
        end.Duration,
        position.Duration,
        min_seek.Duration,
        max_seek.Duration,
        playback_position_enabled,
    )
}

fn timeline_from_ticks(
    start: i64,
    end: i64,
    position: i64,
    min_seek: i64,
    max_seek: i64,
    playback_position_enabled: bool,
) -> Timeline {
    let span = end.saturating_sub(start);
    if start < 0 || span <= 0 || position < start || position > end {
        return Timeline::default();
    }

    let duration = ticks_to_seconds(span);
    let position = ticks_to_seconds(position - start);
    let range_start = min_seek.max(start).min(end);
    let range_end = max_seek.max(start).min(end);
    let valid_seek_range = range_end > range_start;
    let can_seek = valid_seek_range && playback_position_enabled;

    Timeline {
        start: ticks_to_seconds(start),
        position: Some(position),
        duration: Some(duration),
        seek_min: can_seek.then(|| ticks_to_seconds(range_start - start)),
        seek_max: can_seek.then(|| ticks_to_seconds(range_end - start)),
        can_seek,
    }
}

pub fn control(action: &str, value: Option<f64>) -> Result<(), String> {
    ensure_com();
    let manager = session_manager().map_err(es)?;
    let session = manager.GetCurrentSession().map_err(es)?;

    match action {
        "play" => {
            require_control(&session, |c| c.IsPlayEnabled(), "play")?;
            require_success(
                session.TryPlayAsync().map_err(es)?.get().map_err(es)?,
                "playback",
            )?;
        }
        "pause" => {
            require_control(&session, |c| c.IsPauseEnabled(), "pause")?;
            require_success(
                session.TryPauseAsync().map_err(es)?.get().map_err(es)?,
                "pause",
            )?;
        }
        "toggle" => {
            let info = session.GetPlaybackInfo().map_err(es)?;
            let playing = info.PlaybackStatus().map_err(es)? == PlaybackStatus::Playing;
            let controls = info.Controls().map_err(es)?;
            let op = if playing {
                if !controls.IsPauseEnabled().map_err(es)? {
                    return Err("active media session does not support pause".into());
                }
                session.TryPauseAsync()
            } else {
                if !controls.IsPlayEnabled().map_err(es)? {
                    return Err("active media session does not support play".into());
                }
                session.TryPlayAsync()
            };
            require_success(op.map_err(es)?.get().map_err(es)?, "toggle")?;
        }
        "next" => {
            require_control(&session, |c| c.IsNextEnabled(), "skip next")?;
            require_success(
                session.TrySkipNextAsync().map_err(es)?.get().map_err(es)?,
                "skip next",
            )?;
        }
        "previous" => {
            require_control(&session, |c| c.IsPreviousEnabled(), "skip previous")?;
            require_success(
                session
                    .TrySkipPreviousAsync()
                    .map_err(es)?
                    .get()
                    .map_err(es)?,
                "skip previous",
            )?;
        }
        "seek" => {
            let seconds = value.ok_or_else(|| "seek position is required".to_string())?;
            if !seconds.is_finite() || seconds < 0.0 {
                return Err("seek position must be a finite non-negative number".into());
            }
            let info = session.GetPlaybackInfo().map_err(es)?;
            let controls = info.Controls().map_err(es)?;
            if !controls.IsPlaybackPositionEnabled().map_err(es)? {
                return Err("active media session does not support seeking".into());
            }
            let range = timeline(&session, Some(&controls));
            let (Some(duration), Some(min), Some(max)) =
                (range.duration, range.seek_min, range.seek_max)
            else {
                return Err("active media session has no valid seek timeline".into());
            };
            if seconds > duration || seconds < min || seconds > max {
                return Err("seek position is outside the active session's seek range".into());
            }
            let ticks = ((range.start + seconds) * 10_000_000.0).min(i64::MAX as f64) as i64;
            require_success(
                session
                    .TryChangePlaybackPositionAsync(ticks)
                    .map_err(es)?
                    .get()
                    .map_err(es)?,
                "seek",
            )?;
        }
        _ => return Err(format!("unsupported media action: {action}")),
    }
    Ok(())
}

fn require_control(
    session: &GlobalSystemMediaTransportControlsSession,
    enabled: impl FnOnce(
        &windows::Media::Control::GlobalSystemMediaTransportControlsSessionPlaybackControls,
    ) -> windows::core::Result<bool>,
    action: &str,
) -> Result<(), String> {
    let controls = session
        .GetPlaybackInfo()
        .map_err(es)?
        .Controls()
        .map_err(es)?;
    if enabled(&controls).map_err(es)? {
        Ok(())
    } else {
        Err(format!("active media session does not support {action}"))
    }
}

fn require_success(success: bool, action: &str) -> Result<(), String> {
    if success {
        Ok(())
    } else {
        Err(format!("media {action} was rejected by the active session"))
    }
}

/// Media controls use blocking WinRT `.get()` internally, so run them outside
/// the Tauri IPC/UI thread and return only after the platform reports success.
pub async fn control_async(action: String, value: Option<f64>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || control(&action, value))
        .await
        .map_err(|error| format!("media control worker failed: {error}"))?
}

/* ------------------------------- commands ------------------------------- */

#[tauri::command]
pub async fn media_get() -> Result<Option<NowPlaying>, String> {
    // The synchronous WinRT `.get()` calls in `get()` can wait for the Windows
    // media service (and thumbnail stream). Never run them on Tauri's IPC/UI
    // thread, especially because the frontend asks for media during startup.
    tauri::async_runtime::spawn_blocking(get_checked)
        .await
        .map_err(|error| format!("media worker failed: {error}"))?
}

#[tauri::command]
pub async fn media_control(action: String, value: Option<f64>) -> Result<(), String> {
    control_async(action, value).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeking_requires_enabled_control_and_valid_timeline() {
        let range = timeline_from_ticks(
            10_000_000,
            110_000_000,
            30_000_000,
            20_000_000,
            90_000_000,
            true,
        );
        assert!(range.can_seek);
        assert_eq!(range.start, 1.0);
        assert_eq!(range.position, Some(2.0));
        assert_eq!(range.duration, Some(10.0));
        assert_eq!(range.seek_min, Some(1.0));
        assert_eq!(range.seek_max, Some(8.0));

        let disabled = timeline_from_ticks(0, 100_000_000, 50_000_000, 0, 100_000_000, false);
        assert!(!disabled.can_seek);
        assert_eq!(disabled.duration, Some(10.0));
        assert_eq!(disabled.seek_min, None);
        assert_eq!(disabled.seek_max, None);
    }

    #[test]
    fn malformed_timeline_is_neither_progress_nor_seekable() {
        let invalid = timeline_from_ticks(0, 0, 0, 0, 0, true);
        assert_eq!(invalid, Timeline::default());
        let out_of_bounds = timeline_from_ticks(0, 10, 11, 0, 10, true);
        assert_eq!(out_of_bounds, Timeline::default());
    }
}
