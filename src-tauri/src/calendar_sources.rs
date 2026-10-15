//! User-selected HTTPS iCalendar subscriptions. Feed addresses are bearer secrets.
use futures_util::{stream, StreamExt};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    sync::OnceLock,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedSource {
    id: String,
    label: String,
    provider: String,
    url: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSnapshot {
    pub id: String,
    pub label: String,
    pub provider: String,
    pub updated_at: Option<u64>,
    pub error: Option<String>,
    pub contents: Option<String>,
}
#[derive(Clone)]
struct Cached {
    contents: Option<String>,
    updated_at: Option<u64>,
    error: Option<String>,
    checked: Instant,
}
static MUTATION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static CACHE: OnceLock<tokio::sync::Mutex<HashMap<String, Cached>>> = OnceLock::new();
static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
fn cache() -> &'static tokio::sync::Mutex<HashMap<String, Cached>> {
    CACHE.get_or_init(Default::default)
}
fn path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("calendar-sources.dpapi"))
        .map_err(|_| "Calendar storage is unavailable".into())
}
fn read(app: &AppHandle) -> Result<Vec<SavedSource>, String> {
    let bytes = match std::fs::read(path(app)?) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(_) => return Err("Could not read calendar connections".into()),
    };
    if bytes.len() > 64 * 1024 {
        return Err("Calendar connection data is invalid".into());
    }
    let sources: Vec<SavedSource> = serde_json::from_slice(&crate::erp::unprotect(&bytes)?)
        .map_err(|_| "Calendar connection data is invalid")?;
    if sources.len() > 6 {
        return Err("Calendar connection data is invalid".into());
    }
    Ok(sources)
}
fn write(app: &AppHandle, sources: &[SavedSource]) -> Result<(), String> {
    let target = path(app)?;
    let parent = target.parent().ok_or("Calendar storage is unavailable")?;
    std::fs::create_dir_all(parent).map_err(|_| "Could not create calendar storage")?;
    let bytes =
        crate::erp::protect(&serde_json::to_vec(sources).map_err(|_| "Could not save calendars")?)?;
    let temp = target.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temp, bytes).map_err(|_| "Could not save calendars")?;
    if crate::calendar::replace_file(&temp, &target).is_err() {
        let _ = std::fs::remove_file(temp);
        return Err("Could not save calendars".into());
    }
    Ok(())
}
fn validate_url(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    if raw.len() > 8192 {
        return Err("Calendar link is too long".into());
    }
    let normalized = raw
        .strip_prefix("webcal://")
        .map(|rest| format!("https://{rest}"))
        .unwrap_or_else(|| raw.into());
    let url =
        reqwest::Url::parse(&normalized).map_err(|_| "Enter the calendar's HTTPS iCal link")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("Use an HTTPS calendar link without embedded login credentials".into());
    }
    Ok(url.to_string())
}
async fn fetch(url: &str) -> Result<String, String> {
    let url = validate_url(url)?;
    let client = CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(Duration::from_secs(12))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| "Calendar connection is unavailable".into())
        })
        .as_ref()
        .map_err(Clone::clone)?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|_| "Could not reach this calendar. Check the link or try again.")?;
    if !response.status().is_success() {
        return Err("This calendar link is unavailable, private, or redirected. Copy its published iCal link.".into());
    }
    if response
        .content_length()
        .is_some_and(|size| size > 2 * 1024 * 1024)
    {
        return Err("Calendar feed is larger than 2 MB".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Could not read the calendar")?
    {
        if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
            return Err("Calendar feed is larger than 2 MB".into());
        }
        bytes.extend_from_slice(&chunk)
    }
    let text = String::from_utf8(bytes).map_err(|_| "Calendar feed has invalid text")?;
    if !text.contains("BEGIN:VCALENDAR") {
        return Err("This link returned a webpage, not an iCalendar feed".into());
    }
    Ok(text)
}
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[tauri::command]
pub async fn calendar_sources_get(
    app: AppHandle,
    force: Option<bool>,
) -> Result<Vec<SourceSnapshot>, String> {
    let sources = {
        let _guard = MUTATION.lock().await;
        read(&app)?
    };
    let results: Vec<_> = stream::iter(sources.into_iter())
        .map(|source| async move {
            let previous = cache().lock().await.get(&source.id).cloned();
            if !force.unwrap_or(false)
                && previous
                    .as_ref()
                    .is_some_and(|value| value.checked.elapsed() < Duration::from_secs(300))
            {
                return (source, previous.unwrap());
            }
            let value = match fetch(&source.url).await {
                Ok(contents) => Cached {
                    contents: Some(contents),
                    updated_at: Some(now()),
                    error: None,
                    checked: Instant::now(),
                },
                Err(error) => Cached {
                    contents: previous.as_ref().and_then(|value| value.contents.clone()),
                    updated_at: previous.and_then(|value| value.updated_at),
                    error: Some(error),
                    checked: Instant::now(),
                },
            };
            (source, value)
        })
        .buffer_unordered(2)
        .collect()
        .await;
    let current = {
        let _guard = MUTATION.lock().await;
        read(&app)?
    };
    let ids: HashSet<_> = current.iter().map(|value| value.id.as_str()).collect();
    let mut cached = cache().lock().await;
    cached.retain(|id, _| ids.contains(id.as_str()));
    let mut output = vec![];
    for (source, value) in results {
        if ids.contains(source.id.as_str()) {
            cached.insert(source.id.clone(), value.clone());
            output.push(SourceSnapshot {
                id: source.id,
                label: source.label,
                provider: source.provider,
                updated_at: value.updated_at,
                error: value.error,
                contents: value.contents,
            })
        }
    }
    Ok(output)
}
#[tauri::command]
pub async fn calendar_source_add(
    app: AppHandle,
    label: String,
    provider: String,
    url: String,
) -> Result<(), String> {
    let label = label.trim();
    if label.is_empty()
        || label.chars().count() > 60
        || !matches!(provider.as_str(), "google" | "outlook" | "ical")
    {
        return Err("Choose a calendar name and provider".into());
    }
    let url = validate_url(&url)?;
    let contents = fetch(&url).await?;
    let _guard = MUTATION.lock().await;
    let mut sources = read(&app)?;
    if sources.len() >= 6 {
        return Err("You can connect up to six calendars".into());
    }
    if sources.iter().any(|source| source.url == url) {
        return Err("This calendar is already connected".into());
    }
    let source = SavedSource {
        id: uuid::Uuid::new_v4().to_string(),
        label: label.into(),
        provider,
        url,
    };
    sources.push(source.clone());
    write(&app, &sources)?;
    cache().lock().await.insert(
        source.id,
        Cached {
            contents: Some(contents),
            updated_at: Some(now()),
            error: None,
            checked: Instant::now(),
        },
    );
    let _ = app.emit("calendar://sources-changed", ());
    Ok(())
}
#[tauri::command]
pub async fn calendar_source_remove(app: AppHandle, id: String) -> Result<(), String> {
    let _guard = MUTATION.lock().await;
    let mut sources = read(&app)?;
    sources.retain(|value| value.id != id);
    write(&app, &sources)?;
    cache().lock().await.remove(&id);
    let _ = app.emit("calendar://sources-changed", ());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn private_calendar_links_require_https_and_keep_secrets_native() {
        assert!(
            validate_url("https://calendar.google.com/calendar/ical/private/basic.ics").is_ok()
        );
        assert_eq!(
            validate_url("webcal://example.com/private.ics").unwrap(),
            "https://example.com/private.ics"
        );
        for bad in [
            "http://example.com/calendar.ics",
            "https://user:password@example.com/x",
            "file:///C:/secret",
            "javascript:alert(1)",
        ] {
            assert!(validate_url(bad).is_err());
        }
    }
}
