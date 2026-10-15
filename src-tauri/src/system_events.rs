//! Read-only Windows system change monitors for the compact island peek.
//!
//! Volume uses WASAPI endpoint callbacks and brightness uses the WMI change
//! event class. Both start with a quiet baseline and keep their native waits
//! bounded so shutdown and recovery remain responsive.

use std::sync::atomic::Ordering;
use std::thread;

use tauri::{Emitter, Manager};

use crate::state::AppState;
use crate::types::{now_millis, AppNotification};

const EVENT: &str = "device://event";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct VolumeSample {
    level: u32,
    muted: bool,
}

fn observe_volume(previous: &mut Option<VolumeSample>, current: VolumeSample) -> bool {
    match previous.replace(current) {
        Some(previous) => previous != current,
        None => false,
    }
}

fn observe_brightness(previous: &mut Option<u32>, current: u32) -> bool {
    match previous.replace(current) {
        Some(previous) => previous != current,
        None => false,
    }
}

pub fn spawn(app: tauri::AppHandle) {
    let volume_app = app.clone();
    if let Err(error) = thread::Builder::new()
        .name("hover-island-volume-monitor".into())
        .spawn(move || volume::run(volume_app))
    {
        eprintln!("Could not start volume change monitor: {error}");
    }
    if let Err(error) = thread::Builder::new()
        .name("hover-island-brightness-monitor".into())
        .spawn(move || brightness::run(app))
    {
        eprintln!("Could not start brightness change monitor: {error}");
    }
}

fn shutting_down(app: &tauri::AppHandle) -> bool {
    app.state::<AppState>().shutdown.load(Ordering::Acquire)
}

fn emit_change(app: &tauri::AppHandle, app_name: &str, title: String, body: String) {
    let state = app.state::<AppState>();
    let settings = state.settings.lock().unwrap();
    if settings.dnd || !settings.notifications.enabled || !settings.modules.notifications {
        return;
    }
    drop(settings);

    let timestamp = now_millis();
    let event = AppNotification {
        id: format!("system:{app_name}:{timestamp}"),
        app: app_name.to_string(),
        title,
        body,
        timestamp,
        icon: None,
    };
    let _ = app.emit(EVENT, event);
}

fn emit_volume(app: &tauri::AppHandle, sample: VolumeSample) {
    let title = if sample.muted {
        "Volume muted"
    } else {
        "Volume"
    }
    .to_string();
    let body = if sample.muted {
        format!("{}% · Muted", sample.level)
    } else {
        format!("{}%", sample.level)
    };
    emit_change(app, "Volume", title, body);
}

fn emit_brightness(app: &tauri::AppHandle, level: u32) {
    emit_change(
        app,
        "Brightness",
        "Brightness".to_string(),
        format!("{level}%"),
    );
}

#[cfg(target_os = "windows")]
mod volume {
    use super::{emit_volume, observe_volume, shutting_down, VolumeSample};
    use std::sync::mpsc::{self, Sender};
    use std::thread;
    use std::time::{Duration, Instant};
    use windows::core::implement;
    use windows::Win32::Media::Audio::Endpoints::{
        IAudioEndpointVolume, IAudioEndpointVolumeCallback, IAudioEndpointVolumeCallback_Impl,
    };
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED,
    };

    const DEFAULT_DEVICE_CHECK: Duration = Duration::from_secs(3);
    const RECONNECT_START: Duration = Duration::from_secs(3);
    const RECONNECT_MAX: Duration = Duration::from_secs(30);
    const FALLBACK_POLL: Duration = Duration::from_secs(3);

    #[implement(IAudioEndpointVolumeCallback)]
    struct Callback {
        sender: Sender<VolumeSample>,
    }

    impl IAudioEndpointVolumeCallback_Impl for Callback {
        fn OnNotify(
            &self,
            data: *mut windows::Win32::Media::Audio::AUDIO_VOLUME_NOTIFICATION_DATA,
        ) -> windows::core::Result<()> {
            if let Some(data) = unsafe { data.as_ref() } {
                let _ = self.sender.send(VolumeSample {
                    level: (data.fMasterVolume * 100.0).round().clamp(0.0, 100.0) as u32,
                    muted: data.bMuted.as_bool(),
                });
            }
            Ok(())
        }
    }

    struct Endpoint {
        id: String,
        volume: IAudioEndpointVolume,
        callback: IAudioEndpointVolumeCallback,
    }

    impl Drop for Endpoint {
        fn drop(&mut self) {
            let _ = unsafe { self.volume.UnregisterControlChangeNotify(&self.callback) };
        }
    }

    fn com_init() -> Result<(), String> {
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
            .map_err(|error| format!("COM initialization failed: {error}"))
    }

    fn current_default_endpoint_id(enumerator: &IMMDeviceEnumerator) -> Result<String, String> {
        let device = unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole) }
            .map_err(|error| format!("Default audio endpoint unavailable: {error}"))?;
        let native_id = unsafe { device.GetId() }
            .map_err(|error| format!("Default audio endpoint identity unavailable: {error}"))?;
        let value = unsafe { native_id.to_string() };
        unsafe { CoTaskMemFree(Some(native_id.0.cast())) };
        value.map_err(|error| format!("Default audio endpoint identity invalid: {error}"))
    }

    fn open_endpoint(
        enumerator: &IMMDeviceEnumerator,
        sender: Sender<VolumeSample>,
    ) -> Result<Endpoint, String> {
        let device = unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole) }
            .map_err(|error| format!("Default audio endpoint unavailable: {error}"))?;
        let native_id = unsafe { device.GetId() }
            .map_err(|error| format!("Default audio endpoint identity unavailable: {error}"))?;
        let id = unsafe { native_id.to_string() };
        unsafe { CoTaskMemFree(Some(native_id.0.cast())) };
        let id = id.map_err(|error| format!("Default audio endpoint identity invalid: {error}"))?;
        let volume: IAudioEndpointVolume = unsafe { device.Activate(CLSCTX_ALL, None) }
            .map_err(|error| format!("Default audio volume unavailable: {error}"))?;
        let callback: IAudioEndpointVolumeCallback = Callback { sender }.into();
        unsafe { volume.RegisterControlChangeNotify(&callback) }
            .map_err(|error| format!("Could not listen for volume changes: {error}"))?;
        Ok(Endpoint {
            id,
            volume,
            callback,
        })
    }

    fn initial_sample(volume: &IAudioEndpointVolume) -> Option<VolumeSample> {
        let level = unsafe { volume.GetMasterVolumeLevelScalar() }.ok()?;
        let muted = unsafe { volume.GetMute() }.ok()?.as_bool();
        Some(VolumeSample {
            level: (level * 100.0).round().clamp(0.0, 100.0) as u32,
            muted,
        })
    }

    pub(super) fn run(app: tauri::AppHandle) {
        if com_init().is_err() {
            fallback(&app);
            return;
        }
        struct ComApartment;
        impl Drop for ComApartment {
            fn drop(&mut self) {
                unsafe { windows::Win32::System::Com::CoUninitialize() };
            }
        }
        let _com = ComApartment;
        let enumerator: IMMDeviceEnumerator =
            match unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) } {
                Ok(value) => value,
                Err(_) => {
                    fallback(&app);
                    return;
                }
            };
        let (sender, receiver) = mpsc::channel();
        let mut previous = None;
        let mut endpoint: Option<Endpoint> = None;
        let mut reconnect = RECONNECT_START;
        let mut retry_at = Instant::now();
        let mut device_check_at = Instant::now();

        while !shutting_down(&app) {
            if endpoint.is_none() && Instant::now() >= retry_at {
                match open_endpoint(&enumerator, sender.clone()) {
                    Ok(opened) => {
                        if let Some(sample) = initial_sample(&opened.volume) {
                            let _ = observe_volume(&mut previous, sample); // Quiet baseline.
                        }
                        endpoint = Some(opened);
                        reconnect = RECONNECT_START;
                    }
                    Err(_) => {
                        retry_at = Instant::now() + reconnect;
                        reconnect = (reconnect * 2).min(RECONNECT_MAX);
                    }
                }
                device_check_at = Instant::now() + DEFAULT_DEVICE_CHECK;
            }

            if endpoint.is_some() && Instant::now() >= device_check_at {
                device_check_at = Instant::now() + DEFAULT_DEVICE_CHECK;
                let changed = endpoint
                    .as_ref()
                    .and_then(|active| {
                        current_default_endpoint_id(&enumerator)
                            .ok()
                            .map(|id| id != active.id)
                    })
                    .unwrap_or(true);
                if changed {
                    endpoint.take(); // Unregister before releasing the old endpoint.
                    retry_at = Instant::now();
                }
            }

            if endpoint.is_some() {
                match receiver.recv_timeout(Duration::from_millis(700)) {
                    Ok(mut sample) => {
                        // Collapse a burst of media-key callbacks to the newest
                        // value while keeping the callback itself nonblocking.
                        thread::sleep(Duration::from_millis(65));
                        while let Ok(next) = receiver.try_recv() {
                            sample = next;
                        }
                        if observe_volume(&mut previous, sample) {
                            emit_volume(&app, sample);
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        endpoint.take();
                        retry_at = Instant::now() + reconnect;
                        reconnect = (reconnect * 2).min(RECONNECT_MAX);
                    }
                }
            } else {
                thread::sleep(Duration::from_millis(200));
            }
        }
        endpoint.take();
    }

    fn fallback(app: &tauri::AppHandle) {
        let mut previous = None;
        let mut interval = FALLBACK_POLL;
        while !shutting_down(app) {
            let snapshot = crate::quick_controls::volume_status();
            if let (Some(level), Some(muted)) = (snapshot.level, snapshot.muted) {
                let sample = VolumeSample { level, muted };
                if observe_volume(&mut previous, sample) {
                    emit_volume(app, sample);
                }
                interval = FALLBACK_POLL;
            } else {
                interval = (interval * 2).min(RECONNECT_MAX);
            }
            thread::sleep(interval);
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod volume {
    pub(super) fn run(_: tauri::AppHandle) {}
}

#[cfg(target_os = "windows")]
mod brightness {
    use super::{emit_brightness, observe_brightness, shutting_down};
    use std::thread;
    use std::time::Duration;
    use windows::core::PCWSTR;
    use windows::core::{w, BSTR};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoSetProxyBlanket, CLSCTX_INPROC_SERVER,
        COINIT_MULTITHREADED, EOAC_NONE, RPC_C_AUTHN_LEVEL_CALL, RPC_C_IMP_LEVEL_IMPERSONATE,
    };
    use windows::Win32::System::Rpc::{RPC_C_AUTHN_WINNT, RPC_C_AUTHZ_NONE};
    use windows::Win32::System::Variant::{
        VariantChangeType, VariantClear, VARIANT, VAR_CHANGE_FLAGS, VT_I4,
    };
    use windows::Win32::System::Wmi::{
        IEnumWbemClassObject, IWbemClassObject, IWbemContext, IWbemLocator, IWbemServices,
        WbemLocator, WBEM_FLAG_FORWARD_ONLY, WBEM_FLAG_RETURN_IMMEDIATELY,
    };

    const WAIT_MS: i32 = 900;
    const RECONNECT_START: Duration = Duration::from_secs(3);
    const RECONNECT_MAX: Duration = Duration::from_secs(60);

    struct ComApartment;
    impl Drop for ComApartment {
        fn drop(&mut self) {
            unsafe { windows::Win32::System::Com::CoUninitialize() };
        }
    }

    fn wmi_services() -> Result<IWbemServices, String> {
        let locator: IWbemLocator =
            unsafe { CoCreateInstance(&WbemLocator, None, CLSCTX_INPROC_SERVER) }
                .map_err(|error| format!("WMI locator unavailable: {error}"))?;
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
        .map_err(|error| format!("WMI connection failed: {error}"))?;
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
        .map_err(|error| format!("WMI security setup failed: {error}"))?;
        Ok(services)
    }

    fn subscribe() -> Result<IEnumWbemClassObject, String> {
        let services = wmi_services()?;
        unsafe {
            services.ExecNotificationQuery(
                &BSTR::from("WQL"),
                &BSTR::from("SELECT * FROM WmiMonitorBrightnessEvent WHERE Active = TRUE"),
                WBEM_FLAG_FORWARD_ONLY | WBEM_FLAG_RETURN_IMMEDIATELY,
                None::<&IWbemContext>,
            )
        }
        .map_err(|error| format!("Brightness event subscription failed: {error}"))
    }

    fn next_event(source: &IEnumWbemClassObject) -> Result<Option<IWbemClassObject>, ()> {
        let mut objects: [Option<IWbemClassObject>; 1] = [None];
        let mut returned = 0u32;
        unsafe { source.Next(WAIT_MS, &mut objects, &mut returned) }
            .ok()
            .map_err(|_| ())?;
        Ok((returned > 0).then(|| objects[0].take()).flatten())
    }

    fn event_level(event: &IWbemClassObject) -> Option<u32> {
        let mut value = VARIANT::default();
        unsafe { event.Get(w!("Brightness"), 0, &mut value, None, None) }.ok()?;
        let mut converted = VARIANT::default();
        let result = unsafe {
            VariantChangeType(&mut converted, &value, VAR_CHANGE_FLAGS(0), VT_I4)
                .ok()
                .and_then(|_| {
                    let level = converted.Anonymous.Anonymous.Anonymous.lVal;
                    u32::try_from(level).ok().map(|level| level.min(100))
                })
        };
        unsafe {
            let _ = VariantClear(&mut converted);
            let _ = VariantClear(&mut value);
        }
        result
    }

    pub(super) fn run(app: tauri::AppHandle) {
        if unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_err() {
            fallback(&app);
            return;
        }
        let _com = ComApartment;
        let mut previous = crate::quick_controls::brightness_status().level;
        let mut delay = RECONNECT_START;
        while !shutting_down(&app) {
            match subscribe() {
                Ok(source) => {
                    delay = RECONNECT_START;
                    while !shutting_down(&app) {
                        match next_event(&source) {
                            Ok(Some(event)) => {
                                if let Some(level) = event_level(&event) {
                                    if observe_brightness(&mut previous, level) {
                                        emit_brightness(&app, level);
                                    }
                                }
                            }
                            Ok(None) => {}
                            Err(()) => break,
                        }
                    }
                    if !shutting_down(&app) {
                        fallback_for(&app, delay, &mut previous);
                        delay = (delay * 2).min(RECONNECT_MAX);
                    }
                }
                Err(_) => {
                    // If WMI notifications are unavailable, use the existing
                    // read-only WMI snapshot at a low rate and back off on errors.
                    fallback_for(&app, delay, &mut previous);
                    delay = (delay * 2).min(RECONNECT_MAX);
                }
            }
        }
    }

    fn fallback_for(app: &tauri::AppHandle, delay: Duration, previous: &mut Option<u32>) {
        let mut remaining = delay;
        while remaining > Duration::ZERO && !shutting_down(app) {
            let quantum = remaining.min(Duration::from_millis(200));
            thread::sleep(quantum);
            remaining = remaining.saturating_sub(quantum);
        }
        if shutting_down(app) {
            return;
        }
        let status = crate::quick_controls::brightness_status();
        if let Some(level) = status.level {
            if observe_brightness(previous, level) {
                emit_brightness(app, level);
            }
        }
    }

    fn fallback(app: &tauri::AppHandle) {
        let mut previous = None;
        let mut delay = Duration::from_secs(3);
        while !shutting_down(app) {
            let status = crate::quick_controls::brightness_status();
            if let Some(level) = status.level {
                if observe_brightness(&mut previous, level) {
                    emit_brightness(app, level);
                }
                delay = Duration::from_secs(3);
            } else {
                delay = (delay * 2).min(RECONNECT_MAX);
            }
            let mut remaining = delay;
            while remaining > Duration::ZERO && !shutting_down(app) {
                let quantum = remaining.min(Duration::from_millis(200));
                thread::sleep(quantum);
                remaining = remaining.saturating_sub(quantum);
            }
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod brightness {
    pub(super) fn run(_: tauri::AppHandle) {}
}

#[cfg(test)]
mod tests {
    use super::{observe_brightness, observe_volume, VolumeSample};

    #[test]
    fn volume_baseline_is_quiet_and_only_changes_emit() {
        let mut previous = None;
        let sample = VolumeSample {
            level: 46,
            muted: false,
        };
        assert!(!observe_volume(&mut previous, sample));
        assert!(!observe_volume(&mut previous, sample));
        assert!(observe_volume(
            &mut previous,
            VolumeSample {
                level: 47,
                muted: false,
            }
        ));
        assert!(observe_volume(
            &mut previous,
            VolumeSample {
                level: 47,
                muted: true,
            }
        ));
    }

    #[test]
    fn brightness_baseline_is_quiet_and_only_changes_emit() {
        let mut previous = None;
        assert!(!observe_brightness(&mut previous, 72));
        assert!(!observe_brightness(&mut previous, 72));
        assert!(observe_brightness(&mut previous, 71));
    }
}
