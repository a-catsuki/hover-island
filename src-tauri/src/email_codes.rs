//! Opt-in local email verification-code detection. Only short message previews are fetched;
//! codes remain in process memory and credentials are protected with Windows DPAPI.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    OnceLock,
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::Html,
    routing::get,
    Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;
use uuid::Uuid;

const STORE_FILE: &str = "email-codes.dpapi";
const MAX_STORE_BYTES: usize = 256 * 1024;
const MAX_RESPONSE_BYTES: usize = 512 * 1024;
const MAX_ACCOUNTS: usize = 5;
const MAX_MESSAGES: usize = 25;
const MAX_GMAIL_DETAILS_PER_POLL: usize = 8;
const MAX_SEEN_IDS: usize = 200;
const AUTH_TIMEOUT: Duration = Duration::from_secs(180);
const GOOGLE_SCOPE: &str = "openid email https://www.googleapis.com/auth/gmail.readonly";
const MICROSOFT_SCOPE: &str = "openid profile offline_access User.Read Mail.Read";

static HTTP: OnceLock<Result<Client, String>> = OnceLock::new();
static AUTH_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static STORE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static POLL_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static AUTH_GENERATION: AtomicU64 = AtomicU64::new(0);
static ACCESS_TOKENS: OnceLock<tokio::sync::Mutex<HashMap<String, CachedToken>>> = OnceLock::new();

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Google,
    Microsoft,
}

impl Provider {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "google" => Ok(Self::Google),
            "microsoft" => Ok(Self::Microsoft),
            _ => Err("Choose Google or Microsoft.".into()),
        }
    }
    fn token_url(self) -> &'static str {
        match self {
            Self::Google => "https://oauth2.googleapis.com/token",
            Self::Microsoft => "https://login.microsoftonline.com/common/oauth2/v2.0/token",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSummary {
    pub id: String,
    pub provider: Provider,
    pub address: String,
    pub paused: bool,
    pub connected_at: u64,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailCodeEvent {
    pub id: String,
    pub code: String,
    pub sender: String,
    pub subject: String,
    pub account: String,
    pub received_at: u64,
    pub expires_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailCodesSnapshot {
    pub accounts: Vec<AccountSummary>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct SavedStore {
    accounts: Vec<SavedAccount>,
}
impl Default for SavedStore {
    fn default() -> Self {
        Self { accounts: vec![] }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedAccount {
    id: String,
    provider: Provider,
    address: String,
    client_id: String,
    client_secret: Option<String>,
    refresh_token: String,
    paused: bool,
    connected_at: u64,
    last_checked: u64,
    baseline_pending: bool,
    seen_ids: Vec<String>,
    #[serde(default)]
    last_error: Option<String>,
}

impl SavedAccount {
    fn summary(&self) -> AccountSummary {
        AccountSummary {
            id: self.id.clone(),
            provider: self.provider,
            address: self.address.clone(),
            paused: self.paused,
            connected_at: self.connected_at,
            last_error: self.last_error.clone(),
        }
    }
}

#[derive(Clone)]
struct CallbackState {
    expected_state: String,
    expected_host: String,
    sender: std::sync::Arc<std::sync::Mutex<Option<oneshot::Sender<Result<String, String>>>>>,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct GmailProfile {
    #[serde(rename = "emailAddress")]
    email_address: String,
}
#[derive(Debug, Deserialize)]
struct GmailList {
    #[serde(default)]
    messages: Vec<GmailMessageRef>,
}
#[derive(Debug, Deserialize)]
struct GmailMessageRef {
    id: String,
}
#[derive(Debug, Deserialize)]
struct GmailMessage {
    id: String,
    #[serde(rename = "internalDate")]
    internal_date: Option<String>,
    snippet: Option<String>,
    payload: Option<GmailPayload>,
}
#[derive(Debug, Deserialize)]
struct GmailPayload {
    #[serde(default)]
    headers: Vec<GmailHeader>,
}
#[derive(Debug, Deserialize)]
struct GmailHeader {
    name: String,
    value: String,
}
#[derive(Debug, Deserialize)]
struct GraphList {
    #[serde(default)]
    value: Vec<GraphMessage>,
}
#[derive(Debug, Deserialize)]
struct GraphMessage {
    id: String,
    #[serde(rename = "receivedDateTime")]
    received_at: Option<String>,
    from: Option<GraphFrom>,
    subject: Option<String>,
    #[serde(rename = "bodyPreview")]
    body_preview: Option<String>,
}
#[derive(Debug, Deserialize)]
struct GraphFrom {
    #[serde(rename = "emailAddress")]
    email: GraphAddress,
}
#[derive(Debug, Deserialize)]
struct GraphAddress {
    address: String,
}

#[derive(Clone)]
struct CachedToken {
    value: String,
    expires_at: u64,
    connected_at: u64,
}

fn token_cache() -> &'static tokio::sync::Mutex<HashMap<String, CachedToken>> {
    ACCESS_TOKENS.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()))
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0)
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

fn http() -> Result<&'static Client, String> {
    HTTP.get_or_init(|| {
        Client::builder()
            .timeout(Duration::from_secs(10))
            .connect_timeout(Duration::from_secs(4))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("Hover-Island/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|_| "Email connections are unavailable right now.".to_string())
    })
    .as_ref()
    .map_err(Clone::clone)
}

fn storage_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(STORE_FILE))
        .map_err(|_| "Could not locate secure email connection storage.".into())
}

fn read_store(app: &AppHandle) -> Result<SavedStore, String> {
    let bytes = match std::fs::read(storage_path(app)?) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SavedStore::default())
        }
        Err(_) => return Err("Could not read saved email connections.".into()),
    };
    if bytes.len() > MAX_STORE_BYTES {
        return Err("Saved email connection data is invalid.".into());
    }
    let clear = crate::erp::unprotect(&bytes)?;
    let store: SavedStore = serde_json::from_slice(&clear)
        .map_err(|_| "Saved email connection data is invalid.".to_string())?;
    if store.accounts.len() > MAX_ACCOUNTS {
        return Err("Saved email connection data is invalid.".into());
    }
    for account in &store.accounts {
        if account.id.len() > 180
            || account.address.len() > 254
            || account.client_id.len() > 300
            || account
                .client_secret
                .as_ref()
                .is_some_and(|value| value.len() > 2048)
            || account.refresh_token.len() > 8192
            || account.seen_ids.len() > MAX_SEEN_IDS
            || account
                .last_error
                .as_ref()
                .is_some_and(|value| value.len() > 240)
        {
            return Err("Saved email connection data is invalid.".into());
        }
    }
    Ok(store)
}

fn write_store(app: &AppHandle, store: &SavedStore) -> Result<(), String> {
    if store.accounts.len() > MAX_ACCOUNTS {
        return Err("You can connect up to five email accounts.".into());
    }
    let path = storage_path(app)?;
    let parent = path
        .parent()
        .ok_or_else(|| "Could not locate secure email connection storage.".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|_| "Could not save email connection settings.".to_string())?;
    let clear = serde_json::to_vec(store)
        .map_err(|_| "Could not save email connection settings.".to_string())?;
    let encrypted = crate::erp::protect(&clear)?;
    let temp = path.with_extension("dpapi.tmp");
    std::fs::write(&temp, encrypted)
        .map_err(|_| "Could not save email connection settings.".to_string())?;
    std::fs::rename(&temp, &path).map_err(|_| {
        let _ = std::fs::remove_file(&temp);
        "Could not save email connection settings.".to_string()
    })
}

fn valid_client_id(value: &str) -> bool {
    (8..=300).contains(&value.trim().len())
        && value
            .trim()
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
}

fn account_id(provider: Provider, address: &str) -> String {
    format!(
        "{}:{}",
        match provider {
            Provider::Google => "google",
            Provider::Microsoft => "microsoft",
        },
        address.trim().to_ascii_lowercase()
    )
}

fn encode_query(url: &str, pairs: &[(&str, &str)]) -> Result<String, String> {
    let mut url = Url::parse(url).map_err(|_| "Email sign-in could not be started.".to_string())?;
    url.query_pairs_mut().extend_pairs(pairs.iter().copied());
    Ok(url.into())
}

fn callback_state_valid(expected: &str, received: &str) -> bool {
    !expected.is_empty()
        && expected.len() == received.len()
        && expected.as_bytes() == received.as_bytes()
}

fn callback_origin_valid(host: Option<&str>, origin: Option<&str>, expected_host: &str) -> bool {
    if host != Some(expected_host) {
        return false;
    }
    origin.map_or(true, |origin| origin == format!("http://{expected_host}"))
}

fn is_new_message(id: &str, received_at: u64, last_checked: u64, seen_ids: &[String]) -> bool {
    received_at >= last_checked && !seen_ids.iter().any(|seen| seen == id)
}

fn should_process_message(
    id: &str,
    received_at: u64,
    last_checked: u64,
    poll_started: u64,
    seen_ids: &[String],
) -> bool {
    received_at <= poll_started && is_new_message(id, received_at, last_checked, seen_ids)
}

fn code_expires_at(now_millis: u64) -> u64 {
    now_millis.saturating_add(10 * 60 * 1000)
}

async fn callback(
    State(state): State<CallbackState>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> (StatusCode, Html<&'static str>) {
    let host = headers.get("host").and_then(|value| value.to_str().ok());
    let origin = headers.get("origin").and_then(|value| value.to_str().ok());
    if !callback_origin_valid(host, origin, &state.expected_host) {
        return (
            StatusCode::BAD_REQUEST,
            Html("Sign-in could not be completed. Return to Hover Island."),
        );
    }
    let received_state = query.get("state").map(String::as_str).unwrap_or_default();
    if !callback_state_valid(&state.expected_state, received_state) {
        return (
            StatusCode::BAD_REQUEST,
            Html("Sign-in could not be verified. Return to Hover Island and try again."),
        );
    }
    let result = if query.get("error").is_some() {
        Err("Email sign-in was declined or could not be completed.".to_string())
    } else {
        query
            .get("code")
            .filter(|code| !code.is_empty() && code.len() <= 4096)
            .cloned()
            .ok_or_else(|| "Email sign-in did not return an authorization code.".to_string())
    };
    if let Ok(mut sender) = state.sender.lock() {
        if let Some(sender) = sender.take() {
            let _ = sender.send(result);
        }
    }
    (
        StatusCode::OK,
        Html("Email connected. You can close this window and return to Hover Island."),
    )
}

#[tauri::command]
pub async fn email_codes_authorize(
    app: AppHandle,
    provider: String,
    client_id: String,
    client_secret: Option<String>,
) -> Result<AccountSummary, String> {
    let _auth = AUTH_LOCK.lock().await;
    let generation = AUTH_GENERATION.load(Ordering::Acquire);
    let provider = Provider::parse(&provider)?;
    let client_id = client_id.trim().to_string();
    if !valid_client_id(&client_id) {
        return Err("Enter a valid OAuth client ID from your provider's developer console.".into());
    }
    let client_secret = client_secret.filter(|value| !value.is_empty());
    if provider == Provider::Microsoft && client_secret.is_some() {
        return Err(
            "Microsoft desktop connections use a public client ID without a client secret.".into(),
        );
    }
    if client_secret
        .as_ref()
        .is_some_and(|value| value.len() > 2048)
    {
        return Err("The Google client secret is too long.".into());
    }

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|_| "Could not open a temporary local sign-in callback.".to_string())?;
    let port = listener
        .local_addr()
        .map_err(|_| "Could not open a temporary local sign-in callback.".to_string())?
        .port();
    let redirect_uri = match provider {
        Provider::Google => format!("http://127.0.0.1:{port}/"),
        Provider::Microsoft => format!("http://localhost:{port}/"),
    };
    let expected_host = match provider {
        Provider::Google => format!("127.0.0.1:{port}"),
        Provider::Microsoft => format!("localhost:{port}"),
    };
    let state_value = Uuid::new_v4().to_string();
    let verifier = format!(
        "{}{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    );
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let (send_code, receive_code) = oneshot::channel();
    let callback_state = CallbackState {
        expected_state: state_value.clone(),
        expected_host: expected_host.clone(),
        sender: std::sync::Arc::new(std::sync::Mutex::new(Some(send_code))),
    };
    let router = Router::new()
        .route("/", get(callback))
        .with_state(callback_state);
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await;
    });

    let auth_url = match provider {
        Provider::Google => encode_query(
            "https://accounts.google.com/o/oauth2/v2/auth",
            &[
                ("client_id", &client_id),
                ("redirect_uri", &redirect_uri),
                ("response_type", "code"),
                ("scope", GOOGLE_SCOPE),
                ("state", &state_value),
                ("code_challenge", &challenge),
                ("code_challenge_method", "S256"),
                ("access_type", "offline"),
                ("prompt", "consent"),
            ],
        )?,
        Provider::Microsoft => encode_query(
            "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
            &[
                ("client_id", &client_id),
                ("redirect_uri", &redirect_uri),
                ("response_type", "code"),
                ("response_mode", "query"),
                ("scope", MICROSOFT_SCOPE),
                ("state", &state_value),
                ("code_challenge", &challenge),
                ("code_challenge_method", "S256"),
                ("prompt", "select_account"),
            ],
        )?,
    };
    if crate::apps::open_url(&app, &auth_url).is_err() {
        let _ = shutdown_tx.send(());
        server.abort();
        return Err("Could not open the provider sign-in page.".into());
    }
    let auth_code = match tokio::time::timeout(AUTH_TIMEOUT, receive_code).await {
        Ok(Ok(Ok(code))) => code,
        Ok(Ok(Err(error))) => {
            let _ = shutdown_tx.send(());
            server.abort();
            return Err(error);
        }
        _ => {
            let _ = shutdown_tx.send(());
            server.abort();
            return Err("Email sign-in timed out. Start again when ready.".into());
        }
    };
    let _ = shutdown_tx.send(());
    server.abort();
    if generation != AUTH_GENERATION.load(Ordering::Acquire) {
        return Err("Email connection changed during sign-in. Start again.".into());
    }

    let token = exchange_code(
        provider,
        &client_id,
        client_secret.as_deref(),
        &redirect_uri,
        &auth_code,
        &verifier,
    )
    .await?;
    let address = fetch_account_address(provider, &token.access_token).await?;
    if !valid_email(&address) {
        return Err("The provider did not return a valid email address.".into());
    }
    if generation != AUTH_GENERATION.load(Ordering::Acquire) {
        return Err("Email connection changed during sign-in. Start again.".into());
    }
    let refresh_token = token.refresh_token.ok_or_else(|| "The provider did not issue a refresh token. Disconnect Hover Island in your account settings, then connect again and approve ongoing access.".to_string())?;
    let summary;
    {
        let _lock = STORE_LOCK.lock().await;
        if generation != AUTH_GENERATION.load(Ordering::Acquire) {
            return Err("Email connection changed during sign-in. Start again.".into());
        }
        let mut store = read_store(&app)?;
        let id = account_id(provider, &address);
        let connected_at = now_millis();
        let account = SavedAccount {
            id: id.clone(),
            provider,
            address: address.clone(),
            client_id,
            client_secret,
            refresh_token,
            paused: false,
            connected_at,
            last_checked: now_millis(),
            baseline_pending: true,
            seen_ids: vec![],
            last_error: None,
        };
        if let Some(existing) = store.accounts.iter_mut().find(|item| item.id == id) {
            *existing = account.clone();
        } else if store.accounts.len() < MAX_ACCOUNTS {
            store.accounts.push(account.clone());
        } else {
            return Err("You can connect up to five email accounts. Remove one first.".into());
        }
        write_store(&app, &store)?;
        summary = account.summary();
    }
    token_cache().lock().await.insert(
        summary.id.clone(),
        CachedToken {
            value: token.access_token,
            expires_at: now_seconds() + bounded_token_lifetime(token.expires_in),
            connected_at: summary.connected_at,
        },
    );
    Ok(summary)
}

async fn exchange_code(
    provider: Provider,
    client_id: &str,
    client_secret: Option<&str>,
    redirect_uri: &str,
    code: &str,
    verifier: &str,
) -> Result<TokenResponse, String> {
    let mut form = vec![
        ("client_id", client_id),
        ("code", code),
        ("code_verifier", verifier),
        ("redirect_uri", redirect_uri),
        ("grant_type", "authorization_code"),
    ];
    if let Some(secret) = client_secret {
        form.push(("client_secret", secret));
    }
    let response = http()?
        .post(provider.token_url())
        .form(&form)
        .send()
        .await
        .map_err(|_| "Could not exchange the provider authorization code.".to_string())?;
    if !response.status().is_success() {
        return Err(
            "The provider could not complete sign-in. Check the client ID and OAuth configuration."
                .into(),
        );
    }
    let bytes = read_bounded(response, 64 * 1024).await?;
    let token: TokenResponse = serde_json::from_slice(&bytes)
        .map_err(|_| "The provider returned an invalid sign-in response.".to_string())?;
    if token.access_token.is_empty()
        || token.access_token.len() > 8192
        || token
            .refresh_token
            .as_ref()
            .is_some_and(|value| value.is_empty() || value.len() > 8192)
    {
        return Err("The provider returned an invalid sign-in response.".into());
    }
    Ok(token)
}

fn bounded_token_lifetime(expires_in: Option<u64>) -> u64 {
    expires_in
        .unwrap_or(3600)
        .clamp(60, 24 * 60 * 60)
        .saturating_sub(30)
}

async fn fetch_account_address(provider: Provider, token: &str) -> Result<String, String> {
    let url = match provider {
        Provider::Google => "https://gmail.googleapis.com/gmail/v1/users/me/profile",
        Provider::Microsoft => "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName",
    };
    let response = http()?
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| "Could not verify the connected email account.".to_string())?;
    if !response.status().is_success() {
        return Err("Could not verify the connected email account. Check the requested provider permissions.".into());
    }
    let bytes = read_bounded(response, 32 * 1024).await?;
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct GraphProfile {
        mail: Option<String>,
        user_principal_name: Option<String>,
    }
    let address = match provider {
        Provider::Google => serde_json::from_slice::<GmailProfile>(&bytes)
            .map(|data| data.email_address)
            .ok(),
        Provider::Microsoft => serde_json::from_slice::<GraphProfile>(&bytes)
            .ok()
            .and_then(|data| data.mail.or(data.user_principal_name)),
    };
    address.ok_or_else(|| "Could not read the connected email address.".into())
}

fn valid_email(value: &str) -> bool {
    value.len() <= 254 && value.contains('@') && !value.chars().any(char::is_control)
}

#[tauri::command]
pub async fn email_codes_accounts(app: AppHandle) -> Result<EmailCodesSnapshot, String> {
    let store = read_store(&app)?;
    Ok(EmailCodesSnapshot {
        accounts: store.accounts.iter().map(SavedAccount::summary).collect(),
        last_error: None,
    })
}

#[tauri::command]
pub async fn email_codes_remove(app: AppHandle, id: String) -> Result<(), String> {
    let _lock = STORE_LOCK.lock().await;
    AUTH_GENERATION.fetch_add(1, Ordering::AcqRel);
    let mut store = read_store(&app)?;
    let before = store.accounts.len();
    store.accounts.retain(|account| account.id != id);
    if store.accounts.len() == before {
        return Err("That email connection was not found.".into());
    }
    write_store(&app, &store)?;
    token_cache().lock().await.remove(&id);
    Ok(())
}

#[tauri::command]
pub async fn email_codes_set_paused(
    app: AppHandle,
    id: String,
    paused: bool,
) -> Result<EmailCodesSnapshot, String> {
    let _lock = STORE_LOCK.lock().await;
    AUTH_GENERATION.fetch_add(1, Ordering::AcqRel);
    let mut store = read_store(&app)?;
    let Some(account) = store.accounts.iter_mut().find(|account| account.id == id) else {
        return Err("That email connection was not found.".into());
    };
    let resuming = account.paused && !paused;
    account.paused = paused;
    if resuming {
        account.baseline_pending = true;
        account.last_checked = now_millis();
        account.seen_ids.clear();
        account.last_error = None;
    }
    write_store(&app, &store)?;
    Ok(EmailCodesSnapshot {
        accounts: store.accounts.iter().map(SavedAccount::summary).collect(),
        last_error: None,
    })
}

pub async fn poll(app: &AppHandle, notifications_enabled: bool, dnd: bool) -> Result<(), String> {
    if !notifications_enabled || dnd {
        return Ok(());
    }
    let Ok(_poll) = POLL_LOCK.try_lock() else {
        return Ok(());
    };
    let store = read_store(app)?;
    for account in store
        .accounts
        .into_iter()
        .filter(|account| !account.paused)
        .take(MAX_ACCOUNTS)
    {
        if app
            .state::<crate::state::AppState>()
            .shutdown
            .load(Ordering::Relaxed)
        {
            break;
        }
        let id = account.id.clone();
        let poll_started = now_millis();
        let access_token = match access_token(app, &account).await {
            Ok(Some(token)) => token,
            Ok(None) => continue,
            Err(_) => {
                let _ = update_account_error(app, &account, Some("Provider access expired or could not be refreshed. Reconnect this account.".into())).await;
                let _ = app.emit("auth://error", "An email connection needs attention.");
                continue;
            }
        };
        let messages = match fetch_recent_messages(&account, &access_token).await {
            Ok(messages) => messages,
            Err(_) => {
                let _ = update_account_error(
                    app,
                    &account,
                    Some("Could not check this inbox. Hover Island will retry.".into()),
                )
                .await;
                let _ = app.emit(
                    "auth://error",
                    "Email code checking is temporarily unavailable.",
                );
                continue;
            }
        };
        let current_store = read_store(app)?;
        let Some(current) = current_store
            .accounts
            .iter()
            .find(|item| item.id == id && !item.paused)
        else {
            continue;
        };
        if current.connected_at != account.connected_at {
            continue;
        }
        let baseline = current.baseline_pending;
        if baseline {
            for message in &messages {
                if message.received_at <= poll_started {
                    update_checkpoint(
                        app,
                        &id,
                        account.connected_at,
                        poll_started,
                        Some(message.id.clone()),
                    )
                    .await?;
                }
            }
            update_checkpoint(app, &id, account.connected_at, poll_started, None).await?;
            update_account_error(app, &account, None).await?;
            continue;
        }
        let mut delivery_failed = false;
        for message in messages {
            if !should_process_message(
                &message.id,
                message.received_at,
                current.last_checked,
                poll_started,
                &current.seen_ids,
            ) {
                continue;
            }
            let detected_code = extract_code(&message.sender, &message.subject, &message.preview);
            if let Some(code) = detected_code {
                let event = EmailCodeEvent {
                    id: format!("{}:{}", id, message.id),
                    code,
                    sender: message.sender.clone(),
                    subject: safe_text(&message.subject, 120),
                    account: current.address.clone(),
                    received_at: message.received_at,
                    expires_at: code_expires_at(now_millis()),
                };
                if emit_code_if_active(app, &account, event).await? {
                    update_checkpoint(
                        app,
                        &id,
                        account.connected_at,
                        current.last_checked,
                        Some(message.id.clone()),
                    )
                    .await?;
                } else {
                    delivery_failed = true;
                    break;
                }
            } else {
                update_checkpoint(
                    app,
                    &id,
                    account.connected_at,
                    current.last_checked,
                    Some(message.id.clone()),
                )
                .await?;
            }
        }
        if !delivery_failed {
            update_checkpoint(app, &id, account.connected_at, poll_started, None).await?;
        }
        update_account_error(app, &account, None).await?;
    }
    Ok(())
}

async fn emit_code_if_active(
    app: &AppHandle,
    expected: &SavedAccount,
    event: EmailCodeEvent,
) -> Result<bool, String> {
    let _lock = STORE_LOCK.lock().await;
    let store = read_store(app)?;
    if !store.accounts.iter().any(|item| {
        item.id == expected.id && item.connected_at == expected.connected_at && !item.paused
    }) {
        return Ok(false);
    }
    app.emit("auth://code", event)
        .map(|_| true)
        .map_err(|_| "Could not deliver a detected email code.".to_string())
}

async fn update_account_error(
    app: &AppHandle,
    expected: &SavedAccount,
    error: Option<String>,
) -> Result<(), String> {
    let _lock = STORE_LOCK.lock().await;
    let mut store = read_store(app)?;
    if let Some(account) = store.accounts.iter_mut().find(|account| {
        account.id == expected.id
            && account.connected_at == expected.connected_at
            && !account.paused
    }) {
        if account.last_error != error {
            account.last_error = error;
            write_store(app, &store)?;
            let _ = app.emit("auth://connections-changed", ());
        }
    }
    Ok(())
}

async fn update_checkpoint(
    app: &AppHandle,
    id: &str,
    connected_at: u64,
    checked: u64,
    seen_id: Option<String>,
) -> Result<(), String> {
    let _lock = STORE_LOCK.lock().await;
    let mut store = read_store(app)?;
    if let Some(account) = store
        .accounts
        .iter_mut()
        .find(|account| account.id == id && account.connected_at == connected_at && !account.paused)
    {
        account.baseline_pending = false;
        account.last_checked = account.last_checked.max(checked);
        if let Some(seen_id) = seen_id {
            if !account.seen_ids.contains(&seen_id) {
                account.seen_ids.push(seen_id);
            }
            while account.seen_ids.len() > MAX_SEEN_IDS {
                account.seen_ids.remove(0);
            }
        }
        write_store(app, &store)?;
    }
    Ok(())
}

async fn access_token(app: &AppHandle, account: &SavedAccount) -> Result<Option<String>, String> {
    let now = now_seconds();
    if let Some(token) = token_cache()
        .lock()
        .await
        .get(&account.id)
        .filter(|token| token.expires_at > now + 30 && token.connected_at == account.connected_at)
        .cloned()
    {
        return Ok(Some(token.value));
    }
    let response = http()?
        .post(account.provider.token_url())
        .form(
            &[
                ("client_id", account.client_id.as_str()),
                ("refresh_token", account.refresh_token.as_str()),
                ("grant_type", "refresh_token"),
            ]
            .into_iter()
            .chain(
                account
                    .client_secret
                    .as_deref()
                    .map(|secret| ("client_secret", secret)),
            )
            .collect::<Vec<_>>(),
        )
        .send()
        .await
        .map_err(|_| "Email token refresh failed.".to_string())?;
    if !response.status().is_success() {
        let _ = token_cache().lock().await.remove(&account.id);
        return Err(
            "Provider authorization expired or was withdrawn. Reconnect this account.".into(),
        );
    }
    let bytes = read_bounded(response, 64 * 1024).await?;
    let token: TokenResponse = serde_json::from_slice(&bytes)
        .map_err(|_| "The provider returned an invalid token response.".to_string())?;
    if token.access_token.is_empty()
        || token.access_token.len() > 8192
        || token
            .refresh_token
            .as_ref()
            .is_some_and(|value| value.is_empty() || value.len() > 8192)
    {
        return Err("The provider returned an invalid token response.".into());
    }
    {
        let _lock = STORE_LOCK.lock().await;
        let mut store = read_store(app)?;
        let Some(saved) = store.accounts.iter_mut().find(|item| {
            item.id == account.id
                && item.connected_at == account.connected_at
                && item.refresh_token == account.refresh_token
                && !item.paused
        }) else {
            return Ok(None);
        };
        if let Some(refresh) = token.refresh_token.as_ref() {
            if refresh != &saved.refresh_token {
                saved.refresh_token = refresh.clone();
                write_store(app, &store)?;
            }
        }
    }
    let expires_at = now + bounded_token_lifetime(token.expires_in);
    token_cache().lock().await.insert(
        account.id.clone(),
        CachedToken {
            value: token.access_token.clone(),
            expires_at,
            connected_at: account.connected_at,
        },
    );
    Ok(Some(token.access_token))
}

#[derive(Clone)]
struct MailPreview {
    id: String,
    received_at: u64,
    sender: String,
    subject: String,
    preview: String,
}

async fn fetch_recent_messages(
    account: &SavedAccount,
    access: &str,
) -> Result<Vec<MailPreview>, String> {
    match account.provider {
        Provider::Google => fetch_gmail(account, access).await,
        Provider::Microsoft => fetch_graph(account, access).await,
    }
}

async fn fetch_gmail(account: &SavedAccount, access: &str) -> Result<Vec<MailPreview>, String> {
    let client = http()?;
    let after = account.last_checked.saturating_sub(2 * 60 * 1000) / 1000;
    let query = format!("newer_than:2d after:{after}");
    let response = client
        .get("https://gmail.googleapis.com/gmail/v1/users/me/messages")
        .query(&[
            ("labelIds", "INBOX"),
            ("maxResults", "25"),
            ("q", query.as_str()),
        ])
        .bearer_auth(access)
        .send()
        .await
        .map_err(|_| "Gmail is unavailable.".to_string())?;
    if !response.status().is_success() {
        return Err("Gmail is unavailable.".into());
    }
    let list: GmailList =
        serde_json::from_slice(&read_bounded(response, MAX_RESPONSE_BYTES).await?)
            .map_err(|_| "Gmail returned invalid message data.".to_string())?;
    let mut messages = Vec::new();
    for item in list
        .messages
        .into_iter()
        .take(MAX_MESSAGES)
        .filter(|item| !account.seen_ids.iter().any(|seen| seen == &item.id))
        .take(if account.baseline_pending {
            MAX_MESSAGES
        } else {
            MAX_GMAIL_DETAILS_PER_POLL
        })
    {
        if !item
            .id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        {
            continue;
        }
        let url = format!(
            "https://gmail.googleapis.com/gmail/v1/users/me/messages/{}",
            item.id
        );
        let response = client
            .get(url)
            .query(&[
                ("format", "metadata"),
                ("metadataHeaders", "From"),
                ("metadataHeaders", "Subject"),
            ])
            .bearer_auth(access)
            .send()
            .await
            .map_err(|_| "Gmail is unavailable.".to_string())?;
        if !response.status().is_success() {
            continue;
        }
        let data: GmailMessage =
            match serde_json::from_slice(&read_bounded(response, 96 * 1024).await?) {
                Ok(data) => data,
                Err(_) => continue,
            };
        let header = |name: &str| {
            data.payload
                .as_ref()
                .and_then(|payload| {
                    payload
                        .headers
                        .iter()
                        .find(|header| header.name.eq_ignore_ascii_case(name))
                })
                .map(|header| header.value.clone())
                .unwrap_or_default()
        };
        let received_at = data
            .internal_date
            .as_deref()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);
        let sender = header("From");
        let subject = header("Subject");
        let id = data.id;
        let preview = data.snippet.unwrap_or_default();
        messages.push(MailPreview {
            id,
            received_at,
            sender,
            subject,
            preview,
        });
    }
    Ok(messages)
}

async fn fetch_graph(account: &SavedAccount, access: &str) -> Result<Vec<MailPreview>, String> {
    let client = http()?;
    let response = client
        .get("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages")
        .query(&[
            ("$select", "id,receivedDateTime,from,subject,bodyPreview"),
            ("$top", "25"),
            ("$orderby", "receivedDateTime desc"),
        ])
        .bearer_auth(access)
        .send()
        .await
        .map_err(|_| "Outlook is unavailable.".to_string())?;
    if !response.status().is_success() {
        return Err("Outlook is unavailable.".into());
    }
    let list: GraphList =
        serde_json::from_slice(&read_bounded(response, MAX_RESPONSE_BYTES).await?)
            .map_err(|_| "Outlook returned invalid message data.".to_string())?;
    Ok(list
        .value
        .into_iter()
        .filter(|item| !account.seen_ids.iter().any(|seen| seen == &item.id))
        .take(MAX_MESSAGES)
        .map(|item| MailPreview {
            id: item.id,
            received_at: item
                .received_at
                .as_deref()
                .and_then(parse_rfc3339_millis)
                .unwrap_or(0),
            sender: item.from.map(|from| from.email.address).unwrap_or_default(),
            subject: item.subject.unwrap_or_default(),
            preview: item.body_preview.unwrap_or_default(),
        })
        .collect())
}

fn parse_rfc3339_millis(value: &str) -> Option<u64> {
    if !value.is_ascii() {
        return None;
    }
    let (date, time_zone) = value.split_once('T')?;
    if date.len() != 10 || date.as_bytes()[4] != b'-' || date.as_bytes()[7] != b'-' {
        return None;
    }
    let mut date_parts = date.split('-');
    let year = date_parts.next()?.parse::<i64>().ok()?;
    let month = date_parts.next()?.parse::<i64>().ok()?;
    let day = date_parts.next()?.parse::<i64>().ok()?;
    if date_parts.next().is_some() || !(1..=12).contains(&month) {
        return None;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let month_days: [i64; 12] = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if day < 1 || day > month_days[(month - 1) as usize] {
        return None;
    }

    let (local, offset_minutes) = if let Some(local) = time_zone.strip_suffix('Z') {
        (local, 0i64)
    } else {
        let sign_at = time_zone
            .char_indices()
            .skip(8)
            .find(|(_, ch)| *ch == '+' || *ch == '-')?
            .0;
        let (local, zone) = time_zone.split_at(sign_at);
        if zone.len() != 6 || zone.as_bytes()[3] != b':' {
            return None;
        }
        let hours = zone[1..3].parse::<i64>().ok()?;
        let minutes = zone[4..6].parse::<i64>().ok()?;
        if hours > 23 || minutes > 59 {
            return None;
        }
        let sign = if zone.starts_with('-') { -1 } else { 1 };
        (local, sign * (hours * 60 + minutes))
    };
    let (clock, fraction) = match local.split_once('.') {
        Some((clock, fraction))
            if !fraction.is_empty() && fraction.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            (clock, fraction)
        }
        Some(_) => return None,
        None => (local, ""),
    };
    let mut clock_parts = clock.split(':');
    if clock.len() != 8 {
        return None;
    }
    let hour = clock_parts.next()?.parse::<i64>().ok()?;
    let minute = clock_parts.next()?.parse::<i64>().ok()?;
    let second = clock_parts.next()?.parse::<i64>().ok()?;
    if clock_parts.next().is_some() || hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let fraction_ms = if fraction.is_empty() {
        0
    } else {
        let first_three = &fraction[..fraction.len().min(3)];
        let value = first_three.parse::<u64>().ok()?;
        value
            * match first_three.len() {
                1 => 100,
                2 => 10,
                _ => 1,
            }
    };
    let utc_seconds = civil_to_days(year, month, day)
        .checked_mul(86_400)?
        .checked_add(hour * 3600 + minute * 60 + second)?
        .checked_sub(offset_minutes * 60)?;
    if utc_seconds < 0 {
        return None;
    }
    (utc_seconds as u64)
        .checked_mul(1000)?
        .checked_add(fraction_ms)
}

fn civil_to_days(year: i64, month: i64, day: i64) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let shifted_month = month + if month > 2 { -3 } else { 9 };
    let doy = (153 * shifted_month + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

async fn read_bounded(mut response: reqwest::Response, max: usize) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > max as u64)
    {
        return Err("Email provider response was too large.".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Email provider response could not be read.")?
    {
        if body.len().saturating_add(chunk.len()) > max {
            return Err("Email provider response was too large.".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn safe_text(value: &str, max: usize) -> String {
    value
        .chars()
        .filter(|ch| !ch.is_control())
        .take(max)
        .collect()
}

fn sender_is_security_related(sender: &str) -> bool {
    let sender = sender.to_ascii_lowercase();
    let address = sender
        .rsplit('<')
        .next()
        .unwrap_or(&sender)
        .trim_end_matches('>');
    [
        "no-reply",
        "noreply",
        "security",
        "verify",
        "verification",
        "account",
        "auth",
        "login",
        "signin",
    ]
    .iter()
    .any(|hint| address.contains(hint))
}

fn has_code_keyword(text: &str) -> bool {
    let text = text.to_ascii_lowercase();
    [
        "verification code",
        "security code",
        "one-time",
        "one time",
        "otp",
        "2fa",
        "two-factor",
        "two factor",
        "passcode",
        "sign-in code",
        "sign in code",
        "login code",
        "authentication code",
        "verify your",
        "verification number",
        "your code",
        "code is",
        "code:",
        "code -",
        "code below",
    ]
    .iter()
    .any(|keyword| text.contains(keyword))
}

fn nearest_phrase_distance(
    text: &str,
    start: usize,
    end: usize,
    phrases: &[&str],
) -> Option<usize> {
    phrases
        .iter()
        .flat_map(|phrase| {
            text.match_indices(phrase).map(move |(phrase_start, _)| {
                let phrase_end = phrase_start + phrase.len();
                if phrase_end <= start {
                    start - phrase_end
                } else if phrase_start >= end {
                    phrase_start - end
                } else {
                    0
                }
            })
        })
        .min()
}

fn extract_code(sender: &str, subject: &str, preview: &str) -> Option<String> {
    if !sender_is_security_related(sender) {
        return None;
    }
    let text = format!("{} {}", safe_text(subject, 512), safe_text(preview, 4096));
    let text: String = text
        .chars()
        .map(|ch| match ch {
            '€' | '£' | '₹' | '¥' => '$',
            ch if ch.is_ascii() => ch,
            _ => ' ',
        })
        .collect();
    let lower = text.to_ascii_lowercase();
    let mut candidates = Vec::new();
    let bytes = text.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if !bytes[index].is_ascii_alphanumeric() {
            index += 1;
            continue;
        }
        let start = index;
        while index < bytes.len() && bytes[index].is_ascii_alphanumeric() {
            index += 1;
        }
        let word = &text[start..index];
        if !(4..=8).contains(&word.len()) || !word.bytes().any(|byte| byte.is_ascii_digit()) {
            continue;
        }
        let before = &lower[start.saturating_sub(40)..start];
        let after = &lower[index..(index + 40).min(lower.len())];
        let context = format!("{before}{word}{after}");
        if !has_code_keyword(&context) {
            continue;
        }
        let digits = word.bytes().all(|byte| byte.is_ascii_digit());
        if digits && (word.starts_with("19") || word.starts_with("20")) && word.len() == 4 {
            continue;
        }
        let before_char = text[..start].chars().next_back();
        if matches!(before_char, Some('$')) {
            continue;
        }
        let code_distance = nearest_phrase_distance(
            &lower,
            start,
            index,
            &[
                "verification code",
                "security code",
                "one-time",
                "one time",
                "otp",
                "2fa",
                "two-factor",
                "two factor",
                "passcode",
                "sign-in code",
                "sign in code",
                "login code",
                "authentication code",
                "verify your",
                "verification number",
                "your code",
                "code is",
                "code:",
                "code -",
                "code below",
            ],
        );
        let phone_distance = nearest_phrase_distance(&lower, start, index, &["phone", "call"]);
        if phone_distance.is_some_and(|distance| {
            distance <= 12 && code_distance.map_or(true, |code_distance| distance <= code_distance)
        }) {
            continue;
        }
        candidates.push((start, word.to_string()));
    }
    candidates.into_iter().next().map(|(_, code)| code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn callback_rejects_missing_or_wrong_state() {
        assert!(callback_state_valid("state-123", "state-123"));
        assert!(!callback_state_valid("state-123", "state-124"));
        assert!(!callback_state_valid("state-123", ""));
    }

    #[test]
    fn callback_accepts_only_the_local_host_and_origin() {
        assert!(callback_origin_valid(
            Some("127.0.0.1:4242"),
            None,
            "127.0.0.1:4242"
        ));
        assert!(callback_origin_valid(
            Some("localhost:4242"),
            Some("http://localhost:4242"),
            "localhost:4242"
        ));
        assert!(!callback_origin_valid(
            Some("localhost:4242"),
            Some("https://localhost:4242"),
            "localhost:4242"
        ));
        assert!(!callback_origin_valid(
            Some("evil.example"),
            None,
            "localhost:4242"
        ));
    }

    #[test]
    fn polling_ignores_baseline_mail_and_deduplicates_ids() {
        let seen = vec!["already-seen".to_string()];
        assert!(!is_new_message("old", 99, 100, &seen));
        assert!(is_new_message("same-millisecond-arrival", 100, 100, &seen));
        assert!(!is_new_message("already-seen", 101, 100, &seen));
        assert!(should_process_message("new", 101, 100, 101, &seen));
        assert!(!should_process_message(
            "arrived-during-fetch",
            102,
            100,
            101,
            &seen
        ));
    }

    #[test]
    fn access_token_lifetime_and_code_expiry_are_bounded() {
        assert_eq!(bounded_token_lifetime(Some(1)), 30);
        assert_eq!(bounded_token_lifetime(Some(3600)), 3570);
        assert_eq!(bounded_token_lifetime(Some(u64::MAX)), 86_370);
        assert_eq!(code_expires_at(1_000), 601_000);
    }

    #[test]
    fn code_extraction_requires_security_sender_and_nearby_code_context() {
        assert_eq!(
            extract_code(
                "Security <no-reply@example.com>",
                "Your verification code",
                "Use 004291 to continue"
            ),
            Some("004291".into())
        );
        assert_eq!(
            extract_code(
                "Offers <deals@example.com>",
                "Your verification code",
                "Discount code 472910"
            ),
            None
        );
        assert_eq!(
            extract_code(
                "Security <no-reply@example.com>",
                "Your account activity",
                "Your invoice total is 2048"
            ),
            None
        );
    }

    #[test]
    fn extractor_skips_years_prices_and_phone_numbers() {
        assert_eq!(
            extract_code(
                "Security <no-reply@example.com>",
                "Verification code for 2026",
                "Call 5551234567. Your code is 883144."
            ),
            Some("883144".into())
        );
        assert_eq!(
            extract_code(
                "Security <no-reply@example.com>",
                "Security code $1234",
                "Call our support team"
            ),
            None
        );
        for currency_price in ["€883144", "£883144", "₹883144", "¥883144"] {
            assert_eq!(
                extract_code(
                    "Security <no-reply@example.com>",
                    "Your verification code",
                    currency_price
                ),
                None,
                "currency value {currency_price} must not be surfaced as a code"
            );
        }
        assert_eq!(
            extract_code(
                "Security <no-reply@example.com>",
                "Account verification",
                "Call 883144 if needed, but your code is: 112233."
            ),
            Some("112233".into())
        );
    }

    #[test]
    fn rfc3339_timestamp_parser_handles_offsets_and_milliseconds() {
        assert_eq!(parse_rfc3339_millis("1970-01-01T00:00:05Z"), Some(5_000));
        assert_eq!(
            parse_rfc3339_millis("1970-01-01T01:00:05.25+01:00"),
            Some(5_250)
        );
        assert_eq!(
            parse_rfc3339_millis("1970-01-01T00:00:05-01:00"),
            Some(3_605_000)
        );
        assert_eq!(parse_rfc3339_millis("2026-02-30T00:00:00Z"), None);
        assert_eq!(parse_rfc3339_millis("1970-01-01T00:00:05"), None);
        assert_eq!(parse_rfc3339_millis("not a date"), None);
    }

    #[test]
    fn oauth_inputs_are_bounded_and_provider_names_are_exact() {
        assert!(valid_client_id("123456789.apps.googleusercontent.com"));
        assert!(!valid_client_id("https://accounts.google.com"));
        assert!(Provider::parse("google").is_ok());
        assert!(Provider::parse("Gmail").is_err());
    }
}
