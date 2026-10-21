//! User-invoked Windows quick controls.
//!
//! Real hardware/system state changes:
//! - Volume + mute through the WASAPI `IAudioEndpointVolume` COM interface.
//! - Brightness through WMI (`root/wmi` `WmiMonitorBrightness` /
//!   `WmiMonitorBrightnessMethods.WmiSetBrightness`).
//! - Night light through the undocumented CloudStore registry blob (best effort).
//! - Do Not Disturb through the Windows 11 notification toggle in the registry plus the
//!   shell's `WNF_QUIETHOURS_PROFILE` WNF state (best effort).
//! - Wi-Fi, Bluetooth and Airplane mode through `Windows.Devices.Radios`.
//! - Dark / light theme through the Personalize registry values (HKCU) and a
//!   `WM_SETTINGCHANGE` broadcast.
//! - Battery saver is read-only (`GetSystemPowerStatus`); Windows has no public toggle.
//! - Power mode through the documented Windows 11 `powrprof` APIs.
//!
//! Windows exposes no documented public API for apps to toggle Energy Saver, so the
//! power control is labelled exactly what it does (the Windows power mode) and never
//! pretends to be Energy Saver.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeControl {
    pub supported: bool,
    /// Master volume 0-100, when Windows reports it.
    pub level: Option<u32>,
    pub muted: Option<bool>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrightnessControl {
    pub supported: bool,
    /// Brightness 0-100, or `None` when the display does not expose it (e.g. desktop).
    pub level: Option<u32>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BluetoothControl {
    pub supported: bool,
    pub enabled: Option<bool>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PowerModeControl {
    pub active_name: Option<String>,
    pub supported: bool,
    pub best_efficiency_active: bool,
    pub can_restore_previous: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NightLightControl {
    pub supported: bool,
    pub enabled: Option<bool>,
    /// Night light has no public API; this reflects an undocumented state blob.
    pub best_effort: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoNotDisturbControl {
    pub supported: bool,
    pub enabled: Option<bool>,
    /// Do Not Disturb has no public API; this reflects an undocumented WNF state.
    pub best_effort: bool,
    pub error: Option<String>,
}

/// A plain on/off control (Wi-Fi, Airplane mode, theme, battery saver).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToggleControl {
    pub supported: bool,
    pub enabled: Option<bool>,
    /// Rides undocumented or indirect Windows state.
    pub best_effort: bool,
    /// Windows exposes the state but offers no way to change it.
    pub read_only: bool,
    pub error: Option<String>,
}

impl ToggleControl {
    fn unavailable(error: impl Into<String>) -> Self {
        Self {
            supported: false,
            enabled: None,
            best_effort: false,
            read_only: false,
            error: Some(error.into()),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickControlsSnapshot {
    pub volume: VolumeControl,
    pub brightness: BrightnessControl,
    pub bluetooth: BluetoothControl,
    pub wifi: ToggleControl,
    pub airplane: ToggleControl,
    pub power_mode: PowerModeControl,
    pub night_light: NightLightControl,
    pub do_not_disturb: DoNotDisturbControl,
    /// `enabled` means dark theme.
    pub theme: ToggleControl,
    pub battery_saver: ToggleControl,
}

/// Accepts any finite level and pins it into the 0-100 range. Non-finite input
/// (NaN / infinity) becomes 0 instead of producing a meaningless setting.
fn clamp_volume(level: f64) -> f64 {
    if level.is_finite() {
        level.clamp(0.0, 100.0)
    } else {
        0.0
    }
}

fn clamp_brightness(level: u32) -> u32 {
    level.min(100)
}

/// This is an undocumented CloudStore format. Support only the exact state
/// record layout observed on Windows 11, and refuse to rewrite other versions.
fn is_supported_night_light_record(data: &[u8]) -> bool {
    data.len() >= 40
        && data.len() <= 42
        && data[..10] == [0x43, 0x42, 0x01, 0x00, 0x0a, 0x02, 0x01, 0x00, 0x2a, 0x06]
        && data[15..18] == [0x2a, 0x2b, 0x0e]
        && data[19..23] == [0x43, 0x42, 0x01, 0x00]
        && data[23..25] == [0x10, 0x00]
        && match data[18] {
            // Windows 11 26300 reports the original off state as 0x12. After
            // toggling it off through the same CloudStore convention it is 0x13.
            0x12 | 0x13 => data.len() == 40,
            // Turning it on inserts a second marker ahead of the original one.
            0x15 => data.len() == 42 && data[25..27] == [0x10, 0x00],
            _ => false,
        }
}

/// Reads the "on/off" flag out of the known Night light CloudStore record.
fn decode_night_light(data: &[u8]) -> Option<bool> {
    if !is_supported_night_light_record(data) {
        return None;
    }
    match data[18] {
        0x12 | 0x13 => Some(false),
        0x15 => Some(true),
        _ => None,
    }
}

/// Produces an updated Night light CloudStore blob, or `None` when the current
/// layout is unexpected (in which case the caller must leave the state untouched).
fn apply_night_light(data: &[u8], enabled: bool, now: u64) -> Option<Vec<u8>> {
    let currently_on = decode_night_light(data)?;
    if currently_on == enabled {
        return Some(data.to_vec());
    }
    let mut list = data.to_vec();
    if enabled {
        // Insert the enabled marker in front of the existing nested record.
        list.splice(23..23, [0x10u8, 0x00]);
        list[18] = 0x15;
    } else {
        // The supported enabled record has a marker pair at 23..25 followed by
        // the original nested marker at 25..27. Keep the latter intact.
        if list[23..27] != [0x10, 0x00, 0x10, 0x00] {
            return None;
        }
        list.drain(23..25);
        list[18] = 0x13;
    }
    // Advance the 5-byte little-endian varint timestamp so Windows applies the change.
    let mut timestamp: u64 = 0;
    for index in 0..5 {
        timestamp |= ((list[10 + index] & 0x7F) as u64) << (7 * index);
    }
    timestamp = timestamp.saturating_add(1).max(now);
    for index in 0..5 {
        let mut byte = ((timestamp >> (7 * index)) & 0x7F) as u8;
        if index < 4 {
            byte |= 0x80;
        }
        list[10 + index] = byte;
    }
    Some(list)
}

#[tauri::command]
pub async fn quick_controls_get() -> Result<QuickControlsSnapshot, String> {
    tauri::async_runtime::spawn_blocking(|| {
        // One radio enumeration feeds Bluetooth, Wi-Fi and Airplane mode.
        let (bluetooth, wifi, airplane) = platform::radio_snapshot();
        QuickControlsSnapshot {
            volume: volume_status(),
            brightness: brightness_status(),
            bluetooth,
            wifi,
            airplane,
            power_mode: power_mode_status(),
            night_light: night_light_status(),
            do_not_disturb: do_not_disturb_status(),
            theme: platform::theme_status(),
            battery_saver: platform::battery_saver_status(),
        }
    })
    .await
    .map_err(|error| format!("Quick-controls worker failed: {error}"))
}

#[tauri::command]
pub async fn set_master_volume(level: f64) -> Result<(), String> {
    if !level.is_finite() {
        return Err("Volume must be a finite number.".into());
    }
    let level = clamp_volume(level);
    tauri::async_runtime::spawn_blocking(move || platform::set_master_volume(level))
        .await
        .map_err(|error| format!("Volume worker failed: {error}"))?
}

#[tauri::command]
pub async fn set_mute(muted: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || platform::set_mute(muted))
        .await
        .map_err(|error| format!("Mute worker failed: {error}"))?
}

#[tauri::command]
pub async fn set_brightness(level: u32) -> Result<(), String> {
    let level = clamp_brightness(level);
    tauri::async_runtime::spawn_blocking(move || platform::set_brightness(level))
        .await
        .map_err(|error| format!("Brightness worker failed: {error}"))?
}

#[tauri::command]
pub async fn set_night_light(enabled: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || platform::set_night_light(enabled))
        .await
        .map_err(|error| format!("Night light worker failed: {error}"))?
}

#[tauri::command]
pub async fn set_do_not_disturb(enabled: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || platform::set_do_not_disturb(enabled))
        .await
        .map_err(|error| format!("Do Not Disturb worker failed: {error}"))?
}

#[tauri::command]
pub fn open_night_light_settings() -> Result<(), String> {
    platform::open_night_light_settings()
}

#[tauri::command]
pub fn open_bluetooth_settings() -> Result<(), String> {
    platform::open_bluetooth_settings()
}

#[tauri::command]
pub fn open_power_settings() -> Result<(), String> {
    platform::open_power_settings()
}

fn windows_settings_uri(page: &str) -> Result<&'static str, String> {
    match page {
        "sound" => Ok("ms-settings:sound"),
        "display" => Ok("ms-settings:display"),
        "notifications" => Ok("ms-settings:notifications"),
        "notification-access" => Ok("ms-settings:privacy-notifications"),
        "bluetooth" => Ok("ms-settings:bluetooth"),
        "wifi" => Ok("ms-settings:network-wifi"),
        "airplane" => Ok("ms-settings:network-airplanemode"),
        "colors" => Ok("ms-settings:colors"),
        "battery" => Ok("ms-settings:batterysaver"),
        "focus" => Ok("ms-settings:quiethours"),
        _ => Err("Unknown Windows settings page.".into()),
    }
}

#[tauri::command]
pub fn open_windows_settings(page: String) -> Result<(), String> {
    let uri = windows_settings_uri(&page)?;
    #[cfg(target_os = "windows")]
    {
        use windows::core::{w, PCWSTR};
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        let wide: Vec<u16> = uri.encode_utf16().chain(std::iter::once(0)).collect();
        let result = unsafe {
            ShellExecuteW(
                HWND::default(),
                w!("open"),
                PCWSTR(wide.as_ptr()),
                PCWSTR::null(),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            )
        };
        if result.0 <= 32 {
            Err("Windows could not open this settings page.".into())
        } else {
            Ok(())
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = uri;
        Err("Windows controls are available on Windows.".into())
    }
}

#[tauri::command]
pub async fn set_power_saver_plan(enabled: bool) -> Result<(), String> {
    // Keep the existing command name registered by lib.rs for compatibility.
    // Its behavior is Windows' documented Best power efficiency mode.
    tauri::async_runtime::spawn_blocking(move || platform::set_power_saver_plan(enabled))
        .await
        .map_err(|error| format!("Power-plan worker failed: {error}"))?
}

pub fn restore_previous_power_plan() -> Result<(), String> {
    platform::restore_previous_power_plan()
}

/* ------------------------- Windows banners (setting) ------------------------- */

static BANNER_DIR: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

fn banner_backup_path(dir: &std::path::Path) -> std::path::PathBuf {
    dir.join("windows-banners-previous.txt")
}

/// Hide (`quiet`/`clear`) or show (`normal`) Windows' own toast banners using the
/// same global toast switch as Do Not Disturb. The user's previous raw value is
/// saved to app data first, so a crash still restores it on the next launch.
/// The island's own `dnd` setting is never touched.
pub fn apply_windows_banners(dir: &std::path::Path, mode: &str) -> Result<(), String> {
    if matches!(mode, "quiet" | "clear") {
        let path = banner_backup_path(dir);
        if !path.exists() {
            // A missing value means banners are on.
            let previous = platform::banner_value_read().unwrap_or(1);
            std::fs::create_dir_all(dir)
                .and_then(|()| std::fs::write(&path, previous.to_string()))
                .map_err(|error| format!("Could not save the Windows banner setting: {error}"))?;
        }
        platform::banner_value_write(0)
    } else {
        restore_windows_banners(dir)
    }
}

/// Put the saved value back and forget it. A no-op when nothing was saved.
pub fn restore_windows_banners(dir: &std::path::Path) -> Result<(), String> {
    let path = banner_backup_path(dir);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Ok(());
    };
    let previous = text.trim().parse::<u32>().ok().filter(|v| *v <= 1).unwrap_or(1);
    platform::banner_value_write(previous)?;
    let _ = std::fs::remove_file(&path);
    Ok(())
}

/// Restore using the directory remembered by `spawn_banner_watcher`; used on exit,
/// tray Quit and from the panic hook.
pub fn restore_windows_banners_global() {
    if let Some(dir) = BANNER_DIR.get() {
        let _ = restore_windows_banners(dir);
    }
}

/// Follows `settings.windowsBanners` (checked every 2 s) and installs a panic
/// hook that restores the user's value if the app crashes.
pub fn spawn_banner_watcher(app: tauri::AppHandle) {
    use std::sync::atomic::Ordering;
    use tauri::Manager;
    let Ok(dir) = app.path().app_data_dir() else {
        return;
    };
    let _ = BANNER_DIR.set(dir.clone());
    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        restore_windows_banners_global();
        previous_hook(info);
    }));
    std::thread::spawn(move || {
        let mut applied: Option<String> = None;
        let mut reported = false;
        loop {
            let state = app.state::<crate::state::AppState>();
            if state.shutdown.load(Ordering::Relaxed) {
                restore_windows_banners_global();
                return;
            }
            let mode = {
                let settings = state.settings.lock().unwrap();
                match settings.windows_banners.as_str() {
                    "quiet" => "quiet",
                    "clear" => "clear",
                    _ => "normal",
                }
            };
            // quiet and clear both hide banners; only the notification poll differs.
            let hidden = mode != "normal";
            let target = if hidden { "hidden" } else { "normal" };
            if applied.as_deref() != Some(target) {
                match apply_windows_banners(&dir, mode) {
                    Ok(()) => {
                        applied = Some(target.to_string());
                        reported = false;
                    }
                    Err(error) => {
                        if !reported {
                            eprintln!("Windows banner setting: {error}");
                            reported = true;
                        }
                    }
                }
            }
            drop(state);
            std::thread::sleep(std::time::Duration::from_secs(2));
        }
    });
}

#[tauri::command]
pub async fn set_bluetooth_radio(app: tauri::AppHandle, enabled: bool) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || platform::set_bluetooth_radio(enabled, app))
        .await
        .map_err(|error| format!("Bluetooth worker failed: {error}"))?
}

/// Cheap Bluetooth radio read for the Bluetooth widget (no brightness or volume queries).
#[tauri::command]
pub async fn bluetooth_radio_get() -> Result<BluetoothControl, String> {
    tauri::async_runtime::spawn_blocking(|| platform::radio_snapshot().0)
        .await
        .map_err(|error| format!("Bluetooth worker failed: {error}"))
}

#[tauri::command]
pub async fn set_wifi_radio(app: tauri::AppHandle, enabled: bool) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || platform::set_wifi_radio(enabled, app))
        .await
        .map_err(|error| format!("Wi-Fi worker failed: {error}"))?
}

#[tauri::command]
pub async fn set_airplane_mode(app: tauri::AppHandle, enabled: bool) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || platform::set_airplane_mode(enabled, app))
        .await
        .map_err(|error| format!("Airplane mode worker failed: {error}"))?
}

#[tauri::command]
pub async fn set_dark_mode(enabled: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || platform::set_dark_mode(enabled))
        .await
        .map_err(|error| format!("Theme worker failed: {error}"))?
}

pub(crate) fn volume_status() -> VolumeControl {
    platform::volume_status()
}

pub(crate) fn brightness_status() -> BrightnessControl {
    platform::brightness_status()
}

fn power_mode_status() -> PowerModeControl {
    platform::power_mode_status()
}

fn night_light_status() -> NightLightControl {
    platform::night_light_status()
}

fn do_not_disturb_status() -> DoNotDisturbControl {
    platform::do_not_disturb_status()
}

fn short_error(error: &str) -> String {
    let trimmed = error.trim();
    let short: String = trimmed.chars().take(180).collect();
    if trimmed.chars().count() > 180 {
        format!("{short}…")
    } else {
        short
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{
        apply_night_light, clamp_brightness, clamp_volume, decode_night_light, short_error,
        BluetoothControl, BrightnessControl, DoNotDisturbControl, NightLightControl,
        PowerModeControl, ToggleControl, VolumeControl,
    };
    use std::ffi::c_void;
    use std::sync::{Mutex, OnceLock};
    use windows::core::{w, BSTR, GUID, PCWSTR};
    use windows::Devices::Radios::{Radio, RadioAccessStatus, RadioKind, RadioState};
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM, WPARAM};
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoSetProxyBlanket, CLSCTX_ALL, CLSCTX_INPROC_SERVER,
        COINIT_MULTITHREADED, EOAC_NONE, RPC_C_AUTHN_LEVEL_CALL, RPC_C_IMP_LEVEL_IMPERSONATE,
    };
    use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    use windows::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegGetValueW, RegOpenKeyExW, RegQueryValueExW,
        RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE, REG_BINARY,
        REG_DWORD, REG_OPTION_NON_VOLATILE, REG_VALUE_TYPE, RRF_RT_REG_DWORD,
    };
    use windows::Win32::System::Variant::{
        VariantChangeType, VariantClear, VARIANT, VARIANT_0_0, VARIANT_0_0_0, VAR_CHANGE_FLAGS,
        VT_BOOL, VT_BSTR, VT_I4, VT_UI1,
    };
    use windows::Win32::System::Wmi::{
        IEnumWbemClassObject, IWbemClassObject, IWbemContext, IWbemLocator, IWbemServices,
        WbemLocator, WBEM_FLAG_FORWARD_ONLY, WBEM_FLAG_RETURN_IMMEDIATELY, WBEM_GENERIC_FLAG_TYPE,
    };
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::{
        SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, SW_SHOWNORMAL, WM_SETTINGCHANGE,
    };

    const BEST_EFFICIENCY: GUID = GUID::from_values(
        0x961CC777,
        0x2547,
        0x4F9D,
        [0x81, 0x74, 0x7D, 0x86, 0x18, 0x1B, 0x8A, 0x7A],
    );
    static RESTORE_MODE: OnceLock<Mutex<Option<(GUID, GUID)>>> = OnceLock::new();
    static RADIO_ACCESS: OnceLock<Mutex<Option<RadioAccessStatus>>> = OnceLock::new();
    static POWER_OPERATION: Mutex<()> = Mutex::new(());
    /// Radio kinds that were on when Airplane mode was switched on from here, so
    /// switching it off brings back the same set instead of forcing everything on.
    static AIRPLANE_RESTORE: Mutex<Vec<i32>> = Mutex::new(Vec::new());
    const AIRPLANE_KINDS: [RadioKind; 3] = [
        RadioKind::WiFi,
        RadioKind::Bluetooth,
        RadioKind::MobileBroadband,
    ];

    // Windows 11 Do Not Disturb is the global toast switch in the notification settings.
    const NOTIFICATIONS_KEY: &str =
        "Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings";
    const TOASTS_ENABLED_VALUE: &str = "NOC_GLOBAL_SETTING_TOASTS_ENABLED";
    const PERSONALIZE_KEY: &str =
        "Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize";

    // Night light lives in an undocumented CloudStore registry blob.
    const NIGHT_LIGHT_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\CloudStore\\Store\\DefaultAccount\\Current\\default$windows.data.bluelightreduction.bluelightreductionstate\\windows.data.bluelightreduction.bluelightreductionstate";
    const NIGHT_LIGHT_VALUE: &str = "Data";

    // Do Not Disturb lives in the shell's quiet-hours WNF state.
    const WNF_QUIETHOURS_PROFILE: u64 = 0x0D83_063E_A3BF_1C75;

    const RPC_C_AUTHN_WINNT: u32 = 10;
    const RPC_C_AUTHZ_NONE: u32 = 0;

    type GetPowerMode = unsafe extern "system" fn(*mut GUID) -> u32;
    type SetPowerMode = unsafe extern "system" fn(*const GUID) -> u32;

    #[link(name = "kernel32")]
    extern "system" {
        fn LoadLibraryW(name: *const u16) -> isize;
        fn GetProcAddress(module: isize, name: *const u8) -> *mut c_void;
        fn FreeLibrary(module: isize) -> i32;
    }

    #[link(name = "ntdll")]
    extern "system" {
        fn NtQueryWnfStateData(
            state_name: *mut u64,
            type_id: *const c_void,
            scope: *const c_void,
            change_stamp: *mut u32,
            buffer: *mut u8,
            buffer_size: *mut u32,
        ) -> i32;
        fn NtUpdateWnfStateData(
            state_name: *const u64,
            buffer: *const u8,
            length: u32,
            type_id: *const c_void,
            scope: *const c_void,
            matching_change_stamp: u32,
            check_stamp: u32,
        ) -> i32;
    }

    struct Powrprof(isize);
    impl Drop for Powrprof {
        fn drop(&mut self) {
            unsafe { FreeLibrary(self.0) };
        }
    }

    fn powrprof() -> Result<Powrprof, String> {
        let name: Vec<u16> = "powrprof.dll\0".encode_utf16().collect();
        let module = unsafe { LoadLibraryW(name.as_ptr()) };
        if module == 0 {
            Err("Windows power-mode APIs are unavailable on this version of Windows.".into())
        } else {
            Ok(Powrprof(module))
        }
    }

    fn power_mode_function<T: Copy>(module: &Powrprof, name: &'static [u8]) -> Result<T, String> {
        let address = unsafe { GetProcAddress(module.0, name.as_ptr().cast()) };
        if address.is_null() {
            return Err(
                "Windows 11 power-mode APIs are unavailable on this version of Windows.".into(),
            );
        }
        Ok(unsafe { std::mem::transmute_copy(&address) })
    }

    fn read_power_modes() -> Result<(GUID, GUID), String> {
        let module = powrprof()?;
        let get_ac: GetPowerMode =
            power_mode_function(&module, b"PowerGetUserConfiguredACPowerMode\0")?;
        let get_dc: GetPowerMode =
            power_mode_function(&module, b"PowerGetUserConfiguredDCPowerMode\0")?;
        let mut ac = GUID::zeroed();
        let mut dc = GUID::zeroed();
        let ac_status = unsafe { get_ac(&mut ac) };
        let dc_status = unsafe { get_dc(&mut dc) };
        if ac_status != 0 || dc_status != 0 {
            return Err(format!(
                "Windows could not read the configured power mode (AC {ac_status}, battery {dc_status})."
            ));
        }
        Ok((ac, dc))
    }

    fn write_power_modes(ac: &GUID, dc: &GUID, rollback_ac: &GUID) -> Result<(), String> {
        let module = powrprof()?;
        let set_ac: SetPowerMode =
            power_mode_function(&module, b"PowerSetUserConfiguredACPowerMode\0")?;
        let set_dc: SetPowerMode =
            power_mode_function(&module, b"PowerSetUserConfiguredDCPowerMode\0")?;
        let ac_status = unsafe { set_ac(ac) };
        if ac_status != 0 {
            return Err(format!(
                "Windows could not change the plugged-in power mode ({ac_status})."
            ));
        }
        let dc_status = unsafe { set_dc(dc) };
        if dc_status != 0 {
            // Keep AC/DC settings paired if the second setting is rejected.
            let _ = unsafe { set_ac(rollback_ac) };
            return Err(format!(
                "Windows could not change the battery power mode ({dc_status})."
            ));
        }
        Ok(())
    }

    struct ComApartment;
    impl Drop for ComApartment {
        fn drop(&mut self) {
            unsafe { windows::Win32::System::Com::CoUninitialize() };
        }
    }

    fn com_apartment() -> Result<ComApartment, String> {
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
            .map_err(|error| hresult_error("Windows COM runtime unavailable", &error))?;
        Ok(ComApartment)
    }

    fn hresult_error(context: &str, error: &windows::core::Error) -> String {
        // windows-core 0.52's Error formatting can panic when FormatMessageW
        // returns no system string. Keep native HRESULT failures diagnosable
        // without asking that version to format a missing message pointer.
        format!("{context} (HRESULT 0x{:08X})", error.code().0 as u32)
    }

    /* --------------------------------------------------------------- volume */

    fn default_endpoint_volume() -> Result<IAudioEndpointVolume, String> {
        let enumerator: IMMDeviceEnumerator =
            unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
                .map_err(|error| format!("Audio device enumeration failed: {error}"))?;
        let device = unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole) }
            .map_err(|_| "No default audio output device is available.".to_string())?;
        let volume: IAudioEndpointVolume = unsafe { device.Activate(CLSCTX_ALL, None) }
            .map_err(|error| format!("Could not open the system volume control: {error}"))?;
        Ok(volume)
    }

    pub(super) fn volume_status() -> VolumeControl {
        let _com = match com_apartment() {
            Ok(apartment) => apartment,
            Err(error) => {
                return VolumeControl {
                    supported: false,
                    level: None,
                    muted: None,
                    error: Some(short_error(&error)),
                }
            }
        };
        match default_endpoint_volume() {
            Ok(volume) => {
                let level = unsafe { volume.GetMasterVolumeLevelScalar() }
                    .ok()
                    .map(|scalar| (scalar * 100.0).round().clamp(0.0, 100.0) as u32);
                let muted = unsafe { volume.GetMute() }
                    .ok()
                    .map(|value| value.as_bool());
                if level.is_none() && muted.is_none() {
                    VolumeControl {
                        supported: false,
                        level: None,
                        muted: None,
                        error: Some("Windows did not report the system volume.".into()),
                    }
                } else {
                    VolumeControl {
                        supported: true,
                        level,
                        muted,
                        error: None,
                    }
                }
            }
            Err(error) => VolumeControl {
                supported: false,
                level: None,
                muted: None,
                error: Some(short_error(&error)),
            },
        }
    }

    pub(super) fn set_master_volume(level: f64) -> Result<(), String> {
        let _com = com_apartment()?;
        let volume = default_endpoint_volume()?;
        let scalar = (clamp_volume(level) / 100.0) as f32;
        unsafe { volume.SetMute(BOOL::from(false), std::ptr::null()) }
            .map_err(|error| format!("Windows could not unmute the system volume: {error}"))?;
        unsafe { volume.SetMasterVolumeLevelScalar(scalar, std::ptr::null()) }
            .map_err(|error| format!("Windows could not set the system volume: {error}"))
    }

    pub(super) fn set_mute(muted: bool) -> Result<(), String> {
        let _com = com_apartment()?;
        let volume = default_endpoint_volume()?;
        unsafe { volume.SetMute(BOOL::from(muted), std::ptr::null()) }
            .map_err(|error| format!("Windows could not change mute: {error}"))
    }

    /* ----------------------------------------------------------- brightness */

    fn wmi_services() -> Result<IWbemServices, String> {
        let locator: IWbemLocator =
            unsafe { CoCreateInstance(&WbemLocator, None, CLSCTX_INPROC_SERVER) }.map_err(
                |error| hresult_error("Windows management (WMI) is unavailable", &error),
            )?;
        let services = unsafe {
            locator.ConnectServer(
                &BSTR::from("ROOT\\WMI"),
                &BSTR::from(""),
                &BSTR::from(""),
                &BSTR::from(""),
                0,
                &BSTR::from(""),
                None::<&IWbemContext>,
            )
        }
        .map_err(|error| hresult_error("Windows management (WMI) connection failed", &error))?;
        unsafe {
            CoSetProxyBlanket(
                &services,
                RPC_C_AUTHN_WINNT,
                RPC_C_AUTHZ_NONE,
                PCWSTR::null(),
                RPC_C_AUTHN_LEVEL_CALL,
                RPC_C_IMP_LEVEL_IMPERSONATE,
                None,
                EOAC_NONE,
            )
        }
        .map_err(|error| hresult_error("Windows management (WMI) security setup failed", &error))?;
        Ok(services)
    }

    fn exec_query(services: &IWbemServices, wql: &str) -> Result<IEnumWbemClassObject, String> {
        unsafe {
            services.ExecQuery(
                &BSTR::from("WQL"),
                &BSTR::from(wql),
                WBEM_FLAG_FORWARD_ONLY | WBEM_FLAG_RETURN_IMMEDIATELY,
                None::<&IWbemContext>,
            )
        }
        .map_err(|error| hresult_error("WMI query failed", &error))
    }

    fn first_object(enumerator: &IEnumWbemClassObject) -> Result<Option<IWbemClassObject>, String> {
        let mut objects: [Option<IWbemClassObject>; 1] = [None];
        let mut returned = 0u32;
        unsafe { enumerator.Next(2000, &mut objects, &mut returned) }
            .ok()
            .map_err(|error| hresult_error("Windows brightness query failed", &error))?;
        if returned == 0 {
            return Ok(None);
        }
        Ok(objects[0].take())
    }

    fn variant_to_u32(value: &VARIANT) -> Option<u32> {
        unsafe {
            let mut converted = VARIANT::default();
            if VariantChangeType(&mut converted, value, VAR_CHANGE_FLAGS(0), VT_I4).is_err() {
                return None;
            }
            let result = converted.Anonymous.Anonymous.Anonymous.lVal;
            let _ = VariantClear(&mut converted);
            u32::try_from(result).ok()
        }
    }

    fn brightness_method_succeeded(value: &VARIANT) -> Option<bool> {
        if unsafe { value.Anonymous.Anonymous.vt == VT_BOOL } {
            let mut converted = VARIANT::default();
            let result = unsafe {
                VariantChangeType(&mut converted, value, VAR_CHANGE_FLAGS(0), VT_I4)
                    .ok()
                    .map(|_| converted.Anonymous.Anonymous.Anonymous.lVal != 0)
            };
            unsafe {
                let _ = VariantClear(&mut converted);
            }
            result
        } else {
            variant_to_u32(value).map(|code| code == 0)
        }
    }

    fn uint32_variant(value: u32) -> VARIANT {
        let mut variant = VARIANT::default();
        variant.Anonymous.Anonymous = std::mem::ManuallyDrop::new(VARIANT_0_0 {
            // WMI Automation maps CIM uint32 to VT_I4, preserving the 32-bit
            // bit pattern. See Microsoft's "Numbers (WMI)" mapping table.
            vt: VT_I4,
            wReserved1: 0,
            wReserved2: 0,
            wReserved3: 0,
            Anonymous: VARIANT_0_0_0 { lVal: value as i32 },
        });
        variant
    }

    fn uint8_variant(value: u8) -> VARIANT {
        let mut variant = VARIANT::default();
        variant.Anonymous.Anonymous = std::mem::ManuallyDrop::new(VARIANT_0_0 {
            vt: VT_UI1,
            wReserved1: 0,
            wReserved2: 0,
            wReserved3: 0,
            Anonymous: VARIANT_0_0_0 { bVal: value },
        });
        variant
    }

    fn read_brightness() -> Result<Option<u32>, String> {
        let services = wmi_services()?;
        let enumerator = exec_query(
            &services,
            "SELECT CurrentBrightness FROM WmiMonitorBrightness WHERE Active = TRUE",
        )?;
        let Some(object) = first_object(&enumerator)? else {
            return Ok(None);
        };
        let mut value = VARIANT::default();
        unsafe { object.Get(w!("CurrentBrightness"), 0, &mut value, None, None) }
            .map_err(|error| hresult_error("WMI brightness read failed", &error))?;
        let level = variant_to_u32(&value);
        unsafe {
            let _ = VariantClear(&mut value);
        }
        Ok(level.map(|value| value.min(100)))
    }

    pub(super) fn brightness_status() -> BrightnessControl {
        let _com = match com_apartment() {
            Ok(apartment) => apartment,
            Err(error) => {
                return BrightnessControl {
                    supported: false,
                    level: None,
                    error: Some(short_error(&error)),
                }
            }
        };
        match read_brightness() {
            Ok(Some(level)) => BrightnessControl {
                supported: true,
                level: Some(level),
                error: None,
            },
            Ok(None) => BrightnessControl {
                supported: false,
                level: None,
                error: Some("This display does not support software brightness control.".into()),
            },
            Err(error) => BrightnessControl {
                supported: false,
                level: None,
                error: Some(short_error(&error)),
            },
        }
    }

    fn set_brightness_once(services: &IWbemServices, level: u32) -> Result<(), String> {
        let enumerator = exec_query(
            services,
            "SELECT * FROM WmiMonitorBrightnessMethods WHERE Active = TRUE",
        )?;
        let Some(instance) = first_object(&enumerator)? else {
            return Err("This display does not support software brightness control.".into());
        };

        let mut path_variant = VARIANT::default();
        unsafe { instance.Get(w!("__PATH"), 0, &mut path_variant, None, None) }
            .map_err(|error| hresult_error("WMI brightness path read failed", &error))?;
        let is_bstr = unsafe { path_variant.Anonymous.Anonymous.vt == VT_BSTR };
        let path = if is_bstr {
            unsafe {
                path_variant
                    .Anonymous
                    .Anonymous
                    .Anonymous
                    .bstrVal
                    .to_string()
            }
        } else {
            String::new()
        };
        unsafe {
            let _ = VariantClear(&mut path_variant);
        }
        if path.is_empty() {
            return Err("Windows did not expose a brightness control path.".into());
        }

        // WMI method signatures belong to the class definition. Querying an
        // instance returns its values and path, but providers are not required
        // to expose method metadata on that instance.
        let mut method_class: Option<IWbemClassObject> = None;
        unsafe {
            services.GetObject(
                &BSTR::from("WmiMonitorBrightnessMethods"),
                WBEM_GENERIC_FLAG_TYPE(0),
                None::<&IWbemContext>,
                Some(&mut method_class),
                None,
            )
        }
        .map_err(|error| hresult_error("Windows brightness class unavailable", &error))?;
        let method_class =
            method_class.ok_or_else(|| "Windows brightness class unavailable.".to_string())?;

        let mut in_signature: Option<IWbemClassObject> = None;
        let mut out_signature: Option<IWbemClassObject> = None;
        unsafe {
            method_class.GetMethod(
                w!("WmiSetBrightness"),
                0,
                &mut in_signature,
                &mut out_signature,
            )
        }
        .map_err(|error| hresult_error("Windows did not expose the brightness method", &error))?;
        let in_signature = in_signature
            .ok_or_else(|| "Windows did not expose the brightness method.".to_string())?;
        let in_params = unsafe { in_signature.SpawnInstance(0) }
            .map_err(|error| hresult_error("Could not prepare the brightness change", &error))?;

        let mut brightness = uint8_variant(clamp_brightness(level) as u8);
        // A nonzero transition time is accepted by the built-in WMI provider on
        // this HP panel; zero can be rejected by firmware-backed providers.
        let mut timeout = uint32_variant(1);
        // IWbemClassObject::Put requires Type=0 for an existing property on an
        // instance; the property's CIM type is already fixed by the signature.
        unsafe { in_params.Put(w!("Brightness"), 0, &brightness, 0) }
            .map_err(|error| hresult_error("Could not set the brightness value", &error))?;
        unsafe { in_params.Put(w!("Timeout"), 0, &timeout, 0) }
            .map_err(|error| hresult_error("Could not set the brightness timeout", &error))?;

        let mut output: Option<IWbemClassObject> = None;
        let result = unsafe {
            services.ExecMethod(
                &BSTR::from(path.as_str()),
                &BSTR::from("WmiSetBrightness"),
                WBEM_GENERIC_FLAG_TYPE(0),
                None::<&IWbemContext>,
                &in_params,
                Some(&mut output),
                None,
            )
        }
        .map_err(|error| hresult_error("Windows could not apply the brightness change", &error));

        unsafe {
            let _ = VariantClear(&mut brightness);
            let _ = VariantClear(&mut timeout);
        }
        result?;
        if let Some(output) = output {
            let mut value = VARIANT::default();
            if unsafe { output.Get(w!("ReturnValue"), 0, &mut value, None, None) }.is_ok() {
                let succeeded = brightness_method_succeeded(&value);
                unsafe {
                    let _ = VariantClear(&mut value);
                }
                if succeeded == Some(false) {
                    return Err("Windows rejected the brightness change.".into());
                }
            }
        }
        // Some laptop WMI providers apply the request but omit ReturnValue from
        // the output object. A successful ExecMethod HRESULT is sufficient in
        // that case; the caller reads the effective level back for synchronization.
        Ok(())
    }

    pub(super) fn set_brightness(level: u32) -> Result<(), String> {
        let _com = com_apartment()?;
        let services = wmi_services()?;
        // Like the working Windows CIM flow, refresh the method instance once
        // if it went stale (for example after a display power transition).
        let mut last_error = None;
        for _ in 0..2 {
            match set_brightness_once(&services, level) {
                Ok(()) => return Ok(()),
                Err(error) => last_error = Some(error),
            }
        }
        Err(last_error.unwrap_or_else(|| "Windows could not apply the brightness change.".into()))
    }

    /* --------------------------------------------------------- night light */

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn read_registry_night_light() -> Result<Option<Vec<u8>>, String> {
        let key_wide = wide(NIGHT_LIGHT_KEY);
        let value_wide = wide(NIGHT_LIGHT_VALUE);
        let mut hkey = HKEY::default();
        if unsafe {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                PCWSTR(key_wide.as_ptr()),
                0,
                KEY_QUERY_VALUE,
                &mut hkey,
            )
        }
        .is_err()
        {
            return Ok(None);
        }
        let mut value_type = REG_VALUE_TYPE::default();
        let mut size = 0u32;
        let size_result = unsafe {
            RegQueryValueExW(
                hkey,
                PCWSTR(value_wide.as_ptr()),
                None,
                Some(&mut value_type),
                None,
                Some(&mut size),
            )
        };
        if size_result.is_err() || size == 0 {
            let _ = unsafe { RegCloseKey(hkey) };
            return Ok(None);
        }
        if size > 4096 {
            let _ = unsafe { RegCloseKey(hkey) };
            return Ok(None);
        }
        let mut buffer = vec![0u8; size as usize];
        let read_result = unsafe {
            RegQueryValueExW(
                hkey,
                PCWSTR(value_wide.as_ptr()),
                None,
                Some(&mut value_type),
                Some(buffer.as_mut_ptr()),
                Some(&mut size),
            )
        };
        let _ = unsafe { RegCloseKey(hkey) };
        read_result.map_err(|error| format!("Could not read Night light state: {error}"))?;
        buffer.truncate(size as usize);
        if value_type != REG_BINARY {
            return Ok(None);
        }
        Ok(Some(buffer))
    }

    fn write_registry_night_light(data: &[u8]) -> Result<(), String> {
        let key_wide = wide(NIGHT_LIGHT_KEY);
        let value_wide = wide(NIGHT_LIGHT_VALUE);
        let mut hkey = HKEY::default();
        unsafe {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                PCWSTR(key_wide.as_ptr()),
                0,
                KEY_QUERY_VALUE | KEY_SET_VALUE,
                &mut hkey,
            )
        }
        .map_err(|error| format!("Could not open the Night light state: {error}"))?;
        let result =
            unsafe { RegSetValueExW(hkey, PCWSTR(value_wide.as_ptr()), 0, REG_BINARY, Some(data)) };
        let _ = unsafe { RegCloseKey(hkey) };
        result.map_err(|error| format!("Could not write Night light state: {error}"))
    }

    pub(super) fn night_light_status() -> NightLightControl {
        match read_registry_night_light() {
            Ok(Some(data)) => match decode_night_light(&data) {
                Some(enabled) => NightLightControl {
                    supported: true,
                    enabled: Some(enabled),
                    best_effort: true,
                    error: None,
                },
                None => NightLightControl {
                    supported: false,
                    enabled: None,
                    best_effort: true,
                    error: Some("This Windows Night light format needs Windows Settings.".into()),
                },
            },
            Ok(None) => NightLightControl {
                supported: false,
                enabled: None,
                best_effort: true,
                error: Some("Night light is not configured on this PC.".into()),
            },
            Err(error) => NightLightControl {
                supported: false,
                enabled: None,
                best_effort: true,
                error: Some(short_error(&error)),
            },
        }
    }

    pub(super) fn set_night_light(enabled: bool) -> Result<(), String> {
        let data = match read_registry_night_light() {
            Ok(Some(data)) => data,
            Ok(None) => {
                return Err(
                    "Night light is not configured on this PC. Open Windows Night light once, then try again."
                        .into(),
                )
            }
            Err(error) => return Err(error),
        };
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or(0);
        let updated = apply_night_light(&data, enabled, now).ok_or_else(|| {
            "Windows Night light layout is unexpected; the state was left unchanged.".to_string()
        })?;
        write_registry_night_light(&updated)?;
        if read_registry_night_light()?
            .as_deref()
            .and_then(decode_night_light)
            != Some(enabled)
        {
            return Err("Windows did not retain the Night light preference.".into());
        }
        Ok(())
    }

    /* ------------------------------------------------------ registry helpers */

    fn read_hkcu_dword(subkey: &str, name: &str) -> Option<u32> {
        let subkey = wide(subkey);
        let name = wide(name);
        let mut data = 0u32;
        let mut size = std::mem::size_of::<u32>() as u32;
        unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                PCWSTR(subkey.as_ptr()),
                PCWSTR(name.as_ptr()),
                RRF_RT_REG_DWORD,
                None,
                Some((&mut data as *mut u32).cast::<c_void>()),
                Some(&mut size),
            )
        }
        .ok()?;
        Some(data)
    }

    fn write_hkcu_dword(subkey: &str, name: &str, value: u32) -> Result<(), String> {
        let subkey = wide(subkey);
        let name = wide(name);
        let mut hkey = HKEY::default();
        unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                PCWSTR(subkey.as_ptr()),
                0,
                PCWSTR::null(),
                REG_OPTION_NON_VOLATILE,
                KEY_SET_VALUE,
                None,
                &mut hkey,
                None,
            )
        }
        .map_err(|error| hresult_error("Could not open the Windows setting", &error))?;
        let bytes = value.to_le_bytes();
        let result =
            unsafe { RegSetValueExW(hkey, PCWSTR(name.as_ptr()), 0, REG_DWORD, Some(&bytes)) };
        let _ = unsafe { RegCloseKey(hkey) };
        result.map_err(|error| hresult_error("Could not write the Windows setting", &error))
    }

    /* -------------------------------------------------- do not disturb */

    /// Focus assist / quiet hours profile from the shell's WNF state (0 = off).
    fn wnf_quiet_hours_profile() -> Option<i32> {
        let mut state_name = WNF_QUIETHOURS_PROFILE;
        let mut change_stamp = 0u32;
        let mut buffer = [0u8; 8];
        let mut size = buffer.len() as u32;
        let status = unsafe {
            NtQueryWnfStateData(
                &mut state_name,
                std::ptr::null(),
                std::ptr::null(),
                &mut change_stamp,
                buffer.as_mut_ptr(),
                &mut size,
            )
        };
        if status != 0 || size != 4 {
            return None;
        }
        let value = i32::from_ne_bytes([buffer[0], buffer[1], buffer[2], buffer[3]]);
        (0..=2).contains(&value).then_some(value)
    }

    fn wnf_set_quiet_hours_profile(value: i32) -> i32 {
        let state_name = WNF_QUIETHOURS_PROFILE;
        let bytes = value.to_ne_bytes();
        unsafe {
            NtUpdateWnfStateData(
                &state_name,
                bytes.as_ptr(),
                bytes.len() as u32,
                std::ptr::null(),
                std::ptr::null(),
                0,
                0,
            )
        }
    }

    pub(super) fn do_not_disturb_status() -> DoNotDisturbControl {
        // Windows 11 keeps the Do Not Disturb switch in the registry (0 means toasts are
        // silenced). Older builds only have the Focus assist WNF state. Either one counts.
        let toasts_off = read_hkcu_dword(NOTIFICATIONS_KEY, TOASTS_ENABLED_VALUE) == Some(0);
        let focus_assist = wnf_quiet_hours_profile().is_some_and(|profile| profile != 0);
        DoNotDisturbControl {
            supported: true,
            enabled: Some(toasts_off || focus_assist),
            best_effort: true,
            error: None,
        }
    }

    /// Raw global toast switch (`NOC_GLOBAL_SETTING_TOASTS_ENABLED`); None when unset.
    pub(super) fn banner_value_read() -> Option<u32> {
        read_hkcu_dword(NOTIFICATIONS_KEY, TOASTS_ENABLED_VALUE)
    }

    pub(super) fn banner_value_write(value: u32) -> Result<(), String> {
        write_hkcu_dword(NOTIFICATIONS_KEY, TOASTS_ENABLED_VALUE, value)
    }

    pub(super) fn set_do_not_disturb(enabled: bool) -> Result<(), String> {
        write_hkcu_dword(
            NOTIFICATIONS_KEY,
            TOASTS_ENABLED_VALUE,
            if enabled { 0 } else { 1 },
        )?;
        // Keep the Focus assist state in step where Windows still has it. Failure here is
        // not fatal; the verification below decides whether the change took.
        if wnf_quiet_hours_profile().is_some() {
            let _ = wnf_set_quiet_hours_profile(i32::from(enabled));
        }
        for _ in 0..5 {
            if do_not_disturb_status().enabled == Some(enabled) {
                return Ok(());
            }
            std::thread::sleep(std::time::Duration::from_millis(120));
        }
        Err("Windows did not confirm the Do Not Disturb change.".into())
    }

    /* ----------------------------------------------------------------- theme */

    pub(super) fn theme_status() -> ToggleControl {
        let apps = read_hkcu_dword(PERSONALIZE_KEY, "AppsUseLightTheme");
        let system = read_hkcu_dword(PERSONALIZE_KEY, "SystemUsesLightTheme");
        // Windows treats a missing value as the light theme.
        let light = apps.or(system).map_or(true, |value| value != 0);
        ToggleControl {
            supported: true,
            enabled: Some(!light),
            best_effort: false,
            read_only: false,
            error: None,
        }
    }

    pub(super) fn set_dark_mode(enabled: bool) -> Result<(), String> {
        let value = if enabled { 0 } else { 1 };
        write_hkcu_dword(PERSONALIZE_KEY, "AppsUseLightTheme", value)?;
        write_hkcu_dword(PERSONALIZE_KEY, "SystemUsesLightTheme", value)?;
        // Tell running apps and the shell to re-read the colour mode.
        let setting = wide("ImmersiveColorSet");
        let mut broadcast_result = 0usize;
        unsafe {
            SendMessageTimeoutW(
                HWND_BROADCAST,
                WM_SETTINGCHANGE,
                WPARAM(0),
                LPARAM(setting.as_ptr() as isize),
                SMTO_ABORTIFHUNG,
                500,
                Some(&mut broadcast_result),
            );
        }
        if theme_status().enabled != Some(enabled) {
            return Err("Windows did not keep the theme change.".into());
        }
        Ok(())
    }

    /* --------------------------------------------------------- battery saver */

    pub(super) fn battery_saver_status() -> ToggleControl {
        let mut status = SYSTEM_POWER_STATUS::default();
        if unsafe { GetSystemPowerStatus(&mut status) }.is_err() {
            return ToggleControl::unavailable("Windows did not report the battery state.");
        }
        // 128 = no system battery, 255 = unknown.
        if status.BatteryFlag == 128 || status.BatteryFlag == 255 {
            return ToggleControl::unavailable("This PC has no battery.");
        }
        ToggleControl {
            supported: true,
            enabled: Some(status.SystemStatusFlag == 1),
            best_effort: false,
            // Windows offers no public way for an app to switch Energy Saver.
            read_only: true,
            error: None,
        }
    }

    /* --------------------------------------------------------------- radios */

    fn all_radios() -> Result<Vec<Radio>, String> {
        let radios = Radio::GetRadiosAsync()
            .map_err(|error| hresult_error("Could not list the wireless radios", &error))?
            .get()
            .map_err(|error| hresult_error("Could not read the wireless radios", &error))?;
        let mut list = Vec::new();
        for index in 0..radios.Size().unwrap_or(0) {
            if let Ok(radio) = radios.GetAt(index) {
                list.push(radio);
            }
        }
        Ok(list)
    }

    /// (supported, enabled, error) for every radio of one kind.
    fn radio_kind_status(
        radios: &[Radio],
        kind: RadioKind,
        missing: &str,
    ) -> (bool, Option<bool>, Option<String>) {
        let states: Vec<RadioState> = radios
            .iter()
            .filter(|radio| radio.Kind().ok() == Some(kind))
            .filter_map(|radio| radio.State().ok())
            .collect();
        if states.is_empty() {
            return (false, None, Some(missing.to_string()));
        }
        if states.iter().all(|state| *state == RadioState::Disabled) {
            return (
                false,
                Some(false),
                Some("A hardware switch or Device Manager has turned this radio off.".into()),
            );
        }
        (
            true,
            Some(states.iter().any(|state| *state == RadioState::On)),
            None,
        )
    }

    fn is_airplane_kind(kind: RadioKind) -> bool {
        AIRPLANE_KINDS.contains(&kind)
    }

    /// Airplane mode is "every wireless radio is off", which is exactly what Windows
    /// does when you switch it on, and it keeps working whichever app changed it.
    fn airplane_from(radios: &[Radio]) -> ToggleControl {
        let states: Vec<RadioState> = radios
            .iter()
            .filter(|radio| radio.Kind().ok().is_some_and(is_airplane_kind))
            .filter_map(|radio| radio.State().ok())
            .collect();
        if states.is_empty() {
            return ToggleControl::unavailable("No wireless radios were found on this PC.");
        }
        ToggleControl {
            supported: true,
            enabled: Some(states.iter().all(|state| *state != RadioState::On)),
            best_effort: true,
            read_only: false,
            error: None,
        }
    }

    pub(super) fn radio_snapshot() -> (BluetoothControl, ToggleControl, ToggleControl) {
        let failed = |error: String| {
            let short = short_error(&error);
            (
                BluetoothControl {
                    supported: false,
                    enabled: None,
                    error: Some(short.clone()),
                },
                ToggleControl::unavailable(short.clone()),
                ToggleControl::unavailable(short),
            )
        };
        let _com = match com_apartment() {
            Ok(apartment) => apartment,
            Err(error) => return failed(error),
        };
        let radios = match all_radios() {
            Ok(radios) => radios,
            Err(error) => return failed(error),
        };
        let (bt_supported, bt_enabled, bt_error) = radio_kind_status(
            &radios,
            RadioKind::Bluetooth,
            "No Bluetooth radio is available on this PC.",
        );
        let (wifi_supported, wifi_enabled, wifi_error) = radio_kind_status(
            &radios,
            RadioKind::WiFi,
            "No Wi-Fi adapter is available on this PC.",
        );
        (
            BluetoothControl {
                supported: bt_supported,
                enabled: bt_enabled,
                error: bt_error,
            },
            ToggleControl {
                supported: wifi_supported,
                enabled: wifi_enabled,
                best_effort: false,
                read_only: false,
                error: wifi_error,
            },
            airplane_from(&radios),
        )
    }

    #[cfg(test)]
    pub(super) fn bluetooth_status() -> BluetoothControl {
        radio_snapshot().0
    }

    /// Asks Windows once for permission to change radios. Only a grant is cached, so a
    /// permission fixed in Settings works on the next try.
    fn ensure_radio_access(app: &tauri::AppHandle) -> Result<(), String> {
        let access_cache = RADIO_ACCESS.get_or_init(|| Mutex::new(None));
        let mut access = access_cache
            .lock()
            .map_err(|_| "Radio access state is unavailable.".to_string())?;
        let granted = match *access {
            Some(status) => status,
            None => {
                let (sender, receiver) = std::sync::mpsc::channel();
                app.run_on_main_thread(move || {
                    let _ = sender.send(Radio::RequestAccessAsync());
                })
                .map_err(|error| {
                    format!("Could not request radio access on the UI thread: {error}")
                })?;
                let operation = receiver
                    .recv_timeout(std::time::Duration::from_secs(10))
                    .map_err(|_| "Radio access request could not reach the UI thread.".to_string())?
                    .map_err(|error| hresult_error("Could not request radio control access", &error))?;
                let status = operation.get().map_err(|error| {
                    hresult_error("Could not finish the radio access request", &error)
                })?;
                if status == RadioAccessStatus::Allowed {
                    *access = Some(status);
                }
                status
            }
        };
        drop(access);
        if granted == RadioAccessStatus::Allowed {
            return Ok(());
        }
        Err(match granted {
            RadioAccessStatus::DeniedByUser => {
                "Windows denied radio control. Check app permissions in Settings.".into()
            }
            RadioAccessStatus::DeniedBySystem => {
                "Windows policy does not allow this app to control radios.".into()
            }
            _ => "Windows did not grant radio control access.".to_string(),
        })
    }

    fn apply_radio_state(radio: &Radio, target: RadioState) -> Result<(), String> {
        let current = radio.State().ok();
        if current == Some(target) {
            return Ok(());
        }
        if current == Some(RadioState::Disabled) {
            return Err("A hardware switch or Device Manager has turned this radio off.".into());
        }
        let result = radio
            .SetStateAsync(target)
            .map_err(|error| hresult_error("Could not change the radio state", &error))?
            .get()
            .map_err(|error| hresult_error("Could not finish changing the radio state", &error))?;
        if result != RadioAccessStatus::Allowed {
            return Err(format!("Windows did not apply the radio change ({result:?})."));
        }
        Ok(())
    }

    fn set_radio_kind(
        kind: RadioKind,
        enabled: bool,
        app: &tauri::AppHandle,
        missing: &str,
    ) -> Result<(), String> {
        let _com = com_apartment()?;
        let target = if enabled { RadioState::On } else { RadioState::Off };
        // Check for the adapter first so a missing one is not reported as a permission issue.
        let radios = all_radios()?;
        if !radios.iter().any(|radio| radio.Kind().ok() == Some(kind)) {
            return Err(missing.to_string());
        }
        ensure_radio_access(app)?;
        for radio in radios.iter().filter(|radio| radio.Kind().ok() == Some(kind)) {
            apply_radio_state(radio, target)?;
        }
        // Some drivers report the new state a moment after the call returns.
        for _ in 0..15 {
            let (_, now, _) = radio_kind_status(&all_radios()?, kind, missing);
            if now == Some(enabled) {
                return Ok(());
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        Err("Windows did not confirm the requested radio state.".into())
    }

    pub(super) fn set_bluetooth_radio(
        enabled: bool,
        app: tauri::AppHandle,
    ) -> Result<bool, String> {
        set_radio_kind(
            RadioKind::Bluetooth,
            enabled,
            &app,
            "No Bluetooth radio is available on this PC.",
        )?;
        Ok(enabled)
    }

    pub(super) fn set_wifi_radio(enabled: bool, app: tauri::AppHandle) -> Result<bool, String> {
        set_radio_kind(
            RadioKind::WiFi,
            enabled,
            &app,
            "No Wi-Fi adapter is available on this PC.",
        )?;
        Ok(enabled)
    }

    pub(super) fn set_airplane_mode(enabled: bool, app: tauri::AppHandle) -> Result<bool, String> {
        let _com = com_apartment()?;
        let radios = all_radios()?;
        let considered: Vec<&Radio> = radios
            .iter()
            .filter(|radio| radio.Kind().ok().is_some_and(is_airplane_kind))
            .collect();
        if considered.is_empty() {
            return Err("No wireless radios were found on this PC.".into());
        }
        ensure_radio_access(&app)?;
        let mut first_error: Option<String> = None;
        if enabled {
            let on_kinds: Vec<i32> = considered
                .iter()
                .filter(|radio| radio.State().ok() == Some(RadioState::On))
                .filter_map(|radio| radio.Kind().ok())
                .map(|kind| kind.0)
                .collect();
            if !on_kinds.is_empty() {
                if let Ok(mut slot) = AIRPLANE_RESTORE.lock() {
                    *slot = on_kinds;
                }
            }
            for radio in &considered {
                if let Err(error) = apply_radio_state(radio, RadioState::Off) {
                    first_error.get_or_insert(error);
                }
            }
        } else {
            let remembered = AIRPLANE_RESTORE
                .lock()
                .map(|mut slot| std::mem::take(&mut *slot))
                .unwrap_or_default();
            for radio in &considered {
                let kind = radio.Kind().map(|kind| kind.0).unwrap_or(-1);
                if !remembered.is_empty() && !remembered.contains(&kind) {
                    continue;
                }
                if let Err(error) = apply_radio_state(radio, RadioState::On) {
                    first_error.get_or_insert(error);
                }
            }
        }
        for _ in 0..15 {
            if airplane_from(&all_radios()?).enabled == Some(enabled) {
                return Ok(enabled);
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        Err(first_error
            .unwrap_or_else(|| "Windows did not confirm the requested Airplane mode state.".into()))
    }

    pub(super) fn open_bluetooth_settings() -> Result<(), String> {
        let result = unsafe {
            ShellExecuteW(
                HWND::default(),
                w!("open"),
                w!("ms-settings:bluetooth"),
                PCWSTR::null(),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            )
        };
        if result.0 <= 32 {
            Err("Windows could not open Bluetooth settings.".into())
        } else {
            // A deliberate Settings trip is the recovery path for a previously denied
            // request. The next radio change can check the updated user consent once.
            if let Some(cache) = RADIO_ACCESS.get() {
                if let Ok(mut access) = cache.lock() {
                    *access = None;
                }
            }
            Ok(())
        }
    }

    pub(super) fn open_power_settings() -> Result<(), String> {
        let result = unsafe {
            ShellExecuteW(
                HWND::default(),
                w!("open"),
                w!("ms-settings:batterysaver"),
                PCWSTR::null(),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            )
        };
        if result.0 <= 32 {
            Err("Windows could not open power settings.".into())
        } else {
            Ok(())
        }
    }

    pub(super) fn open_night_light_settings() -> Result<(), String> {
        let result = unsafe {
            ShellExecuteW(
                HWND::default(),
                w!("open"),
                w!("ms-settings:nightlight"),
                PCWSTR::null(),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            )
        };
        if result.0 <= 32 {
            Err("Windows could not open Night Light settings.".into())
        } else {
            Ok(())
        }
    }

    /* ---------------------------------------------------------- power mode */

    pub(super) fn power_mode_status() -> PowerModeControl {
        match read_power_modes() {
            Ok((ac, dc)) => {
                let active = ac == BEST_EFFICIENCY || dc == BEST_EFFICIENCY;
                let can_restore = RESTORE_MODE
                    .get()
                    .and_then(|slot| slot.lock().ok())
                    .is_some_and(|value| value.is_some());
                PowerModeControl {
                    active_name: Some(if ac == dc {
                        power_mode_name(ac)
                    } else {
                        "Different for plugged-in and battery".into()
                    }),
                    supported: true,
                    best_efficiency_active: active,
                    can_restore_previous: can_restore,
                    error: None,
                }
            }
            Err(error) => PowerModeControl {
                active_name: None,
                supported: false,
                best_efficiency_active: false,
                can_restore_previous: false,
                error: Some(short_error(&error)),
            },
        }
    }

    pub(super) fn set_power_saver_plan(enabled: bool) -> Result<(), String> {
        let _operation = POWER_OPERATION
            .lock()
            .map_err(|_| "Windows power-mode control is unavailable.".to_string())?;
        let (ac, dc) = read_power_modes()?;
        let restore = RESTORE_MODE.get_or_init(|| Mutex::new(None));
        if enabled {
            if ac == BEST_EFFICIENCY && dc == BEST_EFFICIENCY {
                return Ok(());
            }
            *restore
                .lock()
                .map_err(|_| "Power-mode restore state is unavailable.".to_string())? =
                Some((ac, dc));
            if let Err(error) = write_power_modes(&BEST_EFFICIENCY, &BEST_EFFICIENCY, &ac) {
                if let Ok(mut slot) = restore.lock() {
                    *slot = None;
                }
                return Err(error);
            }
            Ok(())
        } else {
            let previous = restore
                .lock()
                .map_err(|_| "Power-mode restore state is unavailable.".to_string())?
                .as_ref()
                .copied();
            let Some(previous) = previous else {
                if ac == BEST_EFFICIENCY || dc == BEST_EFFICIENCY {
                    return Err("Best power efficiency is active, but this app has no previous mode to restore. Choose a mode in Windows Settings.".into());
                }
                return Ok(());
            };
            if ac != BEST_EFFICIENCY || dc != BEST_EFFICIENCY {
                if let Ok(mut slot) = restore.lock() {
                    *slot = None;
                }
                return Err("Windows power mode changed elsewhere; it was left unchanged.".into());
            }
            match write_power_modes(&previous.0, &previous.1, &BEST_EFFICIENCY) {
                Ok(()) => {
                    if let Ok(mut slot) = restore.lock() {
                        *slot = None;
                    }
                    Ok(())
                }
                Err(error) => Err(format!(
                    "Could not restore the previous Windows power mode: {error}"
                )),
            }
        }
    }

    pub(super) fn restore_previous_power_plan() -> Result<(), String> {
        let _operation = POWER_OPERATION
            .lock()
            .map_err(|_| "Windows power-mode control is unavailable.".to_string())?;
        let restore = RESTORE_MODE.get_or_init(|| Mutex::new(None));
        let previous = restore
            .lock()
            .map_err(|_| "Power-mode restore state is unavailable.".to_string())?
            .as_ref()
            .copied();
        let Some(previous) = previous else {
            return Ok(());
        };
        let active = match read_power_modes() {
            Ok(active) => active,
            Err(error) => {
                return Err(error);
            }
        };
        if active.0 != BEST_EFFICIENCY || active.1 != BEST_EFFICIENCY {
            // Respect a mode change made by the user or another app after ours.
            if let Ok(mut slot) = restore.lock() {
                *slot = None;
            }
            return Ok(());
        }
        match write_power_modes(&previous.0, &previous.1, &BEST_EFFICIENCY) {
            Ok(()) => {
                if let Ok(mut slot) = restore.lock() {
                    *slot = None;
                }
                Ok(())
            }
            Err(error) => Err(format!(
                "Could not restore the previous Windows power mode: {error}"
            )),
        }
    }

    fn power_mode_name(mode: GUID) -> String {
        if mode == BEST_EFFICIENCY {
            "Best power efficiency".into()
        } else if mode == GUID::default() {
            "Balanced".into()
        } else if mode
            == GUID::from_values(
                0xDED574B5,
                0x45A0,
                0x4F42,
                [0x87, 0x34, 0x46, 0x34, 0x5C, 0x09, 0xC2, 0x38],
            )
        {
            "Best performance".into()
        } else {
            "Custom Windows power mode".into()
        }
    }

    #[cfg(test)]
    mod tests {
        use super::{
            brightness_method_succeeded, power_mode_name, uint32_variant, uint8_variant,
            BEST_EFFICIENCY,
        };
        use std::mem::ManuallyDrop;
        use windows::core::GUID;
        use windows::Win32::Foundation::{VARIANT_BOOL, VARIANT_TRUE};
        use windows::Win32::System::Variant::{
            VARIANT, VARIANT_0_0, VARIANT_0_0_0, VT_BOOL, VT_I4, VT_UI1,
        };

        fn bool_variant(value: VARIANT_BOOL) -> VARIANT {
            let mut variant = VARIANT::default();
            variant.Anonymous.Anonymous = ManuallyDrop::new(VARIANT_0_0 {
                vt: VT_BOOL,
                wReserved1: 0,
                wReserved2: 0,
                wReserved3: 0,
                Anonymous: VARIANT_0_0_0 { boolVal: value },
            });
            variant
        }

        #[test]
        fn brightness_method_accepts_boolean_and_numeric_wmi_success() {
            assert_eq!(
                brightness_method_succeeded(&bool_variant(VARIANT_TRUE)),
                Some(true)
            );
            assert_eq!(
                brightness_method_succeeded(&bool_variant(VARIANT_BOOL(0))),
                Some(false)
            );
            assert_eq!(brightness_method_succeeded(&uint32_variant(0)), Some(true));
            assert_eq!(brightness_method_succeeded(&uint32_variant(5)), Some(false));
        }

        #[test]
        fn brightness_input_variants_match_wmi_automation_types() {
            let brightness = uint8_variant(73);
            assert_eq!(unsafe { brightness.Anonymous.Anonymous.vt }, VT_UI1);
            assert_eq!(unsafe { brightness.Anonymous.Anonymous.Anonymous.bVal }, 73);

            let timeout = uint32_variant(1);
            assert_eq!(unsafe { timeout.Anonymous.Anonymous.vt }, VT_I4);
            assert_eq!(unsafe { timeout.Anonymous.Anonymous.Anonymous.lVal }, 1);
        }

        #[test]
        fn known_power_modes_map_to_labels() {
            assert_eq!(power_mode_name(BEST_EFFICIENCY), "Best power efficiency");
            assert_eq!(power_mode_name(GUID::default()), "Balanced");
            assert_eq!(
                power_mode_name(GUID::from_values(
                    0xDED574B5,
                    0x45A0,
                    0x4F42,
                    [0x87, 0x34, 0x46, 0x34, 0x5C, 0x09, 0xC2, 0x38],
                )),
                "Best performance"
            );
            assert_eq!(
                power_mode_name(GUID::from_values(1, 2, 3, [4, 5, 6, 7, 8, 9, 10, 11])),
                "Custom Windows power mode"
            );
        }

        #[test]
        #[ignore = "read-only Windows hardware/system smoke check"]
        fn windows_quick_controls_snapshot_is_coherent() {
            let volume = super::volume_status();
            let brightness = super::brightness_status();
            let bluetooth = super::bluetooth_status();
            let power = super::power_mode_status();
            assert!(!volume.supported || volume.level.is_some());
            assert!(!brightness.supported || brightness.level.is_some());
            assert!(bluetooth.enabled.is_none() || bluetooth.supported);
            assert!(!power.best_efficiency_active || power.supported);
            println!(
                "Volume supported={}, level={:?}, muted={:?}; brightness supported={}, level={:?}; bluetooth enabled={:?}; power mode={:?}",
                volume.supported,
                volume.level,
                volume.muted,
                brightness.supported,
                brightness.level,
                bluetooth.enabled,
                power.active_name
            );
        }

        #[test]
        #[ignore = "Windows hardware smoke check; moves brightness by one point and restores it"]
        fn brightness_setter_round_trip_restores_original_level() {
            use super::{brightness_status, set_brightness};
            use std::thread;
            use std::time::Duration;

            let current = brightness_status()
                .level
                .expect("active display should expose a brightness level");
            let target = if current < 100 {
                current + 1
            } else {
                current - 1
            };
            let changed = set_brightness(target).and_then(|_| {
                for _ in 0..20 {
                    if brightness_status().level == Some(target) {
                        return Ok(());
                    }
                    thread::sleep(Duration::from_millis(100));
                }
                Err(format!("brightness did not reach {target}%"))
            });

            // Restore even when the target could not be verified.
            let restored = set_brightness(current).and_then(|_| {
                for _ in 0..20 {
                    if brightness_status().level == Some(current) {
                        return Ok(());
                    }
                    thread::sleep(Duration::from_millis(100));
                }
                Err(format!("brightness did not return to {current}%"))
            });
            restored.expect("restore original display brightness");
            changed.expect("verify the one-point brightness change");
        }

        #[test]
        #[ignore = "hardware smoke check; changes the system volume and restores it"]
        fn volume_round_trip() {
            use super::{set_master_volume, volume_status};
            let Some(original) = volume_status().level else {
                return;
            };
            let target = if original > 50 { 25 } else { 75 };
            set_master_volume(f64::from(target)).expect("set volume");
            let observed = volume_status().level.expect("read back volume");
            assert!(observed.abs_diff(target) <= 2, "observed {observed}");
            set_master_volume(f64::from(original)).expect("restore volume");
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod platform {
    use super::{
        BluetoothControl, BrightnessControl, DoNotDisturbControl, NightLightControl,
        PowerModeControl, ToggleControl, VolumeControl,
    };

    const UNAVAILABLE: &str = "Controls are available only on Windows.";

    pub(super) fn volume_status() -> VolumeControl {
        VolumeControl {
            supported: false,
            level: None,
            muted: None,
            error: Some(UNAVAILABLE.into()),
        }
    }
    pub(super) fn set_master_volume(_: f64) -> Result<(), String> {
        Err(UNAVAILABLE.into())
    }
    pub(super) fn set_mute(_: bool) -> Result<(), String> {
        Err(UNAVAILABLE.into())
    }
    pub(super) fn brightness_status() -> BrightnessControl {
        BrightnessControl {
            supported: false,
            level: None,
            error: Some(UNAVAILABLE.into()),
        }
    }
    pub(super) fn set_brightness(_: u32) -> Result<(), String> {
        Err(UNAVAILABLE.into())
    }
    pub(super) fn radio_snapshot() -> (BluetoothControl, ToggleControl, ToggleControl) {
        (
            BluetoothControl {
                supported: false,
                enabled: None,
                error: Some(UNAVAILABLE.into()),
            },
            ToggleControl::unavailable(UNAVAILABLE),
            ToggleControl::unavailable(UNAVAILABLE),
        )
    }
    pub(super) fn theme_status() -> ToggleControl {
        ToggleControl::unavailable(UNAVAILABLE)
    }
    pub(super) fn battery_saver_status() -> ToggleControl {
        ToggleControl::unavailable(UNAVAILABLE)
    }
    pub(super) fn set_wifi_radio(_: bool, _: tauri::AppHandle) -> Result<bool, String> {
        Err(UNAVAILABLE.into())
    }
    pub(super) fn set_airplane_mode(_: bool, _: tauri::AppHandle) -> Result<bool, String> {
        Err(UNAVAILABLE.into())
    }
    pub(super) fn set_dark_mode(_: bool) -> Result<(), String> {
        Err(UNAVAILABLE.into())
    }
    pub(super) fn power_mode_status() -> PowerModeControl {
        PowerModeControl {
            active_name: None,
            supported: false,
            best_efficiency_active: false,
            can_restore_previous: false,
            error: Some(UNAVAILABLE.into()),
        }
    }
    pub(super) fn night_light_status() -> NightLightControl {
        NightLightControl {
            supported: false,
            enabled: None,
            best_effort: true,
            error: Some(UNAVAILABLE.into()),
        }
    }
    pub(super) fn set_night_light(_: bool) -> Result<(), String> {
        Err(UNAVAILABLE.into())
    }
    pub(super) fn do_not_disturb_status() -> DoNotDisturbControl {
        DoNotDisturbControl {
            supported: false,
            enabled: None,
            best_effort: true,
            error: Some(UNAVAILABLE.into()),
        }
    }
    pub(super) fn set_do_not_disturb(_: bool) -> Result<(), String> {
        Err(UNAVAILABLE.into())
    }
    pub(super) fn banner_value_read() -> Option<u32> {
        None
    }
    pub(super) fn banner_value_write(_: u32) -> Result<(), String> {
        Err(UNAVAILABLE.into())
    }
    pub(super) fn open_night_light_settings() -> Result<(), String> {
        Err("Night Light settings are available only on Windows.".into())
    }
    pub(super) fn open_bluetooth_settings() -> Result<(), String> {
        Err("Bluetooth settings are available only on Windows.".into())
    }
    pub(super) fn open_power_settings() -> Result<(), String> {
        Err("Power settings are available only on Windows.".into())
    }
    pub(super) fn set_power_saver_plan(_: bool) -> Result<(), String> {
        Err(UNAVAILABLE.into())
    }
    pub(super) fn restore_previous_power_plan() -> Result<(), String> {
        Ok(())
    }
    pub(super) fn set_bluetooth_radio(_: bool, _: tauri::AppHandle) -> Result<bool, String> {
        Err(UNAVAILABLE.into())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        apply_night_light, clamp_brightness, clamp_volume, decode_night_light, windows_settings_uri,
    };

    #[test]
    fn settings_recovery_only_opens_known_windows_pages() {
        assert_eq!(windows_settings_uri("sound").unwrap(), "ms-settings:sound");
        assert_eq!(
            windows_settings_uri("display").unwrap(),
            "ms-settings:display"
        );
        assert_eq!(
            windows_settings_uri("notifications").unwrap(),
            "ms-settings:notifications"
        );
        assert_eq!(
            windows_settings_uri("notification-access").unwrap(),
            "ms-settings:privacy-notifications"
        );
        assert_eq!(
            windows_settings_uri("bluetooth").unwrap(),
            "ms-settings:bluetooth"
        );
        assert_eq!(
            windows_settings_uri("airplane").unwrap(),
            "ms-settings:network-airplanemode"
        );
        assert_eq!(windows_settings_uri("colors").unwrap(), "ms-settings:colors");
        assert!(windows_settings_uri("file:///C:/anything").is_err());
        assert!(windows_settings_uri("ms-settings:privacy").is_err());
    }

    #[test]
    fn volume_is_clamped_and_rejects_non_finite_values() {
        assert_eq!(clamp_volume(-40.0), 0.0);
        assert_eq!(clamp_volume(0.0), 0.0);
        assert_eq!(clamp_volume(37.5), 37.5);
        assert_eq!(clamp_volume(150.0), 100.0);
        assert_eq!(clamp_volume(f64::NAN), 0.0);
        assert_eq!(clamp_volume(f64::INFINITY), 0.0);
    }

    #[test]
    fn brightness_is_clamped() {
        assert_eq!(clamp_brightness(0), 0);
        assert_eq!(clamp_brightness(55), 55);
        assert_eq!(clamp_brightness(100), 100);
        assert_eq!(clamp_brightness(250), 100);
    }

    fn night_light_blob(on: bool) -> Vec<u8> {
        // Read-only snapshot of this HP's Windows 11 26300 state record with
        // Night light off. Its original status is 0x12 and it already contains
        // the nested 0x10,0x00 marker at byte 23.
        let off = vec![
            0x43, 0x42, 0x01, 0x00, 0x0a, 0x02, 0x01, 0x00, 0x2a, 0x06, 0xea, 0xe3, 0xc0, 0xd6,
            0x06, 0x2a, 0x2b, 0x0e, 0x12, 0x43, 0x42, 0x01, 0x00, 0x10, 0x00, 0xc6, 0x14, 0xcf,
            0xeb, 0xad, 0xef, 0xfd, 0x88, 0xd7, 0xee, 0x01, 0x00, 0x00, 0x00, 0x00,
        ];
        if on {
            apply_night_light(&off, true, 1_700_000_000).expect("known record turns on")
        } else {
            off
        }
    }

    #[test]
    fn night_light_state_is_decoded_from_status_byte() {
        assert_eq!(decode_night_light(&night_light_blob(true)), Some(true));
        assert_eq!(decode_night_light(&night_light_blob(false)), Some(false));
        assert_eq!(decode_night_light(&[0u8; 10]), None);
    }

    #[test]
    fn night_light_toggle_round_trips() {
        let off = night_light_blob(false);
        let on = apply_night_light(&off, true, 1_700_000_000).expect("turn on");
        assert_eq!(decode_night_light(&on), Some(true));
        assert_eq!(&on[23..27], &[0x10, 0x00, 0x10, 0x00]);

        let back_off = apply_night_light(&on, false, 1_700_000_100).expect("turn off");
        assert_eq!(decode_night_light(&back_off), Some(false));
        assert_eq!(back_off.len(), off.len());
        // Only the timestamp and the status byte change across the round trip.
        assert_eq!(&back_off[15..18], &off[15..18]);
        assert_eq!(&back_off[19..], &off[19..]);
        assert_eq!(back_off[18], 0x13);
    }

    #[test]
    fn night_light_toggle_is_idempotent_and_refuses_unknown_layout() {
        let on = night_light_blob(true);
        assert_eq!(apply_night_light(&on, true, 5), Some(on));

        // Unexpected layout while turning off must not guess.
        let mut weird = night_light_blob(true);
        weird[23] = 0x99;
        assert_eq!(apply_night_light(&weird, false, 5), None);
        assert_eq!(apply_night_light(&[0u8; 4], true, 5), None);
        let mut unknown = night_light_blob(false);
        unknown[19] = 0x99;
        assert_eq!(decode_night_light(&unknown), None);
        assert_eq!(apply_night_light(&unknown, true, 5), None);
    }

    #[test]
    fn night_light_timestamp_advances() {
        let off = night_light_blob(false);
        let on = apply_night_light(&off, true, 1_700_000_000).unwrap();
        let mut timestamp: u64 = 0;
        for index in 0..5 {
            timestamp |= ((on[10 + index] & 0x7F) as u64) << (7 * index);
        }
        assert!(timestamp >= 1_700_000_000);
    }
}
