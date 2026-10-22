//! Face unlock for the ambient soft lock. The ambient page runs the face models on webcam
//! frames and sends only face descriptors (number vectors) here; no image ever leaves the
//! page. Enrolled descriptors stay on disk under Windows DPAPI and never go back to the page,
//! so matching and the attempt limit live on this side.
//!
//! A 2D webcam is weaker than Windows Hello's IR camera. The page requires a blink and the
//! anti-spoof and liveness scores to pass, which stops a held-up photo, not a replayed video
//! or a determined attacker. The soft lock is a privacy
//! screen; the real Windows lock after time away is the security boundary.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::ambient::{self, Hello};
use crate::state::AppState;

const STORE_FILE: &str = "face-unlock.dpapi";
const STORE_VERSION: u32 = 1;
const MAX_STORE_BYTES: usize = 512 * 1024;
const MIN_DESCRIPTOR: usize = 64;
const MAX_DESCRIPTOR: usize = 2048;
const MAX_TEMPLATES: usize = 24;
const MIN_TEMPLATES: usize = 3;
const MAX_SAMPLES: usize = 8;
/// Normalized similarity (0..1) of the face model, averaged over the scan's frames. Its authors
/// treat 0.5 as a match; 0.62 rejected real owners in dim, screen-lit rooms.
const MATCH_THRESHOLD: f32 = 0.55;
/// A single frame is noisier than an average, so it alone must clear a higher bar. Matching on
/// the first good frame is what makes an unlock feel instant.
const SINGLE_FRAME_THRESHOLD: f32 = 0.58;
/// Anti-spoof ("real") and liveness ("live") model scores, 0..1, averaged over the scan.
const MIN_REAL: f32 = 0.5;
const MIN_LIVE: f32 = 0.5;
/// Faces learned from successful unlocks, kept beside the enrolled ones (oldest dropped first),
/// so matching follows lighting, glasses and hair the way Face ID does.
const MAX_LEARNED: usize = 12;
/// A matching face this close to a known one adds nothing worth keeping.
const LEARN_BELOW: f32 = 0.9;
/// Failed scans before only Windows Hello can unlock, as with Face ID and a passcode.
const MAX_ATTEMPTS: u32 = 5;
/// Misses inside one scan that are not yet counted as a failed attempt. The page checks each good
/// frame as it arrives and only the scan's last check counts, but this caps the free ones.
const MAX_PROBES: u32 = 4;
/// How long the page's check-mark and unlock animation runs after a match.
const UNLOCK_ANIMATION: Duration = Duration::from_millis(560);

static ATTEMPTS: AtomicU32 = AtomicU32::new(0);
static PROBES: AtomicU32 = AtomicU32::new(0);
/// Set once Hello confirms the user in Settings; one enrollment may then be saved.
static ENROLL_ALLOWED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Default, Serialize, Deserialize)]
struct Store {
    version: u32,
    templates: Vec<Vec<f32>>,
    #[serde(default)]
    learned: Vec<Vec<f32>>,
}

impl Store {
    fn known(&self) -> Vec<&[f32]> {
        self.templates.iter().chain(&self.learned).map(Vec::as_slice).collect()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FaceStatus {
    enrolled: bool,
    attempts_left: u32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FaceSample {
    descriptor: Vec<f32>,
    real: f32,
    live: f32,
}

/// A verdict and the scan's scores, which the page shows after a miss to help tune lighting.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FaceCheck {
    verdict: FaceVerdict,
    score: f32,
    real: f32,
    live: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FaceVerdict {
    /// The face matched; the ambient page closes once its animation has played.
    Match,
    NoMatch,
    /// Too many failed scans, or the face looked like a photo or screen too often.
    LockedOut,
    NotEnrolled,
}

pub(crate) fn reset_attempts() {
    ATTEMPTS.store(0, Ordering::Release);
    PROBES.store(0, Ordering::Release);
}

fn attempts_left() -> u32 {
    MAX_ATTEMPTS.saturating_sub(ATTEMPTS.load(Ordering::Acquire))
}

fn storage_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(STORE_FILE))
        .map_err(|_| "Could not locate face unlock storage.".into())
}

fn read_store(app: &AppHandle) -> Result<Store, String> {
    let bytes = match std::fs::read(storage_path(app)?) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Store::default()),
        Err(_) => return Err("Could not read face unlock data.".into()),
    };
    if bytes.len() > MAX_STORE_BYTES {
        return Err("Face unlock data is invalid.".into());
    }
    let clear = crate::erp::unprotect(&bytes)?;
    let store: Store = serde_json::from_slice(&clear).map_err(|_| "Face unlock data is invalid.".to_string())?;
    if store.version != STORE_VERSION {
        return Ok(Store::default());
    }
    Ok(store)
}

fn write_store(app: &AppHandle, store: &Store) -> Result<(), String> {
    let path = storage_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|_| "Could not save face unlock.".to_string())?;
    }
    let clear = serde_json::to_vec(store).map_err(|_| "Could not save face unlock.".to_string())?;
    let encrypted = crate::erp::protect(&clear)?;
    let temp = path.with_extension("dpapi.tmp");
    std::fs::write(&temp, encrypted).map_err(|_| "Could not save face unlock.".to_string())?;
    std::fs::rename(&temp, &path).map_err(|_| {
        let _ = std::fs::remove_file(&temp);
        "Could not save face unlock.".to_string()
    })
}

fn valid_descriptor(descriptor: &[f32]) -> bool {
    (MIN_DESCRIPTOR..=MAX_DESCRIPTOR).contains(&descriptor.len()) && descriptor.iter().all(|value| value.is_finite())
}

/// The face model's own similarity: scaled euclidean distance, inverted and normalized from
/// 0.2..0.8 to 0..1 (Human `match.similarity` with its defaults), so its thresholds carry over.
fn similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() {
        return 0.0;
    }
    let sum: f64 = a.iter().zip(b).map(|(x, y)| f64::from(x - y).powi(2)).sum();
    let distance = (100.0 * 25.0 * sum).round() / 100.0;
    if distance == 0.0 {
        return 1.0;
    }
    let norm = (1.0 - distance.sqrt() / 100.0 - 0.2) / 0.6;
    norm.clamp(0.0, 1.0) as f32
}

fn best_match(descriptor: &[f32], known: &[&[f32]]) -> f32 {
    known.iter().map(|template| similarity(descriptor, template)).fold(0.0_f32, f32::max)
}

#[derive(Debug, Clone, Copy)]
struct Assessment {
    /// Mean over the frames of each frame's best match.
    score: f32,
    real: f32,
    live: f32,
    pass: bool,
}

fn assess(samples: &[FaceSample], known: &[&[f32]]) -> Assessment {
    let count = samples.len().max(1) as f32;
    let mean = |value: &dyn Fn(&FaceSample) -> f32| samples.iter().map(value).sum::<f32>() / count;
    let score = mean(&|sample| best_match(&sample.descriptor, known));
    let real = mean(&|sample| sample.real);
    let live = mean(&|sample| sample.live);
    let threshold = if samples.len() >= 2 { MATCH_THRESHOLD } else { SINGLE_FRAME_THRESHOLD };
    let pass = !samples.is_empty() && real >= MIN_REAL && live >= MIN_LIVE && score >= threshold;
    Assessment { score, real, live, pass }
}

/// After a match, keep the frame least like what is already known, if it adds anything.
fn learn(store: &mut Store, samples: &[FaceSample]) -> bool {
    let known = store.known();
    let newest = samples
        .iter()
        .map(|sample| (best_match(&sample.descriptor, &known), sample))
        .filter(|(score, _)| *score < LEARN_BELOW)
        .min_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(_, sample)| sample.descriptor.clone());
    let Some(descriptor) = newest else {
        return false;
    };
    if store.templates.first().is_some_and(|first| first.len() != descriptor.len()) {
        return false;
    }
    store.learned.push(descriptor);
    if store.learned.len() > MAX_LEARNED {
        store.learned.remove(0);
    }
    true
}

fn require_blink(app: &AppHandle) -> bool {
    app.state::<AppState>()
        .settings
        .lock()
        .map(|settings| settings.ambient.face_require_blink)
        .unwrap_or(true)
}

#[tauri::command]
pub async fn face_status(app: AppHandle) -> Result<FaceStatus, String> {
    let enrolled = read_store(&app).map(|store| !store.templates.is_empty()).unwrap_or(false);
    Ok(FaceStatus { enrolled, attempts_left: attempts_left() })
}

/// From Settings: confirm with Windows Hello (like Face ID asking for the passcode), then open
/// the full-screen enrollment page.
#[tauri::command]
pub async fn face_enroll_start(app: AppHandle) -> Result<(), String> {
    let hwnd = ambient::window_hwnd(&app, "settings");
    let hello = tauri::async_runtime::spawn_blocking(move || ambient::hello_verify(hwnd))
        .await
        .unwrap_or(Hello::Cancelled);
    // Without Hello there is no PIN to ask for; the user is already at an unlocked desktop.
    if hello == Hello::Cancelled {
        return Err("Windows Hello did not confirm it is you.".into());
    }
    ENROLL_ALLOWED.store(true, Ordering::Release);
    ambient::open_enroll(&app).inspect_err(|_| ENROLL_ALLOWED.store(false, Ordering::Release))
}

#[tauri::command]
pub async fn face_enroll_save(app: AppHandle, templates: Vec<Vec<f32>>) -> Result<(), String> {
    if !ambient::is_enrolling() || !ENROLL_ALLOWED.swap(false, Ordering::AcqRel) {
        return Err("Start face setup from Settings.".into());
    }
    if templates.len() < MIN_TEMPLATES
        || templates.len() > MAX_TEMPLATES
        || !templates.iter().all(|template| valid_descriptor(template) && template.len() == templates[0].len())
    {
        return Err("The face scan was incomplete. Try again.".into());
    }
    write_store(&app, &Store { version: STORE_VERSION, templates, learned: Vec::new() })?;
    reset_attempts();
    Ok(())
}

#[tauri::command]
pub async fn face_reset(app: AppHandle) -> Result<(), String> {
    match std::fs::remove_file(storage_path(&app)?) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Could not remove face unlock.".into()),
    }
}

/// One scan from the locked page: a few frames' descriptors with their anti-spoof and liveness
/// scores. Every call that does not match uses up an attempt.
#[tauri::command]
pub async fn face_verify(app: AppHandle, samples: Vec<FaceSample>, blinked: bool, last: Option<bool>) -> Result<FaceCheck, String> {
    let check = |verdict, assessment: Option<Assessment>| FaceCheck {
        verdict,
        score: assessment.map_or(0.0, |a| a.score),
        real: assessment.map_or(0.0, |a| a.real),
        live: assessment.map_or(0.0, |a| a.live),
    };
    if !ambient::is_locked() {
        return Err("The screen is not locked.".into());
    }
    // With the blink setting on, the page only asks after seeing one; refuse anything else.
    if require_blink(&app) && !blinked {
        return Ok(check(FaceVerdict::NoMatch, None));
    }
    if attempts_left() == 0 {
        return Ok(check(FaceVerdict::LockedOut, None));
    }
    let mut store = read_store(&app)?;
    if store.templates.is_empty() {
        return Ok(check(FaceVerdict::NotEnrolled, None));
    }
    let samples: Vec<FaceSample> = samples
        .into_iter()
        .take(MAX_SAMPLES)
        .filter(|sample| valid_descriptor(&sample.descriptor))
        .collect();
    let assessment = assess(&samples, &store.known());
    if assessment.pass {
        if learn(&mut store, &samples) {
            // Learning is a bonus; a failed write must not block the unlock.
            let _ = write_store(&app, &store);
        }
        // Stay locked while the page plays its unlock animation, then close.
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(UNLOCK_ANIMATION).await;
            if ambient::is_locked() {
                ambient::close(&app);
            }
        });
        return Ok(check(FaceVerdict::Match, Some(assessment)));
    }
    // A probe mid-scan is free, up to a cap; the scan's last check counts as the attempt.
    if !last.unwrap_or(true) && PROBES.fetch_add(1, Ordering::AcqRel) < MAX_PROBES {
        return Ok(check(FaceVerdict::NoMatch, Some(assessment)));
    }
    PROBES.store(0, Ordering::Release);
    let used = ATTEMPTS.fetch_add(1, Ordering::AcqRel) + 1;
    let verdict = if used >= MAX_ATTEMPTS { FaceVerdict::LockedOut } else { FaceVerdict::NoMatch };
    Ok(check(verdict, Some(assessment)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(descriptor: Vec<f32>) -> FaceSample {
        FaceSample { descriptor, real: 0.9, live: 0.9 }
    }

    #[test]
    fn identical_descriptors_match_fully() {
        let a = vec![0.1_f32; 128];
        assert_eq!(similarity(&a, &a), 1.0);
    }

    #[test]
    fn distant_descriptors_do_not_match() {
        let a = vec![0.0_f32; 128];
        let b = vec![1.0_f32; 128];
        assert!(similarity(&a, &b) < MATCH_THRESHOLD);
    }

    #[test]
    fn needs_live_frames_and_a_higher_bar_for_one() {
        let template = vec![0.1_f32; 128];
        let known = vec![template.as_slice()];
        assert!(!assess(&[], &known).pass);
        assert!(assess(&[sample(template.clone())], &known).pass);
        assert!(assess(&[sample(template.clone()), sample(template.clone())], &known).pass);
        // Between the two bars: two frames agreeing pass, one alone does not.
        let near: Vec<f32> = template.iter().map(|v| v + 0.815).collect();
        let score = similarity(&near, &template);
        assert!(score > MATCH_THRESHOLD && score < SINGLE_FRAME_THRESHOLD, "{score}");
        assert!(!assess(&[sample(near.clone())], &known).pass);
        assert!(assess(&[sample(near.clone()), sample(near.clone())], &known).pass);
        let spoof = |real| FaceSample { descriptor: template.clone(), real, live: 0.9 };
        assert!(!assess(&[spoof(0.1), spoof(0.2)], &known).pass);
    }

    #[test]
    fn learns_only_new_looks_and_caps_them() {
        let mut store = Store { version: STORE_VERSION, templates: vec![vec![0.1_f32; 128]], learned: Vec::new() };
        assert!(!learn(&mut store, &[sample(vec![0.1_f32; 128])]));
        for step in 0..20 {
            let look = (0..128).map(|i| 0.1 + ((i * 7 + step * 5) % 23) as f32 * 0.12).collect();
            learn(&mut store, &[sample(look)]);
        }
        assert_eq!(store.learned.len(), MAX_LEARNED);
    }
}
