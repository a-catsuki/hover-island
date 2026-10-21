//! Temporary, token-authenticated LAN file bucket for phones and this PC.
//!
//! The server listens only while the user starts a session. The random QR URL
//! can request pairing; a phone receives bucket access only after PC approval
//! and then uses an HttpOnly cookie whose hash is stored locally. Traffic is
//! plain HTTP on the local network, so stop the session when sharing is done.
//! Files are saved without overwriting into Downloads/Hover Island.

use crate::paired_devices::{
    new_cookie, storage_path as paired_storage_path, PairedDeviceStore, PairingStatus, PendingPairs,
};
use axum::body::{Body, Bytes};
use axum::extract::{ConnectInfo, Path, Query, State as AxumState};
use axum::http::{header, HeaderMap, HeaderValue, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::StreamExt;
use qrcode::render::svg;
use qrcode::QrCode;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, UdpSocket as StdUdpSocket};
use std::path::{Path as FsPath, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{oneshot, Mutex as AsyncMutex, Semaphore};

const SESSION_TTL: Duration = Duration::from_secs(30 * 60);
const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024;
const MAX_BUCKET_BYTES: u64 = 500 * 1024 * 1024;
const MAX_FILES: usize = 50;
const MAX_CONCURRENT_UPLOADS: usize = 2;
const MAX_FILENAME_BYTES: usize = 180;
const IDLE_CHUNK_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_UPLOAD_DURATION: Duration = Duration::from_secs(10 * 60);
const CHUNK_BYTES: usize = 64 * 1024;
const PREFERRED_LAN_PORT: u16 = 47_692;
const DEVICE_COOKIE: &str = "hover_island_device";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferFile {
    pub id: String,
    pub name: String,
    pub size: u64,
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferStatus {
    pub active: bool,
    pub phone_url: Option<String>,
    pub desktop_url: Option<String>,
    pub bookmark_url: Option<String>,
    pub stable_bookmark: bool,
    pub qr_data_url: Option<String>,
    pub expires_at: Option<u64>,
    pub files: Vec<TransferFile>,
    pub save_folder: String,
    pub max_file_bytes: u64,
    pub max_bucket_bytes: u64,
    pub error: Option<String>,
}

#[derive(Deserialize)]
struct PairRequestBody {
    name: String,
}

#[derive(Serialize)]
struct PairRequestStateBody {
    state: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadResult {
    file: TransferFile,
}

#[derive(Deserialize)]
struct UploadQuery {
    name: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileList {
    files: Vec<TransferFile>,
}

struct StoredFile {
    public: TransferFile,
    path: PathBuf,
}

#[derive(Default)]
struct Bucket {
    files: HashMap<String, StoredFile>,
    pending: usize,
    reserved_bytes: u64,
    total_bytes: u64,
}

struct Session {
    token: String,
    port: u16,
    lan_ip: Ipv4Addr,
    stable_bookmark: bool,
    save_dir: PathBuf,
    expires: Instant,
    expires_at: u64,
    qr_data_url: String,
    app: Option<AppHandle>,
    closed: AtomicBool,
    bucket: Mutex<Bucket>,
    paired_devices: Mutex<PairedDeviceStore>,
    pending_pairs: Mutex<PendingPairs>,
    upload_slots: Arc<Semaphore>,
    zip_download_active: AtomicBool,
    // Browser smoke uses loopback networking but must still exercise phone pairing.
    // This field and its checks are compiled only into tests; production continues
    // to trust local loopback access for the desktop's own browser.
    #[cfg(test)]
    require_pairing_on_loopback: AtomicBool,
}

impl Session {
    fn phone_base(&self) -> String {
        format!("http://{}:{}/s/{}", self.lan_ip, self.port, self.token)
    }

    fn desktop_base(&self) -> String {
        format!("http://127.0.0.1:{}/s/{}", self.port, self.token)
    }

    fn bookmark_url(&self) -> String {
        format!("http://{}:{}/device", self.lan_ip, self.port)
    }

    fn is_expired(&self) -> bool {
        self.closed.load(Ordering::Acquire) || Instant::now() >= self.expires
    }

    fn list(&self) -> Vec<TransferFile> {
        let bucket = self.bucket.lock().unwrap_or_else(|p| p.into_inner());
        let mut files = bucket
            .files
            .values()
            .map(|file| file.public.clone())
            .collect::<Vec<_>>();
        files.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        files
    }
}

struct ActiveSession {
    session: Arc<Session>,
    shutdown: Option<oneshot::Sender<()>>,
    server_task: tokio::task::JoinHandle<()>,
    expiry_task: tokio::task::JoinHandle<()>,
}

fn active() -> &'static AsyncMutex<Option<ActiveSession>> {
    static ACTIVE: OnceLock<AsyncMutex<Option<ActiveSession>>> = OnceLock::new();
    ACTIVE.get_or_init(|| AsyncMutex::new(None))
}

#[tauri::command]
pub async fn transfer_status() -> TransferStatus {
    let mut active = active().lock().await;
    if active
        .as_ref()
        .is_some_and(|entry| entry.session.is_expired())
    {
        if let Some(mut expired) = active.take() {
            close_session(expired);
        }
    }
    active
        .as_ref()
        .map(|entry| status_for(&entry.session))
        .unwrap_or_else(inactive_status)
}

#[tauri::command]
pub async fn transfer_start(app: AppHandle) -> Result<TransferStatus, String> {
    let mut active = active().lock().await;
    if let Some(entry) = active.as_ref() {
        if !entry.session.is_expired() {
            return Ok(status_for(&entry.session));
        }
    }
    if let Some(mut expired) = active.take() {
        close_session(expired);
    }

    let lan_ip = discover_lan_ip().ok_or_else(|| {
        "Could not find a local IPv4 network address. Connect this PC and phone to the same Wi-Fi network.".to_string()
    })?;
    let save_dir = download_folder()?;
    std::fs::create_dir_all(&save_dir)
        .map_err(|e| format!("Could not create the download folder: {e}"))?;
    let preferred =
        TcpListener::bind(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, PREFERRED_LAN_PORT)).await;
    let (listener, stable_bookmark) = match preferred {
        Ok(listener) => (listener, true),
        Err(_) => (
            TcpListener::bind(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 0))
                .await
                .map_err(|e| format!("Could not start the local phone bucket: {e}"))?,
            false,
        ),
    };
    let port = listener
        .local_addr()
        .map_err(|e| format!("Could not read the local server address: {e}"))?
        .port();
    let token = uuid::Uuid::new_v4().simple().to_string();
    let phone_url = format!("http://{lan_ip}:{port}/s/{token}");
    let qr = QrCode::new(phone_url.as_bytes())
        .map_err(|e| format!("Could not create a phone QR code: {e}"))?;
    let svg_doc = qr.render::<svg::Color>().min_dimensions(220, 220).build();
    let qr_data_url = format!(
        "data:image/svg+xml;base64,{}",
        base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            svg_doc.as_bytes()
        )
    );
    let expires_at = now_ms().saturating_add(SESSION_TTL.as_millis() as u64);
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate saved phone storage: {error}"))?;
    let paired_devices = PairedDeviceStore::load(paired_storage_path(&app_data))?;
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let session = Arc::new(Session {
        token,
        port,
        lan_ip,
        stable_bookmark,
        save_dir,
        expires: Instant::now() + SESSION_TTL,
        expires_at,
        qr_data_url,
        app: Some(app),
        closed: AtomicBool::new(false),
        bucket: Mutex::new(Bucket::default()),
        paired_devices: Mutex::new(paired_devices),
        pending_pairs: Mutex::new(PendingPairs::default()),
        upload_slots: Arc::new(Semaphore::new(MAX_CONCURRENT_UPLOADS)),
        zip_download_active: AtomicBool::new(false),
        #[cfg(test)]
        require_pairing_on_loopback: AtomicBool::new(false),
    });
    let router = router(session.clone());
    let expiry = session.expires;
    let server_task = tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    });
    let server_abort = server_task.abort_handle();
    let expiry_session = session.clone();
    let expiry_task = tokio::spawn(async move {
        tokio::select! {
            _ = shutdown_rx => {},
            _ = tokio::time::sleep_until(expiry.into()) => {},
        }
        expiry_session.closed.store(true, Ordering::Release);
        server_abort.abort();
    });
    *active = Some(ActiveSession {
        session: session.clone(),
        shutdown: Some(shutdown_tx),
        server_task,
        expiry_task,
    });
    Ok(status_for(&session))
}

#[tauri::command]
pub async fn transfer_stop() {
    if let Some(current) = active().lock().await.take() {
        close_session(current);
    }
}

#[tauri::command]
pub async fn transfer_pairing_status(app: AppHandle) -> Result<PairingStatus, String> {
    let session = {
        let mut active = active().lock().await;
        if active
            .as_ref()
            .is_some_and(|entry| entry.session.is_expired())
        {
            if let Some(expired) = active.take() {
                close_session(expired);
            }
        }
        active.as_ref().map(|entry| entry.session.clone())
    };
    let pending = if let Some(session) = &session {
        session
            .pending_pairs
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .views(Instant::now())
    } else {
        Vec::new()
    };
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate saved phone storage: {error}"))?;
    let mut devices = if let Some(session) = &session {
        session
            .paired_devices
            .lock()
            .map_err(|_| "Saved phone list is busy.".to_string())?
            .views(now_ms())
    } else {
        PairedDeviceStore::load(paired_storage_path(&app_data))?.views(now_ms())
    };
    if let Some(session) = &session {
        let started_at = session
            .expires_at
            .saturating_sub(SESSION_TTL.as_millis() as u64);
        for device in &mut devices {
            device.online &= device.last_seen.is_some_and(|seen| seen >= started_at);
        }
    } else {
        for device in &mut devices {
            device.online = false;
        }
    }
    Ok(PairingStatus { devices, pending })
}

#[tauri::command]
pub async fn transfer_pairing_decide(pair_id: String, allow: bool) -> Result<(), String> {
    let active = active().lock().await;
    let session = active
        .as_ref()
        .map(|entry| entry.session.clone())
        .ok_or_else(|| "Start the phone bucket before approving a phone.".to_string())?;
    if session.is_expired() {
        return Err("The phone bucket session has expired.".into());
    }
    let result = session
        .pending_pairs
        .lock()
        .map_err(|_| "Phone pairing is busy.".to_string())?
        .decide(&pair_id, allow, Instant::now());
    result
}

#[tauri::command]
pub async fn transfer_pairing_remove(app: AppHandle, device_id: String) -> Result<bool, String> {
    let session = active()
        .lock()
        .await
        .as_ref()
        .map(|entry| entry.session.clone());
    if let Some(session) = session {
        return session
            .paired_devices
            .lock()
            .map_err(|_| "Saved phone list is busy.".to_string())?
            .remove(&device_id);
    }
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate saved phone storage: {error}"))?;
    PairedDeviceStore::load(paired_storage_path(&app_data))?.remove(&device_id)
}

struct DroppedMember {
    path: PathBuf,
    name: String,
    size: u64,
}

enum DroppedItem {
    File(DroppedMember),
    Folder {
        name: String,
        members: Vec<DroppedMember>,
    },
}

/// Native Explorer drops retain their filesystem paths. Reuse the same bounded,
/// cancellable upload pipeline as phone/browser uploads, without loading a file
/// into the renderer or silently changing the source files.
#[tauri::command]
pub async fn transfer_stage_dropped_paths(
    app: AppHandle,
    paths: Vec<String>,
) -> Result<TransferStatus, String> {
    let paths = crate::recycle::consume_drop_authorization(&paths)?;
    let plan = tokio::task::spawn_blocking(move || plan_dropped_items(&paths))
        .await
        .map_err(|_| "Could not inspect the dropped files.".to_string())??;
    transfer_start(app).await?;
    let session = active()
        .lock()
        .await
        .as_ref()
        .map(|entry| entry.session.clone())
        .ok_or_else(|| "The phone bucket was stopped.".to_string())?;
    let total = plan
        .iter()
        .map(|item| match item {
            DroppedItem::File(member) => member.size,
            DroppedItem::Folder { members, .. } => {
                members
                    .iter()
                    .map(|member| member.size + member.name.len() as u64 * 2 + 128)
                    .sum::<u64>()
                    + 22
            }
        })
        .sum::<u64>();
    {
        let bucket = session
            .bucket
            .lock()
            .map_err(|_| "The phone bucket is busy.".to_string())?;
        if bucket.files.len() + bucket.pending + plan.len() > MAX_FILES
            || bucket
                .total_bytes
                .saturating_add(bucket.reserved_bytes)
                .saturating_add(total)
                > MAX_BUCKET_BYTES
        {
            return Err("These files do not fit in the phone bucket (50 items / 500 MB).".into());
        }
    }
    for item in plan {
        if session.is_expired() {
            return Err("The phone bucket was stopped or expired.".into());
        }
        match item {
            DroppedItem::File(member) => {
                stage_native_file(session.clone(), &member.path, &member.name).await?
            }
            DroppedItem::Folder { name, members } => {
                let archive = session.save_dir.join(format!(
                    ".hover-island-folder-{}.part",
                    uuid::Uuid::new_v4().simple()
                ));
                let result = async {
                    write_dropped_archive(&session, &archive, &members).await?;
                    stage_native_file(session.clone(), &archive, &name).await
                }
                .await;
                // This exact path was created here, never a user source path.
                let _ = tokio::fs::remove_file(&archive).await;
                result?;
            }
        }
    }
    if session.is_expired() {
        return Err("The phone bucket was stopped or expired.".into());
    }
    Ok(status_for(&session))
}

fn dropped_metadata(path: &FsPath) -> Result<std::fs::Metadata, String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("Could not read a dropped item: {error}"))?;
    let mut linked = metadata.file_type().is_symlink();
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        linked |= metadata.file_attributes() & 0x400 != 0;
    }
    if linked || (!metadata.is_file() && !metadata.is_dir()) {
        return Err("Linked or special files cannot be added to the phone bucket.".into());
    }
    Ok(metadata)
}

fn plan_dropped_items(paths: &[PathBuf]) -> Result<Vec<DroppedItem>, String> {
    if paths.is_empty() || paths.len() > MAX_FILES {
        return Err("Drop between 1 and 50 files or folders.".into());
    }
    let mut items = Vec::new();
    let mut total = 0u64;
    for path in paths {
        let metadata = dropped_metadata(path)?;
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .and_then(sanitize_filename)
            .ok_or_else(|| "A dropped item has an invalid name.".to_string())?;
        if metadata.is_file() {
            if metadata.len() > MAX_FILE_BYTES {
                return Err("A file exceeds the 100 MB limit.".into());
            }
            total = total.saturating_add(metadata.len());
            items.push(DroppedItem::File(DroppedMember {
                path: path.clone(),
                name,
                size: metadata.len(),
            }));
        } else {
            let mut members = Vec::new();
            let mut folder_bytes = 0;
            let mut visited = 0;
            collect_dropped_folder(
                path,
                path,
                &name,
                0,
                &mut members,
                &mut folder_bytes,
                &mut visited,
            )?;
            if members.is_empty() {
                return Err("That folder has no files to share.".into());
            }
            total = total.saturating_add(folder_bytes);
            items.push(DroppedItem::Folder {
                name: format!("{name}.zip"),
                members,
            });
        }
        if total > MAX_BUCKET_BYTES {
            return Err("The dropped files exceed the 500 MB bucket limit.".into());
        }
    }
    Ok(items)
}

fn collect_dropped_folder(
    root: &FsPath,
    directory: &FsPath,
    prefix: &str,
    depth: usize,
    members: &mut Vec<DroppedMember>,
    total: &mut u64,
    visited: &mut usize,
) -> Result<(), String> {
    if depth > 32 {
        return Err("This folder is nested too deeply to share.".into());
    }
    // Bound empty-directory trees as well as files, rather than accumulating an
    // unlimited read_dir list before checking the archive limit.
    for entry in std::fs::read_dir(directory)
        .map_err(|error| format!("Could not read the folder: {error}"))?
    {
        *visited += 1;
        if *visited > 1000 {
            return Err("A folder can contain at most 1000 files and directories.".into());
        }
        let entry = entry.map_err(|error| format!("Could not read a folder entry: {error}"))?;
        let path = entry.path();
        let metadata = dropped_metadata(&path)?;
        if metadata.is_dir() {
            collect_dropped_folder(root, &path, prefix, depth + 1, members, total, visited)?;
        } else {
            if members.len() >= 500 {
                return Err("A folder can contain at most 500 files.".into());
            }
            *total = total.saturating_add(metadata.len());
            if *total > 95 * 1024 * 1024 {
                return Err("Folder drops are limited to 95 MB.".into());
            }
            let relative = path
                .strip_prefix(root)
                .map_err(|_| "A folder entry escaped its root.".to_string())?;
            let components = relative
                .components()
                .map(|component| match component {
                    std::path::Component::Normal(value) => value
                        .to_str()
                        .filter(|value| !value.contains(['\\', '/', ':', '\0']))
                        .map(str::to_owned)
                        .ok_or_else(|| "A folder entry has an invalid relative path.".to_string()),
                    _ => Err("A folder entry has an invalid relative path.".to_string()),
                })
                .collect::<Result<Vec<_>, _>>()?;
            let name = format!("{prefix}/{}", components.join("/"));
            if name.len() > 4096 {
                return Err("A folder entry path is too long.".into());
            }
            members.push(DroppedMember {
                path,
                name,
                size: metadata.len(),
            });
        }
    }
    Ok(())
}

async fn write_dropped_archive(
    session: &Session,
    destination: &FsPath,
    members: &[DroppedMember],
) -> Result<(), String> {
    let mut output = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .await
        .map_err(|error| error.to_string())?;
    let mut central = Vec::new();
    let mut offset = 0u32;
    let mut buffer = vec![0u8; CHUNK_BYTES];
    for member in members {
        dropped_metadata(&member.path)?;
        let local = zip_local_header(member.name.as_bytes());
        output
            .write_all(&local)
            .await
            .map_err(|error| error.to_string())?;
        let local_offset = offset;
        offset += local.len() as u32;
        let mut source = tokio::fs::File::open(&member.path)
            .await
            .map_err(|error| format!("Could not read a folder file: {error}"))?;
        let mut size = 0u32;
        let mut crc = u32::MAX;
        loop {
            if session.is_expired() {
                return Err("The phone bucket was stopped or expired.".into());
            }
            let read = source
                .read(&mut buffer)
                .await
                .map_err(|error| error.to_string())?;
            if read == 0 {
                break;
            }
            size = size
                .checked_add(read as u32)
                .ok_or_else(|| "A folder file grew too large.".to_string())?;
            if size as u64 > member.size {
                return Err("A folder file changed while being prepared. Drop it again.".into());
            }
            crc = crc32_update(crc, &buffer[..read]);
            output
                .write_all(&buffer[..read])
                .await
                .map_err(|error| error.to_string())?;
        }
        if size as u64 != member.size {
            return Err("A folder file changed while being prepared. Drop it again.".into());
        }
        let descriptor = zip_data_descriptor(!crc, size);
        output
            .write_all(&descriptor)
            .await
            .map_err(|error| error.to_string())?;
        offset += size + descriptor.len() as u32;
        central.push(ZipCentralEntry {
            name: member.name.as_bytes().to_vec(),
            crc: !crc,
            size,
            local_offset,
        });
    }
    let directory = zip_central_directory(&central);
    output
        .write_all(&directory)
        .await
        .map_err(|error| error.to_string())?;
    output
        .write_all(&zip_end_record(
            central.len() as u16,
            directory.len() as u32,
            offset,
        ))
        .await
        .map_err(|error| error.to_string())?;
    output.sync_all().await.map_err(|error| error.to_string())
}

async fn stage_native_file(session: Arc<Session>, path: &FsPath, name: &str) -> Result<(), String> {
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|error| format!("Could not read the dropped file: {error}"))?;
    let total = file
        .metadata()
        .await
        .map_err(|error| error.to_string())?
        .len();
    let stream = futures_util::stream::try_unfold(file, |mut file| async move {
        let mut buffer = vec![0; CHUNK_BYTES];
        let read = file.read(&mut buffer).await?;
        buffer.truncate(read);
        Ok::<_, std::io::Error>(if read == 0 {
            None
        } else {
            Some((Bytes::from(buffer), file))
        })
    });
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    headers.insert(
        header::ORIGIN,
        HeaderValue::from_static("tauri://localhost"),
    );
    headers.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&total.to_string()).map_err(|error| error.to_string())?,
    );
    let response = upload_file(
        Path(session.token.clone()),
        Query(UploadQuery { name: name.into() }),
        AxumState(session),
        ConnectInfo(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))),
        headers,
        Request::new(Body::from_stream(stream)),
    )
    .await;
    if response.status().is_success() {
        return Ok(());
    }
    let bytes = axum::body::to_bytes(response.into_body(), 16 * 1024)
        .await
        .map_err(|error| error.to_string())?;
    let message = serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .and_then(|value| value.as_str())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "Could not add these files to the phone bucket.".into());
    Err(message)
}

fn close_session(mut current: ActiveSession) {
    current.session.closed.store(true, Ordering::Release);
    if let Some(shutdown) = current.shutdown.take() {
        let _ = shutdown.send(());
    }
    current.server_task.abort();
    current.expiry_task.abort();
}

#[tauri::command]
pub fn transfer_open_folder(app: AppHandle) -> Result<(), String> {
    let folder = download_folder()?;
    std::fs::create_dir_all(&folder)
        .map_err(|e| format!("Could not open the download folder: {e}"))?;
    app.opener()
        .open_path(folder.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| format!("Could not open the download folder: {e}"))
}

fn router(session: Arc<Session>) -> Router {
    Router::new()
        .route("/device", get(device_bookmark))
        .route("/s/:token", get(phone_page))
        .route("/s/:token/api/pair/request", post(pair_request))
        .route("/s/:token/api/pair/status/:id", get(pair_request_status))
        .route("/s/:token/api/pair/claim/:id", post(pair_claim))
        .route(
            "/s/:token/api/files",
            get(list_files).put(upload_file).options(preflight),
        )
        .route("/s/:token/api/files/:id", get(download_file))
        .route("/s/:token/api/bucket.zip", get(download_bucket_zip))
        .with_state(session)
}

async fn phone_page(
    Path(token): Path<String>,
    AxumState(session): AxumState<Arc<Session>>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if let Err((status, message)) = authorize_base(&session, &token, remote, &headers, false) {
        return (status, message).into_response();
    }
    let paired = match authenticated_device_id(&session, &headers) {
        Some(id) => {
            touch_device(&session, &id);
            true
        }
        None => loopback_bypass_allowed(&session, remote),
    };
    if !paired {
        return secure_html_response(PAIRING_PAGE.to_string());
    }
    let bookmark_note = if session.stable_bookmark {
        "The preferred address is available whenever this PC's bucket is running."
    } else {
        "The port changed for this session. Scan a fresh QR code next time."
    };
    let html = MOBILE_PAGE
        .replace("__DEVICE_BOOKMARK__", &session.bookmark_url())
        .replace("__BOOKMARK_NOTE__", bookmark_note);
    secure_html_response(html)
}

async fn device_bookmark(
    AxumState(session): AxumState<Arc<Session>>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if session.is_expired() {
        return (StatusCode::GONE, "Start the phone bucket on your PC first.").into_response();
    }
    let expected_host = format!("{}:{}", session.lan_ip, session.port);
    if !is_local_address(remote.ip())
        || headers
            .get(header::HOST)
            .and_then(|value| value.to_str().ok())
            != Some(expected_host.as_str())
    {
        return (
            StatusCode::FORBIDDEN,
            "This bookmark is available only from the paired local network.",
        )
            .into_response();
    }
    let Some(id) = authenticated_device_id(&session, &headers) else {
        return (
            StatusCode::UNAUTHORIZED,
            "Remember this phone with a fresh QR code first.",
        )
            .into_response();
    };
    touch_device(&session, &id);
    let mut response = StatusCode::SEE_OTHER.into_response();
    match HeaderValue::from_str(&session.phone_base()) {
        Ok(location) => {
            response.headers_mut().insert(header::LOCATION, location);
        }
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not open the phone bucket.",
            )
                .into_response()
        }
    }
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn pair_request(
    Path(token): Path<String>,
    AxumState(session): AxumState<Arc<Session>>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<PairRequestBody>,
) -> Response {
    if let Err((status, message)) = authorize_base(&session, &token, remote, &headers, true) {
        return (status, message).into_response();
    }
    let mut pending = session
        .pending_pairs
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    match pending.request(
        &body.name,
        new_cookie(),
        remote.ip(),
        Instant::now(),
        now_ms(),
    ) {
        Ok(request) => Json(request).into_response(),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": error})),
        )
            .into_response(),
    }
}

async fn pair_request_status(
    Path((token, id)): Path<(String, String)>,
    AxumState(session): AxumState<Arc<Session>>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if let Err((status, message)) = authorize_base(&session, &token, remote, &headers, false) {
        return (status, message).into_response();
    }
    let state = session
        .pending_pairs
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .state(&id, remote.ip(), Instant::now());
    (
        [(header::CACHE_CONTROL, "no-store")],
        Json(PairRequestStateBody { state }),
    )
        .into_response()
}

async fn pair_claim(
    Path((token, id)): Path<(String, String)>,
    AxumState(session): AxumState<Arc<Session>>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if let Err((status, message)) = authorize_base(&session, &token, remote, &headers, true) {
        return (status, message).into_response();
    }
    let claim = session
        .pending_pairs
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .claim(&id, remote.ip(), Instant::now());
    let (request, cookie) = match claim {
        Ok(claim) => claim,
        Err(error) => {
            return (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({"error": error})),
            )
                .into_response()
        }
    };
    if let Err(error) = session
        .paired_devices
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remember(request.id, request.name, &cookie)
    {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": error})),
        )
            .into_response();
    }
    let cookie =
        format!("{DEVICE_COOKIE}={cookie}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict");
    let mut response = StatusCode::NO_CONTENT.into_response();
    if let Ok(value) = HeaderValue::from_str(&cookie) {
        response.headers_mut().insert(header::SET_COOKIE, value);
    } else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Could not finish phone pairing.",
        )
            .into_response();
    }
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn secure_html_response(body: String) -> Response {
    let mut response = ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], body).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response.headers_mut().insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"),
    );
    response
}

async fn list_files(
    Path(token): Path<String>,
    AxumState(session): AxumState<Arc<Session>>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if let Err((status, message)) = authorize(&session, &token, remote, &headers, false) {
        return (status, message).into_response();
    }
    let mut response = Json(FileList {
        files: session.list(),
    })
    .into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn preflight(
    Path(token): Path<String>,
    AxumState(session): AxumState<Arc<Session>>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if let Err((status, message)) = authorize(&session, &token, remote, &headers, true) {
        return (status, message).into_response();
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    add_cors_headers(&mut response, &session, remote, &headers);
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, PUT, OPTIONS"),
    );
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("content-type"),
    );
    response.headers_mut().insert(
        header::ACCESS_CONTROL_MAX_AGE,
        HeaderValue::from_static("300"),
    );
    response.headers_mut().insert(
        "access-control-allow-private-network",
        HeaderValue::from_static("true"),
    );
    response
}

async fn upload_file(
    Path(token): Path<String>,
    Query(query): Query<UploadQuery>,
    AxumState(session): AxumState<Arc<Session>>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    request: Request<Body>,
) -> Response {
    if let Err((status, message)) = authorize(&session, &token, remote, &headers, true) {
        return upload_error(status, message, &session, remote, &headers);
    }
    if headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map_or(true, |value| {
            !value.eq_ignore_ascii_case("application/octet-stream")
        })
    {
        return upload_error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Upload must use application/octet-stream",
            &session,
            remote,
            &headers,
        );
    }
    if let Some(length) = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|h| h.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
    {
        if length > MAX_FILE_BYTES {
            return upload_error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "File exceeds the 100 MB limit",
                &session,
                remote,
                &headers,
            );
        }
    }
    let file_name = match sanitize_filename(&query.name) {
        Some(name) => name,
        None => {
            return upload_error(
                StatusCode::BAD_REQUEST,
                "Invalid file name",
                &session,
                remote,
                &headers,
            )
        }
    };
    let permit = match tokio::time::timeout(
        Duration::from_secs(2),
        session.upload_slots.clone().acquire_owned(),
    )
    .await
    {
        Ok(Ok(permit)) => permit,
        _ => {
            return upload_error(
                StatusCode::TOO_MANY_REQUESTS,
                "Too many uploads are already active",
                &session,
                remote,
                &headers,
            )
        }
    };
    if let Err(message) = reserve_upload(&session) {
        return upload_error(
            StatusCode::INSUFFICIENT_STORAGE,
            &message,
            &session,
            remote,
            &headers,
        );
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    let temp_path = session.save_dir.join(format!(".hover-island-{id}.part"));
    let upload_start = Instant::now();
    let mut file = match tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp_path)
        .await
    {
        Ok(file) => file,
        Err(error) => {
            release_upload(&session, 0, false);
            return upload_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("Could not create a temporary file: {error}"),
                &session,
                remote,
                &headers,
            );
        }
    };
    let mut body = request.into_body().into_data_stream();
    let from_pc = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            matches!(
                value,
                "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost"
            )
        });
    let declared_total = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    let phase = if from_pc { "staging" } else { "receiving" };
    emit_file_event(&session, &id, &file_name, 0, declared_total, phase);
    let mut last_progress = Instant::now();
    let mut bytes = 0u64;
    let receive_result: Result<(), (StatusCode, String)> = async {
        loop {
            if session.is_expired() || upload_start.elapsed() > MAX_UPLOAD_DURATION {
                return Err((
                    StatusCode::REQUEST_TIMEOUT,
                    "Upload session expired or timed out".to_string(),
                ));
            }
            let next = tokio::time::timeout(IDLE_CHUNK_TIMEOUT, body.next())
                .await
                .map_err(|_| {
                    (
                        StatusCode::REQUEST_TIMEOUT,
                        "Upload stalled for too long".to_string(),
                    )
                })?;
            let Some(chunk) = next else { break };
            let chunk = chunk.map_err(|_| {
                (
                    StatusCode::BAD_REQUEST,
                    "Could not read upload data".to_string(),
                )
            })?;
            let size = chunk.len() as u64;
            if bytes.saturating_add(size) > MAX_FILE_BYTES {
                return Err((
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "File exceeds the 100 MB limit".to_string(),
                ));
            }
            if let Err(message) = reserve_bytes(&session, size) {
                return Err((StatusCode::INSUFFICIENT_STORAGE, message));
            }
            bytes += size;
            file.write_all(&chunk).await.map_err(|_| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Could not save uploaded file".to_string(),
                )
            })?;
            if last_progress.elapsed() >= Duration::from_millis(400) {
                emit_file_event(&session, &id, &file_name, bytes, declared_total, phase);
                last_progress = Instant::now();
            }
        }
        file.sync_all().await.map_err(|_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not finish saving uploaded file".to_string(),
            )
        })?;
        Ok(())
    }
    .await;
    drop(file);

    if let Err((status, message)) = receive_result {
        let _ = tokio::fs::remove_file(&temp_path).await;
        release_upload(&session, bytes, false);
        emit_file_event(&session, &id, &file_name, bytes, declared_total, "error");
        drop(permit);
        return upload_error(status, &message, &session, remote, &headers);
    }

    let (final_path, final_name) =
        match commit_file(&session.save_dir, &temp_path, &file_name).await {
            Ok(value) => value,
            Err(error) => {
                let _ = tokio::fs::remove_file(&temp_path).await;
                release_upload(&session, bytes, false);
                emit_file_event(&session, &id, &file_name, bytes, Some(bytes), "error");
                drop(permit);
                return upload_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    &error,
                    &session,
                    remote,
                    &headers,
                );
            }
        };
    let entry = TransferFile {
        id: id.clone(),
        name: final_name,
        size: bytes,
        created_at: now_ms(),
    };
    {
        let mut bucket = session.bucket.lock().unwrap_or_else(|p| p.into_inner());
        bucket.pending = bucket.pending.saturating_sub(1);
        bucket.reserved_bytes = bucket.reserved_bytes.saturating_sub(bytes);
        bucket.total_bytes = bucket.total_bytes.saturating_add(bytes);
        bucket.files.insert(
            id.clone(),
            StoredFile {
                public: entry.clone(),
                path: final_path,
            },
        );
    }
    emit_file_event(
        &session,
        &id,
        &entry.name,
        bytes,
        Some(bytes),
        if from_pc { "ready" } else { "complete" },
    );
    let mut response = Json(UploadResult { file: entry }).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    add_cors_headers(&mut response, &session, remote, &headers);
    response
}

async fn download_file(
    Path((token, id)): Path<(String, String)>,
    AxumState(session): AxumState<Arc<Session>>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if let Err((status, message)) = authorize(&session, &token, remote, &headers, false) {
        return (status, message).into_response();
    }
    let stored = {
        let bucket = session.bucket.lock().unwrap_or_else(|p| p.into_inner());
        bucket
            .files
            .get(&id)
            .map(|file| (file.public.clone(), file.path.clone()))
    };
    let Some((metadata, path)) = stored else {
        return (StatusCode::NOT_FOUND, "File not found").into_response();
    };
    if !is_child(&session.save_dir, &path) {
        return (StatusCode::NOT_FOUND, "File not found").into_response();
    }
    let file = match tokio::fs::File::open(path).await {
        Ok(file) => file,
        Err(_) => return (StatusCode::NOT_FOUND, "File not found").into_response(),
    };
    let download_id = format!("download-{}", uuid::Uuid::new_v4());
    emit_file_event(
        &session,
        &download_id,
        &metadata.name,
        0,
        Some(metadata.size),
        "sending",
    );
    let stream = futures_util::stream::try_unfold(
        (
            file,
            session.clone(),
            download_id,
            metadata.name.clone(),
            metadata.size,
            0u64,
            Instant::now(),
        ),
        |(mut file, session, id, name, total, mut sent, mut last_progress)| async move {
            let mut buffer = vec![0u8; CHUNK_BYTES];
            let read = match tokio::io::AsyncReadExt::read(&mut file, &mut buffer).await {
                Ok(read) => read,
                Err(error) => {
                    emit_file_event(&session, &id, &name, sent, Some(total), "error");
                    return Err(error);
                }
            };
            if read == 0 {
                emit_file_event(&session, &id, &name, sent, Some(total), "sent");
                return Ok::<_, std::io::Error>(None);
            }
            sent = sent.saturating_add(read as u64);
            if last_progress.elapsed() >= Duration::from_millis(400) {
                emit_file_event(&session, &id, &name, sent, Some(total), "sending");
                last_progress = Instant::now();
            }
            buffer.truncate(read);
            Ok(Some((
                Bytes::from(buffer),
                (file, session, id, name, total, sent, last_progress),
            )))
        },
    );
    let mut response = Body::from_stream(stream).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    response.headers_mut().insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&metadata.size.to_string())
            .unwrap_or_else(|_| HeaderValue::from_static("0")),
    );
    let disposition = format!(
        "attachment; filename*=UTF-8''{}",
        percent_encode(metadata.name.as_bytes())
    );
    if let Ok(value) = HeaderValue::from_str(&disposition) {
        response
            .headers_mut()
            .insert(header::CONTENT_DISPOSITION, value);
    }
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

#[derive(Clone)]
struct ZipMember {
    name: String,
    path: PathBuf,
    size: u64,
}

struct ZipCurrent {
    member: ZipMember,
    file: tokio::fs::File,
    crc: u32,
    size: u32,
    local_offset: u32,
}

struct ZipCentralEntry {
    name: Vec<u8>,
    crc: u32,
    size: u32,
    local_offset: u32,
}

struct ZipDownloadGuard(Arc<Session>);

impl Drop for ZipDownloadGuard {
    fn drop(&mut self) {
        self.0.zip_download_active.store(false, Ordering::Release);
    }
}

struct ZipStream {
    session: Arc<Session>,
    _guard: ZipDownloadGuard,
    entries: Vec<ZipMember>,
    index: usize,
    current: Option<ZipCurrent>,
    central: Vec<ZipCentralEntry>,
    offset: u64,
    total: u64,
    sent: u64,
    last_progress: Instant,
    event_id: String,
    central_emitted: bool,
    finished: bool,
}

async fn download_bucket_zip(
    Path(token): Path<String>,
    AxumState(session): AxumState<Arc<Session>>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if let Err((status, message)) = authorize(&session, &token, remote, &headers, false) {
        return (status, message).into_response();
    }
    let entries = {
        let bucket = session.bucket.lock().unwrap_or_else(|p| p.into_inner());
        bucket
            .files
            .values()
            .map(|stored| ZipMember {
                name: stored.public.name.clone(),
                path: stored.path.clone(),
                size: stored.public.size,
            })
            .collect::<Vec<_>>()
    };
    if entries.is_empty() {
        return (StatusCode::NOT_FOUND, "The phone bucket has no files").into_response();
    }
    if entries.len() > MAX_FILES
        || entries
            .iter()
            .any(|entry| !is_child(&session.save_dir, &entry.path))
    {
        return (StatusCode::CONFLICT, "The phone bucket contents changed").into_response();
    }
    let total = entries
        .iter()
        .fold(0u64, |sum, entry| sum.saturating_add(entry.size));
    if total > MAX_BUCKET_BYTES {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            "The phone bucket exceeds its archive limit",
        )
            .into_response();
    }
    if session
        .zip_download_active
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            "A bucket archive is already being prepared",
        )
            .into_response();
    }

    let event_id = format!("bucket-zip-{}", uuid::Uuid::new_v4().simple());
    emit_file_event(
        &session,
        &event_id,
        "All files.zip",
        0,
        Some(total),
        "sending",
    );
    let state = ZipStream {
        session: session.clone(),
        _guard: ZipDownloadGuard(session),
        entries,
        index: 0,
        current: None,
        central: Vec::new(),
        offset: 0,
        total,
        sent: 0,
        last_progress: Instant::now(),
        event_id,
        central_emitted: false,
        finished: false,
    };
    let stream = futures_util::stream::unfold(state, |mut state| async move {
        if state.finished {
            return None;
        }
        if state.session.is_expired() {
            emit_file_event(
                &state.session,
                &state.event_id,
                "All files.zip",
                state.sent,
                Some(state.total),
                "error",
            );
            state.finished = true;
            return Some((
                Err(std::io::Error::new(
                    std::io::ErrorKind::Interrupted,
                    "Phone bucket session ended",
                )),
                state,
            ));
        }

        if state.current.is_none() && state.index < state.entries.len() {
            let member = state.entries[state.index].clone();
            let name = member.name.as_bytes().to_vec();
            if name.is_empty() || name.len() > u16::MAX as usize || member.size > u32::MAX as u64 {
                state.finished = true;
                emit_file_event(
                    &state.session,
                    &state.event_id,
                    "All files.zip",
                    state.sent,
                    Some(state.total),
                    "error",
                );
                return Some((
                    Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "Archive entry is too large",
                    )),
                    state,
                ));
            }
            match tokio::fs::File::open(&member.path).await {
                Ok(file) => {
                    let local_offset = state.offset as u32;
                    let header = zip_local_header(&name);
                    state.offset = state.offset.saturating_add(header.len() as u64);
                    state.current = Some(ZipCurrent {
                        member,
                        file,
                        crc: u32::MAX,
                        size: 0,
                        local_offset,
                    });
                    return Some((Ok(Bytes::from(header)), state));
                }
                Err(error) => {
                    state.finished = true;
                    emit_file_event(
                        &state.session,
                        &state.event_id,
                        "All files.zip",
                        state.sent,
                        Some(state.total),
                        "error",
                    );
                    return Some((Err(error), state));
                }
            }
        }

        if let Some(current) = state.current.as_mut() {
            let mut buffer = vec![0u8; CHUNK_BYTES];
            match tokio::io::AsyncReadExt::read(&mut current.file, &mut buffer).await {
                Ok(read) if read > 0 => {
                    if state.sent.saturating_add(read as u64) > MAX_BUCKET_BYTES
                        || current.size.checked_add(read as u32).is_none()
                    {
                        state.finished = true;
                        emit_file_event(
                            &state.session,
                            &state.event_id,
                            "All files.zip",
                            state.sent,
                            Some(state.total),
                            "error",
                        );
                        return Some((
                            Err(std::io::Error::new(
                                std::io::ErrorKind::InvalidData,
                                "Archive exceeds its size limit",
                            )),
                            state,
                        ));
                    }
                    current.crc = crc32_update(current.crc, &buffer[..read]);
                    current.size += read as u32;
                    state.sent += read as u64;
                    state.offset += read as u64;
                    buffer.truncate(read);
                    if state.last_progress.elapsed() >= Duration::from_millis(400) {
                        emit_file_event(
                            &state.session,
                            &state.event_id,
                            "All files.zip",
                            state.sent,
                            Some(state.total),
                            "sending",
                        );
                        state.last_progress = Instant::now();
                    }
                    return Some((Ok(Bytes::from(buffer)), state));
                }
                Ok(_) => {
                    let current = state.current.take().unwrap();
                    if current.size as u64 != current.member.size {
                        state.finished = true;
                        emit_file_event(
                            &state.session,
                            &state.event_id,
                            "All files.zip",
                            state.sent,
                            Some(state.total),
                            "error",
                        );
                        return Some((
                            Err(std::io::Error::new(
                                std::io::ErrorKind::InvalidData,
                                "A bucket file changed during archive creation",
                            )),
                            state,
                        ));
                    }
                    let crc = !current.crc;
                    let descriptor = zip_data_descriptor(crc, current.size);
                    state.offset += descriptor.len() as u64;
                    state.central.push(ZipCentralEntry {
                        name: current.member.name.into_bytes(),
                        crc,
                        size: current.size,
                        local_offset: current.local_offset,
                    });
                    state.index += 1;
                    return Some((Ok(Bytes::from(descriptor)), state));
                }
                Err(error) => {
                    state.finished = true;
                    emit_file_event(
                        &state.session,
                        &state.event_id,
                        "All files.zip",
                        state.sent,
                        Some(state.total),
                        "error",
                    );
                    return Some((Err(error), state));
                }
            }
        }

        if !state.central_emitted {
            let central_offset = state.offset as u32;
            let directory = zip_central_directory(&state.central);
            let end = zip_end_record(
                state.central.len() as u16,
                directory.len() as u32,
                central_offset,
            );
            let mut bytes = directory;
            bytes.extend_from_slice(&end);
            state.offset += bytes.len() as u64;
            state.central_emitted = true;
            return Some((Ok(Bytes::from(bytes)), state));
        }
        emit_file_event(
            &state.session,
            &state.event_id,
            "All files.zip",
            state.sent,
            Some(state.total),
            "sent",
        );
        state.finished = true;
        None
    });
    let mut response = Body::from_stream(stream).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/zip"),
    );
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static("attachment; filename=\"Hover-Island-files.zip\""),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

fn zip_local_header(name: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(30 + name.len());
    put_u32(&mut out, 0x04034b50);
    put_u16(&mut out, 20);
    put_u16(&mut out, 0x0808); // UTF-8 names and trailing data descriptor.
    put_u16(&mut out, 0); // Stored; file bytes pass directly through the response stream.
    put_u16(&mut out, 0);
    put_u16(&mut out, 0);
    put_u32(&mut out, 0);
    put_u32(&mut out, 0);
    put_u32(&mut out, 0);
    put_u16(&mut out, name.len() as u16);
    put_u16(&mut out, 0);
    out.extend_from_slice(name);
    out
}

fn zip_data_descriptor(crc: u32, size: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(16);
    put_u32(&mut out, 0x08074b50);
    put_u32(&mut out, crc);
    put_u32(&mut out, size);
    put_u32(&mut out, size);
    out
}

fn zip_central_directory(entries: &[ZipCentralEntry]) -> Vec<u8> {
    let capacity = entries.iter().map(|entry| 46 + entry.name.len()).sum();
    let mut out = Vec::with_capacity(capacity);
    for entry in entries {
        put_u32(&mut out, 0x02014b50);
        put_u16(&mut out, 20);
        put_u16(&mut out, 20);
        put_u16(&mut out, 0x0808);
        put_u16(&mut out, 0);
        put_u16(&mut out, 0);
        put_u16(&mut out, 0);
        put_u32(&mut out, entry.crc);
        put_u32(&mut out, entry.size);
        put_u32(&mut out, entry.size);
        put_u16(&mut out, entry.name.len() as u16);
        put_u16(&mut out, 0);
        put_u16(&mut out, 0);
        put_u16(&mut out, 0);
        put_u16(&mut out, 0);
        put_u32(&mut out, 0);
        put_u32(&mut out, entry.local_offset);
        out.extend_from_slice(&entry.name);
    }
    out
}

fn zip_end_record(entries: u16, central_size: u32, central_offset: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(22);
    put_u32(&mut out, 0x06054b50);
    put_u16(&mut out, 0);
    put_u16(&mut out, 0);
    put_u16(&mut out, entries);
    put_u16(&mut out, entries);
    put_u32(&mut out, central_size);
    put_u32(&mut out, central_offset);
    put_u16(&mut out, 0);
    out
}

fn put_u16(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_le_bytes());
}
fn put_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn crc32_update(mut crc: u32, bytes: &[u8]) -> u32 {
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 == 1 {
                (crc >> 1) ^ 0xedb88320
            } else {
                crc >> 1
            };
        }
    }
    crc
}

fn authorize(
    session: &Session,
    token: &str,
    remote: SocketAddr,
    headers: &HeaderMap,
    require_origin: bool,
) -> Result<(), (StatusCode, &'static str)> {
    authorize_base(session, token, remote, headers, require_origin)?;
    if !loopback_bypass_allowed(session, remote) {
        let id = authenticated_device_id(session, headers).ok_or((
            StatusCode::UNAUTHORIZED,
            "Remember this phone before using the bucket",
        ))?;
        touch_device(session, &id);
    }
    Ok(())
}

fn loopback_bypass_allowed(session: &Session, remote: SocketAddr) -> bool {
    if !remote.ip().is_loopback() {
        return false;
    }
    #[cfg(test)]
    if session.require_pairing_on_loopback.load(Ordering::Acquire) {
        return false;
    }
    true
}

fn authorize_base(
    session: &Session,
    token: &str,
    remote: SocketAddr,
    headers: &HeaderMap,
    require_origin: bool,
) -> Result<(), (StatusCode, &'static str)> {
    if session.is_expired() {
        return Err((StatusCode::GONE, "This phone bucket session has expired"));
    }
    if token != session.token {
        return Err((StatusCode::NOT_FOUND, "Session not found"));
    }
    if !is_local_address(remote.ip()) {
        return Err((
            StatusCode::FORBIDDEN,
            "Phone bucket is available only on the local network",
        ));
    }
    if let Some(origin) = headers.get(header::ORIGIN).and_then(|h| h.to_str().ok()) {
        if !allowed_origin(origin, remote, session, headers) {
            return Err((StatusCode::FORBIDDEN, "Request origin is not allowed"));
        }
    } else if require_origin {
        return Err((
            StatusCode::FORBIDDEN,
            "An allowed origin is required for uploads",
        ));
    }
    Ok(())
}

fn authenticated_device_id(session: &Session, headers: &HeaderMap) -> Option<String> {
    let cookie = headers.get(header::COOKIE)?.to_str().ok()?;
    let prefix = format!("{DEVICE_COOKIE}=");
    let value = cookie
        .split(';')
        .map(str::trim)
        .find_map(|part| part.strip_prefix(prefix.as_str()))?;
    session.paired_devices.lock().ok()?.authenticated_id(value)
}

fn touch_device(session: &Session, id: &str) {
    if let Ok(mut devices) = session.paired_devices.lock() {
        let _ = devices.touch(id, now_ms());
    }
}

fn allowed_origin(
    origin: &str,
    remote: SocketAddr,
    session: &Session,
    headers: &HeaderMap,
) -> bool {
    if remote.ip().is_loopback()
        && matches!(
            origin,
            "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost"
        )
    {
        return true;
    }
    let actual_host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok());
    let allowed_hosts = if remote.ip().is_loopback() {
        vec![
            format!("127.0.0.1:{}", session.port),
            format!("localhost:{}", session.port),
            format!("{}:{}", session.lan_ip, session.port),
        ]
    } else {
        vec![format!("{}:{}", session.lan_ip, session.port)]
    };
    actual_host.is_some_and(|host| {
        allowed_hosts
            .iter()
            .any(|expected| host == expected && origin == format!("http://{expected}"))
    })
}

fn add_cors_headers(
    response: &mut Response,
    session: &Session,
    remote: SocketAddr,
    request_headers: &HeaderMap,
) {
    if let Some(origin) = request_headers
        .get(header::ORIGIN)
        .and_then(|h| h.to_str().ok())
    {
        if allowed_origin(origin, remote, session, request_headers) {
            if let Ok(value) = HeaderValue::from_str(origin) {
                response
                    .headers_mut()
                    .insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
                response
                    .headers_mut()
                    .insert(header::VARY, HeaderValue::from_static("Origin"));
            }
        }
    }
}

fn upload_error(
    status: StatusCode,
    message: &str,
    session: &Session,
    remote: SocketAddr,
    headers: &HeaderMap,
) -> Response {
    #[derive(Serialize)]
    struct ErrorBody<'a> {
        error: &'a str,
    }
    let mut response = (status, Json(ErrorBody { error: message })).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    add_cors_headers(&mut response, session, remote, headers);
    response
}

fn reserve_upload(session: &Session) -> Result<(), String> {
    let mut bucket = session.bucket.lock().unwrap_or_else(|p| p.into_inner());
    if bucket.files.len().saturating_add(bucket.pending) >= MAX_FILES {
        return Err("Bucket is full (maximum 50 files)".to_string());
    }
    if bucket.total_bytes.saturating_add(bucket.reserved_bytes) >= MAX_BUCKET_BYTES {
        return Err("Bucket is full (maximum 500 MB)".to_string());
    }
    bucket.pending += 1;
    Ok(())
}

fn reserve_bytes(session: &Session, size: u64) -> Result<(), String> {
    let mut bucket = session.bucket.lock().unwrap_or_else(|p| p.into_inner());
    if bucket
        .total_bytes
        .saturating_add(bucket.reserved_bytes)
        .saturating_add(size)
        > MAX_BUCKET_BYTES
    {
        return Err("Bucket is full (maximum 500 MB)".to_string());
    }
    bucket.reserved_bytes = bucket.reserved_bytes.saturating_add(size);
    Ok(())
}

fn release_upload(session: &Session, bytes: u64, commit: bool) {
    let mut bucket = session.bucket.lock().unwrap_or_else(|p| p.into_inner());
    bucket.pending = bucket.pending.saturating_sub(1);
    bucket.reserved_bytes = bucket.reserved_bytes.saturating_sub(bytes);
    if commit {
        bucket.total_bytes = bucket.total_bytes.saturating_add(bytes);
    }
}

async fn commit_file(
    dir: &FsPath,
    temp: &FsPath,
    original: &str,
) -> Result<(PathBuf, String), String> {
    for index in 0..10_000usize {
        let name = unique_name(original, index);
        let destination = dir.join(&name);
        match tokio::fs::hard_link(temp, &destination).await {
            Ok(()) => {
                if let Err(error) = tokio::fs::remove_file(temp).await {
                    let _ = tokio::fs::remove_file(&destination).await;
                    return Err(format!("Could not finalize received file: {error}"));
                }
                return Ok((destination, name));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Could not finalize received file: {error}")),
        }
    }
    Err("Could not choose a unique file name".to_string())
}

fn unique_name(original: &str, index: usize) -> String {
    if index == 0 {
        return original.to_string();
    }
    let path = FsPath::new(original);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("File");
    let extension = path
        .extension()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty());
    match extension {
        Some(extension) => format!("{stem} ({index}).{extension}"),
        None => format!("{stem} ({index})"),
    }
}

fn sanitize_filename(name: &str) -> Option<String> {
    if name.is_empty() || name.chars().any(|c| c == '\0' || c == '/' || c == '\\') {
        return None;
    }
    let mut cleaned = name
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect::<String>();
    cleaned = cleaned.trim().trim_matches('.').trim().to_string();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        return None;
    }
    while cleaned.len() > MAX_FILENAME_BYTES {
        cleaned.pop();
    }
    let stem = FsPath::new(&cleaned)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let upper = stem.trim_end_matches('.').to_ascii_uppercase();
    let reserved = matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (upper.len() == 4
            && (upper.starts_with("COM") || upper.starts_with("LPT"))
            && upper.as_bytes()[3].is_ascii_digit()
            && upper.as_bytes()[3] != b'0');
    if reserved {
        cleaned.insert(0, '_');
    }
    Some(cleaned)
}

fn is_child(root: &FsPath, candidate: &FsPath) -> bool {
    candidate.parent() == Some(root)
}

fn is_local_address(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => v4.is_loopback() || v4.is_private() || v4.is_link_local(),
        std::net::IpAddr::V6(v6) => {
            v6.is_loopback() || v6.is_unique_local() || v6.is_unicast_link_local()
        }
    }
}

fn discover_lan_ip() -> Option<Ipv4Addr> {
    let socket = StdUdpSocket::bind(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    // UDP connect only asks the OS for a route; it sends no packet.
    socket
        .connect(SocketAddrV4::new(Ipv4Addr::new(8, 8, 8, 8), 80))
        .ok()?;
    match socket.local_addr().ok()?.ip() {
        std::net::IpAddr::V4(ip) if !ip.is_unspecified() && !ip.is_loopback() => Some(ip),
        _ => None,
    }
}

fn download_folder() -> Result<PathBuf, String> {
    let downloads = dirs::download_dir()
        .ok_or_else(|| "Windows did not provide a Downloads folder".to_string())?;
    Ok(downloads.join("Hover Island"))
}

fn status_for(session: &Session) -> TransferStatus {
    TransferStatus {
        active: !session.is_expired(),
        phone_url: Some(session.phone_base()),
        desktop_url: Some(session.desktop_base()),
        bookmark_url: Some(session.bookmark_url()),
        stable_bookmark: session.stable_bookmark,
        qr_data_url: Some(session.qr_data_url.clone()),
        expires_at: Some(session.expires_at),
        files: session.list(),
        save_folder: session.save_dir.to_string_lossy().to_string(),
        max_file_bytes: MAX_FILE_BYTES,
        max_bucket_bytes: MAX_BUCKET_BYTES,
        error: None,
    }
}

fn inactive_status() -> TransferStatus {
    TransferStatus {
        active: false,
        phone_url: None,
        desktop_url: None,
        bookmark_url: None,
        stable_bookmark: false,
        qr_data_url: None,
        expires_at: None,
        files: Vec::new(),
        save_folder: download_folder()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
        max_file_bytes: MAX_FILE_BYTES,
        max_bucket_bytes: MAX_BUCKET_BYTES,
        error: None,
    }
}

fn emit_file_event(
    session: &Session,
    id: &str,
    name: &str,
    bytes: u64,
    total: Option<u64>,
    phase: &str,
) {
    if let Some(app) = &session.app {
        let _ = app.emit(
            "transfer://event",
            transfer_event(id, name, bytes, total, phase),
        );
    }
}

fn transfer_event(
    id: &str,
    name: &str,
    bytes: u64,
    total: Option<u64>,
    phase: &str,
) -> serde_json::Value {
    let title = match phase {
        "staging" => "Adding to Files",
        "receiving" => "Receiving file",
        "sending" => "Sending to phone",
        "ready" => "Ready for your phone",
        "sent" => "Sent to phone",
        "error" => "Transfer failed",
        _ => "File received",
    };
    serde_json::json!({
        "id": format!("transfer:{id}:{phase}"),
        "transferId": id,
        "category": "transfer",
        "app": "Phone bucket",
        "title": title,
        "body": format!("{name} · {}", format_bytes(bytes)),
        "timestamp": now_ms(),
        "phase": phase,
        "progress": total.filter(|value| *value > 0).map(|value| (bytes as f64 / value as f64).clamp(0.0, 1.0)),
    })
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn format_bytes(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

fn percent_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len());
    for byte in bytes {
        if byte.is_ascii_alphanumeric() || matches!(*byte, b'-' | b'_' | b'.' | b'~') {
            out.push(*byte as char);
        } else {
            use std::fmt::Write;
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

const MOBILE_PAGE: &str = include_str!("phone-bucket.html");
const PAIRING_PAGE: &str = include_str!("phone-pairing.html");

#[cfg(test)]
fn discover_lan_ip_for_session_test() -> Ipv4Addr {
    discover_lan_ip().unwrap_or(Ipv4Addr::new(192, 168, 1, 2))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr};

    #[test]
    fn filenames_are_flat_bounded_and_windows_safe() {
        assert_eq!(sanitize_filename("../secret.txt"), None);
        assert_eq!(sanitize_filename("folder\\secret.txt"), None);
        assert_eq!(sanitize_filename("CON.txt").as_deref(), Some("_CON.txt"));
        assert!(sanitize_filename("a?.txt").unwrap().contains('_'));
        assert!(sanitize_filename(&"x".repeat(300)).unwrap().len() <= MAX_FILENAME_BYTES);
    }

    #[tokio::test]
    async fn native_folder_drop_preserves_structure_and_uses_nonoverwriting_bucket_uploads() {
        let session = test_session();
        let source = session.save_dir.join("Shared folder");
        tokio::fs::create_dir_all(source.join("Nested"))
            .await
            .unwrap();
        tokio::fs::write(source.join("note.txt"), b"hello")
            .await
            .unwrap();
        tokio::fs::write(source.join("Nested").join("image.txt"), b"picture")
            .await
            .unwrap();
        let plan = plan_dropped_items(&[source.clone()]).unwrap();
        let DroppedItem::Folder { name, members } = &plan[0] else {
            panic!("folder should become a ZIP")
        };
        assert_eq!(name, "Shared folder.zip");
        let archive = session.save_dir.join("owned-folder-archive.part");
        write_dropped_archive(&session, &archive, members)
            .await
            .unwrap();
        let bytes = tokio::fs::read(&archive).await.unwrap();
        assert_zip_contents(
            &bytes,
            &[
                ("Shared folder/note.txt", b"hello"),
                ("Shared folder/Nested/image.txt", b"picture"),
            ],
        );
        stage_native_file(session.clone(), &archive, name)
            .await
            .unwrap();
        stage_native_file(session.clone(), &archive, name)
            .await
            .unwrap();
        let files = session.list();
        assert_eq!(files.len(), 2);
        assert!(files.iter().any(|file| file.name == "Shared folder.zip"));
        assert!(files
            .iter()
            .any(|file| file.name == "Shared folder (1).zip"));
        assert_eq!(
            tokio::fs::read(source.join("note.txt")).await.unwrap(),
            b"hello"
        );
        for file in session.bucket.lock().unwrap().files.values() {
            assert_eq!(std::fs::read(&file.path).unwrap(), bytes);
        }
        session.closed.store(true, Ordering::Release);
        assert!(
            stage_native_file(session.clone(), &archive, "cancelled.zip")
                .await
                .is_err()
        );
        assert_eq!(session.list().len(), 2);
        tokio::fs::remove_dir_all(&session.save_dir).await.unwrap();
    }

    #[test]
    fn native_drop_planner_rejects_empty_folders_and_excessive_top_level_items() {
        let folder =
            std::env::temp_dir().join(format!("hover-island-drop-plan-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&folder).unwrap();
        assert!(plan_dropped_items(&[]).is_err());
        assert!(plan_dropped_items(&[folder.clone()]).is_err());
        assert!(plan_dropped_items(&vec![folder.clone(); MAX_FILES + 1]).is_err());
        std::fs::remove_dir(&folder).unwrap();
    }

    #[test]
    fn streaming_zip_records_use_valid_stored_file_headers_and_crc32() {
        let crc = !crc32_update(u32::MAX, b"123456789");
        assert_eq!(crc, 0xcbf4_3926);

        let local = zip_local_header("café.txt".as_bytes());
        assert_eq!(
            u32::from_le_bytes(local[0..4].try_into().unwrap()),
            0x04034b50
        );
        assert_eq!(u16::from_le_bytes(local[6..8].try_into().unwrap()), 0x0808);
        assert_eq!(u16::from_le_bytes(local[8..10].try_into().unwrap()), 0);

        let descriptor = zip_data_descriptor(crc, 9);
        assert_eq!(
            u32::from_le_bytes(descriptor[0..4].try_into().unwrap()),
            0x08074b50
        );
        assert_eq!(
            u32::from_le_bytes(descriptor[4..8].try_into().unwrap()),
            crc
        );

        let central = zip_central_directory(&[ZipCentralEntry {
            name: "café.txt".as_bytes().to_vec(),
            crc,
            size: 9,
            local_offset: 0,
        }]);
        assert_eq!(
            u32::from_le_bytes(central[0..4].try_into().unwrap()),
            0x02014b50
        );
        let end = zip_end_record(1, central.len() as u32, 0);
        assert_eq!(
            u32::from_le_bytes(end[0..4].try_into().unwrap()),
            0x06054b50
        );
        assert_eq!(u16::from_le_bytes(end[8..10].try_into().unwrap()), 1);
    }

    #[test]
    fn phone_bucket_progress_events_include_fraction_and_terminal_ready_phase() {
        let sending = transfer_event("zip-1", "All files.zip", 5, Some(10), "sending");
        assert_eq!(sending["category"], "transfer");
        assert_eq!(sending["app"], "Phone bucket");
        assert_eq!(sending["phase"], "sending");
        assert_eq!(sending["progress"], 0.5);

        let complete = transfer_event("zip-1", "All files.zip", 10, Some(10), "sent");
        assert_eq!(complete["phase"], "sent");
        assert_eq!(complete["progress"], 1.0);
        assert_eq!(complete["title"], "Sent to phone");

        let unknown_total = transfer_event("zip-1", "All files.zip", 10, Some(0), "sending");
        assert!(unknown_total["progress"].is_null());

        let failed = transfer_event("zip-1", "All files.zip", 5, Some(10), "error");
        assert_eq!(failed["phase"], "error");
        assert_eq!(failed["title"], "Transfer failed");
        assert_eq!(failed["progress"], 0.5);
    }

    #[tokio::test]
    async fn phone_bucket_zip_route_rejects_non_lan_clients_and_untrusted_origins() {
        let session = test_session();
        let response = download_bucket_zip(
            Path(session.token.clone()),
            AxumState(session.clone()),
            ConnectInfo("8.8.8.8:4321".parse().unwrap()),
            HeaderMap::new(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);

        let mut headers = HeaderMap::new();
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://attacker.example"),
        );
        let response = download_bucket_zip(
            Path(session.token.clone()),
            AxumState(session.clone()),
            ConnectInfo("127.0.0.1:4321".parse().unwrap()),
            headers,
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);

        let response = download_bucket_zip(
            Path("wrong-token".to_string()),
            AxumState(session),
            ConnectInfo("127.0.0.1:4321".parse().unwrap()),
            HeaderMap::new(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn qr_pairing_is_origin_checked_approved_before_cookie_and_revocable() {
        let mut session = test_session_at(
            47692,
            Ipv4Addr::new(192, 168, 1, 10),
            Duration::from_secs(60),
        );
        let save_dir = session.save_dir.clone();
        Arc::get_mut(&mut session).unwrap().paired_devices =
            Mutex::new(PairedDeviceStore::load(save_dir.join("paired-phones.json")).unwrap());
        let remote: SocketAddr = "192.168.1.42:51234".parse().unwrap();
        let good_origin = format!("http://{}:{}", session.lan_ip, session.port);
        let mut headers = HeaderMap::new();
        headers.insert(
            header::HOST,
            HeaderValue::from_str(&format!("{}:{}", session.lan_ip, session.port)).unwrap(),
        );
        headers.insert(header::ORIGIN, HeaderValue::from_str(&good_origin).unwrap());

        let unpaired_page = phone_page(
            Path(session.token.clone()),
            AxumState(session.clone()),
            ConnectInfo(remote),
            headers.clone(),
        )
        .await;
        assert_eq!(unpaired_page.status(), StatusCode::OK);
        let page = axum::body::to_bytes(unpaired_page.into_body(), 64 * 1024)
            .await
            .unwrap();
        let page = String::from_utf8(page.to_vec()).unwrap();
        assert!(page.contains("Request pairing"));
        assert!(!page.contains("Ready to download"));
        let blocked_files = list_files(
            Path(session.token.clone()),
            AxumState(session.clone()),
            ConnectInfo(remote),
            headers.clone(),
        )
        .await;
        assert_eq!(blocked_files.status(), StatusCode::UNAUTHORIZED);

        let denied = pair_request(
            Path(session.token.clone()),
            AxumState(session.clone()),
            ConnectInfo(remote),
            HeaderMap::from_iter([
                (
                    header::HOST,
                    HeaderValue::from_str(&format!("{}:{}", session.lan_ip, session.port)).unwrap(),
                ),
                (
                    header::ORIGIN,
                    HeaderValue::from_static("http://attacker.example"),
                ),
            ]),
            Json(PairRequestBody {
                name: "Untrusted".into(),
            }),
        )
        .await;
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);
        assert!(session
            .pending_pairs
            .lock()
            .unwrap()
            .views(Instant::now())
            .is_empty());

        let response = pair_request(
            Path(session.token.clone()),
            AxumState(session.clone()),
            ConnectInfo(remote),
            headers.clone(),
            Json(PairRequestBody {
                name: "My phone".into(),
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        let request: crate::paired_devices::PairRequestCreated =
            serde_json::from_slice(&bytes).unwrap();
        assert_eq!(request.name, "My phone");
        assert_eq!(request.code.len(), 6);

        assert!(session
            .pending_pairs
            .lock()
            .unwrap()
            .claim(&request.id, "192.168.1.99".parse().unwrap(), Instant::now())
            .is_err());
        session
            .pending_pairs
            .lock()
            .unwrap()
            .decide(&request.id, true, Instant::now())
            .unwrap();
        let claimed = pair_claim(
            Path((session.token.clone(), request.id.clone())),
            AxumState(session.clone()),
            ConnectInfo(remote),
            headers.clone(),
        )
        .await;
        assert_eq!(claimed.status(), StatusCode::NO_CONTENT);
        let set_cookie = claimed
            .headers()
            .get(header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        assert!(set_cookie.contains("HttpOnly"));
        assert!(set_cookie.contains("SameSite=Strict"));
        let cookie = set_cookie.split(';').next().unwrap().to_string();
        let raw = cookie.split_once('=').unwrap().1;
        assert_eq!(
            session.paired_devices.lock().unwrap().authenticated_id(raw),
            Some(request.id.clone())
        );
        assert!(!session.paired_devices.lock().unwrap().views(now_ms())[0].online);
        let saved = std::fs::read_to_string(save_dir.join("paired-phones.json")).unwrap();
        assert!(
            !saved.contains(raw),
            "the cookie itself must not be persisted"
        );

        let mut authenticated = HeaderMap::new();
        authenticated.insert(
            header::HOST,
            HeaderValue::from_str(&format!("{}:{}", session.lan_ip, session.port)).unwrap(),
        );
        authenticated.insert(header::COOKIE, HeaderValue::from_str(&cookie).unwrap());
        let bookmark = device_bookmark(
            AxumState(session.clone()),
            ConnectInfo(remote),
            authenticated.clone(),
        )
        .await;
        assert_eq!(bookmark.status(), StatusCode::SEE_OTHER);
        assert_eq!(
            bookmark
                .headers()
                .get(header::LOCATION)
                .unwrap()
                .to_str()
                .unwrap(),
            session.phone_base()
        );
        let listing = list_files(
            Path(session.token.clone()),
            AxumState(session.clone()),
            ConnectInfo(remote),
            authenticated.clone(),
        )
        .await;
        assert_eq!(listing.status(), StatusCode::OK);
        assert!(session.paired_devices.lock().unwrap().views(now_ms())[0].online);
        assert!(session
            .paired_devices
            .lock()
            .unwrap()
            .remove(&request.id)
            .unwrap());
        let revoked = list_files(
            Path(session.token.clone()),
            AxumState(session.clone()),
            ConnectInfo(remote),
            authenticated,
        )
        .await;
        assert_eq!(revoked.status(), StatusCode::UNAUTHORIZED);
        let _ = std::fs::remove_dir_all(save_dir);
    }

    #[tokio::test]
    async fn streaming_zip_body_stops_when_phone_session_ends_and_releases_guard() {
        let session = test_session();
        tokio::fs::create_dir_all(&session.save_dir).await.unwrap();
        let path = session.save_dir.join("payload.bin");
        tokio::fs::write(&path, b"bounded streaming payload")
            .await
            .unwrap();
        session.bucket.lock().unwrap().files.insert(
            "payload-id".to_string(),
            StoredFile {
                public: TransferFile {
                    id: "payload-id".to_string(),
                    name: "payload.bin".to_string(),
                    size: 25,
                    created_at: now_ms(),
                },
                path,
            },
        );

        let response = download_bucket_zip(
            Path(session.token.clone()),
            AxumState(session.clone()),
            ConnectInfo("127.0.0.1:4321".parse().unwrap()),
            HeaderMap::new(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert!(session.zip_download_active.load(Ordering::Acquire));

        // Keep the first response body unpolled so its streaming guard is
        // deterministically alive while checking the one-archive limit.
        let busy = download_bucket_zip(
            Path(session.token.clone()),
            AxumState(session.clone()),
            ConnectInfo("127.0.0.1:4321".parse().unwrap()),
            HeaderMap::new(),
        )
        .await;
        assert_eq!(busy.status(), StatusCode::TOO_MANY_REQUESTS);

        let mut body = response.into_body().into_data_stream();
        let first = body.next().await.unwrap().unwrap();
        assert_eq!(&first[..4], b"PK\x03\x04");
        session.closed.store(true, Ordering::Release);
        let interrupted = body.next().await.unwrap();
        assert!(interrupted.is_err());
        assert!(body.next().await.is_none());
        drop(body);
        assert!(!session.zip_download_active.load(Ordering::Acquire));
        let _ = tokio::fs::remove_dir_all(&session.save_dir).await;
    }

    #[test]
    fn paths_and_origins_are_session_scoped() {
        let session = test_session();
        assert!(is_child(
            &session.save_dir,
            &session.save_dir.join("ok.txt")
        ));
        assert!(!is_child(
            &session.save_dir,
            &session.save_dir.join("..\\secret")
        ));
        assert!(is_local_address(IpAddr::V4(Ipv4Addr::LOCALHOST)));
        assert!(is_local_address(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 10))));
        assert!(!is_local_address(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))));
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_static("127.0.0.1:1234"));
        assert!(allowed_origin(
            "http://tauri.localhost",
            "127.0.0.1:1234".parse().unwrap(),
            &session,
            &headers
        ));
        assert!(!allowed_origin(
            "https://evil.example",
            "127.0.0.1:1234".parse().unwrap(),
            &session,
            &headers
        ));
        assert!(!allowed_origin(
            "http://127.0.0.1:4321",
            "127.0.0.1:4321".parse().unwrap(),
            &session,
            &HeaderMap::from_iter([(header::HOST, HeaderValue::from_static("127.0.0.1:4321"),)]),
        ));
        let mut closed = test_session();
        closed.closed.store(true, Ordering::Release);
        assert_eq!(
            authorize(
                &closed,
                &closed.token,
                "127.0.0.1:1234".parse().unwrap(),
                &HeaderMap::new(),
                false,
            )
            .unwrap_err()
            .0,
            StatusCode::GONE
        );
    }

    #[tokio::test]
    async fn oversized_declared_upload_is_rejected_before_body_read() {
        let session = test_session();
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/octet-stream"),
        );
        headers.insert(
            header::CONTENT_LENGTH,
            HeaderValue::from_str(&(MAX_FILE_BYTES + 1).to_string()).unwrap(),
        );
        headers.insert(header::HOST, HeaderValue::from_static("127.0.0.1:1234"));
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://tauri.localhost"),
        );
        let response = upload_file(
            Path(session.token.clone()),
            Query(UploadQuery {
                name: "large.bin".to_string(),
            }),
            AxumState(session),
            ConnectInfo("127.0.0.1:4321".parse().unwrap()),
            headers,
            Request::new(Body::empty()),
        )
        .await;
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn local_http_bucket_uploads_lists_and_downloads_without_overwrite() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let session = test_session_at(address.port(), Ipv4Addr::LOCALHOST, Duration::from_secs(60));
        tokio::fs::create_dir_all(&session.save_dir).await.unwrap();
        let app = router(session.clone());
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap();
        });
        let base = format!("http://{address}/s/{}", session.token);
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap();
        let bad = client
            .get(format!("http://{address}/s/not-the-token"))
            .send()
            .await
            .unwrap();
        assert_eq!(bad.status(), StatusCode::NOT_FOUND);
        let blocked = client
            .request(axum::http::Method::OPTIONS, format!("{base}/api/files"))
            .header(header::ORIGIN, "http://attacker.example")
            .header(header::ACCESS_CONTROL_REQUEST_METHOD, "PUT")
            .send()
            .await
            .unwrap();
        assert_eq!(blocked.status(), StatusCode::FORBIDDEN);
        let wrong_type = client
            .put(format!("{base}/api/files?name=blocked.txt"))
            .header(header::ORIGIN, format!("http://{address}"))
            .header(header::CONTENT_TYPE, "text/plain")
            .body("payload")
            .send()
            .await
            .unwrap();
        assert_eq!(wrong_type.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
        let upload = client
            .put(format!("{base}/api/files?name=hello.txt"))
            .header(header::ORIGIN, format!("http://{address}"))
            .header(header::CONTENT_TYPE, "application/octet-stream")
            .body("hello phone bucket")
            .send()
            .await
            .unwrap();
        assert_eq!(upload.status(), StatusCode::OK);
        let response: UploadResult = upload.json().await.unwrap();
        assert_eq!(response.file.name, "hello.txt");
        let second = client
            .put(format!("{base}/api/files?name=hello.txt"))
            .header(header::ORIGIN, format!("http://{address}"))
            .header(header::CONTENT_TYPE, "application/octet-stream")
            .body("second file")
            .send()
            .await
            .unwrap();
        let second: UploadResult = second.json().await.unwrap();
        assert_eq!(second.file.name, "hello (1).txt");
        let list: FileList = client
            .get(format!("{base}/api/files"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(list.files.len(), 2);
        let downloaded = client
            .get(format!("{base}/api/files/{}", response.file.id))
            .send()
            .await
            .unwrap();
        assert_eq!(
            downloaded.bytes().await.unwrap().as_ref(),
            b"hello phone bucket"
        );
        let archive = client
            .get(format!("{base}/api/bucket.zip"))
            .send()
            .await
            .unwrap();
        assert_eq!(archive.status(), StatusCode::OK);
        assert_eq!(archive.headers()[header::CONTENT_TYPE], "application/zip");
        assert_eq!(
            archive.headers()[header::CONTENT_DISPOSITION],
            "attachment; filename=\"Hover-Island-files.zip\""
        );
        assert_eq!(archive.headers()[header::CACHE_CONTROL], "no-store");
        let archive = archive.bytes().await.unwrap();
        assert_zip_contents(
            &archive,
            &[
                ("hello.txt", b"hello phone bucket"),
                ("hello (1).txt", b"second file"),
            ],
        );
        assert!(!session.zip_download_active.load(Ordering::Acquire));
        let completed = client
            .get(format!("{base}/api/bucket.zip"))
            .send()
            .await
            .unwrap();
        assert_eq!(completed.status(), StatusCode::OK);
        server.abort();
        let _ = tokio::fs::remove_dir_all(&session.save_dir).await;
    }

    #[tokio::test]
    #[ignore = "manual real-phone browser smoke fixture; run with --ignored --nocapture"]
    async fn phone_browser_fixture() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let mut session = test_session_at(
            address.port(),
            Ipv4Addr::LOCALHOST,
            Duration::from_secs(120),
        );
        tokio::fs::create_dir_all(&session.save_dir).await.unwrap();
        let source_dir = session.save_dir.join("smoke-owned-source");
        tokio::fs::create_dir_all(&source_dir).await.unwrap();
        let seed_path = source_dir.join("smoke-seed.txt");
        tokio::fs::write(&seed_path, b"owned phone browser smoke seed\n")
            .await
            .unwrap();
        stage_native_file(session.clone(), &seed_path, "smoke-seed.txt")
            .await
            .unwrap();
        tokio::fs::remove_dir_all(&source_dir).await.unwrap();

        let save_dir = session.save_dir.clone();
        let session_mut = Arc::get_mut(&mut session).expect("fixture session is uniquely owned");
        session_mut.paired_devices =
            Mutex::new(PairedDeviceStore::load(save_dir.join("paired-phones.json")).unwrap());
        session_mut
            .require_pairing_on_loopback
            .store(true, Ordering::Release);

        let phone_url = session.phone_base();
        let app = router(session.clone());
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
        });

        // This approval loop is deliberately confined to this ignored test fixture.
        // Production pairing always requires the user to approve on the PC.
        let approval_session = session.clone();
        let approval = tokio::spawn(async move {
            let deadline = Instant::now() + Duration::from_secs(110);
            while Instant::now() < deadline {
                let requests = approval_session
                    .pending_pairs
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .views(Instant::now());
                for request in requests {
                    if request.name == "Browser smoke phone" {
                        let _ = approval_session
                            .pending_pairs
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .decide(&request.id, true, Instant::now());
                    }
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        });

        println!("PHONE_BUCKET_URL={phone_url}");
        let marker_deadline = Instant::now() + Duration::from_secs(115);
        let marker_uploaded = loop {
            let marker_uploaded = session
                .list()
                .iter()
                .any(|file| file.name == "phone-pairing-smoke-complete.txt");
            if marker_uploaded {
                break true;
            }
            if Instant::now() >= marker_deadline {
                break false;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        };

        session.closed.store(true, Ordering::Release);
        let _ = shutdown_tx.send(());
        let _ = tokio::time::timeout(Duration::from_secs(3), server).await;
        approval.abort();
        let _ = approval.await;
        let _ = tokio::fs::remove_dir_all(&save_dir).await;
        assert!(
            marker_uploaded,
            "browser smoke did not upload its completion marker within 115 seconds"
        );
    }

    fn test_session() -> Arc<Session> {
        test_session_at(
            1234,
            discover_lan_ip_for_session_test(),
            Duration::from_secs(60),
        )
    }

    fn assert_zip_contents(bytes: &[u8], expected: &[(&str, &[u8])]) {
        let mut offset = 0usize;
        let mut local_entries = Vec::new();
        while read_u32(bytes, offset) == 0x0403_4b50 {
            assert_eq!(
                read_u16(bytes, offset + 6),
                0x0808,
                "UTF-8 + descriptor flags"
            );
            assert_eq!(read_u16(bytes, offset + 8), 0, "stored compression");
            let name_len = read_u16(bytes, offset + 26) as usize;
            let extra_len = read_u16(bytes, offset + 28) as usize;
            let name_start = offset + 30;
            let data_start = name_start + name_len + extra_len;
            let name = std::str::from_utf8(&bytes[name_start..name_start + name_len]).unwrap();
            let expected_data = expected
                .iter()
                .find_map(|(expected_name, data)| (*expected_name == name).then_some(*data))
                .unwrap_or_else(|| panic!("unexpected ZIP entry {name}"));
            let data_end = data_start + expected_data.len();
            let data = &bytes[data_start..data_end];
            assert_eq!(data, expected_data);
            let crc = !crc32_update(u32::MAX, data);
            let descriptor = data_end;
            assert_eq!(read_u32(bytes, descriptor), 0x0807_4b50, "data descriptor");
            assert_eq!(read_u32(bytes, descriptor + 4), crc);
            assert_eq!(read_u32(bytes, descriptor + 8), data.len() as u32);
            assert_eq!(read_u32(bytes, descriptor + 12), data.len() as u32);
            local_entries.push((name.to_string(), crc, data.len() as u32, offset as u32));
            offset = descriptor + 16;
        }
        assert_eq!(local_entries.len(), expected.len());

        let central_offset = offset;
        for (name, crc, size, local_offset) in &local_entries {
            assert_eq!(read_u32(bytes, offset), 0x0201_4b50, "central entry");
            assert_eq!(read_u16(bytes, offset + 8), 0x0808);
            assert_eq!(read_u16(bytes, offset + 10), 0);
            assert_eq!(read_u32(bytes, offset + 16), *crc);
            assert_eq!(read_u32(bytes, offset + 20), *size);
            assert_eq!(read_u32(bytes, offset + 24), *size);
            assert_eq!(read_u32(bytes, offset + 42), *local_offset);
            let name_len = read_u16(bytes, offset + 28) as usize;
            let extra_len = read_u16(bytes, offset + 30) as usize;
            let comment_len = read_u16(bytes, offset + 32) as usize;
            assert_eq!(
                std::str::from_utf8(&bytes[offset + 46..offset + 46 + name_len]).unwrap(),
                name
            );
            offset += 46 + name_len + extra_len + comment_len;
        }

        let central_size = offset - central_offset;
        assert_eq!(read_u32(bytes, offset), 0x0605_4b50, "end record");
        assert_eq!(read_u16(bytes, offset + 8), expected.len() as u16);
        assert_eq!(read_u16(bytes, offset + 10), expected.len() as u16);
        assert_eq!(read_u32(bytes, offset + 12), central_size as u32);
        assert_eq!(read_u32(bytes, offset + 16), central_offset as u32);
        assert_eq!(read_u16(bytes, offset + 20), 0);
        assert_eq!(offset + 22, bytes.len(), "no trailing bytes");
    }

    fn read_u16(bytes: &[u8], offset: usize) -> u16 {
        u16::from_le_bytes(bytes[offset..offset + 2].try_into().unwrap())
    }

    fn read_u32(bytes: &[u8], offset: usize) -> u32 {
        u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
    }

    fn test_session_at(port: u16, lan_ip: Ipv4Addr, lifetime: Duration) -> Arc<Session> {
        let token = "0123456789abcdef0123456789abcdef".to_string();
        Arc::new(Session {
            token,
            port,
            lan_ip,
            stable_bookmark: false,
            save_dir: std::env::temp_dir().join(format!(
                "hover-island-transfer-test-{}",
                uuid::Uuid::new_v4()
            )),
            expires: Instant::now() + lifetime,
            expires_at: now_ms() + lifetime.as_millis() as u64,
            qr_data_url: String::new(),
            app: None,
            closed: AtomicBool::new(false),
            bucket: Mutex::new(Bucket::default()),
            paired_devices: Mutex::new(PairedDeviceStore::default()),
            pending_pairs: Mutex::new(PendingPairs::default()),
            upload_slots: Arc::new(Semaphore::new(MAX_CONCURRENT_UPLOADS)),
            zip_download_active: AtomicBool::new(false),
            #[cfg(test)]
            require_pairing_on_loopback: AtomicBool::new(false),
        })
    }
}
