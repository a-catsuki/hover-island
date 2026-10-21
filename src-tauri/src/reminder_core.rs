//! Pure recurrence maths for reminders. No Tauri or Windows types.
//! `src/lib/reminderParse.ts` (`nextOccurrence`) mirrors this for the browser preview.

pub const DAY_MS: i64 = 86_400_000;
pub const MIN_MS: i64 = 60_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecurKind {
    Daily,
    Weekdays,
    Weekly,
}

impl RecurKind {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "daily" => Some(Self::Daily),
            "weekdays" => Some(Self::Weekdays),
            "weekly" => Some(Self::Weekly),
            _ => None,
        }
    }
}

/// Day of week for a day number counted from 1970-01-01 (a Thursday). 0 = Sunday.
fn weekday_of(day: i64) -> i64 {
    (day + 4).rem_euclid(7)
}

/// The first local time of day `hour:minute` after `after_ms` that matches the pattern.
/// `tz_offset_min` follows the JavaScript convention: minutes to add to local time to get UTC
/// (so UTC+10 is -600). `weekday` is 0 (Sunday) to 6 and only matters for weekly reminders.
pub fn next_occurrence(
    kind: RecurKind,
    hour: u32,
    minute: u32,
    weekday: Option<u32>,
    after_ms: i64,
    tz_offset_min: i32,
) -> i64 {
    let offset_ms = tz_offset_min as i64 * MIN_MS;
    let local_after = after_ms - offset_ms;
    let first_day = local_after.div_euclid(DAY_MS);
    let time_of_day = (hour.min(23) as i64 * 60 + minute.min(59) as i64) * MIN_MS;
    for step in 0..=14 {
        let day = first_day + step;
        let dow = weekday_of(day);
        let fits = match kind {
            RecurKind::Daily => true,
            RecurKind::Weekdays => (1..=5).contains(&dow),
            RecurKind::Weekly => dow == weekday.unwrap_or(1).min(6) as i64,
        };
        if !fits {
            continue;
        }
        let candidate = day * DAY_MS + time_of_day + offset_ms;
        if candidate > after_ms {
            return candidate;
        }
    }
    // Unreachable for valid input; fall back to one day later.
    after_ms + DAY_MS
}

#[cfg(test)]
mod tests {
    use super::*;

    // 2026-10-20 is a Tuesday. 12:00 UTC.
    const TUE_NOON_UTC: i64 = 1_792_497_600_000;

    #[test]
    fn calendar_assumption_holds() {
        assert_eq!(weekday_of(TUE_NOON_UTC.div_euclid(DAY_MS)), 2);
    }

    #[test]
    fn daily_picks_today_when_the_time_is_ahead_and_tomorrow_when_not() {
        let later = next_occurrence(RecurKind::Daily, 18, 0, None, TUE_NOON_UTC, 0);
        assert_eq!(later, TUE_NOON_UTC + 6 * 3_600_000);
        let earlier = next_occurrence(RecurKind::Daily, 9, 0, None, TUE_NOON_UTC, 0);
        assert_eq!(earlier, TUE_NOON_UTC + 21 * 3_600_000);
    }

    #[test]
    fn weekdays_skip_the_weekend() {
        // Friday 2026-10-23 15:00 UTC, next 10:00 is Monday.
        let friday = TUE_NOON_UTC + 3 * DAY_MS + 3 * 3_600_000;
        let next = next_occurrence(RecurKind::Weekdays, 10, 0, None, friday, 0);
        assert_eq!(weekday_of(next.div_euclid(DAY_MS)), 1);
        assert_eq!(next, TUE_NOON_UTC + 6 * DAY_MS - 2 * 3_600_000);
    }

    #[test]
    fn weekly_waits_for_the_named_day() {
        let next = next_occurrence(RecurKind::Weekly, 9, 30, Some(5), TUE_NOON_UTC, 0);
        assert_eq!(weekday_of(next.div_euclid(DAY_MS)), 5);
        assert_eq!(next, TUE_NOON_UTC + 3 * DAY_MS - 12 * 3_600_000 + 9 * 3_600_000 + 30 * MIN_MS);
    }

    #[test]
    fn local_offsets_move_the_day_boundary() {
        // UTC+10 (offset -600): 12:00 UTC is 22:00 local, so 09:00 local is 23:00 UTC the same day.
        let next = next_occurrence(RecurKind::Daily, 9, 0, None, TUE_NOON_UTC, -600);
        assert_eq!(next, TUE_NOON_UTC + 11 * 3_600_000);
    }
}
