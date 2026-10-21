//! Opt-in-by-lifecycle system-output spectrum capture for the media visualizer.
//! This uses WASAPI render-loopback, never a microphone or input endpoint.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::Emitter;
use windows::core::{w, GUID};
use windows::Win32::Foundation::HANDLE;
use windows::Win32::Media::Audio::{
    eCommunications, eConsole, eMultimedia, eRender, ERole, IAudioCaptureClient, IAudioClient,
    IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY,
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_LOOPBACK, DEVICE_STATE_ACTIVE, WAVEFORMATEX,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED,
};
use windows::Win32::System::Threading::{
    AvRevertMmThreadCharacteristics, AvSetMmThreadCharacteristicsW,
};

const BAND_COUNT: usize = 24;
const FFT_SIZE: usize = 2048;
const WAVEFORM_SIZE: usize = 128;
const EMIT_INTERVAL: Duration = Duration::from_micros(33_333);
const MAX_ENDPOINTS: usize = 8;
const DEVICE_POLL_INTERVAL: Duration = Duration::from_millis(500);
const REOPEN_DELAY: Duration = Duration::from_millis(250);
/// While no endpoint can be opened, still emit a quiet frame at this rate so the
/// frontend watchdog can tell "idle" from "dead".
const IDLE_HEARTBEAT: Duration = Duration::from_millis(250);
const SPECTRUM_EVENT: &str = "audio://spectrum";
const ERROR_EVENT: &str = "audio://spectrum-error";
const READY_EVENT: &str = "audio://capture-ready";

static RUNNER: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);

#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SpectrumPayload {
    bands: [f32; BAND_COUNT],
    #[serde(serialize_with = "serialize_waveform")]
    waveform: [f32; WAVEFORM_SIZE],
    rms: f32,
    peak: f32,
    energy: f32,
    bass: f32,
    mid: f32,
    treble: f32,
    flux: f32,
    onset: f32,
    sequence: u64,
    beat_sequence: u64,
    beat_at_ms: u64,
    captured_at_ms: u64,
    sample_rate: u32,
}

impl Default for SpectrumPayload {
    fn default() -> Self {
        Self {
            bands: [0.0; BAND_COUNT],
            waveform: [0.0; WAVEFORM_SIZE],
            rms: 0.0,
            peak: 0.0,
            energy: 0.0,
            bass: 0.0,
            mid: 0.0,
            treble: 0.0,
            flux: 0.0,
            onset: 0.0,
            sequence: 0,
            beat_sequence: 0,
            beat_at_ms: 0,
            captured_at_ms: epoch_ms(),
            sample_rate: 0,
        }
    }
}

fn serialize_waveform<S: serde::Serializer>(
    waveform: &[f32; WAVEFORM_SIZE],
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serde::Serialize::serialize(waveform.as_slice(), serializer)
}

fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[link(name = "kernel32")]
extern "system" {
    fn QueryPerformanceCounter(value: *mut i64) -> i32;
    fn QueryPerformanceFrequency(value: *mut i64) -> i32;
}

fn performance_time_100ns() -> Option<u64> {
    static FREQUENCY: OnceLock<Option<i64>> = OnceLock::new();
    let frequency = (*FREQUENCY.get_or_init(|| {
        let mut value = 0i64;
        if unsafe { QueryPerformanceFrequency(&mut value) } != 0 && value > 0 {
            Some(value)
        } else {
            None
        }
    }))?;
    let mut counter = 0i64;
    if unsafe { QueryPerformanceCounter(&mut counter) } == 0 || counter < 0 {
        return None;
    }
    // Multiply in u128: a long-running machine can overflow u64 here before
    // division even though its converted QPC timestamp fits comfortably.
    u64::try_from(counter as u128 * 10_000_000 / frequency as u128).ok()
}

#[tauri::command]
pub fn audio_loopback_start(app: tauri::AppHandle) -> Result<(), String> {
    let mut runner = RUNNER
        .lock()
        .map_err(|_| "system audio capture state is unavailable".to_string())?;
    if runner
        .as_ref()
        .is_some_and(|active| active.load(Ordering::Acquire))
    {
        return Ok(());
    }
    let active = Arc::new(AtomicBool::new(true));
    *runner = Some(active.clone());
    drop(runner);
    let worker_active = active.clone();

    thread::Builder::new()
        .name("hover-island-audio-spectrum".into())
        .spawn(move || {
            if let Err(error) = capture_loop(&app, &worker_active) {
                if worker_active.load(Ordering::Acquire) {
                    let _ = app.emit(ERROR_EVENT, summarize_error(error));
                }
            }
            worker_active.store(false, Ordering::Release);
            if let Ok(mut slot) = RUNNER.lock() {
                if slot
                    .as_ref()
                    .is_some_and(|current| Arc::ptr_eq(current, &worker_active))
                {
                    *slot = None;
                }
            }
        })
        .map_err(|error| {
            active.store(false, Ordering::Release);
            if let Ok(mut slot) = RUNNER.lock() {
                if slot
                    .as_ref()
                    .is_some_and(|current| Arc::ptr_eq(current, &active))
                {
                    *slot = None;
                }
            }
            format!("could not start system audio capture: {error}")
        })?;
    Ok(())
}

#[tauri::command]
pub fn audio_loopback_stop() {
    if let Ok(mut slot) = RUNNER.lock() {
        if let Some(active) = slot.take() {
            // Clear the slot before signaling the old worker so a rapid start request
            // always creates a replacement, even while the previous thread is unwinding.
            active.store(false, Ordering::Release);
        }
    }
}

fn summarize_error(error: String) -> String {
    const MAX: usize = 220;
    let one_line = error.replace(['\r', '\n'], " ");
    one_line.chars().take(MAX).collect()
}

fn hresult_error(context: &str, error: windows::core::Error) -> String {
    format!("{context} (HRESULT 0x{:08X})", error.code().0 as u32)
}

/// Read output endpoints, including a non-default device selected for an app in
/// Windows' volume mixer. Capture exists only while a visual surface subscribes.
fn capture_loop(app: &tauri::AppHandle, active: &AtomicBool) -> Result<(), String> {
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
        .map_err(|error| hresult_error("COM initialization failed", error))?;
    let _com = ComApartment;
    let _scheduler = MultimediaScheduler::acquire();

    let enumerator: IMMDeviceEnumerator = unsafe {
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
            .map_err(|error| hresult_error("Audio device enumeration failed", error))?
    };
    let mut last_error: Option<String> = None;
    while active.load(Ordering::Acquire) {
        let endpoints = match default_render_endpoints(&enumerator) {
            Ok(endpoints) => endpoints,
            Err(error) => {
                if !active.load(Ordering::Acquire) {
                    break;
                }
                if last_error.as_deref() != Some(error.as_str()) {
                    let _ = app.emit(ERROR_EVENT, summarize_error(error.clone()));
                    last_error = Some(error);
                }
                emit_zeros(app);
                thread::sleep(REOPEN_DELAY);
                continue;
            }
        };
        let expected_ids: Vec<String> = endpoints.iter().map(|(_, id, _)| id.clone()).collect();
        let mut streams = Vec::with_capacity(endpoints.len());
        let mut endpoint_error = None;
        for (device, _, _) in &endpoints {
            if !active.load(Ordering::Acquire) {
                break;
            }
            let slot = EndpointSlot::open(device);
            if slot.stream.is_none() {
                endpoint_error = slot.last_error.clone();
            }
            streams.push(slot);
        }
        if streams.iter().all(|slot| slot.stream.is_none()) {
            if !active.load(Ordering::Acquire) {
                break;
            }
            if let Some(error) = endpoint_error {
                if last_error.as_deref() != Some(error.as_str()) {
                    let _ = app.emit(ERROR_EVENT, summarize_error(error.clone()));
                    last_error = Some(error);
                }
            }
            idle_with_heartbeat(app, active, Duration::from_secs(2));
            continue;
        }
        last_error = None;
        if !active.load(Ordering::Acquire) {
            break;
        }
        let _ = app.emit(READY_EVENT, ());
        if let Err(error) = pump_endpoints(app, active, &enumerator, &expected_ids, &mut streams) {
            if !active.load(Ordering::Acquire) {
                break;
            }
            if last_error.as_deref() != Some(error.as_str()) {
                let _ = app.emit(ERROR_EVENT, summarize_error(error.clone()));
                last_error = Some(error);
            }
            emit_zeros(app);
            thread::sleep(REOPEN_DELAY);
        }
        // Dropping `streams` stops every render stream before the next attempt.
    }
    Ok(())
}

fn default_render_endpoints(
    enumerator: &IMMDeviceEnumerator,
) -> Result<Vec<(IMMDevice, String, ERole)>, String> {
    let mut endpoints = Vec::with_capacity(MAX_ENDPOINTS);
    for role in [eConsole, eMultimedia, eCommunications] {
        let device = unsafe { enumerator.GetDefaultAudioEndpoint(eRender, role) };
        let Ok(device) = device else { continue };
        let Ok(id) = get_endpoint_id(&device) else {
            continue;
        };
        if !endpoints.iter().any(|(_, known_id, _)| known_id == &id) {
            endpoints.push((device, id, role));
        }
    }
    // Defaults alone miss Spotify/browser playback routed to a different output.
    // Bound concurrent streams to avoid opening an unbounded virtual-device list.
    if let Ok(collection) = unsafe { enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) } {
        let count = unsafe { collection.GetCount() }.unwrap_or(0);
        for index in 0..count {
            if endpoints.len() >= MAX_ENDPOINTS {
                break;
            }
            let Ok(device) = (unsafe { collection.Item(index) }) else {
                continue;
            };
            let Ok(id) = get_endpoint_id(&device) else {
                continue;
            };
            if !endpoints.iter().any(|(_, known, _)| known == &id) {
                endpoints.push((device, id, eConsole));
            }
        }
    }
    if endpoints.is_empty() {
        Err(
            "no default render endpoint is available for Console, Multimedia, or Communications"
                .into(),
        )
    } else {
        Ok(endpoints)
    }
}

fn get_endpoint_id(device: &IMMDevice) -> Result<String, String> {
    let native_id = unsafe { device.GetId() }
        .map_err(|error| hresult_error("Could not read the audio endpoint identity", error))?;
    let id = unsafe { native_id.to_string() }
        .map_err(|_| "Could not decode the audio endpoint identity".to_string());
    unsafe { CoTaskMemFree(Some(native_id.0.cast())) };
    id
}

/// Keep a failing output independent of healthy playback on other devices.
struct EndpointSlot {
    device: IMMDevice,
    stream: Option<EndpointStream>,
    last_error: Option<String>,
    retry_at: Instant,
    retry_count: u32,
}

impl EndpointSlot {
    fn open(device: &IMMDevice) -> Self {
        let mut slot = Self {
            device: device.clone(),
            stream: None,
            last_error: None,
            retry_at: Instant::now(),
            retry_count: 0,
        };
        slot.poll();
        slot
    }

    fn fail(&mut self, error: String) {
        self.stream = None;
        self.last_error = Some(error);
        self.retry_count = self.retry_count.saturating_add(1);
        self.retry_at =
            Instant::now() + Duration::from_secs(2u64.pow(self.retry_count.min(4)).min(15));
    }

    fn poll(&mut self) {
        if let Some(stream) = &mut self.stream {
            if let Err(error) = stream.drain() {
                self.fail(error);
            }
            return;
        }
        if Instant::now() < self.retry_at {
            return;
        }
        match EndpointStream::open(&self.device) {
            Ok(stream) => {
                self.stream = Some(stream);
                self.last_error = None;
                self.retry_count = 0;
            }
            Err(error) => self.fail(error),
        }
    }
}

/// One open shared-mode loopback capture for one render endpoint.
struct EndpointStream {
    _running: RunningStream,
    capture: IAudioCaptureClient,
    samples: Vec<f32>,
    channel_samples: Vec<Vec<f32>>,
    write_index: usize,
    buffered_frames: usize,
    analysed_frames: usize,
    previous_bands: [f32; BAND_COUNT],
    flux_floor: f32,
    last_analysis_at: Instant,
    last_onset_at: Option<Instant>,
    cached_frame: SpectrumPayload,
    sample_rate: f32,
    channels: usize,
    bytes_per_sample: usize,
    frame_bytes: usize,
    sample_format: SampleFormat,
    last_packet_at: Instant,
    packets_seen: usize,
    frames_seen: usize,
    timestamped_packets: usize,
    timestamp_fallback_packets: usize,
    max_sample_age_ms: u128,
}

impl EndpointStream {
    fn open(device: &IMMDevice) -> Result<Self, String> {
        let client: IAudioClient = unsafe {
            device
                .Activate(CLSCTX_ALL, None)
                .map_err(|error| hresult_error("Could not open default audio output", error))?
        };
        let format = unsafe {
            client
                .GetMixFormat()
                .map_err(|error| hresult_error("Could not read the audio output format", error))?
        };
        if format.is_null() {
            return Err("Windows returned an empty audio output format".into());
        }
        let fmt = unsafe { format.read_unaligned() };
        let sample_format = match unsafe { sample_format(format, &fmt) } {
            Ok(format) => format,
            Err(error) => {
                unsafe { CoTaskMemFree(Some(format.cast())) };
                return Err(error);
            }
        };
        let channels = usize::from(fmt.nChannels);
        let bytes_per_sample = usize::from(fmt.wBitsPerSample / 8);
        let sample_format_supported = match sample_format {
            SampleFormat::Float => fmt.wBitsPerSample == 32,
            SampleFormat::Pcm => matches!(fmt.wBitsPerSample, 16 | 24 | 32),
        };
        if channels == 0
            || bytes_per_sample == 0
            || !sample_format_supported
            || fmt.nBlockAlign == 0
            || usize::from(fmt.nBlockAlign) < channels * bytes_per_sample
            || fmt.nSamplesPerSec == 0
        {
            unsafe { CoTaskMemFree(Some(format.cast())) };
            return Err("Windows returned an unsupported audio output format".into());
        }
        let sample_rate = fmt.nSamplesPerSec as f32;
        let frame_bytes = usize::from(fmt.nBlockAlign);

        let init_result = unsafe {
            client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK,
                1_000_000,
                0,
                format,
                None,
            )
        };
        unsafe { CoTaskMemFree(Some(format.cast())) };
        init_result
            .map_err(|error| hresult_error("Could not initialize system audio loopback", error))?;

        let capture: IAudioCaptureClient = unsafe {
            client.GetService().map_err(|error| {
                hresult_error("Could not open the system audio capture stream", error)
            })?
        };
        unsafe {
            client
                .Start()
                .map_err(|error| hresult_error("Could not start system audio loopback", error))?;
        }
        Ok(Self {
            _running: RunningStream(client),
            capture,
            samples: Vec::with_capacity(FFT_SIZE),
            channel_samples: vec![vec![0.0; FFT_SIZE]; channels.min(8)],
            write_index: 0,
            buffered_frames: 0,
            analysed_frames: 0,
            previous_bands: [0.0; BAND_COUNT],
            flux_floor: 0.0,
            last_analysis_at: Instant::now(),
            last_onset_at: None,
            cached_frame: SpectrumPayload::default(),
            sample_rate,
            channels,
            bytes_per_sample,
            frame_bytes,
            sample_format,
            last_packet_at: Instant::now(),
            packets_seen: 0,
            frames_seen: 0,
            timestamped_packets: 0,
            timestamp_fallback_packets: 0,
            max_sample_age_ms: 0,
        })
    }

    /// Drain every queued packet into the rolling FFT window. Each call is
    /// bounded so one busy endpoint cannot starve the others.
    fn drain(&mut self) -> Result<(), String> {
        for _ in 0..32 {
            let packet = unsafe { self.capture.GetNextPacketSize() }
                .map_err(|error| hresult_error("System audio capture failed", error))?;
            if packet == 0 {
                break;
            }
            let mut data = std::ptr::null_mut();
            let mut frames = 0u32;
            let mut flags = 0u32;
            let mut qpc_position = 0u64;
            unsafe {
                self.capture
                    .GetBuffer(
                        &mut data,
                        &mut frames,
                        &mut flags,
                        None,
                        Some(&mut qpc_position),
                    )
                    .map_err(|error| hresult_error("Could not read system audio samples", error))?;
            }
            if flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0 as u32 != 0
                || self.last_packet_at.elapsed() >= Duration::from_millis(160)
            {
                self.buffered_frames = 0;
                self.previous_bands.fill(0.0);
                self.flux_floor = 0.0;
            }
            if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 == 0 && !data.is_null() {
                let bytes = frames as usize * self.frame_bytes;
                let raw = unsafe { std::slice::from_raw_parts(data, bytes) };
                // A fixed ring bounds memory and avoids repeatedly shifting the
                // audio window. Preserve channels: averaging L/R before FFT can
                // erase phase-inverted music completely.
                let skip = (frames as usize).saturating_sub(FFT_SIZE);
                for frame in raw.chunks_exact(self.frame_bytes).skip(skip) {
                    for channel in 0..self.channel_samples.len() {
                        let begin = channel * self.bytes_per_sample;
                        self.channel_samples[channel][self.write_index] = decode_sample(
                            &frame[begin..begin + self.bytes_per_sample],
                            self.sample_format,
                        );
                    }
                    self.write_index = (self.write_index + 1) % FFT_SIZE;
                    self.buffered_frames = (self.buffered_frames + 1).min(FFT_SIZE);
                }
            } else {
                let silence_frames = (frames as usize).min(FFT_SIZE);
                for _ in 0..silence_frames {
                    for channel in &mut self.channel_samples {
                        channel[self.write_index] = 0.0;
                    }
                    self.write_index = (self.write_index + 1) % FFT_SIZE;
                    self.buffered_frames = (self.buffered_frames + 1).min(FFT_SIZE);
                }
            }
            unsafe {
                self.capture.ReleaseBuffer(frames).map_err(|error| {
                    hresult_error("Could not release the audio capture buffer", error)
                })?;
            }
            self.packets_seen += 1;
            self.frames_seen += frames as usize;
            let now = Instant::now();
            let age =
                if flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR.0 as u32 == 0 && qpc_position > 0 {
                    performance_time_100ns().and_then(|current| {
                        // WASAPI's QPC time is the packet's first sample, in 100 ns
                        // units. Compare its final sample with the same QPC clock.
                        let end = qpc_position.saturating_add(
                            (frames as f64 / self.sample_rate as f64 * 10_000_000.0) as u64,
                        );
                        if end > current.saturating_add(10_000_000) {
                            return None;
                        }
                        Some(Duration::from_nanos(
                            current.saturating_sub(end).saturating_mul(100),
                        ))
                    })
                } else {
                    None
                };
            if let Some(age) = age {
                self.timestamped_packets += 1;
                self.max_sample_age_ms = self.max_sample_age_ms.max(age.as_millis());
                self.last_packet_at = now.checked_sub(age).unwrap_or(now);
            } else {
                // Some output drivers explicitly flag unreliable timestamps.
                self.timestamp_fallback_packets += 1;
                self.last_packet_at = now;
            }
        }
        Ok(())
    }

    /// The newest measured bands while this endpoint is still actively
    /// rendering. A short packet gap holds the last frame instead of flickering.
    fn frame(&mut self) -> Option<SpectrumPayload> {
        if self.last_packet_at.elapsed() >= Duration::from_millis(160) {
            self.buffered_frames = 0;
            self.previous_bands.fill(0.0);
            self.flux_floor = 0.0;
            self.last_onset_at = None;
            return None;
        }
        if self.buffered_frames < FFT_SIZE {
            return None;
        }
        if self.frames_seen == self.analysed_frames {
            let mut cached = self.cached_frame.clone();
            cached.onset = 0.0;
            return Some(cached);
        }
        self.analysed_frames = self.frames_seen;
        // Select the channel carrying the most actual signal, rather than
        // introducing artificial frequencies with a rectified stereo downmix.
        let channel_energy: [f32; 8] = std::array::from_fn(|index| {
            self.channel_samples.get(index).map_or(0.0, |values| {
                values.iter().map(|value| value * value).sum::<f32>() / FFT_SIZE as f32
            })
        });
        let dominant = (0..self.channel_samples.len())
            .max_by(|left, right| channel_energy[*left].total_cmp(&channel_energy[*right]))?;
        let source = &self.channel_samples[dominant];
        self.samples.clear();
        self.samples
            .extend((0..FFT_SIZE).map(|index| source[(self.write_index + index) % FFT_SIZE]));
        let dt = self
            .last_analysis_at
            .elapsed()
            .as_secs_f32()
            .clamp(0.001, 0.2);
        self.last_analysis_at = Instant::now();
        let mut frame = analyse(&self.samples, self.sample_rate);
        // Use the dominant real channel for the waveform, but preserve frequency
        // content from quieter channels too (for example, right-channel hi-hats
        // under a left-channel kick). Combining measured magnitudes cannot phase
        // cancel and avoids false spectral jumps when channel dominance changes.
        let mut scratch = [0.0f32; FFT_SIZE];
        for (index, channel) in self.channel_samples.iter().enumerate() {
            if index == dominant || channel_energy[index] <= 0.00000001 {
                continue;
            }
            for (offset, sample) in scratch.iter_mut().enumerate() {
                *sample = channel[(self.write_index + offset) % FFT_SIZE];
            }
            let other = analyse(&scratch, self.sample_rate);
            for (target, measured) in frame.bands.iter_mut().zip(other.bands) {
                *target = target.max(measured);
            }
            frame.bass = frame.bass.max(other.bass);
            frame.mid = frame.mid.max(other.mid);
            frame.treble = frame.treble.max(other.treble);
            frame.peak = frame.peak.max(other.peak);
        }
        let flux = frame
            .bands
            .iter()
            .zip(self.previous_bands)
            .enumerate()
            .map(|(index, (value, previous))| {
                (value - previous).max(0.0) * if index < 9 { 1.6 } else { 0.75 }
            })
            .sum::<f32>()
            / BAND_COUNT as f32;
        let threshold = (self.flux_floor * 1.65 + 0.004).max(0.012);
        let recovered = self
            .last_onset_at
            .is_none_or(|previous| previous.elapsed() >= Duration::from_millis(180));
        if recovered && frame.rms > 0.00015 && flux > threshold {
            frame.onset = ((flux - threshold) / (threshold * 2.0).max(0.035)).clamp(0.0, 1.0);
            self.last_onset_at = Some(Instant::now());
        }
        self.flux_floor += (flux - self.flux_floor) * (1.0 - (-dt / 0.9).exp());
        self.previous_bands = frame.bands;
        frame.flux = (flux * 5.0).clamp(0.0, 1.0);
        frame.captured_at_ms =
            epoch_ms().saturating_sub(self.last_packet_at.elapsed().as_millis() as u64);
        self.cached_frame = frame.clone();
        Some(frame)
    }

    fn peak(&self) -> f32 {
        self.samples
            .iter()
            .fold(0.0f32, |peak, sample| peak.max(sample.abs()))
    }
}

fn emit_zeros(app: &tauri::AppHandle) {
    let _ = app.emit(SPECTRUM_EVENT, SpectrumPayload::default());
}

/// How many heartbeat steps cover `total` (never fewer than one, bounded).
fn heartbeat_steps(total: Duration, step: Duration) -> u32 {
    let step_ms = step.as_millis().max(1);
    ((total.as_millis() + step_ms - 1) / step_ms).clamp(1, 1_000) as u32
}

/// Wait for `total` while emitting quiet frames, returning early once capture stops.
fn idle_with_heartbeat(app: &tauri::AppHandle, active: &AtomicBool, total: Duration) {
    for _ in 0..heartbeat_steps(total, IDLE_HEARTBEAT) {
        if !active.load(Ordering::Acquire) {
            return;
        }
        emit_zeros(app);
        thread::sleep(IDLE_HEARTBEAT);
    }
}

/// The bounded active output set, with role defaults first.
fn current_default_ids(enumerator: &IMMDeviceEnumerator) -> Vec<String> {
    default_render_endpoints(enumerator)
        .unwrap_or_default()
        .into_iter()
        .map(|(_, id, _)| id)
        .collect()
}

/// Merge actual output spectra without diluting music with other silent devices.
/// The strongest endpoint supplies waveform and envelopes; frequency bands use
/// each endpoint's maximum and onsets retain a global refractory interval.
fn pump_endpoints(
    app: &tauri::AppHandle,
    active: &AtomicBool,
    enumerator: &IMMDeviceEnumerator,
    expected_ids: &[String],
    streams: &mut [EndpointSlot],
) -> Result<(), String> {
    let mut last_emit = Instant::now();
    let mut last_device_check = Instant::now();
    let mut sequence = 0u64;
    let mut beat_sequence = 0u64;
    let mut beat_at_ms = 0u64;
    let mut ready = true;
    while active.load(Ordering::Acquire) {
        if last_device_check.elapsed() >= DEVICE_POLL_INTERVAL {
            last_device_check = Instant::now();
            let current = current_default_ids(enumerator);
            if current.len() != expected_ids.len()
                || expected_ids.iter().any(|id| !current.contains(id))
            {
                return Ok(());
            }
        }
        for slot in streams.iter_mut() {
            slot.poll();
        }
        let healthy = streams.iter().any(|slot| slot.stream.is_some());
        if healthy != ready {
            ready = healthy;
            if healthy {
                let _ = app.emit(READY_EVENT, ());
            } else {
                let error = streams
                    .iter()
                    .find_map(|slot| slot.last_error.clone())
                    .unwrap_or_else(|| "System audio outputs are reconnecting".into());
                let _ = app.emit(ERROR_EVENT, summarize_error(error));
            }
        }
        if last_emit.elapsed() >= EMIT_INTERVAL {
            let mut output = SpectrumPayload::default();
            let mut bands = [0.0f32; BAND_COUNT];
            let mut onset = 0.0f32;
            let mut flux = 0.0f32;
            for stream in streams.iter_mut().filter_map(|slot| slot.stream.as_mut()) {
                if let Some(frame) = stream.frame() {
                    for (target, value) in bands.iter_mut().zip(frame.bands) {
                        if value > *target {
                            *target = value;
                        }
                    }
                    onset = onset.max(frame.onset);
                    flux = flux.max(frame.flux);
                    if frame.rms > output.rms {
                        output = frame;
                    }
                }
            }
            output.bands = bands;
            output.flux = flux;
            output.onset = onset;
            sequence += 1;
            if onset > 0.0 && output.captured_at_ms.saturating_sub(beat_at_ms) >= 180 {
                beat_sequence += 1;
                beat_at_ms = output.captured_at_ms;
            } else {
                output.onset = 0.0;
            }
            output.sequence = sequence;
            output.beat_sequence = beat_sequence;
            output.beat_at_ms = beat_at_ms;
            if active.load(Ordering::Acquire) {
                let _ = app.emit(SPECTRUM_EVENT, output);
            }
            last_emit = Instant::now();
        }
        thread::sleep(Duration::from_millis(6));
    }
    Ok(())
}

/// Bounded, read-only verification of the same capture and analyser used by the
/// visualiser. Returns aggregate metadata only; PCM/waveforms are never retained
/// or written, and this does not start playback or modify output volume.
pub fn diagnostics() -> Result<serde_json::Value, String> {
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
        .map_err(|error| hresult_error("COM initialization failed", error))?;
    let _com = ComApartment;
    let _scheduler = MultimediaScheduler::acquire();
    let enumerator: IMMDeviceEnumerator = unsafe {
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
            .map_err(|error| hresult_error("Audio device enumeration failed", error))?
    };
    let endpoints = default_render_endpoints(&enumerator)?;
    let mut streams = Vec::new();
    let mut errors = Vec::new();
    for (index, (device, _, _)) in endpoints.iter().enumerate() {
        match EndpointStream::open(device) {
            Ok(stream) => streams.push((index, stream)),
            Err(error) => errors.push(format!("output {index}: {error}")),
        }
    }
    if streams.is_empty() {
        return Err(errors.join("; "));
    }
    let started = Instant::now();
    let mut last_frame = Instant::now();
    let mut last_tick = Instant::now();
    let mut ticks = 0usize;
    let mut max_pump_gap_ms = 0u128;
    let mut frames = 0usize;
    let mut sounding_frames = 0usize;
    let mut onset_count = 0usize;
    let mut onset_max = 0.0f32;
    let mut rms_max = 0.0f32;
    let mut rms_sum = 0.0f32;
    let mut rms_min = f32::MAX;
    let mut peak_max = 0.0f32;
    let mut bands_max = [0.0f32; BAND_COUNT];
    let mut flux_max = 0.0f32;
    while started.elapsed() < Duration::from_secs(3) {
        max_pump_gap_ms = max_pump_gap_ms.max(last_tick.elapsed().as_millis());
        last_tick = Instant::now();
        ticks += 1;
        for (index, stream) in &mut streams {
            if let Err(error) = stream.drain() {
                let message = format!("output {index}: {error}");
                if !errors.contains(&message) {
                    errors.push(message);
                }
            }
        }
        if last_frame.elapsed() >= EMIT_INTERVAL {
            let mut rms = 0.0f32;
            let mut onset = 0.0f32;
            for (_, stream) in &mut streams {
                if let Some(frame) = stream.frame() {
                    rms = rms.max(frame.rms);
                    peak_max = peak_max.max(frame.peak);
                    flux_max = flux_max.max(frame.flux);
                    onset = onset.max(frame.onset);
                    for (max, value) in bands_max.iter_mut().zip(frame.bands) {
                        *max = max.max(value);
                    }
                }
            }
            frames += 1;
            if rms > 0.00015 {
                sounding_frames += 1;
            }
            if onset > 0.0 {
                onset_count += 1;
            }
            onset_max = onset_max.max(onset);
            rms_max = rms_max.max(rms);
            rms_min = rms_min.min(rms);
            rms_sum += rms;
            last_frame = Instant::now();
        }
        thread::sleep(Duration::from_millis(6));
    }
    let outputs: Vec<_> = streams
        .iter()
        .map(|(index, stream)| {
            serde_json::json!({
                "index": index, "sampleRate": stream.sample_rate, "channels": stream.channels,
                "packets": stream.packets_seen, "sampleFrames": stream.frames_seen,
                "timestampedPackets": stream.timestamped_packets,
                "timestampFallbackPackets": stream.timestamp_fallback_packets,
                "maxSampleAgeMs": stream.max_sample_age_ms,
            })
        })
        .collect();
    Ok(serde_json::json!({
        "capture": "WASAPI render loopback; all active outputs, at most 8",
        "durationMs": started.elapsed().as_millis(), "analysisFftSize": FFT_SIZE,
        "analysisFrames": frames, "soundingFrames": sounding_frames,
        "state": if sounding_frames > 0 { "active system playback measured" } else { "silence; no active playback measured" },
        "rms": { "min": if frames > 0 { rms_min } else { 0.0 }, "mean": rms_sum / frames.max(1) as f32, "max": rms_max },
        "peakMax": peak_max, "bandsMax": bands_max, "fluxMax": flux_max,
        "onsetCount": onset_count, "onsetMax": onset_max,
        "pumpTicks": ticks, "maxPumpGapMs": max_pump_gap_ms,
        "endpointsFound": endpoints.len(), "endpointsOpened": streams.len(),
        "outputs": outputs, "errors": errors,
        "privacy": "Aggregate metrics only. No microphone, recording, playback, or volume change.",
    }))
}

struct ComApartment;

/// Let Windows schedule the short sample pump as audio work under UI load.
/// This is an optional, thread-local MMCSS hint, never a process-wide priority.
struct MultimediaScheduler(Option<HANDLE>);

impl MultimediaScheduler {
    fn acquire() -> Self {
        let mut index = 0;
        Self(unsafe { AvSetMmThreadCharacteristicsW(w!("Audio"), &mut index) }.ok())
    }
}

impl Drop for MultimediaScheduler {
    fn drop(&mut self) {
        if let Some(handle) = self.0 {
            let _ = unsafe { AvRevertMmThreadCharacteristics(handle) };
        }
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe { windows::Win32::System::Com::CoUninitialize() };
    }
}

struct RunningStream(IAudioClient);

impl Drop for RunningStream {
    fn drop(&mut self) {
        let _ = unsafe { self.0.Stop() };
    }
}

#[derive(Clone, Copy)]
enum SampleFormat {
    Float,
    Pcm,
}

unsafe fn sample_format(
    format: *const WAVEFORMATEX,
    fmt: &WAVEFORMATEX,
) -> Result<SampleFormat, String> {
    match fmt.wFormatTag {
        3 => Ok(SampleFormat::Float),
        1 => Ok(SampleFormat::Pcm),
        0xfffe => {
            if fmt.cbSize < 22 {
                return Err("Windows returned a truncated extensible audio format".into());
            }
            // WAVEFORMATEXTENSIBLE begins with WAVEFORMATEX and places the subtype GUID after
            // the valid-bits and channel-mask fields.
            let extensible = format
                .cast::<windows::Win32::Media::Audio::WAVEFORMATEXTENSIBLE>()
                .read_unaligned();
            let sub_format = std::ptr::read_unaligned(std::ptr::addr_of!(extensible.SubFormat));
            let float_subtype = GUID::from_u128(0x00000003_0000_0010_8000_00aa00389b71);
            let pcm_subtype = GUID::from_u128(0x00000001_0000_0010_8000_00aa00389b71);
            if sub_format == float_subtype {
                Ok(SampleFormat::Float)
            } else if sub_format == pcm_subtype {
                Ok(SampleFormat::Pcm)
            } else {
                Err("system audio format is not PCM or IEEE float".into())
            }
        }
        _ => Err("system audio format is not PCM or IEEE float".into()),
    }
}

fn decode_sample(bytes: &[u8], format: SampleFormat) -> f32 {
    match (format, bytes.len()) {
        (SampleFormat::Float, 4) => {
            let sample = f32::from_le_bytes(bytes.try_into().unwrap_or([0; 4]));
            if sample.is_finite() {
                sample.clamp(-1.0, 1.0)
            } else {
                0.0
            }
        }
        (SampleFormat::Pcm, 2) => i16::from_le_bytes([bytes[0], bytes[1]]) as f32 / i16::MAX as f32,
        (SampleFormat::Pcm, 3) => {
            let raw = (bytes[0] as i32) | ((bytes[1] as i32) << 8) | ((bytes[2] as i32) << 16);
            let signed = (raw << 8) >> 8;
            signed as f32 / 8_388_607.0
        }
        (SampleFormat::Pcm, 4) => {
            i32::from_le_bytes(bytes.try_into().unwrap_or([0; 4])) as f32 / i32::MAX as f32
        }
        _ => 0.0,
    }
}

fn spectrum(input: &[f32], sample_rate: f32) -> [f32; BAND_COUNT] {
    analyse(input, sample_rate).bands
}

/// Physical input, perceptual display. A logarithmic transfer preserves changes
/// in quiet music without the old fixed gain pinning entire bands at 1.0.
fn perceptual(amplitude: f32) -> f32 {
    if amplitude <= 0.0001 {
        return 0.0;
    }
    ((20.0 * amplitude.log10() + 80.0) / 74.0).clamp(0.0, 1.0)
}

fn analyse(input: &[f32], sample_rate: f32) -> SpectrumPayload {
    static WINDOW: OnceLock<[f32; FFT_SIZE]> = OnceLock::new();
    let window = WINDOW.get_or_init(|| {
        std::array::from_fn(|i| {
            0.5 - 0.5 * ((std::f32::consts::TAU * i as f32) / (FFT_SIZE - 1) as f32).cos()
        })
    });
    let mut real = [0.0f32; FFT_SIZE];
    let mut imag = [0.0f32; FFT_SIZE];
    let mean = input.iter().take(FFT_SIZE).sum::<f32>() / FFT_SIZE as f32;
    let mut square_sum = 0.0f32;
    let mut peak = 0.0f32;
    for i in 0..FFT_SIZE {
        let sample = input.get(i).copied().unwrap_or(0.0) - mean;
        square_sum += sample * sample;
        peak = peak.max(sample.abs());
        real[i] = sample * window[i];
    }
    fft(&mut real, &mut imag);

    let nyquist = sample_rate * 0.5;
    let min_hz = 35.0f32.min(nyquist.max(1.0));
    let max_hz = 16_000.0f32.min(nyquist * 0.94).max(min_hz + 1.0);
    let bin_hz = sample_rate / FFT_SIZE as f32;
    let amplitude_scale = 4.0 / FFT_SIZE as f32;
    let power: [f32; FFT_SIZE / 2] = std::array::from_fn(|bin| {
        (real[bin] * real[bin] + imag[bin] * imag[bin]) * amplitude_scale * amplitude_scale
    });
    let range_amplitude = |low_hz: f32, high_hz: f32| -> f32 {
        let low = (low_hz / bin_hz).max(1.0);
        let high = (high_hz / bin_hz)
            .min((FFT_SIZE / 2 - 1) as f32)
            .max(low + 0.001);
        let first = low.floor() as usize;
        let last = high.ceil() as usize;
        let mut sum = 0.0;
        let mut width = 0.0;
        for bin in first..last.min(power.len()) {
            let weight = (high.min((bin + 1) as f32) - low.max(bin as f32)).max(0.0);
            sum += power[bin] * weight;
            width += weight;
        }
        (sum / width.max(0.001)).sqrt()
    };
    let mut bands = [0.0f32; BAND_COUNT];
    for (band, target) in bands.iter_mut().enumerate() {
        let low_hz = min_hz * (max_hz / min_hz).powf(band as f32 / BAND_COUNT as f32);
        let high_hz = min_hz * (max_hz / min_hz).powf((band + 1) as f32 / BAND_COUNT as f32);
        *target = perceptual(range_amplitude(low_hz, high_hz));
    }
    let rms = (square_sum / FFT_SIZE as f32).sqrt().clamp(0.0, 1.0);
    let waveform = std::array::from_fn(|point| {
        // Average each real sample bucket to prevent high-frequency aliasing in
        // the compact oscilloscope transfer. These are never synthesized values.
        let start = point * FFT_SIZE / WAVEFORM_SIZE;
        let end = (point + 1) * FFT_SIZE / WAVEFORM_SIZE;
        input.get(start..end).unwrap_or(&[]).iter().sum::<f32>() / (end - start) as f32
    });
    SpectrumPayload {
        bands,
        waveform,
        rms,
        peak: peak.clamp(0.0, 1.0),
        energy: perceptual(rms),
        bass: perceptual(range_amplitude(35.0, 220.0)),
        mid: perceptual(range_amplitude(220.0, 2_400.0)),
        treble: perceptual(range_amplitude(2_400.0, max_hz)),
        sample_rate: sample_rate as u32,
        ..SpectrumPayload::default()
    }
}

fn fft(real: &mut [f32; FFT_SIZE], imag: &mut [f32; FFT_SIZE]) {
    let mut j = 0;
    for i in 1..FFT_SIZE {
        let mut bit = FFT_SIZE >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if i < j {
            real.swap(i, j);
            imag.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= FFT_SIZE {
        let angle = -std::f32::consts::TAU / len as f32;
        let step_real = angle.cos();
        let step_imag = angle.sin();
        for base in (0..FFT_SIZE).step_by(len) {
            let mut wr = 1.0;
            let mut wi = 0.0;
            for offset in 0..len / 2 {
                let even = base + offset;
                let odd = even + len / 2;
                let tr = wr * real[odd] - wi * imag[odd];
                let ti = wr * imag[odd] + wi * real[odd];
                real[odd] = real[even] - tr;
                imag[odd] = imag[even] - ti;
                real[even] += tr;
                imag[even] += ti;
                let next_wr = wr * step_real - wi * step_imag;
                wi = wr * step_imag + wi * step_real;
                wr = next_wr;
            }
        }
        len <<= 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fft_places_a_tone_in_its_frequency_band() {
        let sample_rate = 48_000.0;
        let tone_hz = 1500.0;
        let samples: Vec<_> = (0..FFT_SIZE)
            .map(|i| (std::f32::consts::TAU * tone_hz * i as f32 / sample_rate).sin())
            .collect();
        let bands = spectrum(&samples, sample_rate);
        let peak = bands
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.total_cmp(b.1))
            .unwrap()
            .0;
        assert!((8..=17).contains(&peak), "unexpected peak band {peak}");
        assert!(bands[peak] > 0.1);
    }

    #[test]
    fn quiet_loopback_tones_remain_visible_in_the_emitted_bands() {
        let sample_rate = 48_000.0;
        let tone_hz = 1500.0;
        let spectrum_for = |amplitude: f32| {
            let samples: Vec<_> = (0..FFT_SIZE)
                .map(|i| {
                    amplitude * (std::f32::consts::TAU * tone_hz * i as f32 / sample_rate).sin()
                })
                .collect();
            spectrum(&samples, sample_rate)
        };
        let quiet_bands = spectrum_for(0.0065);
        let louder_bands = spectrum_for(0.026);
        let (peak_index, quiet) = quiet_bands
            .iter()
            .copied()
            .enumerate()
            .max_by(|a, b| a.1.total_cmp(&b.1))
            .unwrap();
        let louder = louder_bands.iter().copied().fold(0.0f32, f32::max);

        assert!(
            (14..=15).contains(&peak_index),
            "unexpected peak band {peak_index}"
        );
        assert!(quiet > 0.25, "quiet loopback tone collapsed to {quiet}");
        assert!(
            louder > quiet + 0.1 && louder < 1.0,
            "log band response flattened the input increase: quiet={quiet}, louder={louder}"
        );
    }

    #[test]
    fn heartbeat_steps_cover_the_wait_and_never_return_zero() {
        let step = Duration::from_millis(250);
        assert_eq!(heartbeat_steps(Duration::from_secs(2), step), 8);
        assert_eq!(heartbeat_steps(Duration::from_millis(260), step), 2);
        assert_eq!(heartbeat_steps(Duration::ZERO, step), 1);
        assert_eq!(heartbeat_steps(Duration::from_secs(1), Duration::ZERO), 1_000);
    }

    #[test]
    fn silence_produces_quiet_zero_bands() {
        assert!(spectrum(&[0.0; FFT_SIZE], 48_000.0)
            .iter()
            .all(|value| *value == 0.0));
    }

    #[test]
    fn loopback_float_samples_preserve_signal_and_reject_non_finite_values() {
        assert_eq!(
            decode_sample(&0.25f32.to_le_bytes(), SampleFormat::Float),
            0.25
        );
        assert_eq!(
            decode_sample(&2.0f32.to_le_bytes(), SampleFormat::Float),
            1.0
        );
        assert_eq!(
            decode_sample(&f32::NAN.to_le_bytes(), SampleFormat::Float),
            0.0
        );
    }

    #[test]
    fn loopback_pcm_samples_preserve_signed_values() {
        let positive = decode_sample(&16_384i16.to_le_bytes(), SampleFormat::Pcm);
        assert!((positive - 0.5).abs() < 0.0001);
        let negative = decode_sample(&(-268_435_456i32).to_le_bytes(), SampleFormat::Pcm);
        assert!((negative + 0.125).abs() < 0.0001);
    }

    #[test]
    #[ignore = "reads every current system render loopback for one second; does not start audio playback"]
    fn default_render_loopback_opens_reads_and_stops() {
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.expect("initialize COM");
        let _com = ComApartment;
        let enumerator: IMMDeviceEnumerator = unsafe {
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).expect("create enumerator")
        };
        let endpoints =
            default_render_endpoints(&enumerator).expect("get default render endpoints");
        let mut streams = Vec::new();
        for (device, _, _) in &endpoints {
            match EndpointStream::open(device) {
                Ok(stream) => streams.push(stream),
                Err(error) => println!("loopback endpoint skipped: {error}"),
            }
        }
        assert!(
            !streams.is_empty(),
            "no default render endpoint could be opened"
        );
        let deadline = Instant::now() + Duration::from_millis(1_200);
        let mut packet_queries = 0usize;
        while Instant::now() < deadline {
            for stream in streams.iter_mut() {
                stream.drain().expect("read loopback packets");
                let _ = stream.frame();
                packet_queries += 1;
            }
            thread::sleep(Duration::from_millis(8));
        }
        assert!(
            packet_queries > 10,
            "loopback read loop did not make progress"
        );
        let packets_read: usize = streams.iter().map(|stream| stream.packets_seen).sum();
        let frames_read: usize = streams.iter().map(|stream| stream.frames_seen).sum();
        let peak = streams
            .iter()
            .fold(0.0f32, |peak, stream| peak.max(stream.peak()));
        let mut bands = [0.0f32; BAND_COUNT];
        for stream in streams.iter_mut() {
            // This live probe reads the final window directly instead of using
            // the emit path's freshness gate.
            if stream.samples.len() >= FFT_SIZE {
                let window = spectrum(
                    &stream.samples[stream.samples.len() - FFT_SIZE..],
                    stream.sample_rate,
                );
                for (target, value) in bands.iter_mut().zip(window) {
                    if value > *target {
                        *target = value;
                    }
                }
            }
        }
        let max_band = bands.iter().copied().fold(0.0f32, f32::max);
        let bands_json = bands
            .iter()
            .map(|band| format!("{band:.6}"))
            .collect::<Vec<_>>()
            .join(",");
        println!(
            "WASAPI default render loopback: endpoints={}, packets={packets_read}, frames={frames_read}, sample_peak={peak:.5}, max_band={max_band:.5}, bands=[{bands_json}]; zero levels mean no active system playback during the sample window",
            streams.len()
        );
    }
}
