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
    use windows::Devices::Enumeration::{DeviceInformation, DeviceUnpairingResultStatus};
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
    const BATTERY_PROPERTY: &str = "System.Devices.BatteryLife";
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
    }

    pub(super) fn list() -> Result<Vec<BluetoothDevice>, String> {
        let _apartment = apartment(COINIT_MULTITHREADED)?;
        list_native()?
            .into_iter()
            .map(|device| Ok(device.public))
            .collect()
    }

    fn list_native() -> Result<Vec<NativeDevice>, String> {
        let selectors = [
            ClassicDevice::GetDeviceSelectorFromPairingState(true)
                .map_err(|error| hresult("Could not prepare Bluetooth device query", &error))?,
            BluetoothLEDevice::GetDeviceSelectorFromPairingState(true)
                .map_err(|error| hresult("Could not prepare Bluetooth LE device query", &error))?,
        ];
        let properties = IIterable::<HSTRING>::try_from(vec![
            HSTRING::from(CONNECTED_PROPERTY),
            HSTRING::from(CONTAINER_PROPERTY),
            HSTRING::from(BATTERY_PROPERTY),
        ])
        .map_err(|error| hresult("Could not prepare Bluetooth device properties", &error))?;
        let mut devices = std::collections::HashMap::<String, NativeDevice>::new();
        for selector in selectors {
            let collection = bounded_get(
                DeviceInformation::FindAllAsyncAqsFilterAndAdditionalProperties(
                    &selector,
                    &properties,
                )
                .map_err(|error| hresult("Could not enumerate paired Bluetooth devices", &error))?,
                "Bluetooth device enumeration",
            )?;
            let count = collection
                .Size()
                .map_err(|error| hresult("Could not read Bluetooth device list", &error))?;
            if count as usize > MAX_DEVICES
                || devices.len().saturating_add(count as usize) > MAX_DEVICES * 2
            {
                return Err("Bluetooth device list exceeded the safety limit.".into());
            }
            for index in 0..count {
                let info = collection
                    .GetAt(index)
                    .map_err(|error| hresult("Could not read a Bluetooth device", &error))?;
                let pairing = info
                    .Pairing()
                    .map_err(|error| hresult("Could not read Bluetooth pairing state", &error))?;
                if !pairing
                    .IsPaired()
                    .map_err(|error| hresult("Could not verify Bluetooth pairing state", &error))?
                {
                    continue;
                }
                let raw_id = info
                    .Id()
                    .map_err(|error| hresult("Could not read Bluetooth device identity", &error))?;
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
                let properties = info.Properties().map_err(|error| {
                    hresult("Could not read Bluetooth device properties", &error)
                })?;
                let connected = property(&properties, CONNECTED_PROPERTY)
                    .and_then(|value| value.GetBoolean().ok());
                let container_id = property(&properties, CONTAINER_PROPERTY)
                    .and_then(|value| value.GetGuid().ok());
                let battery_pct = property(&properties, BATTERY_PROPERTY)
                    .and_then(|value| value.GetUInt8().ok())
                    .filter(|value| *value <= 100);
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
                });
                if devices.len() > MAX_DEVICES {
                    return Err("Bluetooth device list exceeded the safety limit.".into());
                }
            }
        }

        // Bluetooth listing remains useful if the Windows audio service or
        // an endpoint driver is unavailable; in that case audio actions stay
        // disabled and the UI sends users to Bluetooth Settings.
        let audio = audio_endpoint_inventory().unwrap_or_default();
        for device in devices.values_mut() {
            if let Some(container) = device.container_id {
                if let Some(endpoint) = audio
                    .iter()
                    .find(|endpoint| endpoint.container_id == container)
                {
                    device.public.kind = "audio".into();
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
        let mut values: Vec<_> = devices.into_values().collect();
        values.sort_unstable_by(|a, b| {
            a.public
                .name
                .to_lowercase()
                .cmp(&b.public.name.to_lowercase())
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
        use super::{audio_action_capabilities, device_key, safe_name, MAX_NAME_CHARS};

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
