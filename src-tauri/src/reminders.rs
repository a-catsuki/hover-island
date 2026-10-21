//! Timed reminders, persisted to `<app_config_dir>/reminders.json`.
//!
//! A single scheduler thread sleeps until the next reminder is due (never longer than 30 seconds,
//! so a PC resuming from sleep is noticed quickly) and wakes whenever the list changes. When a
//! reminder comes due it emits `reminders://due`, plays a soft tone (unless Do Not Disturb is on
//! and the reminder is not marked important) and the webview shows the notch peek. Reminders
//! that came due while the app was closed or the PC asleep are flagged `missedAt` on launch.

use std::path::PathBuf;
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::{Condvar, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::awake_core::Tone;
use crate::reminder_core::{next_occurrence, RecurKind};

/// A reminder that is more than this late when noticed counts as missed (no sound).
const MISS_GRACE_MS: i64 = 120_000;
const MAX_REMINDERS: usize = 500;
const MAX_WAIT_MS: i64 = 30_000;

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Recur {
    /// "daily" | "weekdays" | "weekly"
    pub kind: String,
    pub hour: u32,
    pub minute: u32,
    /// 0 (Sunday) to 6, weekly only.
    pub weekday: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Reminder {
    pub id: String,
    pub title: String,
    /// Next time it is due, epoch milliseconds.
    pub due: i64,
    pub recur: Option<Recur>,
    /// Important reminders still make a sound under Do Not Disturb.
    pub important: bool,
    pub done: bool,
    /// Last time it was marked done (recurring reminders stay open).
    pub done_at: Option<i64>,
    /// Set when the due alert went out and nobody has answered yet.
    pub fired_at: Option<i64>,
    /// The due time that was missed while the app was closed.
    pub missed_at: Option<i64>,
    /// Id of the Notes item this reminder is linked to.
    pub link: Option<String>,
    pub created_at: i64,
    pub snoozes: u32,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
struct File {
    items: Vec<Reminder>,
}

static STORE: Mutex<Vec<Reminder>> = Mutex::new(Vec::new());
static WAKE: Condvar = Condvar::new();
static PATH: OnceLock<PathBuf> = OnceLock::new();
/// JavaScript-style offset (minutes to add to local time to get UTC), reported by the webview.
static TZ_OFFSET_MIN: AtomicI32 = AtomicI32::new(0);

fn lock() -> MutexGuard<'static, Vec<Reminder>> {
    STORE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn now_ms() -> i64 {
    crate::awake::now_ms()
}

fn set_tz(offset: Option<i32>) {
    if let Some(value) = offset {
        if (-840..=840).contains(&value) {
            TZ_OFFSET_MIN.store(value, Ordering::Relaxed);
        }
    }
}

fn save(items: &[Reminder]) {
    let Some(path) = PATH.get() else { return };
    let file = File { items: items.to_vec() };
    let Ok(text) = serde_json::to_string_pretty(&file) else { return };
    let temp = path.with_extension("json.tmp");
    if std::fs::write(&temp, text).is_ok() && std::fs::rename(&temp, path).is_err() {
        let _ = std::fs::remove_file(path);
        let _ = std::fs::rename(&temp, path);
    }
}

/// Moves a recurring reminder to its next occurrence after `after_ms`.
fn advance(reminder: &mut Reminder, after_ms: i64) {
    if let Some(recur) = &reminder.recur {
        if let Some(kind) = RecurKind::parse(&recur.kind) {
            reminder.due = next_occurrence(
                kind,
                recur.hour,
                recur.minute,
                recur.weekday,
                after_ms,
                TZ_OFFSET_MIN.load(Ordering::Relaxed),
            );
        }
    }
}

/// Fires or flags everything that is due. Returns the reminders that should alert now and
/// whether anything changed.
fn catch_up(items: &mut [Reminder], now: i64) -> (Vec<Reminder>, bool) {
    let mut fired = Vec::new();
    let mut changed = false;
    for reminder in items.iter_mut() {
        if reminder.done || reminder.fired_at.is_some() || reminder.due > now {
            continue;
        }
        changed = true;
        if now - reminder.due > MISS_GRACE_MS {
            reminder.missed_at = Some(reminder.due);
            if reminder.recur.is_some() {
                advance(reminder, now);
            } else {
                // Needs an answer, but no sound for something that is already late.
                reminder.fired_at = Some(now);
            }
        } else {
            reminder.fired_at = Some(now);
            fired.push(reminder.clone());
        }
    }
    (fired, changed)
}

fn announce(app: &AppHandle, reminder: &Reminder) {
    let _ = app.emit("reminders://due", reminder.clone());
    let quiet = {
        let state = app.state::<crate::state::AppState>();
        let quiet = match state.settings.lock() {
            Ok(prefs) => prefs.dnd || !prefs.notifications.enabled,
            Err(_) => false,
        };
        quiet
    };
    if reminder.important || !quiet {
        let (gain, repeats) = if reminder.important { (1.0, 2) } else { (0.7, 1) };
        crate::awake::play_tone(Tone::Reminder, gain, repeats, reminder.created_at as u64);
    }
}

fn emit_changed(app: &AppHandle, items: Vec<Reminder>) {
    let _ = app.emit("reminders://changed", items);
}

fn run(app: AppHandle) {
    loop {
        let mut items = lock();
        let now = now_ms();
        let (fired, changed) = catch_up(&mut items, now);
        if changed {
            save(&items);
        }
        if changed || !fired.is_empty() {
            let snapshot = items.clone();
            drop(items);
            for reminder in &fired {
                announce(&app, reminder);
            }
            emit_changed(&app, snapshot);
            continue;
        }
        let next = items
            .iter()
            .filter(|reminder| !reminder.done && reminder.fired_at.is_none())
            .map(|reminder| reminder.due)
            .min();
        let wait = next.map(|due| (due - now).clamp(20, MAX_WAIT_MS)).unwrap_or(MAX_WAIT_MS);
        let _ = WAKE
            .wait_timeout(items, Duration::from_millis(wait as u64))
            .unwrap_or_else(|poisoned| poisoned.into_inner());
    }
}

/// Loads the saved list and starts the scheduler thread. Call once from `setup`, after
/// `app.manage(...)`.
pub fn spawn(app: AppHandle) {
    if let Ok(dir) = app.path().app_config_dir() {
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("reminders.json");
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(file) = serde_json::from_str::<File>(&text) {
                *lock() = file.items;
            }
        }
        let _ = PATH.set(path);
    }
    let _ = std::thread::Builder::new()
        .name("reminder-scheduler".into())
        .spawn(move || run(app));
}

/* --------------------------------------------------------------- commands */

fn clean(mut reminder: Reminder, now: i64) -> Result<Reminder, String> {
    reminder.title = reminder.title.trim().chars().filter(|c| !c.is_control()).take(200).collect();
    if reminder.title.is_empty() {
        return Err("Give the reminder a name.".into());
    }
    if reminder.due <= 0 {
        return Err("Pick a time for the reminder.".into());
    }
    if let Some(recur) = &reminder.recur {
        if RecurKind::parse(&recur.kind).is_none() || recur.hour > 23 || recur.minute > 59 {
            return Err("That repeat pattern is not supported.".into());
        }
        if recur.kind == "weekly" && recur.weekday.map_or(true, |day| day > 6) {
            return Err("Pick a day of the week.".into());
        }
    }
    if reminder.id.trim().is_empty() {
        reminder.id = uuid::Uuid::new_v4().to_string();
    }
    reminder.id.truncate(80);
    if reminder.created_at <= 0 {
        reminder.created_at = now;
    }
    if let Some(link) = &mut reminder.link {
        link.truncate(120);
    }
    Ok(reminder)
}

fn mutate<F>(app: &AppHandle, change: F) -> Result<Vec<Reminder>, String>
where
    F: FnOnce(&mut Vec<Reminder>, i64) -> Result<(), String>,
{
    let snapshot = {
        let mut items = lock();
        change(&mut *items, now_ms())?;
        save(&items);
        items.clone()
    };
    WAKE.notify_all();
    emit_changed(app, snapshot.clone());
    Ok(snapshot)
}

#[tauri::command]
pub fn reminders_list(tz_offset_min: Option<i32>) -> Vec<Reminder> {
    set_tz(tz_offset_min);
    lock().clone()
}

/// Adds a reminder, or replaces the one with the same id.
#[tauri::command]
pub fn reminders_save(app: AppHandle, reminder: Reminder, tz_offset_min: Option<i32>) -> Result<Vec<Reminder>, String> {
    set_tz(tz_offset_min);
    mutate(&app, |items, now| {
        let reminder = clean(reminder, now)?;
        match items.iter_mut().find(|item| item.id == reminder.id) {
            Some(existing) => *existing = reminder,
            None => {
                if items.len() >= MAX_REMINDERS {
                    return Err("You have too many reminders. Delete a few first.".into());
                }
                items.push(reminder);
            }
        }
        Ok(())
    })
}

/// Marks a reminder done. A repeating one moves on to its next occurrence instead.
#[tauri::command]
pub fn reminders_done(app: AppHandle, id: String, tz_offset_min: Option<i32>) -> Result<Vec<Reminder>, String> {
    set_tz(tz_offset_min);
    mutate(&app, |items, now| {
        let item = items.iter_mut().find(|item| item.id == id).ok_or("That reminder no longer exists.")?;
        item.done_at = Some(now);
        item.fired_at = None;
        item.missed_at = None;
        if item.recur.is_some() {
            // Finishing early skips the occurrence that has not happened yet.
            let after = now.max(item.due);
            advance(item, after);
        } else {
            item.done = true;
        }
        Ok(())
    })
}

#[tauri::command]
pub fn reminders_snooze(app: AppHandle, id: String, minutes: u32) -> Result<Vec<Reminder>, String> {
    mutate(&app, |items, now| {
        let item = items.iter_mut().find(|item| item.id == id).ok_or("That reminder no longer exists.")?;
        item.due = now + minutes.clamp(1, 1440) as i64 * 60_000;
        item.done = false;
        item.fired_at = None;
        item.missed_at = None;
        item.snoozes += 1;
        Ok(())
    })
}

#[tauri::command]
pub fn reminders_delete(app: AppHandle, id: String) -> Result<Vec<Reminder>, String> {
    mutate(&app, |items, _| {
        items.retain(|item| item.id != id);
        Ok(())
    })
}

#[tauri::command]
pub fn reminders_clear_done(app: AppHandle) -> Result<Vec<Reminder>, String> {
    mutate(&app, |items, _| {
        items.retain(|item| !item.done);
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reminder(due: i64) -> Reminder {
        Reminder { id: "a".into(), title: "Stretch".into(), due, created_at: 1, ..Reminder::default() }
    }

    #[test]
    fn on_time_reminders_fire_and_late_ones_are_flagged_missed() {
        let mut items = vec![reminder(1_000_000), reminder(1_000_000 - 500_000), reminder(9_000_000)];
        let (fired, changed) = catch_up(&mut items, 1_010_000);
        assert!(changed);
        assert_eq!(fired.len(), 1);
        assert_eq!(items[0].fired_at, Some(1_010_000));
        assert_eq!(items[1].missed_at, Some(500_000));
        assert!(items[1].fired_at.is_some());
        assert!(items[2].fired_at.is_none());
    }

    #[test]
    fn a_missed_repeating_reminder_moves_to_its_next_time() {
        let mut item = reminder(1_000_000);
        item.recur = Some(Recur { kind: "daily".into(), hour: 10, minute: 0, weekday: None });
        let now = 1_000_000 + 600_000;
        let mut items = vec![item];
        let (fired, _) = catch_up(&mut items, now);
        assert!(fired.is_empty());
        assert_eq!(items[0].missed_at, Some(1_000_000));
        assert!(items[0].due > now);
        assert!(items[0].fired_at.is_none());
    }

    #[test]
    fn bad_input_is_rejected() {
        assert!(clean(Reminder { title: "  ".into(), due: 5, ..Reminder::default() }, 1).is_err());
        assert!(clean(Reminder { title: "x".into(), due: 0, ..Reminder::default() }, 1).is_err());
        let weekly_without_day = Recur { kind: "weekly".into(), hour: 9, minute: 0, weekday: None };
        assert!(clean(Reminder { title: "x".into(), due: 5, recur: Some(weekly_without_day), ..Reminder::default() }, 1).is_err());
        let ok = clean(Reminder { title: "x".into(), due: 5, ..Reminder::default() }, 7).unwrap();
        assert!(!ok.id.is_empty());
        assert_eq!(ok.created_at, 7);
    }
}
