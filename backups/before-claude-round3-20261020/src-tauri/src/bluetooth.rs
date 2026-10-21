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
    use super::{BluetoothDevice, MAX_DEVICES, MAX_NAME_CHARS};
    use sha2::{Digest, Sha256};
    use std::thread;
    use std::time::{Duration, Instant};
    use windows::core::{w, ComInterface, Error, GUID, HSTRING, PCWSTR};
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
    const MAX_ASYNC_WAIT: Duration = Duration::from_secs(8);
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
    }

    type GuidKey = (u32, u16, u16, [u8; 8]);

    fn guid_key(guid: &GUID) -> GuidKey {
        (guid.data1, guid.data2, guid.data3, guid.data4)
    }

    /// Device category by raw id. Negative results are cached too, so a device that
    /// will not answer is not asked again on every refresh.
    static CATEGORY_CACHE: Mutex<Option<HashMap<String, &'static str>>> = Mutex::new(None);

    pub(super) fn list() -> Result<Vec<BluetoothDevice>, String> {
        let _apartment = apartment(COINIT_MULTITHREADED)?;
        list_native()?
            .into_iter()
            .map(|device| Ok(device.public))
            .collect()
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

    fn list_native() -> Result<Vec<NativeDevice>, String> {
        let selectors = [
            (
                false,
                ClassicDevice::GetDeviceSelectorFromPairingState(true)
                    .map_err(|error| hresult("Could not prepare Bluetooth device query", &error))?,
            ),
            (
                true,
                BluetoothLEDevice::GetDeviceSelectorFromPairingState(true).map_err(|error| {
                    hresult("Could not prepare Bluetooth LE device query", &error)
                })?,
            ),
        ];
        let mut devices = HashMap::<String, NativeDevice>::new();
        let mut first_error: Option<String> = None;
        for (low_energy, selector) in selectors {
            // A failure in one transport (for example no LE support) must not hide the other.
            let collection = match find_paired(&selector) {
                Ok(collection) => collection,
                Err(error) => {
                    first_error.get_or_insert(error);
                    continue;
                }
            };
            let count = collection.Size().unwrap_or(0).min(MAX_DEVICES as u32);
            for index in 0..count {
                let Ok(info) = collection.GetAt(index) else {
                    continue;
                };
                // The selector already asks for paired devices; only skip an explicit "not paired".
                if let Ok(pairing) = info.Pairing() {
                    if pairing.IsPaired() == Ok(false) {
                        continue;
                    }
                }
                let Ok(raw_id) = info.Id() else {
                    continue;
                };
                if raw_id.is_empty() {
                    continue;
                }
                let name = info
                    .Name()
                    .map(|name| safe_name(&name.to_string()))
                    .unwrap_or_default();
                let name = if name.is_empty() {
                    "Bluetooth device".into()
                } else {
                    name
                };
                let properties = info.Properties().ok();
                let lookup = |key: &str| {
                    properties
                        .as_ref()
                        .and_then(|properties| property(properties, key))
                };
                let connected = lookup(CONNECTED_PROPERTY).and_then(|value| value.GetBoolean().ok());
                let container_id = lookup(CONTAINER_PROPERTY).and_then(|value| value.GetGuid().ok());
                let battery_pct = lookup(BATTERY_PROPERTY).and_then(|value| byte_value(&value));
                let key = device_key(&raw_id.to_string());
                devices.entry(key.clone()).or_insert_with(|| NativeDevice {
                    public: BluetoothDevice {
                        id: key,
                        name,
                        kind: "device".into(),
                        paired: true,
                        connected,
                        battery_pct,
                        can_connect: false,
                        can_disconnect: false,
                        can_unpair: true,
                        action_reason: Some("Windows connects this device automatically. Open Bluetooth settings for connection options.".into()),
                    },
                    raw_id,
                    container_id,
                    low_energy,
                });
            }
        }
        if devices.is_empty() {
            if let Some(error) = first_error {
                return Err(error);
            }
        }

        // The same headphones can be paired over classic and LE. Show one row per
        // physical device, preferring the classic entry, and merge what each knows.
        let mut by_container = HashMap::<GuidKey, NativeDevice>::new();
        let mut unkeyed = Vec::<NativeDevice>::new();
        let mut ordered: Vec<NativeDevice> = devices.into_values().collect();
        ordered.sort_by_key(|device| (device.low_energy, device.public.name.to_lowercase()));
        for device in ordered {
            let Some(container) = device.container_id else {
                unkeyed.push(device);
                continue;
            };
            match by_container.get_mut(&guid_key(&container)) {
                Some(existing) => {
                    if existing.public.connected != Some(true) && device.public.connected == Some(true)
                    {
                        existing.public.connected = Some(true);
                    }
                    if existing.public.battery_pct.is_none() {
                        existing.public.battery_pct = device.public.battery_pct;
                    }
                }
                None => {
                    by_container.insert(guid_key(&container), device);
                }
            }
        }
        let mut values: Vec<NativeDevice> = by_container.into_values().chain(unkeyed).collect();

        // Category icons and battery come from separate, cached lookups.
        let batteries = container_batteries();
        for (position, device) in values.iter_mut().enumerate() {
            if device.public.battery_pct.is_none() {
                if let Some(container) = device.container_id {
                    device.public.battery_pct = batteries.get(&guid_key(&container)).copied();
                }
            }
            if position < MAX_CLASS_LOOKUPS {
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
        Ok(values)
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
        let info = bounded_get(
            DeviceInformation::CreateFromIdAsync(&device.raw_id)
                .map_err(|error| hresult("Could not open the paired device", &error))?,
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
            audio_action_capabilities, classify_appearance, classify_class, device_key, safe_name,
            MAX_NAME_CHARS,
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
    use super::BluetoothDevice;

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
