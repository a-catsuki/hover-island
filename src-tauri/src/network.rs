//! Network widget: TCP latency probes, a capped Cloudflare speed test with live progress events,
//! and best-effort connection info. Nothing here runs until the widget asks for it, and the
//! speed test hard-caps what it transfers (about 24 MB down and 10 MB up).
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::net::TcpStream;
use tokio::task::JoinHandle;

use crate::types::now_millis;

pub const SPEEDTEST_EVENT: &str = "network://speedtest";
const SPEED_BASE: &str = "https://speed.cloudflare.com";
const DEFAULT_HOST: &str = "1.1.1.1";
const CONNECT_TIMEOUT: Duration = Duration::from_millis(2000);
const MAX_PING_SAMPLES: u32 = 20;

/// Four parallel streams keep a fast link busy without needing more than the byte caps below.
const DOWN_STREAMS: u64 = 4;
const DOWN_BYTES_PER_STREAM: u64 = 6_000_000; // 24 MB in total
const DOWN_TIME_CAP: Duration = Duration::from_secs(9);
const UP_STREAMS: u64 = 4;
const UP_BYTES_PER_STREAM: u64 = 2_500_000; // 10 MB in total
const UP_TIME_CAP: Duration = Duration::from_secs(8);
const UP_CHUNK: usize = 64 * 1024;

static RUNNING: AtomicBool = AtomicBool::new(false);
static CANCEL: AtomicBool = AtomicBool::new(false);

/// Only one speed test at a time; the flag clears when the test ends for any reason.
struct RunGuard;
impl RunGuard {
    fn acquire() -> Option<Self> {
        RUNNING
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()
            .map(|_| {
                CANCEL.store(false, Ordering::SeqCst);
                RunGuard
            })
    }
}
impl Drop for RunGuard {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::SeqCst);
    }
}

// ---------------------------------------------------------------- ping

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PingResult {
    pub host: String,
    pub address: Option<String>,
    pub port: u16,
    pub sent: u32,
    pub received: u32,
    pub loss_pct: f64,
    pub min_ms: Option<f64>,
    pub avg_ms: Option<f64>,
    pub max_ms: Option<f64>,
    pub jitter_ms: Option<f64>,
    /// one entry per probe, null when it timed out
    pub samples_ms: Vec<Option<f64>>,
}

/// Accepts `host`, `host:port`, or a URL, and returns a hostname or IP plus a port (default 443).
fn parse_target(input: &str) -> Result<(String, u16), String> {
    const HINT: &str = "Enter a host like 1.1.1.1 or example.com";
    let mut text = input.trim();
    for prefix in ["https://", "http://"] {
        if let Some(rest) = text.strip_prefix(prefix) {
            text = rest;
        }
    }
    let text = text.split(['/', '?', '#']).next().unwrap_or("").trim();
    if text.is_empty() {
        return Ok((DEFAULT_HOST.into(), 443));
    }
    // A bare IPv6 address has several colons and no port.
    let (host, port) = match text.rsplit_once(':') {
        Some((host, port)) if !host.contains(':') => {
            (host, port.parse::<u16>().map_err(|_| HINT.to_string())?)
        }
        _ => (text, 443),
    };
    let valid = !host.is_empty()
        && host.len() <= 253
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':'));
    if !valid || port == 0 {
        return Err(HINT.into());
    }
    Ok((host.to_string(), port))
}

fn latency_stats(values: &[f64]) -> Option<(f64, f64, f64, f64)> {
    if values.is_empty() {
        return None;
    }
    let min = values.iter().cloned().fold(f64::INFINITY, f64::min);
    let max = values.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let avg = values.iter().sum::<f64>() / values.len() as f64;
    // Jitter is the mean gap between consecutive probes, like RFC 3550 without the smoothing.
    let jitter = if values.len() > 1 {
        values.windows(2).map(|pair| (pair[1] - pair[0]).abs()).sum::<f64>() / (values.len() - 1) as f64
    } else {
        0.0
    };
    Some((min, avg, max, jitter))
}

fn round1(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

/// Time TCP handshakes to `host` (default 1.1.1.1:443). DNS is resolved once up front and is not
/// part of the timings.
#[tauri::command]
pub async fn network_ping(host: Option<String>, samples: Option<u32>) -> Result<PingResult, String> {
    let (name, port) = parse_target(host.as_deref().unwrap_or(""))?;
    let count = samples.unwrap_or(6).clamp(1, MAX_PING_SAMPLES);
    let resolved: Option<SocketAddr> = match tokio::time::timeout(
        Duration::from_secs(3),
        tokio::net::lookup_host((name.as_str(), port)),
    )
    .await
    {
        Ok(Ok(addresses)) => {
            let all: Vec<SocketAddr> = addresses.collect();
            all.iter().find(|address| address.is_ipv4()).or_else(|| all.first()).copied()
        }
        _ => None,
    };
    let Some(address) = resolved else {
        return Ok(PingResult {
            host: name,
            port,
            sent: count,
            loss_pct: 100.0,
            samples_ms: vec![None; count as usize],
            ..Default::default()
        });
    };

    let mut timings: Vec<Option<f64>> = Vec::with_capacity(count as usize);
    for index in 0..count {
        let started = Instant::now();
        let connected = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(address)).await;
        timings.push(match connected {
            Ok(Ok(_stream)) => Some(round1(started.elapsed().as_secs_f64() * 1000.0)),
            _ => None,
        });
        if index + 1 < count {
            tokio::time::sleep(Duration::from_millis(120)).await;
        }
    }
    let good: Vec<f64> = timings.iter().flatten().copied().collect();
    let stats = latency_stats(&good);
    Ok(PingResult {
        host: name,
        address: Some(address.ip().to_string()),
        port,
        sent: count,
        received: good.len() as u32,
        loss_pct: round1((count as usize - good.len()) as f64 / count as f64 * 100.0),
        min_ms: stats.map(|s| round1(s.0)),
        avg_ms: stats.map(|s| round1(s.1)),
        max_ms: stats.map(|s| round1(s.2)),
        jitter_ms: stats.map(|s| round1(s.3)),
        samples_ms: timings,
    })
}

// ---------------------------------------------------------------- speed test

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SpeedtestResult {
    pub download_mbps: f64,
    pub upload_mbps: f64,
    pub latency_ms: f64,
    pub jitter_ms: f64,
    pub bytes_down: u64,
    pub bytes_up: u64,
    pub finished_at: u64,
    pub server: String,
    pub cancelled: bool,
}

/// Payload of the `network://speedtest` event.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct SpeedProgress {
    /// latency | download | upload | done | cancelled | error
    phase: &'static str,
    /// live throughput in the current phase
    mbps: f64,
    /// 0..1 through the current phase
    progress: f64,
    latency_ms: Option<f64>,
    jitter_ms: Option<f64>,
    download_mbps: Option<f64>,
    upload_mbps: Option<f64>,
    message: Option<String>,
}

fn emit_progress(app: &AppHandle, payload: SpeedProgress) {
    let _ = app.emit(SPEEDTEST_EVENT, payload);
}

/// Shared byte counter for one transfer phase. Times are microseconds since `base`, so the final
/// figure covers only the span in which data actually moved.
struct Meter {
    base: Instant,
    bytes: AtomicU64,
    first: AtomicU64,
    last: AtomicU64,
}
impl Meter {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            base: Instant::now(),
            bytes: AtomicU64::new(0),
            first: AtomicU64::new(0),
            last: AtomicU64::new(0),
        })
    }
    fn stamp(&self) -> u64 {
        self.base.elapsed().as_micros() as u64 + 1
    }
    fn add(&self, count: u64) {
        let now = self.stamp();
        self.bytes.fetch_add(count, Ordering::Relaxed);
        let _ = self.first.compare_exchange(0, now, Ordering::Relaxed, Ordering::Relaxed);
        self.last.fetch_max(now, Ordering::Relaxed);
    }
    fn touch(&self) {
        self.last.fetch_max(self.stamp(), Ordering::Relaxed);
    }
    fn total(&self) -> u64 {
        self.bytes.load(Ordering::Relaxed)
    }
    fn mbps(&self) -> f64 {
        let first = self.first.load(Ordering::Relaxed);
        let last = self.last.load(Ordering::Relaxed);
        if first == 0 || last <= first {
            return 0.0;
        }
        let seconds = (last - first) as f64 / 1_000_000.0;
        if seconds < 0.02 {
            return 0.0;
        }
        self.total() as f64 * 8.0 / 1_000_000.0 / seconds
    }
}

fn speed_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(25))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("Hover-Island/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| "Could not start the speed test".to_string())
}

/// Median and jitter of a few tiny requests on one kept-alive connection (the first one pays for
/// the TLS handshake and is thrown away).
async fn measure_latency(client: &reqwest::Client) -> Option<(f64, f64)> {
    let url = format!("{SPEED_BASE}/__down?bytes=0");
    let mut samples: Vec<f64> = Vec::new();
    for index in 0..7 {
        if CANCEL.load(Ordering::SeqCst) {
            return None;
        }
        let started = Instant::now();
        let ok = match client.get(&url).send().await {
            Ok(response) if response.status().is_success() => {
                let _ = response.bytes().await;
                true
            }
            _ => false,
        };
        if index > 0 && ok {
            samples.push(started.elapsed().as_secs_f64() * 1000.0);
        }
    }
    let (_, _, _, jitter) = latency_stats(&samples)?;
    let mut sorted = samples.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median = sorted[sorted.len() / 2];
    Some((round1(median), round1(jitter)))
}

fn spawn_download(client: reqwest::Client, meter: Arc<Meter>, stop: Arc<AtomicBool>) -> JoinHandle<()> {
    tokio::spawn(async move {
        let url = format!("{SPEED_BASE}/__down?bytes={DOWN_BYTES_PER_STREAM}");
        let Ok(mut response) = client.get(url).send().await else {
            return;
        };
        if !response.status().is_success() {
            return;
        }
        let mut got = 0u64;
        while !stop.load(Ordering::Relaxed) {
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    got += chunk.len() as u64;
                    meter.add(chunk.len() as u64);
                    if got >= DOWN_BYTES_PER_STREAM {
                        break;
                    }
                }
                _ => break,
            }
        }
    })
}

fn spawn_upload(client: reqwest::Client, meter: Arc<Meter>, stop: Arc<AtomicBool>) -> JoinHandle<()> {
    tokio::spawn(async move {
        let chunks = (UP_BYTES_PER_STREAM as usize + UP_CHUNK - 1) / UP_CHUNK;
        let counter = meter.clone();
        let halt = stop.clone();
        // The counter moves as the HTTP layer pulls each chunk, so it tracks what is being sent.
        let body = futures_util::stream::iter((0..chunks).map(move |index| {
            if halt.load(Ordering::Relaxed) {
                return Err(std::io::Error::new(std::io::ErrorKind::Interrupted, "stopped"));
            }
            let size = if index + 1 == chunks {
                UP_BYTES_PER_STREAM as usize - index * UP_CHUNK
            } else {
                UP_CHUNK
            };
            counter.add(size as u64);
            Ok::<Vec<u8>, std::io::Error>(vec![0u8; size])
        }));
        let _ = client
            .post(format!("{SPEED_BASE}/__up"))
            .header(reqwest::header::CONTENT_LENGTH, UP_BYTES_PER_STREAM)
            .body(reqwest::Body::wrap_stream(body))
            .send()
            .await;
        meter.touch();
    })
}

/// Emit live progress every 100 ms until the streams finish, the time or byte cap is hit, or the
/// user cancels. Returns true when cancelled.
async fn watch(
    app: &AppHandle,
    phase: &'static str,
    meter: &Arc<Meter>,
    handles: &[JoinHandle<()>],
    stop: &Arc<AtomicBool>,
    expected: u64,
    cap: Duration,
    carried: &SpeedProgress,
) -> bool {
    let started = Instant::now();
    let mut last_bytes = 0u64;
    let mut last_at = started;
    let mut smooth = 0.0f64;
    let mut cancelled = false;
    let mut tick = tokio::time::interval(Duration::from_millis(100));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tick.tick().await;
        if CANCEL.load(Ordering::SeqCst) {
            cancelled = true;
            break;
        }
        let now = Instant::now();
        let bytes = meter.total();
        let seconds = now.duration_since(last_at).as_secs_f64().max(0.001);
        let instant = bytes.saturating_sub(last_bytes) as f64 * 8.0 / 1_000_000.0 / seconds;
        smooth = if smooth == 0.0 { instant } else { smooth * 0.7 + instant * 0.3 };
        last_bytes = bytes;
        last_at = now;
        let elapsed = started.elapsed();
        let progress = (bytes as f64 / expected as f64)
            .max(elapsed.as_secs_f64() / cap.as_secs_f64())
            .min(1.0);
        emit_progress(
            app,
            SpeedProgress { phase, mbps: round1(smooth), progress, ..carried.clone() },
        );
        if handles.iter().all(|handle| handle.is_finished()) || elapsed >= cap || bytes >= expected {
            break;
        }
    }
    stop.store(true, Ordering::SeqCst);
    for handle in handles {
        if !handle.is_finished() {
            handle.abort();
        }
    }
    cancelled
}

fn cancelled_result(app: &AppHandle, partial: SpeedtestResult) -> Result<SpeedtestResult, String> {
    emit_progress(app, SpeedProgress { phase: "cancelled", ..Default::default() });
    Ok(SpeedtestResult { cancelled: true, ..partial })
}

/// Run latency, download and upload against Cloudflare, emitting `network://speedtest` as it goes.
#[tauri::command]
pub async fn network_speedtest(app: AppHandle) -> Result<SpeedtestResult, String> {
    let _guard = RunGuard::acquire().ok_or_else(|| "A speed test is already running".to_string())?;
    let client = speed_client()?;
    let mut carried = SpeedProgress { phase: "latency", ..Default::default() };
    emit_progress(&app, carried.clone());

    let Some((latency, jitter)) = measure_latency(&client).await else {
        if CANCEL.load(Ordering::SeqCst) {
            return cancelled_result(&app, SpeedtestResult::default());
        }
        let message = "Could not reach the speed test server. Check your connection.".to_string();
        emit_progress(&app, SpeedProgress { phase: "error", message: Some(message.clone()), ..Default::default() });
        return Err(message);
    };
    carried.latency_ms = Some(latency);
    carried.jitter_ms = Some(jitter);
    let mut result = SpeedtestResult {
        latency_ms: latency,
        jitter_ms: jitter,
        server: "Cloudflare".into(),
        ..Default::default()
    };

    // download
    let meter = Meter::new();
    let stop = Arc::new(AtomicBool::new(false));
    let handles: Vec<JoinHandle<()>> = (0..DOWN_STREAMS)
        .map(|_| spawn_download(client.clone(), meter.clone(), stop.clone()))
        .collect();
    let cancelled = watch(
        &app,
        "download",
        &meter,
        &handles,
        &stop,
        DOWN_STREAMS * DOWN_BYTES_PER_STREAM,
        DOWN_TIME_CAP,
        &carried,
    )
    .await;
    result.bytes_down = meter.total();
    result.download_mbps = round1(meter.mbps());
    if cancelled {
        return cancelled_result(&app, result);
    }
    if result.bytes_down == 0 {
        let message = "The download test did not return data. Try again in a moment.".to_string();
        emit_progress(&app, SpeedProgress { phase: "error", message: Some(message.clone()), ..Default::default() });
        return Err(message);
    }
    carried.download_mbps = Some(result.download_mbps);

    // upload (a failure here still reports the download figure)
    let meter = Meter::new();
    let stop = Arc::new(AtomicBool::new(false));
    let handles: Vec<JoinHandle<()>> = (0..UP_STREAMS)
        .map(|_| spawn_upload(client.clone(), meter.clone(), stop.clone()))
        .collect();
    let cancelled = watch(
        &app,
        "upload",
        &meter,
        &handles,
        &stop,
        UP_STREAMS * UP_BYTES_PER_STREAM,
        UP_TIME_CAP,
        &carried,
    )
    .await;
    result.bytes_up = meter.total();
    result.upload_mbps = round1(meter.mbps());
    if cancelled {
        return cancelled_result(&app, result);
    }
    carried.upload_mbps = Some(result.upload_mbps);

    result.finished_at = now_millis();
    emit_progress(&app, SpeedProgress { phase: "done", progress: 1.0, ..carried });
    Ok(result)
}

/// Stop a running speed test; it reports `cancelled: true` with whatever it measured so far.
#[tauri::command]
pub fn network_speedtest_cancel() {
    CANCEL.store(true, Ordering::SeqCst);
}

// ---------------------------------------------------------------- connection info

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInfo {
    /// wifi | wired | offline | unknown
    pub kind: String,
    pub ssid: Option<String>,
    pub signal_pct: Option<u8>,
    pub link_mbps: Option<u32>,
    pub radio: Option<String>,
    pub local_ip: Option<String>,
}

/// The address the OS would use to reach the internet. Connecting a UDP socket sends nothing.
fn local_address() -> Option<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("1.1.1.1:80").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    (!ip.is_unspecified()).then(|| ip.to_string())
}

#[derive(Default)]
struct WifiDetails {
    ssid: Option<String>,
    signal_pct: Option<u8>,
    link_mbps: Option<u32>,
    radio: Option<String>,
}

/// Parse `netsh wlan show interfaces`. Only the SSID key is matched by name; the others are found by
/// shape so a translated Windows still works.
fn parse_wlan(output: &str) -> WifiDetails {
    let mut details = WifiDetails::default();
    for line in output.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        if key == "SSID" {
            details.ssid.get_or_insert_with(|| value.to_string());
        } else if key.eq_ignore_ascii_case("Radio type") {
            details.radio.get_or_insert_with(|| value.to_string());
        } else if key.starts_with("Receive rate") {
            if details.link_mbps.is_none() {
                details.link_mbps = value.parse::<f64>().ok().map(|rate| rate.round() as u32);
            }
        } else if let Some(percent) = value.strip_suffix('%') {
            if key.eq_ignore_ascii_case("Signal") && details.signal_pct.is_none() {
                details.signal_pct = percent.trim().parse::<u8>().ok();
            }
        }
    }
    details
}

#[cfg(windows)]
fn wlan_details() -> WifiDetails {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("netsh")
        .args(["wlan", "show", "interfaces"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|output| parse_wlan(&String::from_utf8_lossy(&output.stdout)))
        .unwrap_or_default()
}

#[cfg(not(windows))]
fn wlan_details() -> WifiDetails {
    WifiDetails::default()
}

/// Best-effort description of the current connection. Never fails: unknown fields are null.
#[tauri::command]
pub async fn network_info() -> NetworkInfo {
    tokio::task::spawn_blocking(|| {
        let local_ip = local_address();
        let wifi = wlan_details();
        let kind = if local_ip.is_none() {
            "offline"
        } else if wifi.ssid.is_some() {
            "wifi"
        } else if cfg!(windows) {
            "wired"
        } else {
            "unknown"
        };
        NetworkInfo {
            kind: kind.into(),
            ssid: wifi.ssid,
            signal_pct: wifi.signal_pct,
            link_mbps: wifi.link_mbps,
            radio: wifi.radio,
            local_ip,
        }
    })
    .await
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn targets_default_and_parse() {
        assert_eq!(parse_target("").unwrap(), ("1.1.1.1".to_string(), 443));
        assert_eq!(parse_target("https://example.com/path").unwrap(), ("example.com".to_string(), 443));
        assert_eq!(parse_target("8.8.8.8:53").unwrap(), ("8.8.8.8".to_string(), 53));
        assert!(parse_target("bad host").is_err());
        assert!(parse_target("host:notaport").is_err());
    }

    #[test]
    fn latency_stats_cover_spread() {
        let (min, avg, max, jitter) = latency_stats(&[10.0, 20.0, 10.0]).unwrap();
        assert_eq!((min, max), (10.0, 20.0));
        assert!((avg - 13.333).abs() < 0.01);
        assert_eq!(jitter, 10.0);
        assert!(latency_stats(&[]).is_none());
    }

    #[test]
    fn wlan_output_is_parsed() {
        let sample = "    Name                   : Wi-Fi\n    SSID                   : Home\n    BSSID                  : aa:bb:cc:dd:ee:ff\n    Radio type             : 802.11ax\n    Receive rate (Mbps)    : 866.7\n    Signal                 : 91%\n";
        let details = parse_wlan(sample);
        assert_eq!(details.ssid.as_deref(), Some("Home"));
        assert_eq!(details.signal_pct, Some(91));
        assert_eq!(details.link_mbps, Some(867));
        assert_eq!(details.radio.as_deref(), Some("802.11ax"));
    }
}
