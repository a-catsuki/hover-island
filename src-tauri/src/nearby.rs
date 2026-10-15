//! Nearby / AirDrop-style transfer, implemented as a **LocalSend protocol v2.2** node.
//!
//! Transport is plain HTTP + UDP multicast, matching what stock Windows can do (see
//! docs/airdrop-feasibility.md). We intentionally implement the **unencrypted** HTTP
//! variant (LocalSend also supports HTTPS with an on-the-fly self-signed cert; that is
//! noted in the summary and left for a later pass, since interop over HTTPS would also
//! need a matching client-cert/trust story).
//!
//! Discovery : UDP multicast 224.0.0.167:53317 (+ legacy 53318), JSON announcement.
//! Register  : `POST /api/localsend/v2/register` (two-way discovery).
//! Receive   : `POST /api/localsend/v2/prepare-upload`, `.../upload`, `.../cancel`.
//! Info      : `GET  /api/localsend/v2/info` (debug).
//!
//! The whole module is intentionally self-contained and `Result`-based; it never panics.

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::{Body, Bytes};
use axum::extract::{ConnectInfo, Query, State as AxumState};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use socket2::{Domain, Protocol, Socket, Type};
use tauri::async_runtime;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, UdpSocket};
use tokio::sync::{oneshot, Semaphore};

use crate::state::AppState;
use crate::types::{NearbyPeer, NearbyStatus, NearbyTransfer};

/* ------------------------------- constants ------------------------------ */

const MULTICAST_ADDR: Ipv4Addr = Ipv4Addr::new(224, 0, 0, 167);
const DEFAULT_PORT: u16 = 53317;
const LEGACY_PORT: u16 = 53318;
const PROTOCOL_VERSION: &str = "2.2";
const PEER_TIMEOUT: Duration = Duration::from_secs(30);
const SESSION_TIMEOUT: Duration = Duration::from_secs(3600);
const CHUNK: usize = 64 * 1024;
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_PENDING_APPROVALS: usize = 8;
const MAX_ACTIVE_SESSIONS: usize = 32;
const MAX_PEERS: usize = 128;
const MAX_FILES_PER_REQUEST: usize = 64;
const MAX_FILE_SIZE: u64 = 2 * 1024 * 1024 * 1024;
const MAX_REQUEST_SIZE: u64 = 4 * 1024 * 1024 * 1024;
const MAX_TRANSFER_ROWS: usize = 200;

/* --------------------------------- wire --------------------------------- */

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct DeviceInfo {
    alias: String,
    version: String,
    device_model: Option<String>,
    device_type: Option<String>,
    fingerprint: String,
    port: u16,
    protocol: String,
    download: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct MulticastMessage {
    alias: String,
    version: String,
    device_model: Option<String>,
    device_type: Option<String>,
    fingerprint: String,
    port: u16,
    protocol: String,
    download: bool,
    announce: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct FileMeta {
    id: String,
    file_name: String,
    size: u64,
    file_type: Option<String>,
    sha256: Option<String>,
    preview: Option<String>,
    metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrepareUploadRequest {
    info: DeviceInfo,
    files: HashMap<String, FileMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct PrepareUploadResponse {
    session_id: String,
    files: HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadQuery {
    session_id: String,
    file_id: String,
    token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionQuery {
    session_id: String,
}

/* --------------------------------- state -------------------------------- */

struct PeerEntry {
    peer: NearbyPeer,
    last_seen: Instant,
    #[allow(dead_code)]
    protocol: String,
}

struct Session {
    #[allow(dead_code)]
    peer_name: String,
    files: HashMap<String, FileMeta>,
    tokens: HashMap<String, String>,
    dir: PathBuf,
    created: Instant,
}

struct PendingApproval {
    sender: oneshot::Sender<bool>,
    created: Instant,
}

pub struct NearbyRuntime {
    app: AppHandle,
    device_name: String,
    fingerprint: String,
    port: u16,
    running: AtomicBool,
    peers: Mutex<Vec<PeerEntry>>,
    transfers: Mutex<Vec<NearbyTransfer>>,
    sessions: Mutex<HashMap<String, Session>>,
    pending_approvals: Mutex<HashMap<String, PendingApproval>>,
    upload_slots: Arc<Semaphore>,
    send_slots: Arc<Semaphore>,
    shutdown_tx: Mutex<Option<oneshot::Sender<()>>>,
    shutdown_done_rx: Mutex<Option<oneshot::Receiver<()>>>,
    shutdown_lock: tokio::sync::Mutex<()>,
    client: reqwest::Client,
}

impl NearbyRuntime {
    fn new(app: AppHandle, device_name: String, fingerprint: String, port: u16) -> Arc<Self> {
        let client = reqwest::Client::builder()
            .user_agent(format!("HoverIsland/0.1 LocalSend/{PROTOCOL_VERSION}"))
            .connect_timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());

        Arc::new(Self {
            app,
            device_name,
            fingerprint,
            port,
            running: AtomicBool::new(true),
            peers: Mutex::new(Vec::new()),
            transfers: Mutex::new(Vec::new()),
            sessions: Mutex::new(HashMap::new()),
            pending_approvals: Mutex::new(HashMap::new()),
            upload_slots: Arc::new(Semaphore::new(4)),
            send_slots: Arc::new(Semaphore::new(4)),
            shutdown_tx: Mutex::new(None),
            shutdown_done_rx: Mutex::new(None),
            shutdown_lock: tokio::sync::Mutex::new(()),
            client,
        })
    }

    fn device_info(&self) -> DeviceInfo {
        DeviceInfo {
            alias: self.device_name.clone(),
            version: PROTOCOL_VERSION.to_string(),
            device_model: Some("Windows".into()),
            device_type: Some("desktop".into()),
            fingerprint: self.fingerprint.clone(),
            port: self.port,
            protocol: "http".into(),
            download: false,
        }
    }

    fn multicast_message(&self, announce: bool) -> MulticastMessage {
        MulticastMessage {
            alias: self.device_name.clone(),
            version: PROTOCOL_VERSION.to_string(),
            device_model: Some("Windows".into()),
            device_type: Some("desktop".into()),
            fingerprint: self.fingerprint.clone(),
            port: self.port,
            protocol: "http".into(),
            download: false,
            announce,
        }
    }

    fn status(&self) -> NearbyStatus {
        let peers = self
            .peers
            .lock()
            .map(|p| p.iter().map(|e| e.peer.clone()).collect())
            .unwrap_or_default();
        let transfers = self.transfers.lock().map(|t| t.clone()).unwrap_or_default();
        NearbyStatus {
            running: self.running.load(Ordering::Relaxed),
            device_name: self.device_name.clone(),
            port: self.port,
            peers,
            transfers,
            detail: None,
        }
    }
}

/* -------------------------------- helpers ------------------------------- */

fn device_name() -> String {
    hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .filter(|s| !s.trim().is_empty())
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .unwrap_or_else(|| "Windows PC".into())
}

fn downloads_dir() -> PathBuf {
    dirs::download_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(std::env::temp_dir)
}

fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn sanitize(name: &str) -> String {
    // Treat both Windows and POSIX separators as untrusted, even when running on
    // the opposite platform. Windows also rejects control chars and these marks.
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let cleaned: String = base
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
        .collect();
    let trimmed = cleaned.trim().trim_end_matches(|c| c == '.' || c == ' ');
    let stem = trimmed.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit());
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." || reserved {
        "file".into()
    } else {
        trimmed.chars().take(200).collect()
    }
}

fn valid_upload_request(files: &HashMap<String, FileMeta>) -> bool {
    if files.is_empty() || files.len() > MAX_FILES_PER_REQUEST {
        return false;
    }
    let mut ids = std::collections::HashSet::new();
    let mut total = 0_u64;
    files.iter().all(|(key, meta)| {
        let id = if meta.id.is_empty() { key } else { &meta.id };
        total = total.saturating_add(meta.size);
        total <= MAX_REQUEST_SIZE
            && !id.is_empty()
            && id.len() <= 128
            && ids.insert(id)
            && meta.size <= MAX_FILE_SIZE
            && !meta.file_name.trim().is_empty()
            && meta.file_name.len() <= 1024
    })
}

fn append_transfers(rt: &NearbyRuntime, transfers: impl IntoIterator<Item = NearbyTransfer>) {
    if let Ok(mut list) = rt.transfers.lock() {
        list.extend(transfers);
        if list.len() > MAX_TRANSFER_ROWS {
            let remove = list.len() - MAX_TRANSFER_ROWS;
            list.drain(0..remove);
        }
    }
}

fn resolve_pending_approval(
    pending: &Mutex<HashMap<String, PendingApproval>>,
    session_id: &str,
    accepted: bool,
) -> Result<(), &'static str> {
    let approval = pending
        .lock()
        .map_err(|_| "approval state unavailable")?
        .remove(session_id)
        .ok_or("approval request expired")?;
    approval
        .sender
        .send(accepted)
        .map_err(|_| "sender disconnected")
}

fn session_capacity_reached(rt: &NearbyRuntime) -> bool {
    rt.sessions
        .lock()
        .map(|sessions| sessions.len() >= MAX_ACTIVE_SESSIONS)
        .unwrap_or(true)
}

enum SessionInsertError {
    Capacity,
    Unavailable,
}

fn insert_pending_approval(
    rt: &NearbyRuntime,
    session_id: String,
    sender: oneshot::Sender<bool>,
) -> Result<(), StatusCode> {
    let mut pending = rt
        .pending_approvals
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if pending.len() >= MAX_PENDING_APPROVALS {
        return Err(StatusCode::TOO_MANY_REQUESTS);
    }
    pending.insert(
        session_id,
        PendingApproval {
            sender,
            created: Instant::now(),
        },
    );
    Ok(())
}

fn insert_session(
    rt: &NearbyRuntime,
    session_id: String,
    peer_name: String,
    files: HashMap<String, FileMeta>,
    tokens: HashMap<String, String>,
    dir: PathBuf,
) -> Result<(), SessionInsertError> {
    let mut sessions = rt
        .sessions
        .lock()
        .map_err(|_| SessionInsertError::Unavailable)?;
    if sessions.len() >= MAX_ACTIVE_SESSIONS {
        return Err(SessionInsertError::Capacity);
    }
    sessions.insert(
        session_id,
        Session {
            peer_name,
            files,
            tokens,
            dir,
            created: Instant::now(),
        },
    );
    Ok(())
}

fn mime_for(name: &str) -> String {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        "md" => "text/markdown",
        "json" => "application/json",
        "zip" => "application/zip",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        _ => "application/octet-stream",
    }
    .to_string()
}

fn transfer_timeout(size: u64) -> Duration {
    // Allow large files over slower LAN/Wi-Fi links, while keeping stalled
    // peers bounded to two hours per file.
    Duration::from_secs(60 + (size / 500_000).min(2 * 60 * 60))
}

fn emit_changed(rt: &NearbyRuntime) {
    let _ = rt.app.emit("nearby://changed", rt.status());
}

fn add_peer(
    rt: &NearbyRuntime,
    fingerprint: &str,
    name: &str,
    address: &str,
    port: u16,
    protocol: &str,
) {
    if fingerprint.is_empty()
        || fingerprint.len() > 128
        || name.len() > 128
        || protocol.len() > 32
        || port == 0
        || fingerprint == rt.fingerprint
    {
        return;
    }
    let fresh = NearbyPeer {
        id: fingerprint.to_string(),
        name: if name.trim().is_empty() {
            address.to_string()
        } else {
            name.to_string()
        },
        address: address.to_string(),
        port,
    };
    if let Ok(mut peers) = rt.peers.lock() {
        if let Some(entry) = peers.iter_mut().find(|e| e.peer.id == fresh.id) {
            entry.peer = fresh;
            entry.last_seen = Instant::now();
            entry.protocol = protocol.to_string();
        } else {
            if peers.len() >= MAX_PEERS {
                return;
            }
            peers.push(PeerEntry {
                peer: fresh,
                last_seen: Instant::now(),
                protocol: protocol.to_string(),
            });
        }
    }
}

fn set_transfer_progress(rt: &NearbyRuntime, id: &str, bytes: u64) {
    if let Ok(mut list) = rt.transfers.lock() {
        if let Some(t) = list.iter_mut().find(|t| t.id == id) {
            t.bytes = bytes;
        }
    }
}

fn set_transfer_status(rt: &NearbyRuntime, id: &str, status: &str) {
    if let Ok(mut list) = rt.transfers.lock() {
        if let Some(t) = list.iter_mut().find(|t| t.id == id) {
            t.status = status.to_string();
        }
    }
}

fn set_transfer_error(rt: &NearbyRuntime, id: &str, error: impl std::fmt::Display) {
    let message = error.to_string().replace('\r', " ").replace('\n', " ");
    let message: String = message.chars().take(140).collect();
    set_transfer_status(rt, id, &format!("failed: {message}"));
}

fn sender_label(alias: &str, address: std::net::IpAddr) -> String {
    let name: String = alias
        .chars()
        .filter(|c| !c.is_control())
        .take(128)
        .collect();
    let name = if name.trim().is_empty() {
        "Unknown sender"
    } else {
        name.trim()
    };
    format!("{name} ({address})")
}

fn resolve_target(rt: &NearbyRuntime, target: &str) -> Option<(String, u16)> {
    if let Ok(addr) = target.parse::<SocketAddr>() {
        return Some((addr.ip().to_string(), addr.port()));
    }
    if let Some((ip, port)) = target.rsplit_once(':') {
        if let (Ok(ip), Ok(port)) = (ip.parse::<std::net::IpAddr>(), port.parse::<u16>()) {
            return Some((ip.to_string(), port));
        }
    }
    rt.peers
        .lock()
        .ok()?
        .iter()
        .find(|e| e.peer.id == target || e.peer.name == target)
        .map(|e| (e.peer.address.clone(), e.peer.port))
}

/// Expand dropped paths: directories are walked recursively so users can drop whole folders.
#[allow(dead_code)]
fn expand_paths(paths: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for p in paths {
        let path = std::path::Path::new(p);
        if path.is_dir() {
            collect_dir(path, &mut out, 0);
        } else if path.is_file() {
            out.push(p.clone());
        }
    }
    out.truncate(MAX_FILES_PER_REQUEST + 1);
    out
}

#[allow(dead_code)]
fn collect_dir(dir: &std::path::Path, out: &mut Vec<String>, depth: usize) {
    if depth > 16 || out.len() >= MAX_FILES_PER_REQUEST + 1 {
        return;
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            if out.len() >= MAX_FILES_PER_REQUEST + 1 {
                break;
            }
            let path = entry.path();
            if path.is_dir() {
                collect_dir(&path, out, depth + 1);
            } else if path.is_file() {
                out.push(path.to_string_lossy().to_string());
            }
        }
    }
}

/* ------------------------------ tauri commands --------------------------- */

#[tauri::command]
pub fn nearby_status(state: State<AppState>) -> NearbyStatus {
    let Ok(guard) = state.nearby.lock() else {
        return NearbyStatus {
            running: false,
            device_name: device_name(),
            port: 0,
            peers: Vec::new(),
            transfers: Vec::new(),
            detail: Some("Nearby state is unavailable.".into()),
        };
    };
    if let Some(rt) = guard.as_ref() {
        rt.status()
    } else {
        NearbyStatus {
            running: false,
            device_name: device_name(),
            port: 0,
            peers: Vec::new(),
            transfers: Vec::new(),
            detail: Some("Nearby is stopped.".into()),
        }
    }
}

#[tauri::command]
pub async fn nearby_start(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<NearbyStatus, String> {
    // Keep the state lock through bind + publish so two rapid Start requests
    // cannot bind different ports and orphan one server runtime.
    let mut guard = state
        .nearby
        .lock()
        .map_err(|_| "Nearby state is unavailable.".to_string())?;
    if let Some(rt) = guard.as_ref() {
        if rt.running.load(Ordering::Acquire) {
            return Ok(rt.status());
        }
        return Err("Nearby is still stopping. Try again in a moment.".into());
    }

    let (port, tcp) = bind_tcp().ok_or_else(|| {
        "Could not bind LocalSend TCP port 53317/53318 (already in use?).".to_string()
    })?;
    let udp = bind_udp(port, true).ok();
    let other = if port == DEFAULT_PORT {
        LEGACY_PORT
    } else {
        DEFAULT_PORT
    };
    let legacy = bind_udp(other, true).ok();

    let name = device_name();
    let fingerprint = uuid::Uuid::new_v4().to_string().replace('-', "");
    let rt = NearbyRuntime::new(app, name, fingerprint, port);

    spawn_tasks(&rt, tcp, udp, legacy);
    let status = rt.status();

    *guard = Some(rt);
    eprintln!("[nearby] started on port {port} (HTTP + UDP multicast {MULTICAST_ADDR})");
    Ok(status)
}

#[tauri::command]
pub async fn nearby_stop(state: State<'_, AppState>) -> Result<(), String> {
    let rt = {
        let guard = state
            .nearby
            .lock()
            .map_err(|_| "Nearby state is unavailable.".to_string())?;
        let Some(rt) = guard.as_ref().cloned() else {
            return Ok(());
        };
        rt.running.store(false, Ordering::Release);
        if let Ok(mut tx) = rt.shutdown_tx.lock() {
            if let Some(tx) = tx.take() {
                let _ = tx.send(());
            }
        }
        if let Ok(mut pending) = rt.pending_approvals.lock() {
            for (_, approval) in pending.drain() {
                let _ = approval.sender.send(false);
            }
        }
        emit_changed(&rt);
        rt
    };

    let _shutdown_guard = rt.shutdown_lock.lock().await;
    let mut done = rt
        .shutdown_done_rx
        .lock()
        .map_err(|_| "Nearby shutdown state is unavailable.".to_string())?
        .take();
    if let Some(rx) = done.as_mut() {
        if tokio::time::timeout(Duration::from_secs(5), rx)
            .await
            .is_err()
        {
            if let Ok(mut slot) = rt.shutdown_done_rx.lock() {
                *slot = done;
            }
            return Err("Nearby is still closing an active request. Try again shortly.".into());
        }
    }
    let mut guard = state
        .nearby
        .lock()
        .map_err(|_| "Nearby state is unavailable.".to_string())?;
    if guard
        .as_ref()
        .is_some_and(|current| Arc::ptr_eq(current, &rt))
    {
        *guard = None;
    }
    eprintln!("[nearby] stopped");
    Ok(())
}

#[tauri::command]
pub fn nearby_send(
    app: AppHandle,
    state: State<AppState>,
    target: String,
    paths: Vec<String>,
) -> Result<(), String> {
    let _ = app;
    let rt = state
        .nearby
        .lock()
        .map_err(|_| "Nearby state is unavailable.".to_string())?
        .clone()
        .ok_or_else(|| "Nearby is not running.".to_string())?;
    if paths.is_empty() {
        return Err("No files selected.".into());
    }
    let paths = expand_paths(&paths);
    if paths.is_empty() {
        return Err("No readable files were selected.".into());
    }
    if paths.len() > MAX_FILES_PER_REQUEST {
        return Err(format!(
            "A send can contain at most {MAX_FILES_PER_REQUEST} files."
        ));
    }
    let mut total_size = 0_u64;
    for p in &paths {
        let path = std::path::Path::new(p);
        if !path.is_file() {
            return Err(format!("File not found: {p}"));
        }
        let meta = std::fs::metadata(path).map_err(|e| format!("Cannot read {p}: {e}"))?;
        if meta.len() > MAX_FILE_SIZE {
            return Err(format!("{p} exceeds the 2 GiB per-file limit."));
        }
        total_size = total_size.saturating_add(meta.len());
        if total_size > MAX_REQUEST_SIZE {
            return Err("A send can contain at most 4 GiB total.".into());
        }
    }
    let (ip, port) =
        resolve_target(&rt, &target).ok_or_else(|| format!("Unknown Nearby target: {target}"))?;
    let permit = rt.send_slots.clone().try_acquire_owned().map_err(|_| {
        "Nearby is already sending four batches. Wait for one to finish.".to_string()
    })?;

    async_runtime::spawn(async move {
        let _permit = permit;
        do_send(rt, ip, port, paths).await;
    });
    Ok(())
}

#[tauri::command]
pub fn nearby_approve(
    state: State<AppState>,
    session_id: String,
    approved: bool,
) -> Result<(), String> {
    let rt = state
        .nearby
        .lock()
        .map_err(|_| "Nearby state is unavailable.".to_string())?
        .clone()
        .ok_or_else(|| "Nearby is not running.".to_string())?;
    resolve_pending_approval(&rt.pending_approvals, &session_id, approved).map_err(|reason| {
        match reason {
            "approval state unavailable" => "Nearby approval state is unavailable.".to_string(),
            "approval request expired" => "This approval request has expired.".to_string(),
            _ => "The sender disconnected before approval.".to_string(),
        }
    })
}

/* ------------------------------- socket setup ---------------------------- */

fn bind_tcp() -> Option<(u16, TcpListener)> {
    for port in [DEFAULT_PORT, LEGACY_PORT] {
        if let Ok(std_listener) = try_bind_tcp(port) {
            if let Ok(listener) = TcpListener::from_std(std_listener) {
                return Some((port, listener));
            }
        }
    }
    None
}

fn try_bind_tcp(port: u16) -> std::io::Result<std::net::TcpListener> {
    let socket = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP))?;
    socket.set_reuse_address(true)?;
    let addr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, port));
    socket.bind(&addr.into())?;
    socket.listen(1024)?;
    let listener: std::net::TcpListener = socket.into();
    listener.set_nonblocking(true)?;
    Ok(listener)
}

fn bind_udp(port: u16, join_multicast: bool) -> std::io::Result<UdpSocket> {
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    socket.set_reuse_address(true)?;
    let addr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, port));
    socket.bind(&addr.into())?;
    if join_multicast {
        // Best-effort: some adapters/stacks refuse the UNSPECIFIED interface.
        let _ = socket.join_multicast_v4(&MULTICAST_ADDR, &Ipv4Addr::UNSPECIFIED);
        let _ = socket.set_multicast_loop_v4(true);
    }
    let std_socket: std::net::UdpSocket = socket.into();
    std_socket.set_nonblocking(true)?;
    Ok(UdpSocket::from_std(std_socket)?)
}

/* -------------------------------- task fork ------------------------------ */

fn spawn_tasks(
    rt: &Arc<NearbyRuntime>,
    tcp: TcpListener,
    udp: Option<UdpSocket>,
    legacy: Option<UdpSocket>,
) {
    let (tx, rx) = oneshot::channel::<()>();
    let (done_tx, done_rx) = oneshot::channel::<()>();
    if let Ok(mut slot) = rt.shutdown_tx.lock() {
        *slot = Some(tx);
    }
    if let Ok(mut slot) = rt.shutdown_done_rx.lock() {
        *slot = Some(done_rx);
    }

    // HTTP receive server.
    let http_rt = rt.clone();
    async_runtime::spawn(async move {
        let app = Router::new()
            .route("/api/localsend/v2/register", post(handle_register))
            .route("/api/localsend/v2/info", get(handle_info))
            .route(
                "/api/localsend/v2/prepare-upload",
                post(handle_prepare_upload),
            )
            .route("/api/localsend/v2/upload", post(handle_upload))
            .route("/api/localsend/v2/upload-state", post(handle_upload_state))
            .route("/api/localsend/v2/cancel", post(handle_cancel))
            .with_state(http_rt.clone());

        let make = app.into_make_service_with_connect_info::<SocketAddr>();
        if let Err(e) = axum::serve(tcp, make)
            .with_graceful_shutdown(async move {
                let _ = rx.await;
            })
            .await
        {
            eprintln!("[nearby] http server stopped: {e}");
        }
        let _ = done_tx.send(());
    });

    if let Some(sock) = udp {
        let udp_rt = rt.clone();
        async_runtime::spawn(async move { udp_loop(udp_rt, sock, true).await });
    }
    if let Some(sock) = legacy {
        let udp_rt = rt.clone();
        async_runtime::spawn(async move { udp_loop(udp_rt, sock, false).await });
    }

    // Housekeeping: prune stale peers and abandoned sessions.
    let prune_rt = rt.clone();
    async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(5));
        loop {
            interval.tick().await;
            if !prune_rt.running.load(Ordering::Relaxed) {
                break;
            }
            let peers_changed = {
                let Ok(mut peers) = prune_rt.peers.lock() else {
                    continue;
                };
                let before = peers.len();
                peers.retain(|p| p.last_seen.elapsed() < PEER_TIMEOUT);
                before != peers.len()
            };
            let sessions_changed = {
                if let Ok(mut sessions) = prune_rt.sessions.lock() {
                    let before = sessions.len();
                    sessions.retain(|_, s| s.created.elapsed() < SESSION_TIMEOUT);
                    before != sessions.len()
                } else {
                    false
                }
            };
            let approvals_changed = {
                if let Ok(mut approvals) = prune_rt.pending_approvals.lock() {
                    let before = approvals.len();
                    approvals.retain(|_, a| a.created.elapsed() < APPROVAL_TIMEOUT);
                    before != approvals.len()
                } else {
                    false
                }
            };
            if peers_changed || sessions_changed || approvals_changed {
                emit_changed(&prune_rt);
            }
        }
    });
}

/* ------------------------------- discovery ------------------------------- */

async fn udp_loop(rt: Arc<NearbyRuntime>, socket: UdpSocket, announce: bool) {
    let payload = serde_json::to_vec(&rt.multicast_message(announce)).unwrap_or_default();
    let target = SocketAddr::V4(SocketAddrV4::new(MULTICAST_ADDR, DEFAULT_PORT));
    let mut interval = tokio::time::interval(Duration::from_secs(4));
    let mut buf = vec![0u8; 65536];

    loop {
        if !rt.running.load(Ordering::Relaxed) {
            break;
        }
        tokio::select! {
            _ = interval.tick() => {
                if announce {
                    let _ = socket.send_to(&payload, target).await;
                }
            }
            received = tokio::time::timeout(Duration::from_millis(800), socket.recv_from(&mut buf)) => {
                if let Ok(Ok((len, src))) = received {
                    if let Ok(msg) = serde_json::from_slice::<MulticastMessage>(&buf[..len]) {
                        handle_announcement(&rt, &msg, src).await;
                    }
                }
            }
        }
    }
}

async fn handle_announcement(rt: &Arc<NearbyRuntime>, msg: &MulticastMessage, src: SocketAddr) {
    if msg.fingerprint.is_empty() || msg.fingerprint == rt.fingerprint {
        return;
    }
    let ip = src.ip().to_string();
    let port = if msg.port != 0 {
        msg.port
    } else {
        DEFAULT_PORT
    };
    add_peer(rt, &msg.fingerprint, &msg.alias, &ip, port, &msg.protocol);
    emit_changed(rt);

    if msg.announce {
        let rt = rt.clone();
        async_runtime::spawn(async move { register_with_peer(&rt, &ip, port).await });
    }
}

async fn register_with_peer(rt: &Arc<NearbyRuntime>, ip: &str, port: u16) {
    let url = format!("http://{ip}:{port}/api/localsend/v2/register");
    match rt
        .client
        .post(&url)
        .timeout(Duration::from_secs(15))
        .json(&rt.device_info())
        .send()
        .await
    {
        Ok(resp) => {
            if let Ok(info) = resp.json::<DeviceInfo>().await {
                add_peer(rt, &info.fingerprint, &info.alias, ip, port, &info.protocol);
                emit_changed(rt);
            }
        }
        Err(e) => eprintln!("[nearby] register {ip}:{port} failed: {e}"),
    }
}

/* ---------------------------- inbound HTTP API --------------------------- */

async fn handle_register(
    AxumState(rt): AxumState<Arc<NearbyRuntime>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(info): Json<DeviceInfo>,
) -> Json<DeviceInfo> {
    let port = if info.port != 0 {
        info.port
    } else {
        DEFAULT_PORT
    };
    add_peer(
        &rt,
        &info.fingerprint,
        &info.alias,
        &addr.ip().to_string(),
        port,
        &info.protocol,
    );
    emit_changed(&rt);
    Json(rt.device_info())
}

async fn handle_info(AxumState(rt): AxumState<Arc<NearbyRuntime>>) -> Json<DeviceInfo> {
    Json(rt.device_info())
}

async fn create_received_file(
    dir: &std::path::Path,
    file_name: &str,
) -> std::io::Result<(tokio::fs::File, PathBuf)> {
    let original = std::path::Path::new(file_name);
    let stem = original.file_stem().unwrap_or_default().to_string_lossy();
    let extension = original.extension().map(|e| e.to_string_lossy());
    for suffix in 1..=1000 {
        let candidate = if suffix == 1 {
            file_name.to_string()
        } else if let Some(ext) = extension.as_deref() {
            format!("{stem} ({suffix}).{ext}")
        } else {
            format!("{stem} ({suffix})")
        };
        let path = dir.join(candidate);
        match tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .await
        {
            Ok(file) => return Ok((file, path)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "too many files with the same name",
    ))
}

async fn handle_prepare_upload(
    AxumState(rt): AxumState<Arc<NearbyRuntime>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(req): Json<PrepareUploadRequest>,
) -> Result<Json<PrepareUploadResponse>, StatusCode> {
    if !rt.running.load(Ordering::Acquire) {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }
    if req.info.alias.len() > 128 || req.info.fingerprint.len() > 128 {
        return Err(StatusCode::BAD_REQUEST);
    }
    if !valid_upload_request(&req.files) {
        return Err(StatusCode::BAD_REQUEST);
    }
    if session_capacity_reached(&rt) {
        return Err(StatusCode::TOO_MANY_REQUESTS);
    }

    let session_id = uuid::Uuid::new_v4().to_string();
    let peer_label = sender_label(&req.info.alias, addr.ip());
    let mut file_names: Vec<String> = req
        .files
        .values()
        .map(|file| sanitize(&file.file_name))
        .collect();
    file_names.sort_unstable();
    let file_preview = file_names
        .iter()
        .take(8)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    let file_preview = if file_names.len() > 8 {
        format!("{file_preview}, and {} more", file_names.len() - 8)
    } else {
        file_preview
    };
    let (approval_tx, approval_rx) = oneshot::channel::<bool>();
    insert_pending_approval(&rt, session_id.clone(), approval_tx)?;
    append_transfers(
        &rt,
        [NearbyTransfer {
            id: session_id.clone(),
            peer: peer_label.clone(),
            direction: "receive".into(),
            file_name: format!(
                "{} file{}: {file_preview}",
                req.files.len(),
                if req.files.len() == 1 { "" } else { "s" }
            ),
            bytes: 0,
            total: req.files.values().map(|f| f.size).sum(),
            status: "pending".into(),
        }],
    );
    emit_changed(&rt);

    let approval = tokio::time::timeout(APPROVAL_TIMEOUT, approval_rx).await;
    if !matches!(&approval, Ok(Ok(true))) {
        if let Ok(mut pending) = rt.pending_approvals.lock() {
            pending.remove(&session_id);
        }
        if let Ok(mut list) = rt.transfers.lock() {
            if let Some(t) = list.iter_mut().find(|t| t.id == session_id) {
                t.status = if !rt.running.load(Ordering::Acquire) {
                    "stopped"
                } else if matches!(&approval, Ok(Ok(false))) {
                    "rejected"
                } else {
                    "expired"
                }
                .into();
            }
        }
        emit_changed(&rt);
        return Err(if matches!(&approval, Ok(Ok(false))) {
            StatusCode::FORBIDDEN
        } else {
            StatusCode::GONE
        });
    }

    if !rt.running.load(Ordering::Acquire) {
        if let Ok(mut list) = rt.transfers.lock() {
            if let Some(t) = list.iter_mut().find(|t| t.id == session_id) {
                t.status = "stopped".into();
            }
        }
        emit_changed(&rt);
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }
    let dir = downloads_dir().join("HoverIsland").join(&session_id);
    if tokio::fs::create_dir_all(&dir).await.is_err() {
        if let Ok(mut list) = rt.transfers.lock() {
            if let Some(t) = list.iter_mut().find(|t| t.id == session_id) {
                t.status = "failed".into();
            }
        }
        emit_changed(&rt);
        return Err(StatusCode::INTERNAL_SERVER_ERROR);
    }

    let mut tokens: HashMap<String, String> = HashMap::new();
    let mut transfers: Vec<NearbyTransfer> = Vec::new();
    for (key, meta) in &req.files {
        let file_id = if meta.id.is_empty() {
            key.clone()
        } else {
            meta.id.clone()
        };
        tokens.insert(file_id.clone(), uuid::Uuid::new_v4().to_string());
        transfers.push(NearbyTransfer {
            id: file_id,
            peer: peer_label.clone(),
            direction: "receive".into(),
            file_name: meta.file_name.clone(),
            bytes: 0,
            total: meta.size,
            status: "active".into(),
        });
    }

    let insert_result = insert_session(
        &rt,
        session_id.clone(),
        peer_label.clone(),
        req.files.clone(),
        tokens.clone(),
        dir.clone(),
    );
    if let Err(error) = insert_result {
        let _ = std::fs::remove_dir(&dir);
        let (status, message) = match error {
            SessionInsertError::Capacity => (
                StatusCode::TOO_MANY_REQUESTS,
                "failed: too many active sessions",
            ),
            SessionInsertError::Unavailable => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "failed: session state unavailable",
            ),
        };
        if let Ok(mut list) = rt.transfers.lock() {
            if let Some(t) = list.iter_mut().find(|t| t.id == session_id) {
                t.status = message.into();
            }
        }
        emit_changed(&rt);
        return Err(status);
    }
    if let Ok(mut list) = rt.transfers.lock() {
        list.retain(|t| t.id != session_id);
    }
    append_transfers(&rt, transfers);
    emit_changed(&rt);

    Ok(Json(PrepareUploadResponse {
        session_id,
        files: tokens,
    }))
}

async fn handle_upload(
    AxumState(rt): AxumState<Arc<NearbyRuntime>>,
    Query(q): Query<UploadQuery>,
    _conn: ConnectInfo<SocketAddr>,
    body: Body,
) -> StatusCode {
    let Ok(_upload_slot) = rt.upload_slots.clone().try_acquire_owned() else {
        return StatusCode::TOO_MANY_REQUESTS;
    };
    let (dir, file_name, expected_sha, expected_size) = {
        let sessions = match rt.sessions.lock() {
            Ok(s) => s,
            Err(_) => return StatusCode::INTERNAL_SERVER_ERROR,
        };
        let Some(session) = sessions.get(&q.session_id) else {
            return StatusCode::FORBIDDEN;
        };
        match session.tokens.get(&q.file_id) {
            Some(token) if *token == q.token => {}
            _ => return StatusCode::FORBIDDEN,
        }
        let meta = session
            .files
            .get(&q.file_id)
            .or_else(|| session.files.values().find(|m| m.id == q.file_id));
        let Some(meta) = meta else {
            return StatusCode::BAD_REQUEST;
        };
        if meta.size > MAX_FILE_SIZE {
            return StatusCode::PAYLOAD_TOO_LARGE;
        }
        (
            session.dir.clone(),
            sanitize(&meta.file_name),
            meta.sha256.clone(),
            meta.size,
        )
    };

    if let Err(e) = tokio::fs::create_dir_all(&dir).await {
        set_transfer_error(&rt, &q.file_id, e);
        emit_changed(&rt);
        return StatusCode::INTERNAL_SERVER_ERROR;
    }

    let (mut file, path) = match create_received_file(&dir, &file_name).await {
        Ok(file) => file,
        Err(e) => {
            eprintln!("[nearby] cannot create destination {file_name}: {e}");
            set_transfer_error(&rt, &q.file_id, format!("cannot create destination: {e}"));
            emit_changed(&rt);
            return StatusCode::INTERNAL_SERVER_ERROR;
        }
    };

    let mut stream = body.into_data_stream();
    let mut hasher = Sha256::new();
    let mut written: u64 = 0;
    let mut last_emit = Instant::now();

    loop {
        let chunk = tokio::select! {
            result = tokio::time::timeout(Duration::from_secs(30), stream.next()) => match result {
                Ok(chunk) => chunk,
                Err(_) => {
                    drop(file);
                    let _ = tokio::fs::remove_file(&path).await;
                    set_transfer_error(&rt, &q.file_id, "upload stalled for 30 seconds");
                    emit_changed(&rt);
                    return StatusCode::REQUEST_TIMEOUT;
                }
            },
            _ = tokio::time::sleep(Duration::from_millis(250)) => {
                if !rt.running.load(Ordering::Acquire) {
                    drop(file);
                    let _ = tokio::fs::remove_file(&path).await;
                    set_transfer_error(&rt, &q.file_id, "Nearby was stopped during the transfer");
                    emit_changed(&rt);
                    return StatusCode::SERVICE_UNAVAILABLE;
                }
                continue;
            }
        };
        let Some(chunk) = chunk else {
            break;
        };
        let session_is_active = rt
            .sessions
            .lock()
            .map(|s| s.contains_key(&q.session_id))
            .unwrap_or(false);
        if !session_is_active {
            drop(file);
            let _ = tokio::fs::remove_file(&path).await;
            set_transfer_error(&rt, &q.file_id, "transfer session was cancelled or expired");
            emit_changed(&rt);
            return StatusCode::GONE;
        }
        match chunk {
            Ok(bytes) => {
                if written.saturating_add(bytes.len() as u64) > expected_size {
                    drop(file);
                    let _ = tokio::fs::remove_file(&path).await;
                    set_transfer_error(&rt, &q.file_id, "upload exceeded the declared file size");
                    emit_changed(&rt);
                    return StatusCode::PAYLOAD_TOO_LARGE;
                }
                if let Err(e) = file.write_all(&bytes).await {
                    eprintln!("[nearby] write error: {e}");
                    drop(file);
                    let _ = tokio::fs::remove_file(&path).await;
                    set_transfer_error(&rt, &q.file_id, e);
                    emit_changed(&rt);
                    return StatusCode::INTERNAL_SERVER_ERROR;
                }
                hasher.update(&bytes);
                written += bytes.len() as u64;
                if last_emit.elapsed().as_millis() >= 120 {
                    last_emit = Instant::now();
                    set_transfer_progress(&rt, &q.file_id, written);
                    emit_changed(&rt);
                }
            }
            Err(e) => {
                eprintln!("[nearby] upload stream error: {e}");
                drop(file);
                let _ = tokio::fs::remove_file(&path).await;
                set_transfer_error(&rt, &q.file_id, e);
                emit_changed(&rt);
                return StatusCode::INTERNAL_SERVER_ERROR;
            }
        }
    }
    let _ = file.flush().await;

    if written != expected_size {
        drop(file);
        let _ = tokio::fs::remove_file(&path).await;
        set_transfer_error(
            &rt,
            &q.file_id,
            "received size did not match the declared size",
        );
        emit_changed(&rt);
        return StatusCode::UNPROCESSABLE_ENTITY;
    }

    if let Some(expected) = expected_sha {
        if !expected.is_empty() && !to_hex(&hasher.finalize()).eq_ignore_ascii_case(&expected) {
            drop(file);
            let _ = tokio::fs::remove_file(&path).await;
            eprintln!("[nearby] checksum mismatch for {file_name}");
            set_transfer_error(&rt, &q.file_id, "SHA-256 checksum mismatch");
            emit_changed(&rt);
            return StatusCode::UNPROCESSABLE_ENTITY;
        }
    }

    set_transfer_progress(&rt, &q.file_id, written);
    set_transfer_status(&rt, &q.file_id, "done");
    emit_changed(&rt);
    StatusCode::OK
}

async fn handle_upload_state(
    AxumState(rt): AxumState<Arc<NearbyRuntime>>,
    Query(q): Query<SessionQuery>,
) -> StatusCode {
    match rt.sessions.lock() {
        Ok(sessions) if sessions.contains_key(&q.session_id) => StatusCode::OK,
        Ok(_) => StatusCode::NOT_FOUND,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

async fn handle_cancel(
    AxumState(rt): AxumState<Arc<NearbyRuntime>>,
    Query(q): Query<SessionQuery>,
) -> StatusCode {
    let removed = rt
        .sessions
        .lock()
        .ok()
        .and_then(|mut s| s.remove(&q.session_id));
    if let Some(session) = removed {
        let ids: Vec<String> = session
            .files
            .iter()
            .map(|(k, m)| {
                if m.id.is_empty() {
                    k.clone()
                } else {
                    m.id.clone()
                }
            })
            .collect();
        if let Ok(mut list) = rt.transfers.lock() {
            for id in ids {
                if let Some(t) = list.iter_mut().find(|t| t.id == id) {
                    if t.status == "active" {
                        t.status = "failed".into();
                    }
                }
            }
        }
        emit_changed(&rt);
    }
    StatusCode::OK
}

/* ------------------------------ outbound send ---------------------------- */

async fn do_send(rt: Arc<NearbyRuntime>, ip: String, port: u16, paths: Vec<String>) {
    let peer_label = format!("{ip}:{port}");

    let mut files: HashMap<String, FileMeta> = HashMap::new();
    let mut order: Vec<(String, String)> = Vec::new();
    for path in &paths {
        let p = std::path::Path::new(path);
        let name = p
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "file".into());
        let size = std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
        let id = uuid::Uuid::new_v4().to_string();
        files.insert(
            id.clone(),
            FileMeta {
                id: id.clone(),
                file_name: name.clone(),
                size,
                file_type: Some(mime_for(&name)),
                sha256: None,
                preview: None,
                metadata: None,
            },
        );
        order.push((id, path.clone()));
    }

    let outgoing = order.iter().map(|(id, path)| {
        let name = std::path::Path::new(path)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let total = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        NearbyTransfer {
            id: id.clone(),
            peer: peer_label.clone(),
            direction: "send".into(),
            file_name: name,
            bytes: 0,
            total,
            status: "waiting".into(),
        }
    });
    append_transfers(&rt, outgoing);
    emit_changed(&rt);

    let url = format!("http://{ip}:{port}/api/localsend/v2/prepare-upload");
    let request = PrepareUploadRequest {
        info: rt.device_info(),
        files: files.clone(),
    };
    let resp = match rt
        .client
        .post(&url)
        .timeout(APPROVAL_TIMEOUT + Duration::from_secs(15))
        .json(&request)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[nearby] prepare-upload to {peer_label} failed: {e}");
            for (id, _) in &order {
                set_transfer_error(&rt, id, &e);
            }
            emit_changed(&rt);
            return;
        }
    };
    if !resp.status().is_success() {
        eprintln!(
            "[nearby] prepare-upload rejected by {peer_label}: {}",
            resp.status()
        );
        for (id, _) in &order {
            set_transfer_error(&rt, id, format!("receiver returned {}", resp.status()));
        }
        emit_changed(&rt);
        return;
    }
    let prepared: PrepareUploadResponse = match resp.json().await {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[nearby] bad prepare-upload response: {e}");
            for (id, _) in &order {
                set_transfer_error(&rt, id, &e);
            }
            emit_changed(&rt);
            return;
        }
    };

    for (file_id, _) in &order {
        set_transfer_status(&rt, file_id, "active");
    }
    emit_changed(&rt);
    for (file_id, path) in &order {
        let Some(token) = prepared.files.get(file_id).cloned() else {
            set_transfer_error(&rt, file_id, "receiver did not return an upload token");
            continue;
        };
        upload_to_peer(&rt, &ip, port, &prepared.session_id, file_id, &token, path).await;
    }
    emit_changed(&rt);
}

async fn upload_to_peer(
    rt: &Arc<NearbyRuntime>,
    ip: &str,
    port: u16,
    session_id: &str,
    file_id: &str,
    token: &str,
    path: &str,
) {
    let file = match tokio::fs::File::open(path).await {
        Ok(f) => f,
        Err(e) => {
            eprintln!("[nearby] cannot open {path}: {e}");
            set_transfer_error(rt, file_id, &e);
            emit_changed(rt);
            return;
        }
    };

    let sent = Arc::new(AtomicU64::new(0));
    let last = Arc::new(Mutex::new(Instant::now()));
    let rt_stream = rt.clone();
    let id_stream = file_id.to_string();

    let stream = futures_util::stream::unfold(file, move |mut f| {
        let sent = sent.clone();
        let last = last.clone();
        let rt = rt_stream.clone();
        let id = id_stream.clone();
        async move {
            if !rt.running.load(Ordering::Acquire) {
                return Some((
                    Err(std::io::Error::new(
                        std::io::ErrorKind::Interrupted,
                        "Nearby stopped",
                    )),
                    f,
                ));
            }
            let mut buf = vec![0u8; CHUNK];
            match f.read(&mut buf).await {
                Ok(0) => None,
                Ok(n) => {
                    buf.truncate(n);
                    let total = sent.fetch_add(n as u64, Ordering::Relaxed) + n as u64;
                    let should_emit = {
                        let Ok(mut l) = last.lock() else {
                            return Some((
                                Err(std::io::Error::new(
                                    std::io::ErrorKind::Other,
                                    "progress state unavailable",
                                )),
                                f,
                            ));
                        };
                        if l.elapsed().as_millis() >= 120 {
                            *l = Instant::now();
                            true
                        } else {
                            false
                        }
                    };
                    if should_emit {
                        set_transfer_progress(&rt, &id, total);
                        emit_changed(&rt);
                    }
                    Some((Ok::<Bytes, std::io::Error>(Bytes::from(buf)), f))
                }
                Err(e) => Some((Err(e), f)),
            }
        }
    });

    let body = reqwest::Body::wrap_stream(stream);
    let url = format!(
        "http://{ip}:{port}/api/localsend/v2/upload?sessionId={session_id}&fileId={file_id}&token={token}"
    );

    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    match rt
        .client
        .post(&url)
        .timeout(transfer_timeout(size))
        .body(body)
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            let total = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
            set_transfer_progress(rt, file_id, total);
            set_transfer_status(rt, file_id, "done");
        }
        Ok(resp) => {
            eprintln!("[nearby] upload {file_id} rejected: {}", resp.status());
            set_transfer_error(rt, file_id, format!("receiver returned {}", resp.status()));
        }
        Err(e) => {
            eprintln!("[nearby] upload {file_id} failed: {e}");
            set_transfer_error(rt, file_id, &e);
        }
    }
    emit_changed(rt);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(id: &str, file_name: &str, size: u64) -> FileMeta {
        FileMeta {
            id: id.into(),
            file_name: file_name.into(),
            size,
            file_type: None,
            sha256: None,
            preview: None,
            metadata: None,
        }
    }

    #[test]
    fn inbound_names_are_flat_and_windows_safe() {
        assert_eq!(sanitize(r"..\..\escape.txt"), "escape.txt");
        assert_eq!(sanitize("CON.txt"), "file");
        assert_eq!(sanitize(" report. "), "report");
        assert_eq!(sanitize(""), "file");
    }

    #[test]
    fn approval_prompt_identifies_sender_address_without_control_text() {
        assert_eq!(
            sender_label("Tablet\n", "192.168.1.9".parse().unwrap()),
            "Tablet (192.168.1.9)"
        );
    }

    #[test]
    fn upload_request_validation_bounds_ids_and_sizes() {
        let mut files = HashMap::from([("a".into(), meta("a", "a.txt", 12))]);
        assert!(valid_upload_request(&files));
        files.insert("b".into(), meta("a", "b.txt", 1));
        assert!(
            !valid_upload_request(&files),
            "duplicate protocol IDs must be rejected"
        );
        files.clear();
        files.insert(
            "large".into(),
            meta("large", "large.bin", MAX_FILE_SIZE + 1),
        );
        assert!(!valid_upload_request(&files));
        files.clear();
        files.insert("bad".into(), meta("bad", "  ", 0));
        assert!(!valid_upload_request(&files));
    }

    #[test]
    fn approval_is_one_shot_and_decision_reaches_waiting_request() {
        let pending = Mutex::new(HashMap::new());
        let (tx, mut rx) = oneshot::channel();
        pending.lock().unwrap().insert(
            "session".into(),
            PendingApproval {
                sender: tx,
                created: Instant::now(),
            },
        );

        assert_eq!(resolve_pending_approval(&pending, "session", true), Ok(()));
        assert!(matches!(rx.try_recv(), Ok(true)));
        assert_eq!(
            resolve_pending_approval(&pending, "session", false),
            Err("approval request expired")
        );
    }

    #[tokio::test]
    async fn duplicate_names_get_a_new_path_without_replacing_existing_bytes() {
        let dir = std::env::temp_dir().join(format!("hover-nearby-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let (mut first, first_path) = create_received_file(&dir, "report.txt").await.unwrap();
        first.write_all(b"original").await.unwrap();
        first.flush().await.unwrap();
        drop(first);

        let (mut second, second_path) = create_received_file(&dir, "report.txt").await.unwrap();
        second.write_all(b"incoming").await.unwrap();
        second.flush().await.unwrap();
        drop(second);

        assert_eq!(tokio::fs::read(first_path).await.unwrap(), b"original");
        assert_eq!(tokio::fs::read(second_path).await.unwrap(), b"incoming");
        tokio::fs::remove_dir_all(dir).await.unwrap();
    }
}
