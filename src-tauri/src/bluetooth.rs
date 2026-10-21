//! Paired Bluetooth device inventory and explicitly requested device actions.
//!
//! The frontend receives opaque SHA-256 keys rather than Windows device IDs.
//! Pairing is delegated to Windows Settings; forgetting always requires an
//! explicit in-app confirmation. Audio endpoint connect/disconnect uses the
//! documented Bluetooth audio one-shot KS properties when the matching device
//! container and driver support can be verified.

use serde::Serialize;

const MAX_DEVICES: usize = 64;
const MAX_NAME_CHARS: usize = 128;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BluetoothDevice {
    /// Opaque key; the platform device identifier never leaves the native layer.
    pub id: String,
    pub name: String,
    pub kind: String,
    pub paired: bool,
    pub connected: Option<bool>,
    pub battery_pct: Option<u8>,
    pub can_connect: bool,
    pub can_disconnect: bool,
    pub can_unpair: bool,
    pub action_reason: Option<String>,
}

/// What one place we read devices from reported, so the UI can say why a list is empty.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BluetoothSourceReport {
    pub source: String,
    pub ok: bool,
    pub count: u32,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BluetoothSnapshot {
    pub devices: Vec<BluetoothDevice>,
    pub sources: Vec<BluetoothSourceReport>,
    /// Set only when no device was found and at least one source failed.
    pub error: Option<String>,
}

#[tauri::command]
pub async fn bluetooth_devices_snapshot() -> Result<BluetoothSnapshot, String> {
    tauri::async_runtime::spawn_blocking(platform::snapshot)
        .await
        .map_err(|error| format!("Bluetooth list worker failed: {error}"))
}

#[tauri::command]
pub async fn bluetooth_devices_list() -> Result<Vec<BluetoothDevice>, String> {
    tauri::async_runtime::spawn_blocking(platform::list)
        .await
        .map_err(|error| format!("Bluetooth list worker failed: {error}"))?
}

#[tauri::command]
pub async fn bluetooth_connect(device_id: String) -> Result<BluetoothDevice, String> {
    tauri::async_runtime::spawn_blocking(move || platform::set_audio_connected(&device_id, true))
        .await
        .map_err(|error| format!("Bluetooth connect worker failed: {error}"))?
}

#[tauri::command]
pub async fn bluetooth_disconnect(device_id: String) -> Result<BluetoothDevice, String> {
    tauri::async_runtime::spawn_blocking(move || platform::set_audio_connected(&device_id, false))
        .await
        .map_err(|error| format!("Bluetooth disconnect worker failed: {error}"))?
}

#[tauri::command]
pub async fn bluetooth_unpair(device_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || platform::unpair(&device_id))
        .await
        .map_err(|error| format!("Bluetooth forget worker failed: {error}"))?
}

#[tauri::command]
pub fn bluetooth_open_settings() -> Result<(), String> {
    platform::open_settings()
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{BluetoothDevice, BluetoothSnapshot, BluetoothSourceReport, MAX_DEVICES, MAX_NAME_CHARS};
    use sha2::{Digest, Sha256};
    use std::thread;
    use std::time::{Duration, Instant};
    use windows::core::{w, ComInterface, Error, GUID, HSTRING, PCWSTR, PWSTR};
    use windows::Devices::Bluetooth::{BluetoothDevice as ClassicDevice, BluetoothLEDevice};
    use std::collections::HashMap;
    use std::sync::Mutex;
    use windows::Devices::Enumeration::{
        DeviceInformation, DeviceInformationCollection, DeviceInformationKind,
        DeviceUnpairingResultStatus,
    };
    use windows::Foundation::Collections::IIterable;
    use windows::Foundation::{AsyncStatus, IAsyncInfo, IAsyncOperation, IPropertyValue};
    use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_ContainerId;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_LOCAL_MACHINE,
        KEY_READ, REG_VALUE_TYPE,
    };
    use windows::Win32::Media::Audio::{
        eRender, IDeviceTopology, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator,
    };
    use windows::Win32::Media::KernelStreaming::{
        IKsControl, KSPROPSETID_BtAudio, KSIDENTIFIER, KSIDENTIFIER_0, KSIDENTIFIER_0_0,
        KSPROPERTY_DESCRIPTION, KSPROPERTY_ONESHOT_DISCONNECT, KSPROPERTY_ONESHOT_RECONNECT,
        KSPROPERTY_TYPE_BASICSUPPORT, KSPROPERTY_TYPE_GET,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_APARTMENTTHREADED,
        COINIT_MULTITHREADED, STGM_READ,
    };
    use windows::Win32::System::Variant::VT_CLSID;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    const DEVICE_STATE_ACTIVE: u32 = 0x0000_0001;
    const DEVICE_STATE_UNPLUGGED: u32 = 0x0000_0008;
    const MAX_ASYNC_WAIT: Duration = Duration::from_secs(5);
    const ASYNC_POLL: Duration = Duration::from_millis(40);
    const VERIFY_WAIT: Duration = Duration::from_secs(6);
    /// Battery percentage published by Windows on the device node (byte, 0-100).
    const BATTERY_PROPERTY: &str = "{104EA319-6EE2-4701-BD47-8DDF94B2F95D} 2";
    /// Device setup class GUID shared by every Bluetooth device node.
    const BLUETOOTH_CLASS_FILTER: &str =
        "System.Devices.ClassGuid:=\"{e0cbf06c-cd8b-4647-bb8a-263b43f0f974}\"";
    const DEVICE_CONTAINER_PROPERTY: &str = "System.Devices.ContainerId";
    const MAX_CLASS_LOOKUPS: usize = 32;
    const CONNECTED_PROPERTY: &str = "System.Devices.Aep.IsConnected";
    const CONTAINER_PROPERTY: &str = "System.Devices.Aep.ContainerId";
    const PAIRED_PROPERTY: &str = "System.Devices.Aep.IsPaired";
    const ADDRESS_PROPERTY: &str = "System.Devices.Aep.DeviceAddress";
    /// Classic Bluetooth and Bluetooth LE protocol ids for association endpoints.
    const CLASSIC_AEP_FILTER: &str =
        "System.Devices.Aep.ProtocolId:=\"{e0cbf06c-cd8b-4647-bb8a-263b43f0f974}\"";
    const LE_AEP_FILTER: &str =
        "System.Devices.Aep.ProtocolId:=\"{bb7bb05e-5972-42b5-94fc-76eaa7084d49}\"";
    const BTHPORT_DEVICES_KEY: &str =
        "SYSTEM\\CurrentControlSet\\Services\\BTHPORT\\Parameters\\Devices";
    const BTHENUM_KEY: &str = "SYSTEM\\CurrentControlSet\\Enum\\BTHENUM";
    /// Total time the WinRT sources may spend before the rest are skipped.
    const SOURCE_BUDGET: Duration = Duration::from_secs(14);

    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe { windows::Win32::System::Com::CoUninitialize() };
        }
    }

    fn apartment(kind: windows::Win32::System::Com::COINIT) -> Result<Apartment, String> {
        unsafe { CoInitializeEx(None, kind) }
            .map_err(|error| hresult("COM initialization failed", &error))?;
        Ok(Apartment)
    }

    fn hresult(context: &str, error: &Error) -> String {
        format!("{context} (HRESULT 0x{:08X})", error.code().0 as u32)
    }

    fn bounded_get<T: windows::core::RuntimeType + 'static>(
        operation: IAsyncOperation<T>,
        context: &str,
    ) -> Result<T, String> {
        let info: IAsyncInfo = operation.cast().map_err(|error| hresult(context, &error))?;
        let deadline = Instant::now() + MAX_ASYNC_WAIT;
        loop {
            match info.Status().map_err(|error| hresult(context, &error))? {
                AsyncStatus::Completed => {
                    return operation.get().map_err(|error| hresult(context, &error));
                }
                AsyncStatus::Error => {
                    return Err(hresult(
                        context,
                        &Error::from(info.ErrorCode().unwrap_or_default()),
                    ));
                }
                AsyncStatus::Canceled => return Err(format!("{context} was canceled.")),
                _ if Instant::now() >= deadline => {
                    let _ = info.Cancel();
                    let _ = info.Close();
                    return Err(format!("{context} timed out."));
                }
                _ => thread::sleep(ASYNC_POLL),
            }
        }
    }

    #[derive(Clone)]
    struct NativeDevice {
        public: BluetoothDevice,
        raw_id: HSTRING,
        container_id: Option<GUID>,
        low_energy: bool,
        /// Bluetooth address (48 bits) when known; the stable identity across sources.
        address: Option<u64>,
        /// Found through the association-endpoint query (needed to reopen it for unpairing).
        aep: bool,
    }

    type GuidKey = (u32, u16, u16, [u8; 8]);

    fn guid_key(guid: &GUID) -> GuidKey {
        (guid.data1, guid.data2, guid.data3, guid.data4)
    }

    /// Device category by raw id. Negative results are cached too, so a device that
    /// will not answer is not asked again on every refresh.
    static CATEGORY_CACHE: Mutex<Option<HashMap<String, &'static str>>> = Mutex::new(None);

    pub(super) fn list() -> Result<Vec<BluetoothDevice>, String> {
        let snapshot = snapshot();
        match (snapshot.devices.is_empty(), snapshot.error) {
            (true, Some(error)) => Err(error),
            (_, _) => Ok(snapshot.devices),
        }
    }

    fn string_iterable(items: &[&str]) -> Result<IIterable<HSTRING>, String> {
        IIterable::<HSTRING>::try_from(items.iter().map(|item| HSTRING::from(*item)).collect::<Vec<_>>())
            .map_err(|error| hresult("Could not prepare Bluetooth device properties", &error))
    }

    /// Asks for the richer property set first and retries with the basics, so one
    /// unsupported property can never make the whole list disappear.
    fn find_paired(selector: &HSTRING) -> Result<DeviceInformationCollection, String> {
        let attempts: [&[&str]; 2] = [
            &[CONNECTED_PROPERTY, CONTAINER_PROPERTY, BATTERY_PROPERTY],
            &[CONNECTED_PROPERTY, CONTAINER_PROPERTY],
        ];
        let mut last_error = String::new();
        for names in attempts {
            let properties = string_iterable(names)?;
            let operation = match DeviceInformation::FindAllAsyncAqsFilterAndAdditionalProperties(
                selector,
                &properties,
            ) {
                Ok(operation) => operation,
                Err(error) => {
                    last_error = hresult("Could not enumerate paired Bluetooth devices", &error);
                    continue;
                }
            };
            match bounded_get(operation, "Bluetooth device enumeration") {
                Ok(collection) => return Ok(collection),
                Err(error) => last_error = error,
            }
        }
        Err(last_error)
    }

    fn byte_value(value: &IPropertyValue) -> Option<u8> {
        value
            .GetUInt8()
            .ok()
            .or_else(|| value.GetUInt32().ok().and_then(|v| u8::try_from(v).ok()))
            .or_else(|| value.GetInt32().ok().and_then(|v| u8::try_from(v).ok()))
            .filter(|value| *value <= 100)
    }

    /// Battery levels from the Bluetooth device nodes, keyed by device container.
    /// Best effort: any failure just means no battery is shown.
    fn container_batteries() -> HashMap<GuidKey, u8> {
        let lookup = || -> Result<HashMap<GuidKey, u8>, String> {
            let properties = string_iterable(&[DEVICE_CONTAINER_PROPERTY, BATTERY_PROPERTY])?;
            let collection = bounded_get(
                DeviceInformation::FindAllAsyncWithKindAqsFilterAndAdditionalProperties(
                    &HSTRING::from(BLUETOOTH_CLASS_FILTER),
                    &properties,
                    DeviceInformationKind::Device,
                )
                .map_err(|error| hresult("Could not read Bluetooth battery levels", &error))?,
                "Bluetooth battery lookup",
            )?;
            let mut map = HashMap::new();
            let count = collection.Size().unwrap_or(0).min(256);
            for index in 0..count {
                let Ok(info) = collection.GetAt(index) else {
                    continue;
                };
                let Ok(properties) = info.Properties() else {
                    continue;
                };
                let container = property(&properties, DEVICE_CONTAINER_PROPERTY)
                    .and_then(|value| value.GetGuid().ok());
                let battery =
                    property(&properties, BATTERY_PROPERTY).and_then(|value| byte_value(&value));
                if let (Some(container), Some(battery)) = (container, battery) {
                    map.entry(guid_key(&container)).or_insert(battery);
                }
            }
            Ok(map)
        };
        lookup().unwrap_or_default()
    }

    /// Bluetooth class-of-device to a short category the interface draws an icon for.
    pub(super) fn classify_class(raw: u32) -> &'static str {
        let major = (raw >> 8) & 0x1F;
        let minor = (raw >> 2) & 0x3F;
        match major {
            1 => "computer",
            2 => "phone",
            4 => match minor {
                1 | 2 | 6 | 7 => "headphones",
                4 => "microphone",
                5 | 8 | 10 | 15 => "speaker",
                9 | 14 | 16 => "display",
                12 | 13 => "camera",
                18 => "gamepad",
                _ => "audio",
            },
            5 => {
                let keyboard = minor & 0x10 != 0;
                let pointer = minor & 0x20 != 0;
                if keyboard {
                    "keyboard"
                } else if pointer {
                    "mouse"
                } else if matches!(minor & 0x0F, 1 | 2) {
                    "gamepad"
                } else {
                    "device"
                }
            }
            7 => "watch",
            9 => "health",
            _ => "device",
        }
    }

    /// GAP appearance (Bluetooth LE) to the same categories.
    pub(super) fn classify_appearance(raw: u16) -> &'static str {
        let category = raw >> 6;
        let sub = raw & 0x3F;
        match category {
            1 => "phone",
            2 => "computer",
            3 => "watch",
            5 => "display",
            15 => match sub {
                1 => "keyboard",
                2 => "mouse",
                3 | 4 => "gamepad",
                _ => "device",
            },
            _ => "device",
        }
    }

    fn lookup_category(raw_id: &HSTRING, low_energy: bool) -> Option<&'static str> {
        let key = raw_id.to_string();
        if let Ok(guard) = CATEGORY_CACHE.lock() {
            if let Some(hit) = guard.as_ref().and_then(|cache| cache.get(&key)) {
                return if hit.is_empty() { None } else { Some(*hit) };
            }
        }
        let found = if low_energy {
            let device = bounded_get(
                BluetoothLEDevice::FromIdAsync(raw_id).ok()?,
                "Opening Bluetooth LE device",
            )
            .ok();
            let category = device
                .as_ref()
                .and_then(|device| device.Appearance().ok())
                .and_then(|appearance| appearance.RawValue().ok())
                .map(classify_appearance);
            if let Some(device) = &device {
                let _ = device.Close();
            }
            category
        } else {
            let device = bounded_get(
                ClassicDevice::FromIdAsync(raw_id).ok()?,
                "Opening Bluetooth device",
            )
            .ok();
            let category = device
                .as_ref()
                .and_then(|device| device.ClassOfDevice().ok())
                .and_then(|class| class.RawValue().ok())
                .map(classify_class);
            if let Some(device) = &device {
                let _ = device.Close();
            }
            category
        };
        if let Ok(mut guard) = CATEGORY_CACHE.lock() {
            let cache = guard.get_or_insert_with(HashMap::new);
            if cache.len() > 256 {
                cache.clear();
            }
            cache.insert(key, found.unwrap_or(""));
        }
        found.filter(|category| *category != "device")
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Origin {
        /// Association-endpoint query: returns every known device, so pairing must be proven.
        Aep,
        /// `GetDeviceSelectorFromPairingState(true)`: already filtered to paired devices.
        Selector,
    }

    fn zero_guid(guid: &GUID) -> bool {
        guid_key(guid) == (0, 0, 0, [0; 8])
    }

    /// Parses a Bluetooth address from "aa:bb:cc:dd:ee:ff", "aabbccddeeff" or a device
    /// id such as "Bluetooth#Bluetooth00:11:22:33:44:55-aa:bb:cc:dd:ee:ff".
    pub(super) fn parse_address(text: &str) -> Option<u64> {
        let tail = text.rsplit('-').next().unwrap_or(text);
        let digits: String = tail.chars().filter(|ch| ch.is_ascii_hexdigit()).collect();
        if digits.len() != 12 {
            return None;
        }
        u64::from_str_radix(&digits, 16).ok().filter(|value| *value != 0)
    }

    #[allow(clippy::too_many_arguments)]
    fn build_device(
        raw_id: HSTRING,
        name: String,
        connected: Option<bool>,
        battery_pct: Option<u8>,
        container_id: Option<GUID>,
        address: Option<u64>,
        low_energy: bool,
        aep: bool,
    ) -> NativeDevice {
        let name = if name.is_empty() {
            "Bluetooth device".to_string()
        } else {
            name
        };
        let manageable = !raw_id.is_empty();
        NativeDevice {
            public: BluetoothDevice {
                id: device_key(&match address {
                    Some(address) => format!("addr:{address:012x}"),
                    None => raw_id.to_string(),
                }),
                name,
                kind: "device".into(),
                paired: true,
                connected,
                battery_pct,
                can_connect: false,
                can_disconnect: false,
                can_unpair: manageable,
                action_reason: Some(if manageable {
                    "Windows connects this device automatically. Open Bluetooth settings for connection options.".into()
                } else {
                    "Found in the Windows registry only. Open Bluetooth settings to manage it.".into()
                }),
            },
            raw_id,
            container_id,
            low_energy,
            address,
            aep,
        }
    }

    /// Enumerates the rows of a device-information collection into candidates.
    fn ingest(
        collection: &DeviceInformationCollection,
        low_energy: bool,
        origin: Origin,
    ) -> Vec<NativeDevice> {
        let mut out = Vec::new();
        let count = collection.Size().unwrap_or(0).min(256);
        for index in 0..count {
            let Ok(info) = collection.GetAt(index) else {
                continue;
            };
            let Ok(raw_id) = info.Id() else {
                continue;
            };
            if raw_id.is_empty() {
                continue;
            }
            let properties = info.Properties().ok();
            let lookup = |key: &str| {
                properties
                    .as_ref()
                    .and_then(|properties| property(properties, key))
            };
            let paired = lookup(PAIRED_PROPERTY)
                .and_then(|value| value.GetBoolean().ok())
                .or_else(|| info.Pairing().ok().and_then(|pairing| pairing.IsPaired().ok()));
            match (origin, paired) {
                (Origin::Aep, Some(true)) => {}
                (Origin::Aep, _) => continue,
                (Origin::Selector, Some(false)) => continue,
                (Origin::Selector, _) => {}
            }
            let name = info
                .Name()
                .map(|name| safe_name(&name.to_string()))
                .unwrap_or_default();
            let connected = lookup(CONNECTED_PROPERTY).and_then(|value| value.GetBoolean().ok());
            let container_id = lookup(CONTAINER_PROPERTY)
                .and_then(|value| value.GetGuid().ok())
                .filter(|guid| !zero_guid(guid));
            let battery_pct = lookup(BATTERY_PROPERTY).and_then(|value| byte_value(&value));
            let address = lookup(ADDRESS_PROPERTY)
                .and_then(|value| value.GetString().ok())
                .and_then(|text| parse_address(&text.to_string()))
                .or_else(|| parse_address(&raw_id.to_string()));
            out.push(build_device(
                raw_id,
                name,
                connected,
                battery_pct,
                container_id,
                address,
                low_energy,
                origin == Origin::Aep,
            ));
        }
        out
    }

    /// Association-endpoint query (the supported way to list known Bluetooth devices):
    /// no special capability needed. Retries with fewer properties so one property
    /// the OS rejects cannot hide the whole list; a timeout is not retried.
    fn find_aep(filter: &HSTRING) -> Result<DeviceInformationCollection, String> {
        let attempts: [&[&str]; 4] = [
            &[
                PAIRED_PROPERTY,
                CONNECTED_PROPERTY,
                ADDRESS_PROPERTY,
                CONTAINER_PROPERTY,
                BATTERY_PROPERTY,
            ],
            &[
                PAIRED_PROPERTY,
                CONNECTED_PROPERTY,
                ADDRESS_PROPERTY,
                CONTAINER_PROPERTY,
            ],
            &[PAIRED_PROPERTY, CONNECTED_PROPERTY],
            &[],
        ];
        let mut last_error = String::new();
        for names in attempts {
            let properties = string_iterable(names)?;
            let operation =
                match DeviceInformation::FindAllAsyncWithKindAqsFilterAndAdditionalProperties(
                    filter,
                    &properties,
                    DeviceInformationKind::AssociationEndpoint,
                ) {
                    Ok(operation) => operation,
                    Err(error) => {
                        last_error = hresult("Could not query Bluetooth devices", &error);
                        continue;
                    }
                };
            match bounded_get(operation, "Bluetooth device query") {
                Ok(collection) => return Ok(collection),
                Err(error) => {
                    let timed_out = error.contains("timed out");
                    last_error = error;
                    if timed_out {
                        break;
                    }
                }
            }
        }
        Err(last_error)
    }

    fn read_aep(low_energy: bool) -> Result<Vec<NativeDevice>, String> {
        let filter = HSTRING::from(if low_energy {
            LE_AEP_FILTER
        } else {
            CLASSIC_AEP_FILTER
        });
        let collection = find_aep(&filter)?;
        Ok(ingest(&collection, low_energy, Origin::Aep))
    }

    fn read_selector(low_energy: bool) -> Result<Vec<NativeDevice>, String> {
        let selector = match if low_energy {
            BluetoothLEDevice::GetDeviceSelectorFromPairingState(true)
        } else {
            ClassicDevice::GetDeviceSelectorFromPairingState(true)
        } {
            Ok(selector) => selector,
            Err(error) => return Err(hresult("Could not prepare Bluetooth device query", &error)),
        };
        let collection = find_paired(&selector)?;
        Ok(ingest(&collection, low_energy, Origin::Selector))
    }

    /* ----------------------------- registry fallback ----------------------------- */

    struct RegKey(HKEY);
    impl Drop for RegKey {
        fn drop(&mut self) {
            let _ = unsafe { RegCloseKey(self.0) };
        }
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn reg_open(parent: HKEY, path: &str) -> Result<RegKey, String> {
        let path_wide = wide(path);
        let mut hkey = HKEY::default();
        unsafe { RegOpenKeyExW(parent, PCWSTR(path_wide.as_ptr()), 0, KEY_READ, &mut hkey) }
            .map_err(|error| hresult("Could not open the Bluetooth registry key", &error))?;
        Ok(RegKey(hkey))
    }

    fn reg_subkeys(key: &RegKey) -> Vec<String> {
        let mut names = Vec::new();
        for index in 0..512u32 {
            let mut buffer = [0u16; 256];
            let mut length = buffer.len() as u32;
            let result = unsafe {
                RegEnumKeyExW(
                    key.0,
                    index,
                    PWSTR(buffer.as_mut_ptr()),
                    &mut length,
                    None,
                    PWSTR::null(),
                    None,
                    None,
                )
            };
            if result.is_err() {
                break;
            }
            names.push(String::from_utf16_lossy(&buffer[..(length as usize).min(buffer.len())]));
        }
        names
    }

    fn reg_value(key: &RegKey, name: &str) -> Option<(REG_VALUE_TYPE, Vec<u8>)> {
        let name_wide = wide(name);
        let mut value_type = REG_VALUE_TYPE::default();
        let mut size = 0u32;
        unsafe {
            RegQueryValueExW(
                key.0,
                PCWSTR(name_wide.as_ptr()),
                None,
                Some(&mut value_type),
                None,
                Some(&mut size),
            )
        }
        .ok()?;
        if size == 0 || size > 4096 {
            return None;
        }
        let mut buffer = vec![0u8; size as usize];
        unsafe {
            RegQueryValueExW(
                key.0,
                PCWSTR(name_wide.as_ptr()),
                None,
                Some(&mut value_type),
                Some(buffer.as_mut_ptr()),
                Some(&mut size),
            )
        }
        .ok()?;
        buffer.truncate(size as usize);
        Some((value_type, buffer))
    }

    /// Radio-level list of every device Windows has paired: subkeys are the device
    /// addresses and `Name` is a NUL-terminated UTF-8 REG_BINARY. No connection
    /// state is available this way. Needs no WinRT and no capability.
    fn read_registry() -> Result<Vec<NativeDevice>, String> {
        let devices = reg_open(HKEY_LOCAL_MACHINE, BTHPORT_DEVICES_KEY)?;
        // Friendly names Windows stored per bus enumerator, used when `Name` is absent.
        let enum_names = reg_open(HKEY_LOCAL_MACHINE, BTHENUM_KEY)
            .map(|enumerator| {
                let mut map = HashMap::<u64, String>::new();
                for entry in reg_subkeys(&enumerator) {
                    let Some(address) = entry
                        .to_ascii_uppercase()
                        .strip_prefix("DEV_")
                        .and_then(parse_address)
                    else {
                        continue;
                    };
                    let Ok(entry_key) = reg_open(enumerator.0, &entry) else {
                        continue;
                    };
                    for instance in reg_subkeys(&entry_key) {
                        let Ok(instance_key) = reg_open(entry_key.0, &instance) else {
                            continue;
                        };
                        if let Some((_, bytes)) = reg_value(&instance_key, "FriendlyName") {
                            let units: Vec<u16> = bytes
                                .chunks_exact(2)
                                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                                .take_while(|unit| *unit != 0)
                                .collect();
                            let text = safe_name(&String::from_utf16_lossy(&units));
                            if !text.is_empty() {
                                map.entry(address).or_insert(text);
                                break;
                            }
                        }
                    }
                }
                map
            })
            .unwrap_or_default();
        let mut out = Vec::new();
        for entry in reg_subkeys(&devices).into_iter().take(MAX_DEVICES) {
            let Some(address) = parse_address(&entry) else {
                continue;
            };
            let Ok(key) = reg_open(devices.0, &entry) else {
                continue;
            };
            let name = reg_value(&key, "Name")
                .map(|(_, bytes)| {
                    let end = bytes.iter().position(|byte| *byte == 0).unwrap_or(bytes.len());
                    safe_name(&String::from_utf8_lossy(&bytes[..end]))
                })
                .filter(|name| !name.is_empty())
                .or_else(|| enum_names.get(&address).cloned())
                .unwrap_or_default();
            let kind = reg_value(&key, "COD")
                .filter(|(_, bytes)| bytes.len() >= 4)
                .map(|(_, bytes)| u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
                .map(classify_class);
            let mut device = build_device(
                HSTRING::new(),
                name,
                None,
                None,
                None,
                Some(address),
                false,
                false,
            );
            if let Some(kind) = kind {
                device.public.kind = kind.into();
            }
            out.push(device);
        }
        Ok(out)
    }

    /* ----------------------------- PowerShell fallback ----------------------------- */

    /// Last resort: `Get-PnpDevice` (hidden window, 6 s limit).
    fn read_powershell() -> Result<Vec<NativeDevice>, String> {
        use std::os::windows::process::CommandExt;
        use std::process::{Command, Stdio};
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut child = Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Get-PnpDevice -Class Bluetooth -PresentOnly | Select-Object FriendlyName,InstanceId | ConvertTo-Json -Compress",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|error| format!("PowerShell could not start: {error}"))?;
        let deadline = Instant::now() + Duration::from_secs(6);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if Instant::now() >= deadline => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("PowerShell timed out.".into());
                }
                Ok(None) => thread::sleep(ASYNC_POLL),
                Err(error) => return Err(format!("PowerShell failed: {error}")),
            }
        }
        let output = child
            .wait_with_output()
            .map_err(|error| format!("PowerShell failed: {error}"))?;
        if !output.status.success() {
            return Err("PowerShell reported an error listing Bluetooth devices.".into());
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let text = text.trim();
        if text.is_empty() {
            return Ok(Vec::new());
        }
        let value: serde_json::Value =
            serde_json::from_str(text).map_err(|_| "PowerShell returned unreadable output.".to_string())?;
        let rows = match value {
            serde_json::Value::Array(rows) => rows,
            other => vec![other],
        };
        let mut out = Vec::new();
        for row in rows.into_iter().take(MAX_DEVICES) {
            let instance = row
                .get("InstanceId")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_ascii_uppercase();
            // Only per-device nodes carry the address: BTHENUM\DEV_<12 hex> and BTHLE\DEV_<12 hex>.
            let Some(position) = instance.find("DEV_") else {
                continue;
            };
            let Some(address) = parse_address(
                &instance[position + 4..].chars().take(12).collect::<String>(),
            ) else {
                continue;
            };
            let name = safe_name(
                row.get("FriendlyName")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default(),
            );
            out.push(build_device(
                HSTRING::new(),
                name,
                None,
                None,
                None,
                Some(address),
                instance.starts_with("BTHLE"),
                false,
            ));
        }
        Ok(out)
    }

    /* ----------------------------------- merge ----------------------------------- */

    fn merge_candidates(mut candidates: Vec<NativeDevice>) -> Vec<NativeDevice> {
        // Classic entries first so their identifiers win for one physical device.
        candidates.sort_by_key(|device| (device.low_energy, device.public.name.to_lowercase()));
        let mut merged: Vec<NativeDevice> = Vec::new();
        for device in candidates {
            let existing = merged.iter_mut().find(|existing| {
                (!device.raw_id.is_empty() && existing.raw_id == device.raw_id)
                    || (existing.address.is_some() && existing.address == device.address)
                    || (existing.container_id.is_some()
                        && existing.container_id.map(|guid| guid_key(&guid))
                            == device.container_id.map(|guid| guid_key(&guid)))
            });
            match existing {
                Some(existing) => {
                    if existing.public.connected != Some(true) && device.public.connected == Some(true)
                    {
                        existing.public.connected = Some(true);
                    }
                    if existing.public.connected.is_none() {
                        existing.public.connected = device.public.connected;
                    }
                    if existing.public.battery_pct.is_none() {
                        existing.public.battery_pct = device.public.battery_pct;
                    }
                    if existing.address.is_none() {
                        existing.address = device.address;
                    }
                    if existing.container_id.is_none() {
                        existing.container_id = device.container_id;
                    }
                    if existing.raw_id.is_empty() && !device.raw_id.is_empty() {
                        existing.raw_id = device.raw_id.clone();
                        existing.aep = device.aep;
                        existing.low_energy = device.low_energy;
                        existing.public.can_unpair = true;
                    }
                    if existing.public.name == "Bluetooth device"
                        && device.public.name != "Bluetooth device"
                    {
                        existing.public.name = device.public.name.clone();
                    }
                }
                None => merged.push(device),
            }
        }
        for device in merged.iter_mut() {
            device.public.id = device_key(&match device.address {
                Some(address) => format!("addr:{address:012x}"),
                None => device.raw_id.to_string(),
            });
        }
        merged
    }

    fn push_report(
        reports: &mut Vec<BluetoothSourceReport>,
        candidates: &mut Vec<NativeDevice>,
        source: &str,
        outcome: Result<Vec<NativeDevice>, String>,
    ) {
        match outcome {
            Ok(found) => {
                reports.push(BluetoothSourceReport {
                    source: source.into(),
                    ok: true,
                    count: found.len() as u32,
                    error: None,
                });
                candidates.extend(found);
            }
            Err(error) => reports.push(BluetoothSourceReport {
                source: source.into(),
                ok: false,
                count: 0,
                error: Some(error),
            }),
        }
    }

    fn collect_native() -> (Vec<NativeDevice>, Vec<BluetoothSourceReport>) {
        let started = Instant::now();
        let over_budget = || started.elapsed() > SOURCE_BUDGET;
        let skipped = || Err("Skipped because earlier Windows Bluetooth queries timed out.".to_string());
        let mut reports = Vec::new();
        let mut candidates = Vec::new();

        // 1. Association endpoints (classic, then LE).
        for (low_energy, label) in [(false, "Windows Bluetooth"), (true, "Windows Bluetooth LE")] {
            let outcome = if over_budget() { skipped() } else { read_aep(low_energy) };
            push_report(&mut reports, &mut candidates, label, outcome);
        }
        // 2. The older paired-state selectors, only when the first pass found nothing.
        if candidates.is_empty() {
            for (low_energy, label) in [
                (false, "Windows Bluetooth (paired selector)"),
                (true, "Windows Bluetooth LE (paired selector)"),
            ] {
                let outcome = if over_budget() { skipped() } else { read_selector(low_energy) };
                push_report(&mut reports, &mut candidates, label, outcome);
            }
        }
        let mut values = merge_candidates(candidates);
        // 3. Registry, 4. PowerShell: only when Windows' own API produced nothing.
        if values.is_empty() {
            let mut extra = Vec::new();
            push_report(&mut reports, &mut extra, "Windows registry", read_registry());
            values = merge_candidates(extra);
        }
        if values.is_empty() {
            let mut extra = Vec::new();
            push_report(&mut reports, &mut extra, "PowerShell", read_powershell());
            values = merge_candidates(extra);
        }

        // Category icons and battery come from separate, cached lookups.
        let batteries = if over_budget() || values.iter().all(|device| device.container_id.is_none()) {
            HashMap::new()
        } else {
            container_batteries()
        };
        for (position, device) in values.iter_mut().enumerate() {
            if device.public.battery_pct.is_none() {
                if let Some(container) = device.container_id {
                    device.public.battery_pct = batteries.get(&guid_key(&container)).copied();
                }
            }
            if position < MAX_CLASS_LOOKUPS && !device.raw_id.is_empty() && !over_budget() {
                if let Some(category) = lookup_category(&device.raw_id, device.low_energy) {
                    device.public.kind = category.into();
                }
            }
        }

        // Bluetooth listing remains useful if the Windows audio service or
        // an endpoint driver is unavailable; in that case audio actions stay
        // disabled and the UI sends users to Bluetooth Settings.
        let audio = audio_endpoint_inventory().unwrap_or_default();
        for device in values.iter_mut() {
            if let Some(container) = device.container_id {
                if let Some(endpoint) = audio
                    .iter()
                    .find(|endpoint| endpoint.container_id == container)
                {
                    if device.public.kind == "device" {
                        device.public.kind = "audio".into();
                    }
                    device.public.connected = Some(endpoint.connected);
                    let reconnect =
                        ks_property_supported(&endpoint.id, KSPROPERTY_ONESHOT_RECONNECT.0);
                    let disconnect =
                        ks_property_supported(&endpoint.id, KSPROPERTY_ONESHOT_DISCONNECT.0);
                    let (can_connect, can_disconnect) =
                        audio_action_capabilities(endpoint.connected, reconnect, disconnect);
                    device.public.can_connect = can_connect;
                    device.public.can_disconnect = can_disconnect;
                    device.public.action_reason = if reconnect || disconnect {
                        None
                    } else {
                        Some("This audio driver does not expose the Windows Bluetooth connection control; use Bluetooth settings.".into())
                    };
                }
            }
        }
        // Connected devices first, then alphabetical.
        values.sort_unstable_by(|a, b| {
            (b.public.connected == Some(true))
                .cmp(&(a.public.connected == Some(true)))
                .then_with(|| {
                    a.public
                        .name
                        .to_lowercase()
                        .cmp(&b.public.name.to_lowercase())
                })
        });
        (values, reports)
    }

    fn failure_summary(reports: &[BluetoothSourceReport]) -> Option<String> {
        let failed: Vec<String> = reports
            .iter()
            .filter(|report| !report.ok)
            .map(|report| {
                format!(
                    "{}: {}",
                    report.source,
                    report.error.as_deref().unwrap_or("failed")
                )
            })
            .collect();
        if failed.is_empty() {
            None
        } else {
            Some(failed.join("; "))
        }
    }

    fn list_native() -> Result<Vec<NativeDevice>, String> {
        let (devices, reports) = collect_native();
        if devices.is_empty() {
            if let Some(error) = failure_summary(&reports) {
                return Err(error);
            }
        }
        Ok(devices)
    }

    pub(super) fn snapshot() -> BluetoothSnapshot {
        // WinRT async calls are polled (never blocked on), so a plain MTA worker is enough.
        let com = apartment(COINIT_MULTITHREADED);
        let apartment_error = com.as_ref().err().cloned();
        let _keep_apartment = com;
        let (devices, mut sources) = collect_native();
        if let Some(error) = apartment_error {
            sources.insert(
                0,
                BluetoothSourceReport {
                    source: "COM".into(),
                    ok: false,
                    count: 0,
                    error: Some(error),
                },
            );
        }
        let error = if devices.is_empty() {
            failure_summary(&sources)
        } else {
            None
        };
        BluetoothSnapshot {
            devices: devices.into_iter().map(|device| device.public).collect(),
            sources,
            error,
        }
    }

    fn property(
        properties: &windows::Foundation::Collections::IMapView<
            HSTRING,
            windows::core::IInspectable,
        >,
        key: &str,
    ) -> Option<IPropertyValue> {
        properties
            .Lookup(&HSTRING::from(key))
            .ok()?
            .cast::<IPropertyValue>()
            .ok()
    }

    fn device_key(raw_id: &str) -> String {
        let digest = Sha256::digest(raw_id.as_bytes());
        digest.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    fn safe_name(name: &str) -> String {
        name.trim()
            .chars()
            .filter(|ch| !ch.is_control())
            .take(MAX_NAME_CHARS)
            .collect()
    }

    fn audio_action_capabilities(
        connected: bool,
        reconnect_supported: bool,
        disconnect_supported: bool,
    ) -> (bool, bool) {
        (
            !connected && reconnect_supported,
            connected && disconnect_supported,
        )
    }

    fn find_native(key: &str) -> Result<NativeDevice, String> {
        if key.len() != 64 || !key.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("Invalid Bluetooth device key.".into());
        }
        list_native()?
            .into_iter()
            .find(|device| device.public.id == key && device.public.paired)
            .ok_or_else(|| "This Bluetooth device is no longer paired. Refresh the list.".into())
    }

    pub(super) fn unpair(key: &str) -> Result<(), String> {
        let _apartment = apartment(COINIT_MULTITHREADED)?;
        let device = find_native(key)?;
        if device.raw_id.is_empty() {
            return Err("Windows only exposes this device through the registry. Forget it in Bluetooth settings.".into());
        }
        let opened = if device.aep {
            DeviceInformation::CreateFromIdAsyncWithKindAndAdditionalProperties(
                &device.raw_id,
                &string_iterable(&[PAIRED_PROPERTY])?,
                DeviceInformationKind::AssociationEndpoint,
            )
        } else {
            DeviceInformation::CreateFromIdAsync(&device.raw_id)
        };
        let info = bounded_get(
            opened.map_err(|error| hresult("Could not open the paired device", &error))?,
            "Opening Bluetooth device",
        )?;
        let pairing = info
            .Pairing()
            .map_err(|error| hresult("Could not read Bluetooth pairing state", &error))?;
        if !pairing.IsPaired().unwrap_or(false) {
            return Err("This Bluetooth device is already unpaired.".into());
        }
        let result = bounded_get(
            pairing
                .UnpairAsync()
                .map_err(|error| hresult("Windows could not forget this device", &error))?,
            "Forgetting Bluetooth device",
        )?;
        match result
            .Status()
            .map_err(|error| hresult("Could not verify the forget operation", &error))?
        {
            DeviceUnpairingResultStatus::Unpaired
            | DeviceUnpairingResultStatus::AlreadyUnpaired => {}
            DeviceUnpairingResultStatus::AccessDenied => {
                return Err("Windows denied permission to forget this device.".into())
            }
            DeviceUnpairingResultStatus::OperationAlreadyInProgress => {
                return Err("Windows is already changing this device's pairing.".into())
            }
            _ => return Err("Windows could not confirm that the device was forgotten.".into()),
        }
        if list_native()?.iter().any(|entry| entry.public.id == key) {
            return Err("Windows reported success, but the device still appears paired. Refresh and check Windows settings.".into());
        }
        Ok(())
    }

    pub(super) fn set_audio_connected(
        key: &str,
        connected: bool,
    ) -> Result<BluetoothDevice, String> {
        let _apartment = apartment(COINIT_MULTITHREADED)?;
        let device = find_native(key)?;
        let endpoint = audio_endpoint_inventory()?
            .into_iter()
            .find(|endpoint| device.container_id.is_some_and(|id| id == endpoint.container_id))
            .ok_or_else(|| "Windows did not expose a matching Bluetooth audio endpoint. Open Bluetooth settings.".to_string())?;
        if endpoint.connected == connected {
            return Err(if connected {
                "This audio device is already connected."
            } else {
                "This audio device is already disconnected."
            }
            .into());
        }
        let property = if connected {
            KSPROPERTY_ONESHOT_RECONNECT.0
        } else {
            KSPROPERTY_ONESHOT_DISCONNECT.0
        };
        if !ks_property_supported(&endpoint.id, property) {
            return Err("This audio driver does not expose the Windows Bluetooth connection control. Open Bluetooth settings.".into());
        }

        // Endpoint/topology objects are apartment-bound. Execute the one-shot
        // request on a dedicated STA, then verify the endpoint state from MTA.
        let endpoint_id = endpoint.id.clone();
        let (sender, receiver) = std::sync::mpsc::channel();
        thread::Builder::new()
            .name("hover-island-bluetooth-audio".into())
            .spawn(move || {
                let outcome = (|| {
                    let _sta = apartment(COINIT_APARTMENTTHREADED)?;
                    request_audio_state(&endpoint_id, connected)
                })();
                let _ = sender.send(outcome);
            })
            .map_err(|error| format!("Could not start Bluetooth audio worker: {error}"))?;
        receiver
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| "Windows Bluetooth audio driver did not respond in time.".to_string())??;

        let deadline = Instant::now() + VERIFY_WAIT;
        while Instant::now() < deadline {
            if audio_endpoint_inventory()?
                .iter()
                .any(|item| item.id == endpoint.id && item.connected == connected)
            {
                return find_native(key).map(|device| device.public);
            }
            thread::sleep(ASYNC_POLL);
        }
        Err("Windows did not confirm the requested Bluetooth audio state. Check Bluetooth settings.".into())
    }

    #[derive(Clone)]
    struct AudioEndpoint {
        id: String,
        container_id: GUID,
        connected: bool,
    }

    fn audio_endpoint_inventory() -> Result<Vec<AudioEndpoint>, String> {
        let enumerator: IMMDeviceEnumerator =
            unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }.map_err(
                |error| hresult("Windows audio endpoint service is unavailable", &error),
            )?;
        let collection = unsafe {
            enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE | DEVICE_STATE_UNPLUGGED)
        }
        .map_err(|error| hresult("Could not enumerate audio endpoints", &error))?;
        let count = unsafe { collection.GetCount() }
            .map_err(|error| hresult("Could not read audio endpoint list", &error))?;
        let mut endpoints = Vec::new();
        for index in 0..count {
            let endpoint = unsafe { collection.Item(index) }
                .map_err(|error| hresult("Could not read an audio endpoint", &error))?;
            let state = unsafe { endpoint.GetState() }
                .map_err(|error| hresult("Could not read audio endpoint state", &error))?;
            let Some(container_id) = endpoint_container_id(&endpoint) else {
                continue;
            };
            let id = unsafe { endpoint.GetId() }
                .map_err(|error| hresult("Could not read audio endpoint identity", &error))?;
            let id_result = unsafe { id.to_string() };
            unsafe {
                CoTaskMemFree(Some(id.0 as _));
            }
            let id = id_result
                .map_err(|_| "Windows returned an invalid audio endpoint identity.".to_string())?;
            endpoints.push(AudioEndpoint {
                id,
                container_id,
                connected: state & DEVICE_STATE_ACTIVE != 0,
            });
        }
        Ok(endpoints)
    }

    fn endpoint_container_id(endpoint: &IMMDevice) -> Option<GUID> {
        let store = unsafe { endpoint.OpenPropertyStore(STGM_READ) }.ok()?;
        let mut value = unsafe { store.GetValue(&PKEY_Device_ContainerId) }.ok()?;
        let guid = unsafe {
            if value.Anonymous.Anonymous.vt == VT_CLSID {
                value.Anonymous.Anonymous.Anonymous.puuid.as_ref().copied()
            } else {
                None
            }
        };
        unsafe {
            let _ = windows::Win32::System::Com::StructuredStorage::PropVariantClear(&mut value);
        }
        guid
    }

    fn ks_control(endpoint_id: &str) -> Result<IKsControl, String> {
        let enumerator: IMMDeviceEnumerator =
            unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }.map_err(
                |error| hresult("Windows audio endpoint service is unavailable", &error),
            )?;
        let wide: Vec<u16> = endpoint_id
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let endpoint = unsafe { enumerator.GetDevice(PCWSTR(wide.as_ptr())) }
            .map_err(|error| hresult("Could not open the Bluetooth audio endpoint", &error))?;
        let topology: IDeviceTopology = unsafe { endpoint.Activate(CLSCTX_ALL, None) }
            .map_err(|error| hresult("Could not open Bluetooth audio topology", &error))?;
        let connector = unsafe { topology.GetConnector(0) }
            .map_err(|error| hresult("Could not locate Bluetooth audio connector", &error))?;
        let adapter_ptr = unsafe { connector.GetDeviceIdConnectedTo() }
            .map_err(|error| hresult("Could not locate Bluetooth audio driver", &error))?;
        let adapter_id_result = unsafe { adapter_ptr.to_string() };
        unsafe {
            CoTaskMemFree(Some(adapter_ptr.0 as _));
        }
        let adapter_id = adapter_id_result
            .map_err(|_| "Could not decode Bluetooth audio driver identity.".to_string())?;
        if adapter_id.is_empty() {
            return Err("Bluetooth audio endpoint has no connected driver filter.".into());
        }
        let adapter_wide: Vec<u16> = adapter_id
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let adapter = unsafe { enumerator.GetDevice(PCWSTR(adapter_wide.as_ptr())) }
            .map_err(|error| hresult("Could not open Bluetooth audio driver", &error))?;
        unsafe { adapter.Activate(CLSCTX_ALL, None) }
            .map_err(|error| hresult("Bluetooth audio driver does not expose KS controls", &error))
    }

    fn ks_property_supported(endpoint_id: &str, property_id: i32) -> bool {
        let Ok(control) = ks_control(endpoint_id) else {
            return false;
        };
        let property = ks_identifier(property_id, KSPROPERTY_TYPE_BASICSUPPORT);
        let mut description = KSPROPERTY_DESCRIPTION::default();
        let mut returned = 0u32;
        unsafe {
            control.KsProperty(
                &property,
                std::mem::size_of::<KSIDENTIFIER>() as u32,
                (&mut description as *mut KSPROPERTY_DESCRIPTION).cast(),
                std::mem::size_of::<KSPROPERTY_DESCRIPTION>() as u32,
                &mut returned,
            )
        }
        .is_ok()
    }

    fn request_audio_state(endpoint_id: &str, connected: bool) -> Result<(), String> {
        let control = ks_control(endpoint_id)?;
        let id = if connected {
            KSPROPERTY_ONESHOT_RECONNECT.0
        } else {
            KSPROPERTY_ONESHOT_DISCONNECT.0
        };
        let property = ks_identifier(id, KSPROPERTY_TYPE_GET);
        let mut returned = 0u32;
        unsafe {
            control.KsProperty(
                &property,
                std::mem::size_of::<KSIDENTIFIER>() as u32,
                std::ptr::null_mut(),
                0,
                &mut returned,
            )
        }
        .map_err(|error| {
            hresult(
                "Windows could not request the Bluetooth audio state change",
                &error,
            )
        })
    }

    fn ks_identifier(id: i32, flags: u32) -> KSIDENTIFIER {
        KSIDENTIFIER {
            Anonymous: KSIDENTIFIER_0 {
                Anonymous: KSIDENTIFIER_0_0 {
                    Set: KSPROPSETID_BtAudio,
                    Id: id as u32,
                    Flags: flags,
                },
            },
        }
    }

    pub(super) fn open_settings() -> Result<(), String> {
        let uri = HSTRING::from("ms-settings:bluetooth");
        let result = unsafe {
            ShellExecuteW(
                HWND::default(),
                w!("open"),
                PCWSTR(uri.as_ptr()),
                PCWSTR::null(),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            )
        };
        if result.0 <= 32 {
            Err("Windows could not open Bluetooth settings.".into())
        } else {
            Ok(())
        }
    }

    #[cfg(test)]
    mod tests {
        use super::{
            audio_action_capabilities, classify_appearance, classify_class, device_key, parse_address,
            safe_name, MAX_NAME_CHARS,
        };

        #[test]
        fn class_of_device_maps_to_icon_categories() {
            // Major 4 (audio/video), minor 6 (headphones): 0x240418 style values.
            assert_eq!(classify_class(0x0024_0418), "headphones");
            assert_eq!(classify_class(0x0024_0414), "speaker");
            // Major 5 (peripheral): keyboard 0x40, pointing device 0x80.
            assert_eq!(classify_class(0x0000_0540), "keyboard");
            assert_eq!(classify_class(0x0000_0580), "mouse");
            assert_eq!(classify_class(0x0000_0508), "gamepad");
            assert_eq!(classify_class(0x0000_020C), "phone");
            assert_eq!(classify_class(0x0000_010C), "computer");
            assert_eq!(classify_class(0), "device");
        }

        #[test]
        fn le_appearance_maps_to_icon_categories() {
            assert_eq!(classify_appearance(0x03C1), "keyboard");
            assert_eq!(classify_appearance(0x03C2), "mouse");
            assert_eq!(classify_appearance(0x0040), "phone");
            assert_eq!(classify_appearance(0x00C0), "watch");
            assert_eq!(classify_appearance(0x0000), "device");
        }

        #[test]
        fn public_device_key_is_opaque_and_stable() {
            let raw = "Bluetooth#BluetoothLE#DEVICE_123456789";
            assert_eq!(device_key(raw), device_key(raw));
            assert_eq!(device_key(raw).len(), 64);
            assert!(!device_key(raw).contains("123456789"));
        }

        #[test]
        fn addresses_parse_from_properties_ids_and_registry_keys() {
            assert_eq!(parse_address("aa:bb:cc:dd:ee:ff"), Some(0xAABB_CCDD_EEFF));
            assert_eq!(parse_address("AABBCCDDEEFF"), Some(0xAABB_CCDD_EEFF));
            assert_eq!(
                parse_address("Bluetooth#Bluetooth00:11:22:33:44:55-aa:bb:cc:dd:ee:ff"),
                Some(0xAABB_CCDD_EEFF)
            );
            assert_eq!(parse_address("not an address"), None);
            assert_eq!(parse_address("000000000000"), None);
        }

        #[test]
        fn names_are_bounded_and_drop_control_characters() {
            assert_eq!(safe_name("  Headphones\nPro  "), "HeadphonesPro");
            assert_eq!(safe_name(&"x".repeat(200)).len(), MAX_NAME_CHARS);
        }

        #[test]
        fn audio_controls_require_matching_connection_state_and_driver_support() {
            assert_eq!(audio_action_capabilities(false, true, true), (true, false));
            assert_eq!(audio_action_capabilities(true, true, true), (false, true));
            assert_eq!(
                audio_action_capabilities(false, false, true),
                (false, false)
            );
            assert_eq!(audio_action_capabilities(true, true, false), (false, false));
        }

        #[test]
        #[ignore = "read-only Bluetooth inventory smoke test; performs no connection or pairing changes"]
        fn live_paired_device_inventory_is_bounded() {
            let devices = super::list().expect("enumerate paired Bluetooth devices");
            assert!(devices.len() <= super::MAX_DEVICES);
            assert!(devices
                .iter()
                .all(|device| device.paired && !device.id.is_empty()));
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod platform {
    use super::{BluetoothDevice, BluetoothSnapshot};

    pub(super) fn snapshot() -> BluetoothSnapshot {
        BluetoothSnapshot {
            devices: Vec::new(),
            sources: Vec::new(),
            error: Some("Bluetooth device management is available on Windows.".into()),
        }
    }
    pub(super) fn list() -> Result<Vec<BluetoothDevice>, String> {
        Err("Bluetooth device management is available on Windows.".into())
    }
    pub(super) fn set_audio_connected(_: &str, _: bool) -> Result<BluetoothDevice, String> {
        Err("Bluetooth audio control is available on Windows.".into())
    }
    pub(super) fn unpair(_: &str) -> Result<(), String> {
        Err("Bluetooth device management is available on Windows.".into())
    }
    pub(super) fn open_settings() -> Result<(), String> {
        Err("Bluetooth settings are available on Windows.".into())
    }
}
