//! Lightweight native CPU, memory, and battery statistics.
//!
//! Windows provides all values through kernel32, so this module adds no dependency and
//! performs no subprocess or file-system scans. CPU is sampled at most once per second;
//! memory and power state are read on demand.

use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemStats {
    pub cpu_percent: Option<f64>,
    pub memory_used_bytes: u64,
    pub memory_total_bytes: u64,
    pub battery_percent: Option<f64>,
    pub charging: bool,
}

#[derive(Default)]
struct CpuSample {
    previous: Option<(u64, u64)>, // (idle time, total time), in 100 ns units
    sampled_at: Option<Instant>,
    percent: Option<f64>,
}

static CPU_SAMPLE: Mutex<CpuSample> = Mutex::new(CpuSample {
    previous: None,
    sampled_at: None,
    percent: None,
});

fn cpu_percent_from_delta(
    previous_idle: u64,
    previous_total: u64,
    idle: u64,
    total: u64,
) -> Option<f64> {
    let idle_delta = idle.checked_sub(previous_idle)?;
    let total_delta = total.checked_sub(previous_total)?;
    if total_delta == 0 {
        return None;
    }
    let busy_delta = total_delta.saturating_sub(idle_delta);
    Some((busy_delta as f64 * 100.0 / total_delta as f64).clamp(0.0, 100.0))
}

fn sample_cpu(idle: u64, kernel: u64, user: u64, now: Instant) -> Option<f64> {
    let total = kernel.checked_add(user)?;
    let mut sample = CPU_SAMPLE.lock().ok()?;
    if sample
        .sampled_at
        .is_some_and(|at| now.saturating_duration_since(at) < Duration::from_secs(1))
    {
        return sample.percent;
    }
    if let Some((previous_idle, previous_total)) = sample.previous {
        if let Some(percent) = cpu_percent_from_delta(previous_idle, previous_total, idle, total) {
            sample.percent = Some(percent);
        }
    }
    sample.previous = Some((idle, total));
    sample.sampled_at = Some(now);
    sample.percent
}

#[tauri::command]
pub fn system_stats() -> Result<SystemStats, String> {
    platform::read()
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{sample_cpu, SystemStats};
    use std::mem::size_of;
    use std::time::Instant;

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct FileTime {
        low: u32,
        high: u32,
    }

    impl FileTime {
        fn as_u64(self) -> u64 {
            ((self.high as u64) << 32) | self.low as u64
        }
    }

    #[repr(C)]
    struct MemoryStatusEx {
        length: u32,
        memory_load: u32,
        total_physical: u64,
        available_physical: u64,
        total_page_file: u64,
        available_page_file: u64,
        total_virtual: u64,
        available_virtual: u64,
        available_extended_virtual: u64,
    }

    impl Default for MemoryStatusEx {
        fn default() -> Self {
            Self {
                length: size_of::<Self>() as u32,
                memory_load: 0,
                total_physical: 0,
                available_physical: 0,
                total_page_file: 0,
                available_page_file: 0,
                total_virtual: 0,
                available_virtual: 0,
                available_extended_virtual: 0,
            }
        }
    }

    #[repr(C)]
    #[derive(Default)]
    struct SystemPowerStatus {
        ac_line_status: u8,
        battery_flag: u8,
        battery_life_percent: u8,
        system_status_flag: u8,
        battery_life_time: u32,
        battery_full_life_time: u32,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetSystemTimes(idle: *mut FileTime, kernel: *mut FileTime, user: *mut FileTime) -> i32;
        fn GlobalMemoryStatusEx(status: *mut MemoryStatusEx) -> i32;
        fn GetSystemPowerStatus(status: *mut SystemPowerStatus) -> i32;
    }

    pub(super) fn read() -> Result<SystemStats, String> {
        let mut idle = FileTime::default();
        let mut kernel = FileTime::default();
        let mut user = FileTime::default();
        // SAFETY: each function receives a pointer to a correctly sized writable C struct.
        let cpu_percent = unsafe {
            if GetSystemTimes(&mut idle, &mut kernel, &mut user) == 0 {
                return Err("Windows could not read CPU times".into());
            }
            sample_cpu(
                idle.as_u64(),
                kernel.as_u64(),
                user.as_u64(),
                Instant::now(),
            )
        };

        let mut memory = MemoryStatusEx::default();
        // SAFETY: length is initialized as required by MEMORYSTATUSEX.
        if unsafe { GlobalMemoryStatusEx(&mut memory) } == 0 {
            return Err("Windows could not read memory status".into());
        }
        if memory.total_physical == 0 {
            return Err("Windows returned an invalid physical memory total".into());
        }

        let mut power = SystemPowerStatus::default();
        // SAFETY: status points to a writable SYSTEM_POWER_STATUS.
        if unsafe { GetSystemPowerStatus(&mut power) } == 0 {
            return Err("Windows could not read battery status".into());
        }
        let battery_percent =
            (power.battery_life_percent <= 100).then_some(power.battery_life_percent as f64);
        // BatteryFlag bit 3 is the Windows ACPI charging flag.
        let charging = power.battery_flag & 0b0000_1000 != 0;

        Ok(SystemStats {
            cpu_percent,
            memory_used_bytes: memory
                .total_physical
                .saturating_sub(memory.available_physical),
            memory_total_bytes: memory.total_physical,
            battery_percent,
            charging,
        })
    }
}

#[cfg(not(target_os = "windows"))]
mod platform {
    use super::SystemStats;

    pub(super) fn read() -> Result<SystemStats, String> {
        Err("System statistics are currently available only on Windows".into())
    }
}

#[cfg(test)]
mod tests {
    use super::cpu_percent_from_delta;

    #[test]
    fn cpu_delta_reports_busy_share_and_bounds_to_percentage() {
        assert_eq!(cpu_percent_from_delta(100, 1000, 125, 1100), Some(75.0));
        assert_eq!(cpu_percent_from_delta(100, 1000, 1200, 1100), Some(0.0));
        assert_eq!(cpu_percent_from_delta(100, 1000, 100, 1000), None);
    }

    #[test]
    fn cpu_delta_rejects_counter_regressions() {
        assert_eq!(cpu_percent_from_delta(200, 1000, 100, 1100), None);
        assert_eq!(cpu_percent_from_delta(100, 1200, 110, 1100), None);
    }
}
