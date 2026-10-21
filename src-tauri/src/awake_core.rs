//! Pure logic for "Keep me awake": the alarm schedule and the synthesised alarm sounds.
//! Nothing here touches Tauri or Windows, so it can be unit tested anywhere.
//! `src/lib/awakeSchedule.ts` mirrors the schedule rules for the browser preview.

use std::f64::consts::TAU;

/// How often an alarm may sound, and how long the user has to confirm before it gets louder.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Intensity {
    Gentle,
    Medium,
    Relentless,
}

impl Intensity {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "gentle" => Some(Self::Gentle),
            "medium" => Some(Self::Medium),
            "relentless" => Some(Self::Relentless),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Gentle => "gentle",
            Self::Medium => "medium",
            Self::Relentless => "relentless",
        }
    }

    /// Random gap between alarms, in seconds (inclusive range).
    pub fn range_secs(self) -> (u64, u64) {
        match self {
            Self::Gentle => (240, 540),
            Self::Medium => (120, 300),
            Self::Relentless => (60, 180),
        }
    }

    /// Seconds without a confirmation before the alarm repeats louder.
    pub fn confirm_secs(self) -> u64 {
        match self {
            Self::Gentle => 60,
            Self::Medium => 40,
            Self::Relentless => 25,
        }
    }
}

/// No new check-in alarm starts this close to the end time; the final alarm covers it.
pub const FINAL_GUARD_MS: i64 = 20_000;
/// Highest escalation step.
pub const MAX_LEVEL: u32 = 4;
pub const MIN_SESSION_MS: i64 = 60_000;
pub const MAX_SESSION_MS: i64 = 18 * 3_600_000;

pub const SOUNDS: [&str; 6] = ["chimes", "bell", "marimba", "beep", "rooster", "system"];

pub fn valid_sound(value: &str) -> bool {
    SOUNDS.contains(&value)
}

/// Small xorshift64* generator. Alarm timing does not need cryptographic randomness.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(if seed == 0 { 0x9E37_79B9_7F4A_7C15 } else { seed })
    }

    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    /// Uniform in [0, 1).
    pub fn next_f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
}

/// A random gap before the next check-in, whole seconds inside the intensity's range.
pub fn next_delay_ms(intensity: Intensity, rng: &mut Rng) -> i64 {
    let (low, high) = intensity.range_secs();
    let span = (high - low) as f64;
    let secs = low + (rng.next_f64() * (span + 1.0)).floor().min(span) as u64;
    secs as i64 * 1000
}

/// The time of the next alarm, or None when it would land too close to the end.
pub fn plan_next_alarm(from_ms: i64, end_ms: i64, intensity: Intensity, rng: &mut Rng) -> Option<i64> {
    let at = from_ms + next_delay_ms(intensity, rng);
    if at > end_ms - FINAL_GUARD_MS {
        None
    } else {
        Some(at)
    }
}

/// Volume for an escalation step: each unconfirmed repeat is louder, capped at full volume.
pub fn escalated_volume(base: f32, level: u32) -> f32 {
    let base = base.clamp(0.05, 1.0);
    (base * (1.0 + 0.4 * level.min(MAX_LEVEL) as f32)).min(1.0)
}

/* ------------------------------------------------------------------ sounds */

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tone {
    Chimes,
    Bell,
    Marimba,
    Beep,
    Rooster,
    /// Soft two-note ping used by reminders.
    Reminder,
    /// Calm rising phrase that closes a session.
    Final,
}

impl Tone {
    pub fn from_sound(id: &str) -> Self {
        match id {
            "bell" => Self::Bell,
            "marimba" => Self::Marimba,
            "beep" => Self::Beep,
            "rooster" => Self::Rooster,
            _ => Self::Chimes,
        }
    }
}

const RATE: u32 = 22_050;

struct Voice {
    start: f64,
    freq: f64,
    dur: f64,
    decay: f64,
    amp: f64,
    partials: &'static [(f64, f64)],
}

fn add_voice(buf: &mut [f64], voice: &Voice) {
    let first = (voice.start * RATE as f64) as usize;
    let count = (voice.dur * RATE as f64) as usize;
    for i in 0..count {
        let index = first + i;
        if index >= buf.len() {
            break;
        }
        let t = i as f64 / RATE as f64;
        let attack = (t / 0.006).min(1.0);
        let release = ((voice.dur - t) / 0.03).clamp(0.0, 1.0);
        let envelope = (-t * voice.decay).exp() * attack * release;
        let mut sample = 0.0;
        for (multiple, gain) in voice.partials {
            sample += (t * voice.freq * multiple * TAU).sin() * gain;
        }
        buf[index] += sample * envelope * voice.amp;
    }
}

const PURE: &[(f64, f64)] = &[(1.0, 1.0), (2.0, 0.18)];
const BELL: &[(f64, f64)] = &[(1.0, 1.0), (2.76, 0.5), (5.4, 0.25), (8.93, 0.12)];
const MARIMBA: &[(f64, f64)] = &[(1.0, 1.0), (4.0, 0.3), (9.9, 0.05)];
const SQUARE: &[(f64, f64)] = &[(1.0, 1.0), (3.0, 0.33), (5.0, 0.2)];

/// Hz for notes of a major pentatonic scale rooted at C5 (index wraps up octaves).
fn pentatonic(index: usize) -> f64 {
    const STEPS: [f64; 5] = [0.0, 2.0, 4.0, 7.0, 9.0];
    let octave = (index / 5) as f64;
    let semis = STEPS[index % 5] + 12.0 * octave;
    523.25 * 2f64.powf(semis / 12.0)
}

fn rooster(buf: &mut [f64], start: f64) {
    // Four glides: cock-a-doodle-doo. Phase is accumulated so the pitch can slide cleanly.
    const SYLLABLES: [(f64, f64, f64, f64); 4] = [
        (0.00, 0.17, 520.0, 700.0),
        (0.20, 0.14, 700.0, 560.0),
        (0.38, 0.20, 560.0, 930.0),
        (0.62, 0.62, 930.0, 600.0),
    ];
    for (offset, dur, from, to) in SYLLABLES {
        let first = ((start + offset) * RATE as f64) as usize;
        let count = (dur * RATE as f64) as usize;
        let mut phase = 0.0;
        for i in 0..count {
            let index = first + i;
            if index >= buf.len() {
                break;
            }
            let p = i as f64 / count as f64;
            let vibrato = 1.0 + 0.02 * (p * dur * 38.0 * TAU).sin();
            let freq = (from + (to - from) * p) * vibrato;
            phase += freq / RATE as f64;
            let mut sample = 0.0;
            for h in 1..=6 {
                sample += (phase * h as f64 * TAU).sin() / h as f64;
            }
            let envelope = (p / 0.06).min(1.0) * ((1.0 - p) / 0.15).clamp(0.0, 1.0);
            buf[index] += sample * envelope * 0.38;
        }
    }
}

/// Synthesises one alarm as a 16-bit mono WAV. `gain` is 0..1 of full scale (the peak stays
/// below it), `repeats` plays the phrase more than once, `seed` varies chime and marimba notes.
pub fn tone_wav(tone: Tone, gain: f32, repeats: u32, seed: u64) -> Vec<u8> {
    let repeats = repeats.clamp(1, 3);
    let mut rng = Rng::new(seed);
    let phrase = match tone {
        Tone::Chimes => 1.5,
        Tone::Bell => 2.2,
        Tone::Marimba => 1.2,
        Tone::Beep => 0.62,
        Tone::Rooster => 1.35,
        Tone::Reminder => 0.9,
        Tone::Final => 2.4,
    };
    let total = phrase * repeats as f64 + 0.25;
    let mut buf = vec![0.0f64; (total * RATE as f64) as usize];
    for round in 0..repeats {
        let at = phrase * round as f64;
        match tone {
            Tone::Chimes => {
                let mut index = 3 + (rng.next_u64() % 3) as usize;
                for n in 0..4 {
                    add_voice(&mut buf, &Voice { start: at + n as f64 * 0.17, freq: pentatonic(index), dur: 0.9, decay: 4.5, amp: 0.5, partials: PURE });
                    index = (index + 1 + (rng.next_u64() % 2) as usize).min(9);
                }
            }
            Tone::Bell => add_voice(&mut buf, &Voice { start: at, freq: 660.0, dur: 2.1, decay: 1.9, amp: 0.45, partials: BELL }),
            Tone::Marimba => {
                for n in 0..5 {
                    let index = (rng.next_u64() % 6) as usize;
                    add_voice(&mut buf, &Voice { start: at + n as f64 * 0.12, freq: pentatonic(index) / 2.0, dur: 0.5, decay: 9.0, amp: 0.6, partials: MARIMBA });
                }
            }
            Tone::Beep => {
                for n in 0..2 {
                    add_voice(&mut buf, &Voice { start: at + n as f64 * 0.24, freq: 880.0, dur: 0.14, decay: 1.0, amp: 0.45, partials: SQUARE });
                }
            }
            Tone::Rooster => rooster(&mut buf, at),
            Tone::Reminder => {
                add_voice(&mut buf, &Voice { start: at, freq: 784.0, dur: 0.6, decay: 7.0, amp: 0.5, partials: PURE });
                add_voice(&mut buf, &Voice { start: at + 0.11, freq: 1174.7, dur: 0.6, decay: 7.0, amp: 0.4, partials: PURE });
            }
            Tone::Final => {
                for (n, freq) in [523.25, 659.25, 783.99, 1046.5].into_iter().enumerate() {
                    add_voice(&mut buf, &Voice { start: at + n as f64 * 0.28, freq, dur: 1.2, decay: 2.8, amp: 0.45, partials: PURE });
                }
            }
        }
    }
    let peak = buf.iter().fold(0.0f64, |m, v| m.max(v.abs())).max(1e-9);
    let scale = gain.clamp(0.02, 1.0) as f64 * 0.85 / peak;
    let count = buf.len();
    let mut bytes = Vec::with_capacity(44 + count * 2);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36u32 + count as u32 * 2).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&RATE.to_le_bytes());
    bytes.extend_from_slice(&(RATE * 2).to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&16u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&(count as u32 * 2).to_le_bytes());
    for (i, value) in buf.iter().enumerate() {
        let fade = ((count - i) as f64 / (0.02 * RATE as f64)).min(1.0);
        let sample = (value * scale * fade * i16::MAX as f64) as i16;
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delays_stay_inside_each_intensity_range() {
        let mut rng = Rng::new(42);
        for intensity in [Intensity::Gentle, Intensity::Medium, Intensity::Relentless] {
            let (low, high) = intensity.range_secs();
            for _ in 0..500 {
                let ms = next_delay_ms(intensity, &mut rng);
                assert!(ms >= low as i64 * 1000 && ms <= high as i64 * 1000, "{ms}");
                assert_eq!(ms % 1000, 0);
            }
        }
    }

    #[test]
    fn no_check_in_is_planned_next_to_the_end() {
        let mut rng = Rng::new(7);
        assert!(plan_next_alarm(0, 30_000, Intensity::Relentless, &mut rng).is_none());
        assert!(plan_next_alarm(0, 3_600_000, Intensity::Gentle, &mut rng).is_some());
    }

    #[test]
    fn escalation_gets_louder_and_caps() {
        assert!(escalated_volume(0.4, 1) > escalated_volume(0.4, 0));
        assert_eq!(escalated_volume(0.9, 4), 1.0);
        assert!(escalated_volume(0.0, 0) >= 0.05);
    }

    #[test]
    fn every_tone_is_a_bounded_wav() {
        for tone in [Tone::Chimes, Tone::Bell, Tone::Marimba, Tone::Beep, Tone::Rooster, Tone::Reminder, Tone::Final] {
            let bytes = tone_wav(tone, 0.8, 2, 99);
            assert_eq!(&bytes[..4], b"RIFF");
            assert_eq!(&bytes[8..12], b"WAVE");
            assert_eq!(u32::from_le_bytes(bytes[40..44].try_into().unwrap()) as usize, bytes.len() - 44);
            let samples: Vec<i16> = bytes[44..].chunks_exact(2).map(|s| i16::from_le_bytes([s[0], s[1]])).collect();
            let peak = samples.iter().map(|s| s.unsigned_abs()).max().unwrap();
            assert!(peak > 3000, "{tone:?} too quiet: {peak}");
            assert!(peak < 30_000, "{tone:?} too loud: {peak}");
            assert!(samples.last().unwrap().abs() < 20);
            assert!(samples.len() < RATE as usize * 8);
        }
    }

    #[test]
    fn volume_scales_the_waveform() {
        let peak = |gain| {
            tone_wav(Tone::Bell, gain, 1, 1)[44..]
                .chunks_exact(2)
                .map(|s| i16::from_le_bytes([s[0], s[1]]).unsigned_abs())
                .max()
                .unwrap()
        };
        assert!(peak(0.9) > peak(0.3) * 2);
    }
}
