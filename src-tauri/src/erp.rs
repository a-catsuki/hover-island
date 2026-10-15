//! Optional, read-only website alert connectors. Secrets and polling cursors stay
//! native-side in one Windows DPAPI-protected file; no browser cookies are used.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;

use reqwest::header::{AUTHORIZATION, ETAG, IF_NONE_MATCH};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use futures_util::stream::{self, StreamExt};
use tauri::{AppHandle, Emitter, Manager};

const CONNECTION_FILE: &str = "website-alerts.dpapi";
const MAX_RESPONSE_BYTES: usize = 512 * 1024;
const MAX_CONNECTIONS: usize = 12;
const MAX_ALERTS: usize = 100;
const MAX_POLL_PAGES: usize = 4;
const MAX_SITE_POLL_TIME: Duration = Duration::from_secs(12);
const MAX_PARALLEL_SITES: usize = 4;
const ERP_PATH: &str = "/api/integrations/hover-island/events";
const DISCOVERY_PATH: &str = "/.well-known/hover-island.json";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebsiteConnectionSummary {
    pub id: String,
    pub display_name: String,
    pub server_url: String,
    pub adapter: String,
    pub paired_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebsiteAlert {
    pub id: String,
    pub app: Option<String>,
    pub title: String,
    pub body: String,
    pub priority: Option<String>,
    pub timestamp: u64,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebsiteConnectionSnapshot {
    pub connection: WebsiteConnectionSummary,
    pub events: Vec<WebsiteAlert>,
    pub baseline_complete: bool,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebsiteAlertsSnapshot {
    pub connections: Vec<WebsiteConnectionSummary>,
    pub sites: Vec<WebsiteConnectionSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedStore {
    #[serde(default)]
    connections: Vec<SavedConnection>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedConnection {
    id: String,
    display_name: String,
    server_url: String,
    adapter: Adapter,
    feed_path: String,
    token: Option<String>,
    paired_at: String,
    #[serde(default)]
    next_cursor: Option<String>,
    #[serde(default)]
    etag: Option<String>,
    #[serde(default = "default_baseline_pending")]
    baseline_pending: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum Adapter { Erp, Generic }

fn default_baseline_pending() -> bool { true }

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ErpResponse { version: u8, events: Vec<WebsiteAlert>, has_more: bool, next_cursor: Option<String> }

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenericResponse { version: u8, events: Vec<WebsiteAlert> }

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Discovery { version: u8, name: Option<String>, feed_path: String, auth: Option<String> }

static HTTP: OnceLock<Result<Client, String>> = OnceLock::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
static MUTATION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static POLL_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static LAST_GOOD_EVENTS: OnceLock<tokio::sync::Mutex<HashMap<String, Vec<WebsiteAlert>>>> = OnceLock::new();

fn event_cache() -> &'static tokio::sync::Mutex<HashMap<String, Vec<WebsiteAlert>>> {
    LAST_GOOD_EVENTS.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()))
}

fn http() -> Result<&'static Client, String> {
    HTTP.get_or_init(|| Client::builder().timeout(Duration::from_secs(8)).connect_timeout(Duration::from_secs(4))
        .redirect(reqwest::redirect::Policy::none()).user_agent(concat!("Hover-Island/", env!("CARGO_PKG_VERSION")))
        .build().map_err(|_| "Could not initialize website alert connections".to_string()))
        .as_ref().map_err(Clone::clone)
}

fn storage_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map(|path| path.join(CONNECTION_FILE))
        .map_err(|_| "Could not locate secure website connection storage".to_string())
}

fn read_store(app: &AppHandle) -> Result<SavedStore, String> {
    let bytes = match std::fs::read(storage_path(app)?) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(SavedStore { connections: vec![] }),
        Err(_) => return Err("Could not read saved website connections".into()),
    };
    if bytes.len() > 256 * 1024 { return Err("Saved website connection data is invalid".into()); }
    let clear = unprotect(&bytes)?;
    let store: SavedStore = serde_json::from_slice(&clear).map_err(|_| "Saved website connection data is invalid".to_string())?;
    if store.connections.len() > MAX_CONNECTIONS { return Err("Saved website connection data is invalid".into()); }
    for connection in &store.connections {
        validate_server_url(&connection.server_url)?;
        validate_feed_path(&connection.feed_path)?;
        if connection.token.as_ref().is_some_and(|token| token.len() > 8192) { return Err("Saved website connection data is invalid".into()); }
    }
    Ok(store)
}

fn write_store(app: &AppHandle, store: &SavedStore) -> Result<(), String> {
    let path = storage_path(app)?;
    let parent = path.parent().ok_or("Could not locate secure website connection storage")?;
    std::fs::create_dir_all(parent).map_err(|_| "Could not create secure website connection storage")?;
    let clear = serde_json::to_vec(store).map_err(|_| "Could not save website connections")?;
    let encrypted = protect(&clear)?;
    let temp = path.with_extension("dpapi.tmp");
    { use std::io::Write; let mut file = std::fs::File::create(&temp).map_err(|_| "Could not save website connections")?;
      file.write_all(&encrypted).and_then(|_| file.sync_all()).map_err(|_| "Could not save website connections")?; }
    replace_file(&temp, &path).map_err(|_| { let _ = std::fs::remove_file(&temp); "Could not save website connections".to_string() })
}

#[cfg(windows)]
fn replace_file(source: &std::path::Path, destination: &std::path::Path) -> Result<(), ()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "Kernel32")]
    extern "system" { fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32; }
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let destination: Vec<u16> = destination.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let result = unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), 0x1 | 0x8) };
    if result == 0 { Err(()) } else { Ok(()) }
}

#[cfg(not(windows))]
fn replace_file(source: &std::path::Path, destination: &std::path::Path) -> Result<(), ()> {
    std::fs::rename(source, destination).map_err(|_| ())
}

fn validate_server_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw.trim()).map_err(|_| "Enter a valid website address".to_string())?;
    if !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() || url.path() != "/" {
        return Err("Enter only the website origin, without a path or credentials".into());
    }
    match url.scheme() { "https" => {}, "http" if is_loopback_host(&url) => {},
        _ => return Err("Website connections require HTTPS (HTTP is allowed for localhost development)".into()) }
    Ok(url)
}

fn is_loopback_host(url: &Url) -> bool {
    url.host_str().is_some_and(|host| host.eq_ignore_ascii_case("localhost") ||
        host.trim_start_matches('[').trim_end_matches(']').parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback()))
}

fn validate_feed_path(path: &str) -> Result<(), String> {
    if !path.starts_with('/') || path.starts_with("//") || path.contains('?') || path.contains('#') || path.contains('\u{5c}') || path.len() > 512 || path.chars().any(char::is_control) {
        return Err("Alert feed path must be a same-origin path beginning with /".into());
    }
    Ok(())
}

fn endpoint(origin: &str, path: &str) -> Result<Url, String> {
    validate_feed_path(path)?;
    let origin = validate_server_url(origin)?;
    let url = origin.join(path).map_err(|_| "Invalid alert feed path".to_string())?;
    if url.origin() != origin.origin() { return Err("Alert feed must stay on the website origin".into()); }
    Ok(url)
}

async fn read_bounded(response: reqwest::Response) -> Result<Vec<u8>, String> {
    if response.content_length().is_some_and(|n| n > MAX_RESPONSE_BYTES as u64) { return Err("Website returned a response that was too large".into()); }
    let mut response = response; let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "Could not read website response")? {
        if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES { return Err("Website returned a response that was too large".into()); }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn summary(connection: &SavedConnection) -> WebsiteConnectionSummary {
    WebsiteConnectionSummary { id: connection.id.clone(), display_name: connection.display_name.clone(), server_url: connection.server_url.clone(),
        adapter: match connection.adapter { Adapter::Erp => "erp", Adapter::Generic => "website" }.into(), paired_at: connection.paired_at.clone() }
}

fn summaries(store: &SavedStore) -> Vec<WebsiteConnectionSummary> { store.connections.iter().map(summary).collect() }

#[tauri::command]
pub fn website_connections_get(app: AppHandle) -> Result<Vec<WebsiteConnectionSummary>, String> { Ok(summaries(&read_store(&app)?)) }

#[tauri::command]
pub async fn website_connection_add(app: AppHandle, server_url: String, display_name: String, adapter: String, feed_path: Option<String>, auth_token: Option<String>) -> Result<WebsiteConnectionSummary, String> {
    let _guard = MUTATION.lock().await;
    let mut store = read_store(&app)?;
    if store.connections.len() >= MAX_CONNECTIONS { return Err("You can connect up to 12 websites".into()); }
    let origin = validate_server_url(&server_url)?.origin().ascii_serialization();
    let name = display_name.trim();
    if name.is_empty() || name.len() > 80 { return Err("Enter a connection name (up to 80 characters)".into()); }
    let (kind, path, token) = match adapter.as_str() {
        "erp" => {
            let token = auth_token.unwrap_or_default();
            if !valid_device_token(&token) { return Err("Enter the connection key shown once in ERP Settings".into()); }
            let path = ERP_PATH.to_string();
            validate_erp_token(&origin, &token).await?;
            (Adapter::Erp, path, Some(token))
        }
        "website" => {
            let token = auth_token.filter(|value| !value.trim().is_empty()).map(|value| value.trim().to_string());
            if token.as_ref().is_some_and(|value| value.len() > 8192 || value.chars().any(char::is_control)) { return Err("Website bearer key is invalid or too long".into()); }
            let path = if let Some(path) = feed_path.filter(|v| !v.trim().is_empty()) { path.trim().to_string() } else {
                discover_feed(&origin, token.as_deref()).await?.0
            };
            validate_feed_path(&path)?;
            validate_generic_feed(&origin, &path, token.as_deref()).await?;
            (Adapter::Generic, path, token)
        }
        _ => return Err("Choose a supported website connection type".into()),
    };
    if store.connections.iter().any(|saved| saved.server_url == origin && saved.adapter == kind) {
        return Err("That website is already connected. Remove its existing connection first.".into());
    }
    let connection = SavedConnection { id: make_id(), display_name: name.to_string(), server_url: origin, adapter: kind,
        feed_path: path, token, paired_at: now_unix_timestamp(), next_cursor: None, etag: None, baseline_pending: true };
    store.connections.push(connection.clone());
    write_store(&app, &store)?;
    let _ = app.emit("website://connections-changed", ());
    Ok(summary(&connection))
}

#[tauri::command]
pub async fn website_connection_remove(app: AppHandle, id: String) -> Result<Vec<WebsiteConnectionSummary>, String> {
    let _guard = MUTATION.lock().await;
    let mut store = read_store(&app)?;
    store.connections.retain(|connection| connection.id != id);
    write_store(&app, &store)?;
    event_cache().lock().await.remove(&id);
    let _ = app.emit("website://connections-changed", ());
    Ok(summaries(&store))
}

#[tauri::command]
pub async fn website_alerts_get(app: AppHandle) -> Result<WebsiteAlertsSnapshot, String> {
    let _poll_guard = POLL_LOCK.lock().await;
    // Snapshot settings under the mutation lock, then release it before any network work.
    let mut snapshot = {
        let _guard = MUTATION.lock().await;
        read_store(&app)?
    };
    {
        let mut cache = event_cache().lock().await;
        for connection in &mut snapshot.connections {
            if !cache.contains_key(&connection.id) {
                // The in-memory inbox is new after app restart; request a quiet baseline
                // instead of asking a persisted ERP cursor for deltas only.
                connection.next_cursor = None;
                connection.etag = None;
                connection.baseline_pending = true;
            }
        }
    }
    let results: Vec<(SavedConnection, PollOutcome)> = stream::iter(snapshot.connections.into_iter())
        .map(|mut connection| async move {
            let outcome = match tokio::time::timeout(MAX_SITE_POLL_TIME, poll_connection(&mut connection)).await {
                Ok(outcome) => outcome,
                Err(_) => PollOutcome { update: None, error: Some("Website alert polling timed out".into()) },
            };
            (connection, outcome)
        })
        .buffer_unordered(MAX_PARALLEL_SITES)
        .collect()
        .await;

    // Merge only mutable polling state into connections that still exist. A remove that
    // completed during the HTTP requests cannot be undone by this stale snapshot.
    let latest = {
        let _guard = MUTATION.lock().await;
        let mut latest = read_store(&app)?;
        for (polled, _) in &results {
            merge_poll_state(&mut latest, polled);
        }
        write_store(&app, &latest)?;
        latest
    };

    let active_ids: std::collections::HashSet<String> = latest.connections.iter().map(|connection| connection.id.clone()).collect();
    let mut cache = event_cache().lock().await;
    prune_event_cache(&mut cache, &active_ids);
    let outcomes: HashMap<String, PollOutcome> = results.into_iter().map(|(connection, outcome)| (connection.id, outcome)).collect();
    let mut sites = Vec::with_capacity(latest.connections.len());
    for connection in &latest.connections {
        let outcome = outcomes.get(&connection.id);
        let error = outcome.and_then(|value| value.error.clone());
        if let Some(update) = outcome.and_then(|value| value.update.as_ref()) {
            apply_poll_update(&mut cache, &connection.id, update);
        }
        sites.push(WebsiteConnectionSnapshot {
            connection: summary(connection),
            events: cache.get(&connection.id).cloned().unwrap_or_default(),
            baseline_complete: !connection.baseline_pending,
            error,
        });
    }
    Ok(WebsiteAlertsSnapshot { connections: summaries(&latest), sites })
}

async fn validate_erp_token(origin: &str, token: &str) -> Result<(), String> {
    let response = http()?.get(endpoint(origin, ERP_PATH)?).header(AUTHORIZATION, format!("Bearer {token}"))
        .send().await.map_err(|_| "Could not reach the ERP. Check the address and connection.".to_string())?;
    if response.status().as_u16() == 401 || response.status().as_u16() == 403 { return Err("This ERP connection key is invalid or revoked".into()); }
    if !response.status().is_success() { return Err("ERP notifications are unavailable. Check the ERP deployment and try again.".into()); }
    let page: ErpResponse = serde_json::from_slice(&read_bounded(response).await?).map_err(|_| "The ERP returned an unsupported notifications response")?;
    if page.version != 1 { return Err("This ERP notifications API version is not supported".into()); }
    validate_alerts(&page.events)
}

async fn discover_feed(origin: &str, token: Option<&str>) -> Result<(String, Option<String>), String> {
    let mut request = http()?.get(endpoint(origin, DISCOVERY_PATH)?);
    if let Some(token) = token { request = request.header(AUTHORIZATION, format!("Bearer {token}")); }
    let response = request.send().await.map_err(|_| "Could not discover website alerts. Enter the alert feed path manually.".to_string())?;
    if !response.status().is_success() { return Err("Website alert discovery was unavailable. Enter the alert feed path manually.".into()); }
    let doc: Discovery = serde_json::from_slice(&read_bounded(response).await?).map_err(|_| "Website alert discovery returned an unsupported document")?;
    if doc.version != 1 || doc.auth.as_deref().is_some_and(|v| !matches!(v, "bearer" | "none")) { return Err("Website alert discovery version or auth mode is unsupported".into()); }
    validate_feed_path(&doc.feed_path)?;
    Ok((doc.feed_path, doc.name))
}

async fn validate_generic_feed(origin: &str, path: &str, token: Option<&str>) -> Result<(), String> {
    let mut request = http()?.get(endpoint(origin, path)?);
    if let Some(token) = token { request = request.header(AUTHORIZATION, format!("Bearer {token}")); }
    let response = request.send().await.map_err(|_| "Could not reach the website alert feed".to_string())?;
    if response.status().as_u16() == 401 || response.status().as_u16() == 403 { return Err("The website alert feed rejected its connection key".into()); }
    if !response.status().is_success() { return Err("Website notifications are unavailable. Check the feed path and deployment.".into()); }
    let page: GenericResponse = serde_json::from_slice(&read_bounded(response).await?).map_err(|_| "Website alert feed returned an unsupported response")?;
    if page.version != 1 { return Err("This website alert feed version is not supported".into()); }
    validate_alerts(&page.events)
}

enum PollUpdate { ErpDelta(Vec<WebsiteAlert>), GenericSnapshot(Vec<WebsiteAlert>), Unchanged }
struct PollOutcome { update: Option<PollUpdate>, error: Option<String> }

fn poll_error(error: String, partial: Option<PollUpdate>) -> PollOutcome {
    PollOutcome { update: partial, error: Some(error) }
}

async fn poll_connection(connection: &mut SavedConnection) -> PollOutcome {
    match connection.adapter {
        Adapter::Erp => {
            let mut collected = Vec::new();
            for _ in 0..MAX_POLL_PAGES {
                let before = connection.next_cursor.clone();
                let page = match fetch_erp_page(connection).await {
                    Ok(Some(page)) => page,
                    Ok(None) => { connection.baseline_pending = false; return PollOutcome { update: Some(if collected.is_empty() { PollUpdate::Unchanged } else { PollUpdate::ErpDelta(collected) }), error: None }; }
                    Err(error) => return poll_error(error, if collected.is_empty() { None } else { Some(PollUpdate::ErpDelta(collected)) }),
                };
                if let Err(error) = validate_alerts(&page.events) {
                    return poll_error(error, if collected.is_empty() { None } else { Some(PollUpdate::ErpDelta(collected)) });
                }
                if let Some(cursor) = &page.next_cursor {
                    if cursor.len() > 240 || (page.has_more && before.as_deref() == Some(cursor)) {
                        return poll_error("The ERP returned an invalid notification cursor".into(), if collected.is_empty() { None } else { Some(PollUpdate::ErpDelta(collected)) });
                    }
                    connection.next_cursor = Some(cursor.clone());
                }
                let changed = connection.next_cursor != before;
                connection.etag = page.etag;
                collected.extend(page.events);
                if page.has_more {
                    connection.etag = None;
                    if !changed { return poll_error("The ERP returned an invalid notification cursor".into(), if collected.is_empty() { None } else { Some(PollUpdate::ErpDelta(collected)) }); }
                    continue;
                }
                connection.baseline_pending = false;
                return PollOutcome { update: Some(PollUpdate::ErpDelta(collected)), error: None };
            }
            PollOutcome { update: Some(PollUpdate::ErpDelta(collected)), error: None }
        }
        Adapter::Generic => {
            let mut request = match feed_request(connection, &connection.feed_path) { Ok(value) => value, Err(error) => return poll_error(error, None) };
            if let Some(etag) = connection.etag.as_deref() { request = request.header(IF_NONE_MATCH, etag); }
            let response = match request.send().await { Ok(value) => value, Err(_) => return poll_error("Could not reach the website alert feed".into(), None) };
            if response.status().as_u16() == 304 {
                connection.baseline_pending = false;
                return PollOutcome { update: Some(PollUpdate::Unchanged), error: None };
            }
            if response.status().as_u16() == 401 || response.status().as_u16() == 403 { return poll_error("Website connection key was rejected".into(), None); }
            if !response.status().is_success() { return poll_error("Website notifications are unavailable right now".into(), None); }
            connection.etag = response.headers().get(ETAG).and_then(|v| v.to_str().ok()).filter(|v| v.len() <= 512).map(str::to_string);
            let bytes = match read_bounded(response).await { Ok(value) => value, Err(error) => return poll_error(error, None) };
            let page: GenericResponse = match serde_json::from_slice(&bytes) { Ok(value) => value, Err(_) => return poll_error("Website alert feed returned invalid data".into(), None) };
            if page.version != 1 { return poll_error("This website alert feed version is not supported".into(), None); }
            if let Err(error) = validate_alerts(&page.events) { return poll_error(error, None); }
            connection.baseline_pending = false;
            PollOutcome { update: Some(PollUpdate::GenericSnapshot(page.events)), error: None }
        }
    }
}

fn merge_cached_events(cache: &mut HashMap<String, Vec<WebsiteAlert>>, id: &str, delta: &[WebsiteAlert]) {
    let current = cache.entry(id.to_string()).or_default();
    for event in delta {
        if let Some(existing) = current.iter_mut().find(|item| item.id == event.id) { *existing = event.clone(); }
        else { current.push(event.clone()); }
    }
    *current = sorted_limited(std::mem::take(current));
}

fn apply_poll_update(cache: &mut HashMap<String, Vec<WebsiteAlert>>, id: &str, update: &PollUpdate) {
    match update {
        PollUpdate::ErpDelta(events) => merge_cached_events(cache, id, events),
        PollUpdate::GenericSnapshot(events) => { cache.insert(id.to_string(), sorted_limited(events.clone())); }
        PollUpdate::Unchanged => {}
    }
}

fn prune_event_cache(cache: &mut HashMap<String, Vec<WebsiteAlert>>, active_ids: &std::collections::HashSet<String>) {
    cache.retain(|id, _| active_ids.contains(id));
}

fn merge_poll_state(latest: &mut SavedStore, polled: &SavedConnection) {
    if let Some(current) = latest.connections.iter_mut().find(|item| item.id == polled.id) {
        current.next_cursor = polled.next_cursor.clone();
        current.etag = polled.etag.clone();
        current.baseline_pending = polled.baseline_pending;
    }
}

fn sorted_limited(mut events: Vec<WebsiteAlert>) -> Vec<WebsiteAlert> {
    events.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    events.truncate(MAX_ALERTS);
    events
}

#[cfg(test)]
mod cache_tests {
    use super::*;

    fn event(id: &str, title: &str, timestamp: u64) -> WebsiteAlert {
        WebsiteAlert { id: id.into(), app: None, title: title.into(), body: String::new(), priority: None, timestamp, url: None }
    }

    #[test]
    fn erp_incremental_pages_accumulate_and_replace_updated_ids() {
        let mut cache = HashMap::new();
        apply_poll_update(&mut cache, "erp-1", &PollUpdate::ErpDelta(vec![event("po-1", "Needs review", 10)]));
        apply_poll_update(&mut cache, "erp-1", &PollUpdate::ErpDelta(vec![event("po-1", "Urgent review", 20), event("po-2", "New item", 15)]));
        let events = cache.get("erp-1").unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].title, "Urgent review");
        assert_eq!(events[1].id, "po-2");
    }

    #[test]
    fn unchanged_304_and_failed_poll_without_an_update_keep_last_good_inbox() {
        let mut cache = HashMap::from([("site-1".into(), vec![event("a", "Keep", 1)])]);
        apply_poll_update(&mut cache, "site-1", &PollUpdate::Unchanged);
        // An offline poll is represented by PollOutcome { update: None, error: Some(..) };
        // because it applies no update, the cache remains the last known good response.
        let _offline = PollOutcome { update: None, error: Some("offline".into()) };
        assert_eq!(cache.get("site-1").unwrap()[0].title, "Keep");
    }

    #[test]
    fn generic_feed_snapshot_replaces_the_previous_current_feed() {
        let mut cache = HashMap::from([("site-1".into(), vec![event("old", "Old", 1)])]);
        apply_poll_update(&mut cache, "site-1", &PollUpdate::GenericSnapshot(vec![event("new", "New", 2)]));
        let events = cache.get("site-1").unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, "new");
    }

    #[test]
    fn pruning_a_removed_connection_discards_any_in_flight_poll_cache() {
        let mut cache = HashMap::from([("removed".into(), vec![event("a", "No longer connected", 1)]), ("kept".into(), vec![event("b", "Still connected", 2)])]);
        prune_event_cache(&mut cache, &std::collections::HashSet::from(["kept".to_string()]));
        assert!(!cache.contains_key("removed"));
        assert!(cache.contains_key("kept"));
    }

    #[test]
    fn poll_finished_after_remove_cannot_restore_the_saved_connection() {
        let mut latest = SavedStore { connections: vec![] };
        let polled = SavedConnection { id: "removed".into(), display_name: "Removed".into(), server_url: "https://example.com".into(), adapter: Adapter::Generic, feed_path: "/events".into(), token: None, paired_at: "1".into(), next_cursor: Some("cursor".into()), etag: None, baseline_pending: false };
        merge_poll_state(&mut latest, &polled);
        assert!(latest.connections.is_empty());
    }
}

struct ErpPage { events: Vec<WebsiteAlert>, has_more: bool, next_cursor: Option<String>, etag: Option<String> }

fn feed_request(connection: &SavedConnection, path: &str) -> Result<reqwest::RequestBuilder, String> {
    let mut request = http()?.get(endpoint(&connection.server_url, path)?);
    if let Some(token) = &connection.token { request = request.header(AUTHORIZATION, format!("Bearer {token}")); }
    Ok(request)
}

async fn fetch_erp_page(connection: &SavedConnection) -> Result<Option<ErpPage>, String> {
    let mut url = endpoint(&connection.server_url, ERP_PATH)?;
    if let Some(cursor) = &connection.next_cursor { url.query_pairs_mut().append_pair("cursor", cursor); }
    let mut request = http()?.get(url);
    if let Some(token) = &connection.token { request = request.header(AUTHORIZATION, format!("Bearer {token}")); }
    if let Some(etag) = &connection.etag { if etag.len() > 512 { return Err("Saved website notification state is invalid".into()); } request = request.header(IF_NONE_MATCH, etag); }
    let response = request.send().await.map_err(|_| "Could not reach the ERP".to_string())?;
    if response.status().as_u16() == 304 { return Ok(None); }
    if response.status().as_u16() == 401 || response.status().as_u16() == 403 { return Err("ERP connection key was revoked. Add a new key to resume alerts.".into()); }
    if !response.status().is_success() { return Err("The ERP could not return notifications right now".into()); }
    let etag = response.headers().get(ETAG).and_then(|v| v.to_str().ok()).filter(|v| v.len() <= 512).map(str::to_string);
    let page: ErpResponse = serde_json::from_slice(&read_bounded(response).await?).map_err(|_| "The ERP returned invalid notification data")?;
    if page.version != 1 { return Err("This ERP notifications API version is not supported".into()); }
    Ok(Some(ErpPage { events: page.events, has_more: page.has_more, next_cursor: page.next_cursor, etag }))
}

fn validate_alerts(alerts: &[WebsiteAlert]) -> Result<(), String> {
    if alerts.len() > 100 { return Err("Website returned too many notifications".into()); }
    for event in alerts {
        if event.id.is_empty() || event.id.len() > 256 || event.app.as_ref().is_some_and(|v| v.len() > 160) || event.title.is_empty() || event.title.len() > 240 ||
            event.body.len() > 4000 || event.url.as_ref().is_some_and(|v| v.len() > 2048) ||
            event.priority.as_ref().is_some_and(|p| !matches!(p.as_str(), "normal" | "high" | "urgent" | "low")) {
            return Err("Website returned invalid notification data".into());
        }
    }
    Ok(())
}

fn valid_device_token(token: &str) -> bool {
    let Some(secret) = token.strip_prefix("hi_") else { return false; };
    secret.len() == 43 && secret.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn make_id() -> String { format!("site-{}-{}-{}", now_unix_timestamp(), std::process::id(), NEXT_ID.fetch_add(1, Ordering::Relaxed)) }
fn now_unix_timestamp() -> String { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis().to_string() }

#[cfg(windows)] pub(crate) fn protect(input: &[u8]) -> Result<Vec<u8>, String> { dpapi(input, true) }
#[cfg(windows)] pub(crate) fn unprotect(input: &[u8]) -> Result<Vec<u8>, String> { dpapi(input, false) }
#[cfg(not(windows))] pub(crate) fn protect(_: &[u8]) -> Result<Vec<u8>, String> { Err("Secure website connections are available in the Windows desktop app".into()) }
#[cfg(not(windows))] pub(crate) fn unprotect(_: &[u8]) -> Result<Vec<u8>, String> { Err("Secure website connections are available in the Windows desktop app".into()) }

#[cfg(windows)]
fn dpapi(input: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
    use std::ptr::{null, null_mut};
    #[repr(C)] struct DataBlob { size: u32, data: *mut u8 }
    #[link(name = "Crypt32")] extern "system" { fn CryptProtectData(input: *const DataBlob, description: *const u16, entropy: *const DataBlob, reserved: *mut std::ffi::c_void, prompt: *mut std::ffi::c_void, flags: u32, output: *mut DataBlob) -> i32; fn CryptUnprotectData(input: *const DataBlob, description: *mut *mut u16, entropy: *const DataBlob, reserved: *mut std::ffi::c_void, prompt: *mut std::ffi::c_void, flags: u32, output: *mut DataBlob) -> i32; }
    #[link(name = "Kernel32")] extern "system" { fn LocalFree(memory: *mut std::ffi::c_void) -> *mut std::ffi::c_void; }
    const ENTROPY: &[u8] = b"HoverIsland:WebsiteAlerts:Connection:v1";
    let source = DataBlob { size: u32::try_from(input.len()).map_err(|_| "Website connection data is too large")?, data: input.as_ptr() as *mut u8 };
    let entropy = DataBlob { size: ENTROPY.len() as u32, data: ENTROPY.as_ptr() as *mut u8 };
    let mut output = DataBlob { size: 0, data: null_mut() }; let mut description = null_mut();
    let success = unsafe { if encrypt { CryptProtectData(&source, null(), &entropy, null_mut(), null_mut(), 0x1, &mut output) } else { CryptUnprotectData(&source, &mut description, &entropy, null_mut(), null_mut(), 0x1, &mut output) } };
    if success == 0 || output.data.is_null() { return Err("Windows could not unlock saved website connections".into()); }
    let result = unsafe { std::slice::from_raw_parts(output.data, output.size as usize).to_vec() };
    unsafe { LocalFree(output.data as *mut std::ffi::c_void); if !description.is_null() { LocalFree(description as *mut std::ffi::c_void); } }
    Ok(result)
}
