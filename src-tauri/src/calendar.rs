//! Local calendar events persisted as JSON plus optional read-only `calendar.ics` import.
//! No timezone database is available, so local (non-`Z`) ICS times are treated as UTC.
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

use crate::types::CalendarEvent;

static CALENDAR_LOCK: Mutex<()> = Mutex::new(());

fn calendar_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn read_events(app: &AppHandle) -> Result<Vec<CalendarEvent>, String> {
    let dir = calendar_dir(app)?;
    let mut events = read_events_file(&dir.join("calendar.json"))?;
    match std::fs::read_to_string(dir.join("calendar.ics")) {
        Ok(text) => events.extend(parse_ics(&text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("Could not read calendar.ics: {error}")),
    }
    events.sort_by_key(|event| event.start);
    events.truncate(500);
    Ok(events)
}

fn read_local_events(app: &AppHandle) -> Result<Vec<CalendarEvent>, String> {
    let path = calendar_dir(app)?.join("calendar.json");
    read_events_file(&path)
}

fn read_events_file(path: &std::path::Path) -> Result<Vec<CalendarEvent>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text)
            .map_err(|error| format!("Could not parse {}: {error}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(format!("Could not read {}: {error}", path.display())),
    }
}

fn write_local_events(app: &AppHandle, events: &[CalendarEvent]) -> Result<(), String> {
    let path = calendar_dir(app)?.join("calendar.json");
    let payload = serde_json::to_vec_pretty(events).map_err(|e| e.to_string())?;
    let temp = path.with_extension(format!("json.{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temp, payload).map_err(|e| e.to_string())?;
    if let Err(error) = replace_file(&temp, &path) {
        let _ = std::fs::remove_file(&temp);
        return Err(error);
    }
    Ok(())
}

fn write_ics_import(app: &AppHandle, text: &str) -> Result<(), String> {
    if text.len() > 2 * 1024 * 1024 {
        return Err("Calendar files are limited to 2 MB".into());
    }
    if parse_ics(text).is_empty() {
        return Err("No readable calendar events were found in that file".into());
    }
    let path = calendar_dir(app)?.join("calendar.ics");
    let temp = path.with_extension(format!("ics.{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temp, text).map_err(|e| e.to_string())?;
    if let Err(error) = replace_file(&temp, &path) {
        let _ = std::fs::remove_file(temp);
        return Err(error);
    }
    Ok(())
}

pub(crate) fn replace_file(temp: &std::path::Path, path: &std::path::Path) -> Result<(), String> {
    match std::fs::rename(temp, path) {
        Ok(()) => Ok(()),
        Err(first) if path.exists() => {
            let backup = path.with_extension(format!("json.{}.bak", uuid::Uuid::new_v4()));
            std::fs::rename(path, &backup).map_err(|_| first.to_string())?;
            match std::fs::rename(temp, path) {
                Ok(()) => {
                    let _ = std::fs::remove_file(backup);
                    Ok(())
                }
                Err(error) => {
                    let _ = std::fs::rename(backup, path);
                    Err(error.to_string())
                }
            }
        }
        Err(error) => Err(error.to_string()),
    }
}

fn validate_local_event(mut event: CalendarEvent) -> Result<CalendarEvent, String> {
    event.id = event.id.trim().to_string();
    event.title = event.title.trim().to_string();
    if event.id.is_empty()
        || event.id.len() > 128
        || event.id.starts_with("ics:")
        || event.title.is_empty()
        || event.title.chars().count() > 200
        || event.end < event.start
        || event
            .location
            .as_ref()
            .is_some_and(|value| value.chars().count() > 256)
    {
        return Err("Enter a title and a valid event time".into());
    }
    if let Some(location) = event.location.take() {
        let location = location.trim();
        event.location = (!location.is_empty()).then(|| location.to_string());
    }
    Ok(event)
}

fn upsert_local_event(local: &mut Vec<CalendarEvent>, event: CalendarEvent) -> Result<(), String> {
    let event = validate_local_event(event)?;
    if let Some(existing) = local.iter_mut().find(|item| item.id == event.id) {
        *existing = event;
    } else {
        if local.len() >= 500 {
            return Err("The local calendar is full".into());
        }
        local.push(event);
    }
    local.sort_by_key(|item| item.start);
    Ok(())
}

#[tauri::command]
pub fn calendar_get(app: AppHandle) -> Result<Vec<CalendarEvent>, String> {
    let _guard = CALENDAR_LOCK.lock().unwrap();
    read_events(&app)
}

#[tauri::command]
pub fn calendar_save(app: AppHandle, event: CalendarEvent) -> Result<Vec<CalendarEvent>, String> {
    let _guard = CALENDAR_LOCK.lock().unwrap();
    let mut local = read_local_events(&app)?;
    upsert_local_event(&mut local, event)?;
    write_local_events(&app, &local)?;
    read_events(&app)
}

#[tauri::command]
pub fn calendar_delete(app: AppHandle, id: String) -> Result<Vec<CalendarEvent>, String> {
    let _guard = CALENDAR_LOCK.lock().unwrap();
    if id.starts_with("ics:") {
        return Err("Imported calendar events are read-only".into());
    }
    let mut local = read_local_events(&app)?;
    local.retain(|event| event.id != id);
    write_local_events(&app, &local)?;
    read_events(&app)
}

#[tauri::command]
pub fn calendar_import_ics(app: AppHandle, contents: String) -> Result<Vec<CalendarEvent>, String> {
    let _guard = CALENDAR_LOCK.lock().unwrap();
    write_ics_import(&app, &contents)?;
    read_events(&app)
}

#[derive(Default)]
struct Pending {
    uid: Option<String>,
    title: Option<String>,
    location: Option<String>,
    start: Option<u64>,
    end: Option<u64>,
    all_day: bool,
}

impl Pending {
    fn finish(self, index: usize) -> Option<CalendarEvent> {
        let start = self.start?;
        let end = self.end.unwrap_or(start);
        let title = self
            .title
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| "(untitled)".to_string());
        let id = self
            .uid
            .filter(|u| !u.trim().is_empty())
            .unwrap_or_else(|| format!("event-{index}-{start}"));
        Some(CalendarEvent {
            id: format!("ics:{id}"),
            title,
            start,
            end,
            all_day: self.all_day,
            location: self.location.filter(|l| !l.trim().is_empty()),
        })
    }
}

fn parse_ics(text: &str) -> Vec<CalendarEvent> {
    let mut events = Vec::new();
    let mut current: Option<Pending> = None;
    for line in unfold(text).lines() {
        if line.eq_ignore_ascii_case("BEGIN:VEVENT") {
            current = Some(Pending::default());
            continue;
        }
        if line.eq_ignore_ascii_case("END:VEVENT") {
            if let Some(pending) = current.take() {
                if let Some(event) = pending.finish(events.len()) {
                    events.push(event);
                }
            }
            continue;
        }
        let Some(pending) = current.as_mut() else {
            continue;
        };
        let Some((name, value)) = split_property(line) else {
            continue;
        };
        match name.as_str() {
            "DTSTART" => {
                if let Some((millis, all_day)) = parse_ics_time(&value) {
                    pending.start = Some(millis);
                    pending.all_day = all_day;
                }
            }
            "DTEND" => {
                if let Some((millis, _)) = parse_ics_time(&value) {
                    pending.end = Some(millis);
                }
            }
            "SUMMARY" => pending.title = Some(unescape(&value)),
            "LOCATION" => pending.location = Some(unescape(&value)),
            "UID" => pending.uid = Some(value),
            _ => {}
        }
    }
    events.sort_by_key(|e| e.start);
    events
}

/// Undo ICS line folding (continuation lines begin with a space or tab).
fn unfold(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut first = true;
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        if let Some(stripped) = line.strip_prefix(' ').or_else(|| line.strip_prefix('\t')) {
            out.push_str(stripped);
        } else {
            if !first {
                out.push('\n');
            }
            first = false;
            out.push_str(line);
        }
    }
    out
}

fn split_property(line: &str) -> Option<(String, String)> {
    let colon = line.find(':')?;
    let (left, right) = line.split_at(colon);
    let name = left
        .split(';')
        .next()
        .unwrap_or(left)
        .trim()
        .to_ascii_uppercase();
    if name.is_empty() {
        return None;
    }
    Some((name, right[1..].to_string()))
}

fn parse_ics_time(raw: &str) -> Option<(u64, bool)> {
    let value = raw.trim();
    // The fixed-width iCalendar fields below are ASCII byte offsets.
    if !value.is_ascii() { return None; }
    if value.len() == 8 && value.chars().all(|c| c.is_ascii_digit()) {
        let year: i64 = value[0..4].parse().ok()?;
        let month: i64 = value[4..6].parse().ok()?;
        let day: i64 = value[6..8].parse().ok()?;
        if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
            return None;
        }
        let days = days_from_civil(year, month, day);
        return Some((u64::try_from(days * 86_400_000).ok()?, true));
    }
    let (date, rest) = value.split_once('T')?;
    let time = rest.trim_end_matches(['Z', 'z']);
    if date.len() != 8 || time.len() < 6 {
        return None;
    }
    let year: i64 = date[0..4].parse().ok()?;
    let month: i64 = date[4..6].parse().ok()?;
    let day: i64 = date[6..8].parse().ok()?;
    let hour: i64 = time[0..2].parse().ok()?;
    let minute: i64 = time[2..4].parse().ok()?;
    let second: i64 = time[4..6].parse().ok()?;
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    let days = days_from_civil(year, month, day);
    let seconds = days * 86_400 + hour * 3600 + minute * 60 + second;
    Some((u64::try_from(seconds * 1000).ok()?, false))
}

/// Days from 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's algorithm).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = (if year >= 0 { year } else { year - 399 }) / 400;
    let year_of_era = year - era * 400;
    let month_shift = if month > 2 { month - 3 } else { month + 9 };
    let day_of_year = (153 * month_shift + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn unescape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n') | Some('N') => out.push('\n'),
                Some(',') => out.push(','),
                Some(';') => out.push(';'),
                Some('\\') => out.push('\\'),
                Some(other) => {
                    out.push('\\');
                    out.push(other);
                }
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_timed_and_all_day_events() {
        let ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:abc@example.com\r\nSUMMARY:Team Sync\r\nDTSTART:20261013T120000Z\r\nDTEND:20261013T123000Z\r\nLOCATION:Room 1\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:def@example.com\r\nSUMMARY:Holiday\r\nDTSTART;VALUE=DATE:20261014\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let events = parse_ics(ics);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].id, "ics:abc@example.com");
        assert_eq!(events[0].title, "Team Sync");
        assert_eq!(events[0].start, 1_791_892_800_000);
        assert_eq!(events[0].end, 1_791_894_600_000);
        assert!(!events[0].all_day);
        assert_eq!(events[0].location.as_deref(), Some("Room 1"));
        assert!(events[1].all_day);
        assert_eq!(events[1].start, 1_791_936_000_000);
    }

    #[test]
    fn unfolds_continuation_lines_and_unescapes() {
        let ics = "BEGIN:VEVENT\r\nSUMMARY:Long\r\n  title\\, part two\r\nDTSTART:20261013T000000Z\r\nEND:VEVENT\r\n";
        let events = parse_ics(ics);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].title, "Long title, part two");
    }

    #[test]
    fn local_events_validate_upsert_and_keep_ics_imports_read_only() {
        let mut local = Vec::new();
        let event = CalendarEvent {
            id: "local:one".into(),
            title: "  Planning  ".into(),
            start: 100,
            end: 200,
            location: Some("  Room 2  ".into()),
            ..CalendarEvent::default()
        };
        upsert_local_event(&mut local, event.clone()).unwrap();
        let mut edited = event;
        edited.title = "Review".into();
        upsert_local_event(&mut local, edited).unwrap();
        assert_eq!(local.len(), 1);
        assert_eq!(local[0].title, "Review");
        assert_eq!(local[0].location.as_deref(), Some("Room 2"));
        assert!(validate_local_event(CalendarEvent {
            id: "ics:locked".into(),
            ..CalendarEvent::default()
        })
        .is_err());
        assert!(validate_local_event(CalendarEvent {
            end: 1,
            ..CalendarEvent::default()
        })
        .is_err());
    }
}
