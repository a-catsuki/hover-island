//! Opt-in-by-lifecycle system-output spectrum capture for the media visualizer.
//! This uses WASAPI render-loopback, never a microphone or input endpoint.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread;
use std::time::{Duration, Instant};

use tauri::Emitter;
use windows::core::GUID;
use windows::Win32::Media::Audio::{
    eCommunications, eConsole, eMultimedia, eRender, IAudioCaptureClient, IAudioClient, IMMDevice,
    IMMDeviceEnumerator, MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_LOOPBACK, WAVEFORMATEX,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED,
};

const BAND_COUNT: usize = 24;
const FFT_SIZE: usize = 1024;
const DEVICE_POLL_INTERVAL: Duration = Duration::from_millis(500);
const REOPEN_DELAY: Duration = Duration::from_millis(250);
const SPECTRUM_EVENT: &str = "audio://spectrum";
const ERROR_EVENT: &str = "audio://spectrum-error";

static RUNNER: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SpectrumPayload {
    bands: [f32; BAND_COUNT],
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
                let _ = app.emit(ERROR_EVENT, summarize_error(error));
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

fn capture_loop(app: &tauri::AppHandle, active: &AtomicBool) -> Result<(), String> {
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
        .map_err(|e| format!("COM initialization failed: {e}"))?;
    let _com = ComApartment;

    let enumerator: IMMDeviceEnumerator = unsafe {
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
            .map_err(|e| format!("audio device enumeration failed: {e}"))?
    };
    let mut last_error: Option<String> = None;
    let mut last_silence = Instant::now();
    while active.load(Ordering::Acquire) {
        match default_render_endpoint(&enumerator) {
            Ok((device, endpoint_id)) => {
                match capture_endpoint(app, active, &enumerator, &device, &endpoint_id) {
                    Ok(()) => last_error = None,
                    Err(error) => {
                        if last_error.as_deref() != Some(error.as_str()) {
                            let _ = app.emit(ERROR_EVENT, summarize_error(error.clone()));
                            last_error = Some(error);
                        }
                        thread::sleep(REOPEN_DELAY);
                    }
                }
            }
            Err(error) => {
                if last_error.as_deref() != Some(error.as_str()) {
                    let _ = app.emit(ERROR_EVENT, summarize_error(error.clone()));
                    last_error = Some(error);
                }
                if last_silence.elapsed() >= Duration::from_millis(42) {
                    let _ = app.emit(
                        SPECTRUM_EVENT,
                        SpectrumPayload {
                            bands: [0.0; BAND_COUNT],
                        },
                    );
                    last_silence = Instant::now();
                }
                thread::sleep(REOPEN_DELAY);
            }
        }
    }
    Ok(())
}

fn default_render_endpoint(
    enumerator: &IMMDeviceEnumerator,
) -> Result<(IMMDevice, String), String> {
    for role in [eConsole, eMultimedia, eCommunications] {
        let device = unsafe { enumerator.GetDefaultAudioEndpoint(eRender, role) };
        let Ok(device) = device else { continue };
        let Ok(native_id) = (unsafe { device.GetId() }) else {
            continue;
        };
        let id = unsafe { native_id.to_string() };
        unsafe { CoTaskMemFree(Some(native_id.0.cast())) };
        let Ok(id) = id else { continue };
        return Ok((device, id));
    }
    Err("no default render endpoint is available for Console, Multimedia, or Communications".into())
}

fn capture_endpoint(
    app: &tauri::AppHandle,
    active: &AtomicBool,
    enumerator: &IMMDeviceEnumerator,
    device: &IMMDevice,
    endpoint_id: &str,
) -> Result<(), String> {
    let client: IAudioClient = unsafe {
        device
            .Activate(CLSCTX_ALL, None)
            .map_err(|e| format!("could not open default audio output: {e}"))?
    };
    let format = unsafe {
        client
            .GetMixFormat()
            .map_err(|e| format!("could not read audio output format: {e}"))?
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
    init_result.map_err(|e| format!("could not initialize system audio loopback: {e}"))?;

    let capture: IAudioCaptureClient = unsafe {
        client
            .GetService()
            .map_err(|e| format!("could not open system audio capture stream: {e}"))?
    };
    unsafe {
        client
            .Start()
            .map_err(|e| format!("could not start system audio loopback: {e}"))?;
    }
    let _running_stream = RunningStream(client.clone());
    let mut samples = Vec::with_capacity(FFT_SIZE);
    let mut last_emit = Instant::now();
    let mut last_device_check = Instant::now();
    while active.load(Ordering::Acquire) {
        if last_device_check.elapsed() >= DEVICE_POLL_INTERVAL {
            last_device_check = Instant::now();
            match default_render_endpoint(enumerator) {
                Ok((_, current_id)) if current_id == endpoint_id => {}
                _ => return Ok(()),
            }
        }
        let packet = unsafe { capture.GetNextPacketSize() }
            .map_err(|e| format!("system audio capture failed: {e}"))?;
        if packet == 0 {
            thread::sleep(Duration::from_millis(6));
            if last_emit.elapsed() >= Duration::from_millis(42) {
                let _ = app.emit(
                    SPECTRUM_EVENT,
                    SpectrumPayload {
                        bands: [0.0; BAND_COUNT],
                    },
                );
                last_emit = Instant::now();
            }
            continue;
        }
        let mut data = std::ptr::null_mut();
        let mut frames = 0u32;
        let mut flags = 0u32;
        unsafe {
            capture
                .GetBuffer(&mut data, &mut frames, &mut flags, None, None)
                .map_err(|e| format!("could not read system audio samples: {e}"))?;
        }
        if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 == 0 && !data.is_null() {
            let bytes = frames as usize * frame_bytes;
            let raw = unsafe { std::slice::from_raw_parts(data, bytes) };
            // Keep only the newest FFT window from each packet. Draining a Vec for
            // every individual frame needlessly shifted 512 samples at audio rate.
            let skip = (frames as usize).saturating_sub(FFT_SIZE);
            for frame in raw.chunks_exact(frame_bytes).skip(skip) {
                let mut sum = 0.0f32;
                for channel in 0..channels {
                    let begin = channel * bytes_per_sample;
                    sum += decode_sample(&frame[begin..begin + bytes_per_sample], sample_format);
                }
                samples.push(sum / channels as f32);
            }
            if samples.len() > FFT_SIZE {
                samples.drain(..samples.len() - FFT_SIZE);
            }
        } else {
            let silence_frames = (frames as usize).min(FFT_SIZE);
            samples.extend(std::iter::repeat(0.0).take(silence_frames));
            if samples.len() > FFT_SIZE {
                samples.drain(..samples.len() - FFT_SIZE);
            }
        }
        unsafe {
            capture
                .ReleaseBuffer(frames)
                .map_err(|e| format!("could not release audio capture buffer: {e}"))?;
        }

        if samples.len() >= FFT_SIZE && last_emit.elapsed() >= Duration::from_millis(42) {
            let bands = spectrum(&samples[samples.len() - FFT_SIZE..], sample_rate);
            let _ = app.emit(SPECTRUM_EVENT, SpectrumPayload { bands });
            last_emit = Instant::now();
        }
    }
    Ok(())
}

struct ComApartment;

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
    let mut real = [0.0f32; FFT_SIZE];
    let mut imag = [0.0f32; FFT_SIZE];
    for i in 0..FFT_SIZE {
        let window = 0.5 - 0.5 * ((std::f32::consts::TAU * i as f32) / (FFT_SIZE - 1) as f32).cos();
        real[i] = input.get(i).copied().unwrap_or(0.0) * window;
    }
    fft(&mut real, &mut imag);

    let nyquist = sample_rate * 0.5;
    let min_hz = 35.0f32.min(nyquist.max(1.0));
    let max_hz = (nyquist * 0.94).max(min_hz + 1.0);
    let mut bands = [0.0f32; BAND_COUNT];
    for (band, target) in bands.iter_mut().enumerate() {
        let low_hz = min_hz * (max_hz / min_hz).powf(band as f32 / BAND_COUNT as f32);
        let high_hz = min_hz * (max_hz / min_hz).powf((band + 1) as f32 / BAND_COUNT as f32);
        let low = ((low_hz / nyquist * (FFT_SIZE / 2) as f32).floor() as usize)
            .clamp(1, FFT_SIZE / 2 - 1);
        let high = ((high_hz / nyquist * (FFT_SIZE / 2) as f32).ceil() as usize)
            .clamp(low + 1, FFT_SIZE / 2);
        let mut power = 0.0;
        for bin in low..high {
            power += real[bin] * real[bin] + imag[bin] * imag[bin];
        }
        let rms = (power / (high - low) as f32).sqrt() * (4.0 / FFT_SIZE as f32);
        *target = (rms * 36.0).clamp(0.0, 1.0);
    }
    bands
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

        // At 1024 samples, 1500 Hz falls on a geometric band edge. Hann-windowed
        // energy therefore splits across bands 13 and 14, yielding about 0.087
        // for this input (rather than the >0.1 peak produced by the old 512 FFT).
        assert!(
            (13..=14).contains(&peak_index),
            "unexpected peak band {peak_index}"
        );
        assert!(quiet > 0.075, "quiet loopback tone collapsed to {quiet}");
        assert!(
            (louder / quiet - 4.0).abs() < 0.1,
            "band response did not track the 4x input increase: quiet={quiet}, louder={louder}"
        );
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
    #[ignore = "reads current system render loopback for one second; does not start audio playback"]
    fn default_render_loopback_opens_reads_and_stops() {
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.expect("initialize COM");
        let _com = ComApartment;
        let enumerator: IMMDeviceEnumerator = unsafe {
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).expect("create enumerator")
        };
        let device = unsafe {
            enumerator
                .GetDefaultAudioEndpoint(eRender, eMultimedia)
                .expect("get default render endpoint")
        };
        let client: IAudioClient = unsafe {
            device
                .Activate(CLSCTX_ALL, None)
                .expect("activate default render endpoint")
        };
        let format = unsafe { client.GetMixFormat().expect("get output format") };
        assert!(!format.is_null(), "default output returned no mix format");
        let fmt = unsafe { format.read_unaligned() };
        let sample_format = unsafe { sample_format(format, &fmt) }
            .expect("default render format should be PCM or IEEE float");
        let channels = usize::from(fmt.nChannels);
        let bytes_per_sample = usize::from(fmt.wBitsPerSample / 8);
        let frame_bytes = usize::from(fmt.nBlockAlign);
        assert!(
            channels > 0
                && bytes_per_sample > 0
                && frame_bytes >= channels * bytes_per_sample
                && fmt.nSamplesPerSec > 0
        );
        unsafe {
            client
                .Initialize(
                    AUDCLNT_SHAREMODE_SHARED,
                    AUDCLNT_STREAMFLAGS_LOOPBACK,
                    1_000_000,
                    0,
                    format,
                    None,
                )
                .expect("initialize loopback");
            CoTaskMemFree(Some(format.cast()));
        }
        let capture: IAudioCaptureClient =
            unsafe { client.GetService().expect("get capture client") };
        unsafe { client.Start().expect("start loopback") };
        let _running = RunningStream(client);
        let deadline = Instant::now() + Duration::from_secs(1);
        let mut packet_queries = 0usize;
        let mut packets_read = 0usize;
        let mut frames_read = 0usize;
        let mut peak = 0.0f32;
        let mut samples = Vec::with_capacity(FFT_SIZE);
        while Instant::now() < deadline {
            let packet = unsafe { capture.GetNextPacketSize().expect("query loopback packet") };
            packet_queries += 1;
            if packet > 0 {
                let mut data = std::ptr::null_mut();
                let mut frames = 0u32;
                let mut flags = 0u32;
                unsafe {
                    capture
                        .GetBuffer(&mut data, &mut frames, &mut flags, None, None)
                        .expect("read loopback packet");
                }
                if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 == 0 && !data.is_null() {
                    let byte_count = frames as usize * frame_bytes;
                    let raw = unsafe { std::slice::from_raw_parts(data, byte_count) };
                    for frame in raw.chunks_exact(frame_bytes) {
                        let mut mixed = 0.0;
                        for channel in 0..channels {
                            let begin = channel * bytes_per_sample;
                            mixed += decode_sample(
                                &frame[begin..begin + bytes_per_sample],
                                sample_format,
                            );
                        }
                        let sample = mixed / channels as f32;
                        peak = peak.max(sample.abs());
                        samples.push(sample);
                    }
                } else {
                    samples.extend(std::iter::repeat(0.0).take(frames as usize));
                }
                frames_read += frames as usize;
                packets_read += 1;
                if samples.len() > FFT_SIZE {
                    samples.drain(..samples.len() - FFT_SIZE);
                }
                unsafe {
                    capture
                        .ReleaseBuffer(frames)
                        .expect("release loopback packet");
                }
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert!(
            packet_queries > 10,
            "loopback read loop did not make progress"
        );
        let max_band = if samples.len() >= FFT_SIZE {
            spectrum(
                &samples[samples.len() - FFT_SIZE..],
                fmt.nSamplesPerSec as f32,
            )
            .into_iter()
            .fold(0.0f32, f32::max)
        } else {
            0.0
        };
        println!(
            "WASAPI multimedia loopback: packets={packets_read}, frames={frames_read}, sample_peak={peak:.5}, max_band={max_band:.5}; zero levels mean no active system playback during the sample window"
        );
    }
}
