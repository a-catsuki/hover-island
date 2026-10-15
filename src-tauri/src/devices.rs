//! Lightweight Windows Bluetooth and power transition monitor. Enumeration runs on
//! its own MTA worker and emits only changes from a valid snapshot.

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager};
use windows::Devices::Bluetooth::{BluetoothConnectionStatus, BluetoothDevice, BluetoothLEDevice};
use windows::Devices::Enumeration::DeviceInformation;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};

use crate::state::AppState;
use crate::types::{now_millis, AppNotification};

const DEVICE_EVENT: &str = "device://event";
const POLL_INTERVAL: Duration = Duration::from_secs(3);
const SLEEP_QUANTUM: Duration = Duration::from_millis(250);
const MAX_BLUETOOTH_DEVICES: usize = 64;
const MAX_DEVICE_NAME_CHARS: usize = 128;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicesSnapshot {
    pub bluetooth: Vec<String>,
    pub charging: Option<bool>,
    pub error: Option<String>,
}

impl Default for DevicesSnapshot {
    fn default() -> Self {
        Self {
            bluetooth: Vec::new(),
            charging: None,
            error: Some("Device status is still loading".into()),
        }
    }
}

static SNAPSHOT: OnceLock<Mutex<DevicesSnapshot>> = OnceLock::new();

#[tauri::command]
pub fn devices_get() -> DevicesSnapshot {
    SNAPSHOT
        .get_or_init(|| Mutex::new(DevicesSnapshot::default()))
        .lock()
        .map(|snapshot| snapshot.clone())
        .unwrap_or_default()
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BluetoothDeviceInfo {
    name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BluetoothTransition {
    key: String,
    name: String,
    connected: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct BatterySnapshot {
    charging: bool,
    percent: u8,
}

pub fn spawn(app: tauri::AppHandle) {
    if let Err(error) = thread::Builder::new()
        .name("hover-island-device-monitor".into())
        .spawn(move || monitor(app))
    {
        update_error_snapshot(
            &Some(format!("Could not start device worker: {error}")),
            &None,
        );
    }
}

fn monitor(app: tauri::AppHandle) {
    if unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_err() {
        update_error_snapshot(
            &Some("Could not initialize the Windows device worker".into()),
            &None,
        );
        return;
    }
    let _com = ComApartment;
    let mut known_devices: Option<HashMap<String, BluetoothDeviceInfo>> = None;
    let mut known_battery: Option<BatterySnapshot> = None;
    let mut bluetooth_error: Option<String> = None;
    let mut battery_error: Option<String> = None;

    loop {
        if app.state::<AppState>().shutdown.load(Ordering::Acquire) {
            break;
        }

        match connected_bluetooth_devices() {
            Ok(current) => {
                bluetooth_error = None;
                update_bluetooth_snapshot(&current);
                for transition in observe_bluetooth(&mut known_devices, current) {
                    emit_bluetooth_transition(&app, transition);
                }
            }
            // Do not interpret an API/permission failure as an empty device list.
            Err(error) => bluetooth_error = Some(error),
        }

        match battery_snapshot() {
            Ok(Some(current)) => {
                battery_error = None;
                update_battery_snapshot(current.charging);
                if let Some((was_charging, now_charging)) =
                    observe_battery(&mut known_battery, current)
                {
                    emit_power_transition(&app, was_charging, now_charging, current.percent);
                }
            }
            Ok(None) => {}
            Err(error) => battery_error = Some(error),
        }
        update_error_snapshot(&bluetooth_error, &battery_error);

        for _ in 0..(POLL_INTERVAL.as_millis() / SLEEP_QUANTUM.as_millis()) {
            if app.state::<AppState>().shutdown.load(Ordering::Acquire) {
                return;
            }
            thread::sleep(SLEEP_QUANTUM);
        }
    }
}

struct ComApartment;

impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe { windows::Win32::System::Com::CoUninitialize() };
    }
}

fn connected_bluetooth_devices() -> Result<HashMap<String, BluetoothDeviceInfo>, String> {
    let mut devices = HashMap::new();
    for selector in [
        BluetoothDevice::GetDeviceSelectorFromConnectionStatus(
            BluetoothConnectionStatus::Connected,
        ),
        BluetoothLEDevice::GetDeviceSelectorFromConnectionStatus(
            BluetoothConnectionStatus::Connected,
        ),
    ] {
        let selector = selector.map_err(|error| error.to_string())?;
        let collection = DeviceInformation::FindAllAsyncAqsFilter(&selector)
            .map_err(|error| error.to_string())?
            .get()
            .map_err(|error| error.to_string())?;
        let count = collection.Size().map_err(|error| error.to_string())?;
        for index in 0..count {
            let device = collection.GetAt(index).map_err(|error| error.to_string())?;
            let id = device.Id().map_err(|error| error.to_string())?.to_string();
            if id.is_empty() {
                continue;
            }
            let name = device
                .Name()
                .ok()
                .map(|value| safe_device_name(&value.to_string()))
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| "Bluetooth device".to_string());
            if !devices.contains_key(&id) && devices.len() >= MAX_BLUETOOTH_DEVICES {
                return Err("Bluetooth device list exceeded the safety limit".into());
            }
            devices.entry(id).or_insert(BluetoothDeviceInfo { name });
        }
    }
    Ok(devices)
}

fn update_bluetooth_snapshot(devices: &HashMap<String, BluetoothDeviceInfo>) {
    if let Ok(mut snapshot) = SNAPSHOT
        .get_or_init(|| Mutex::new(DevicesSnapshot::default()))
        .lock()
    {
        let mut names: Vec<_> = devices
            .values()
            .take(MAX_BLUETOOTH_DEVICES)
            .map(|device| device.name.clone())
            .collect();
        names.sort_unstable_by_key(|name| name.to_lowercase());
        snapshot.bluetooth = names;
    }
}

fn safe_device_name(name: &str) -> String {
    name.trim()
        .chars()
        .filter(|character| !character.is_control())
        .take(MAX_DEVICE_NAME_CHARS)
        .collect()
}

fn update_battery_snapshot(charging: bool) {
    if let Ok(mut snapshot) = SNAPSHOT
        .get_or_init(|| Mutex::new(DevicesSnapshot::default()))
        .lock()
    {
        snapshot.charging = Some(charging);
    }
}

fn update_error_snapshot(bluetooth: &Option<String>, battery: &Option<String>) {
    if let Ok(mut snapshot) = SNAPSHOT
        .get_or_init(|| Mutex::new(DevicesSnapshot::default()))
        .lock()
    {
        snapshot.error = match (bluetooth, battery) {
            (Some(bt), Some(power)) => Some(format!(
                "Bluetooth: {}; power: {}",
                short_error(bt),
                short_error(power)
            )),
            (Some(error), None) => Some(format!("Bluetooth: {}", short_error(error))),
            (None, Some(error)) => Some(format!("Power: {}", short_error(error))),
            (None, None) => None,
        };
    }
}

fn short_error(error: &str) -> String {
    let trimmed = error.trim();
    let mut chars = trimmed.chars();
    let short: String = chars.by_ref().take(160).collect();
    if chars.next().is_some() {
        format!("{short}…")
    } else {
        short
    }
}

fn observe_bluetooth(
    previous: &mut Option<HashMap<String, BluetoothDeviceInfo>>,
    current: HashMap<String, BluetoothDeviceInfo>,
) -> Vec<BluetoothTransition> {
    let Some(previous_snapshot) = previous.replace(current.clone()) else {
        // Establish a baseline silently at startup; existing paired devices are not arrivals.
        return Vec::new();
    };
    let mut transitions = Vec::new();
    for (key, info) in &current {
        if !previous_snapshot.contains_key(key) {
            transitions.push(BluetoothTransition {
                key: key.clone(),
                name: info.name.clone(),
                connected: true,
            });
        }
    }
    for (key, info) in &previous_snapshot {
        if !current.contains_key(key) {
            transitions.push(BluetoothTransition {
                key: key.clone(),
                name: info.name.clone(),
                connected: false,
            });
        }
    }
    transitions
}

fn battery_snapshot() -> Result<Option<BatterySnapshot>, String> {
    let mut status = SYSTEM_POWER_STATUS::default();
    unsafe { GetSystemPowerStatus(&mut status) }.map_err(|error| error.to_string())?;
    // ACLineStatus: 0=offline, 1=online, 255=unknown. BatteryLifePercent 255,
    // BatteryFlag 255, or bit 7 (no system battery) means the charge state is unavailable.
    Ok(battery_snapshot_from(
        status.ACLineStatus,
        status.BatteryFlag,
        status.BatteryLifePercent,
    ))
}

fn battery_snapshot_from(ac_line: u8, battery_flag: u8, percent: u8) -> Option<BatterySnapshot> {
    if ac_line > 1 || percent > 100 || battery_flag == 255 || battery_flag & 0x80 != 0 {
        return None;
    }
    Some(BatterySnapshot {
        charging: ac_line == 1,
        percent,
    })
}

fn observe_battery(
    previous: &mut Option<BatterySnapshot>,
    current: BatterySnapshot,
) -> Option<(bool, bool)> {
    let old = previous.replace(current)?;
    (old.charging != current.charging).then_some((old.charging, current.charging))
}

fn emit_bluetooth_transition(app: &tauri::AppHandle, transition: BluetoothTransition) {
    let timestamp = now_millis();
    let action = if transition.connected {
        "connected"
    } else {
        "disconnected"
    };
    let id = format!(
        "bluetooth:{}:{action}:{timestamp}",
        private_key(&transition.key)
    );
    emit_event(
        app,
        AppNotification {
            id,
            app: "Bluetooth".into(),
            title: if transition.connected {
                "Device connected".into()
            } else {
                "Device disconnected".into()
            },
            body: transition.name,
            timestamp,
            icon: None,
        },
    );
}

fn emit_power_transition(
    app: &tauri::AppHandle,
    was_charging: bool,
    now_charging: bool,
    percent: u8,
) {
    let timestamp = now_millis();
    let action = if now_charging {
        "plugged-in"
    } else {
        "on-battery"
    };
    let id = format!("battery:{action}:{timestamp}");
    let body = if now_charging {
        format!("Power connected · {percent}% battery")
    } else {
        format!("On battery at {percent}%")
    };
    emit_event(
        app,
        AppNotification {
            id,
            app: "Battery".into(),
            title: if now_charging {
                "Power connected".into()
            } else if was_charging {
                "Power disconnected".into()
            } else {
                "Power changed".into()
            },
            body,
            timestamp,
            icon: None,
        },
    );
}

fn emit_event(app: &tauri::AppHandle, notification: AppNotification) {
    let _ = app.emit(DEVICE_EVENT, notification);
}

fn private_key(id: &str) -> String {
    let digest = Sha256::digest(id.as_bytes());
    digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn devices(items: &[(&str, &str)]) -> HashMap<String, BluetoothDeviceInfo> {
        items
            .iter()
            .map(|(id, name)| {
                (
                    (*id).into(),
                    BluetoothDeviceInfo {
                        name: (*name).into(),
                    },
                )
            })
            .collect()
    }

    #[test]
    fn initial_bluetooth_snapshot_is_silent_then_reports_only_diffs() {
        let mut previous = None;
        assert!(
            observe_bluetooth(&mut previous, devices(&[("private-a", "Headphones")])).is_empty()
        );
        let changes = observe_bluetooth(
            &mut previous,
            devices(&[("private-a", "Headphones"), ("private-b", "Keyboard")]),
        );
        assert_eq!(changes.len(), 1);
        assert!(changes[0].connected);
        assert_eq!(changes[0].name, "Keyboard");

        let changes = observe_bluetooth(&mut previous, HashMap::new());
        assert_eq!(changes.len(), 2);
        assert!(changes.iter().all(|change| !change.connected));
    }

    #[test]
    fn battery_baseline_and_unknown_values_do_not_create_transitions() {
        let mut previous = None;
        assert_eq!(
            observe_battery(
                &mut previous,
                BatterySnapshot {
                    charging: true,
                    percent: 61
                }
            ),
            None
        );
        assert_eq!(
            observe_battery(
                &mut previous,
                BatterySnapshot {
                    charging: true,
                    percent: 62
                }
            ),
            None
        );
        assert_eq!(
            observe_battery(
                &mut previous,
                BatterySnapshot {
                    charging: false,
                    percent: 62
                }
            ),
            Some((true, false))
        );
        assert_eq!(battery_snapshot_from(255, 0, 62), None);
        assert_eq!(
            battery_snapshot_from(1, 8, 62),
            Some(BatterySnapshot {
                charging: true,
                percent: 62
            })
        );
        assert_eq!(battery_snapshot_from(1, 128, 62), None);
        assert_eq!(battery_snapshot_from(1, 255, 62), None);
        assert_eq!(battery_snapshot_from(0, 0, 255), None);
    }

    #[test]
    fn bluetooth_names_are_bounded_and_drop_control_characters() {
        assert_eq!(safe_device_name("  headset\n\u{7} "), "headset");
        assert_eq!(
            safe_device_name(&"x".repeat(MAX_DEVICE_NAME_CHARS + 1)).len(),
            MAX_DEVICE_NAME_CHARS
        );
    }

    #[test]
    fn bluetooth_event_ids_do_not_expose_device_identifiers() {
        let hashed = private_key("Bluetooth#BluetoothLE#DEVICE_123456789");
        assert_eq!(hashed.len(), 16);
        assert!(!hashed.contains("123456789"));
    }
}
