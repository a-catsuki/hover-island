//! Open-Meteo forecast and air quality, cached per selected location.
//! Automatic location is a coarse public-IP estimate; coordinates are never sent to that lookup.
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::state::AppState;
use crate::types::{now_millis, WeatherLocation, WeatherSnapshot};

const CACHE_TTL_MS: u64 = 15 * 60 * 1000;
const AUTO_LOCATION_TTL_MS: u64 = 24 * 60 * 60 * 1000;
const MANUAL_SOURCE: &str = "manual";
const APPROXIMATE_SOURCE: &str = "approximate";
const UNKNOWN_SOURCE: &str = "unknown";

static CACHE: Mutex<Option<(u64, String, WeatherSnapshot)>> = Mutex::new(None);
static AUTO_LOCATION: Mutex<Option<(u64, f64, f64, String)>> = Mutex::new(None);

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .user_agent(concat!("Hover-Island/", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

async fn fetch_forecast(lat: f64, lon: f64, city: &str) -> Result<WeatherSnapshot, String> {
    let response = client()
        .get("https://api.open-meteo.com/v1/forecast")
        .query(&[
            ("latitude", lat.to_string()),
            ("longitude", lon.to_string()),
            ("current", "temperature_2m,weather_code".to_string()),
            ("daily", "temperature_2m_max,temperature_2m_min".to_string()),
            ("timezone", "auto".to_string()),
        ])
        .send()
        .await
        .map_err(|_| "Weather service is offline".to_string())?;
    if !response.status().is_success() {
        return Err("Weather service is unavailable".into());
    }
    let value: Value = response
        .json()
        .await
        .map_err(|_| "Weather service returned invalid data".to_string())?;

    let temp = value
        .pointer("/current/temperature_2m")
        .and_then(Value::as_f64)
        .ok_or_else(|| "Current temperature is unavailable".to_string())?;
    let code = value
        .pointer("/current/weather_code")
        .and_then(Value::as_i64)
        .and_then(|value| i32::try_from(value).ok())
        .unwrap_or(-1);
    let hi = value
        .pointer("/daily/temperature_2m_max/0")
        .and_then(Value::as_f64)
        .unwrap_or(temp);
    let lo = value
        .pointer("/daily/temperature_2m_min/0")
        .and_then(Value::as_f64)
        .unwrap_or(temp);

    Ok(WeatherSnapshot {
        ok: true,
        city: city.to_string(),
        temp_c: temp,
        hi_c: hi,
        lo_c: lo,
        code,
        label: wmo_label(code).to_string(),
        updated_at: now_millis(),
        aqi: None,
        aqi_label: None,
        location_source: None,
        stale: Some(false),
    })
}

async fn fetch_aqi(lat: f64, lon: f64) -> Option<u16> {
    let response = client()
        .get("https://air-quality-api.open-meteo.com/v1/air-quality")
        .query(&[
            ("latitude", lat.to_string()),
            ("longitude", lon.to_string()),
            ("current", "us_aqi".to_string()),
            ("timezone", "auto".to_string()),
        ])
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let value: Value = response.json().await.ok()?;
    value
        .pointer("/current/us_aqi")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0)
        .map(|value| value.round().min(u16::MAX as f64) as u16)
}

async fn fetch(lat: f64, lon: f64, city: &str, source: &str) -> Result<WeatherSnapshot, String> {
    let (forecast, aqi) = tokio::join!(fetch_forecast(lat, lon, city), fetch_aqi(lat, lon));
    let mut snapshot = forecast?;
    snapshot.aqi = aqi;
    snapshot.aqi_label = aqi.map(aqi_label);
    snapshot.location_source = Some(source.to_string());
    Ok(snapshot)
}

fn location_key(lat: f64, lon: f64, city: &str, source: &str) -> String {
    format!("{lat:.5},{lon:.5}:{}:{source}", city.trim().to_lowercase())
}

fn unavailable(city: String, reason: impl Into<String>, source: &str) -> WeatherSnapshot {
    WeatherSnapshot {
        ok: false,
        city,
        temp_c: 0.0,
        hi_c: 0.0,
        lo_c: 0.0,
        code: -1,
        label: reason.into(),
        updated_at: now_millis(),
        aqi: None,
        aqi_label: None,
        location_source: Some(source.to_string()),
        stale: Some(false),
    }
}

fn parse_approximate_location(value: &Value) -> Option<(f64, f64, String)> {
    if !value.get("success")?.as_bool()? {
        return None;
    }
    let geo = value;
    let lat = geo.get("latitude")?.as_f64()?;
    let lon = geo.get("longitude")?.as_f64()?;
    if !lat.is_finite()
        || !lon.is_finite()
        || !(-90.0..=90.0).contains(&lat)
        || !(-180.0..=180.0).contains(&lon)
    {
        return None;
    }
    // ipwho.is names this field `city`; accept `name` as a fallback for
    // compatible IP-geolocation payloads that use the alternate convention.
    // Do not let an empty `city` value hide a usable fallback.
    let city = ["city", "name"]
        .into_iter()
        .filter_map(|key| geo.get(key).and_then(Value::as_str))
        .map(str::trim)
        .find(|name| !name.is_empty())
        .unwrap_or_default();
    let region = geo
        .get("region")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    let country = geo
        .get("country")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    let mut parts = Vec::new();
    for part in [city, region, country] {
        if !part.is_empty() && !parts.contains(&part) {
            parts.push(part);
        }
    }
    let name = parts.join(", ");
    (!name.is_empty()).then_some((lat, lon, name))
}

async fn approximate_location() -> Option<(f64, f64, String)> {
    let now = now_millis();
    if let Ok(cache) = AUTO_LOCATION.lock() {
        if let Some((at, lat, lon, city)) = cache.as_ref() {
            if now.saturating_sub(*at) < AUTO_LOCATION_TTL_MS {
                return Some((*lat, *lon, city.clone()));
            }
        }
    }

    // The provider sees the public IP used for this HTTPS request, but receives
    // no device GPS or other precise coordinates. Failures simply offer city search.
    let response = client().get("https://ipwho.is/").send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let value: Value = response.json().await.ok()?;
    let (lat, lon, city) = parse_approximate_location(&value)?;
    if let Ok(mut cache) = AUTO_LOCATION.lock() {
        *cache = Some((now, lat, lon, city.clone()));
    }
    Some((lat, lon, city))
}

fn parse_locations(value: &Value) -> Vec<WeatherLocation> {
    value
        .get("results")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let name = item.get("name")?.as_str()?.trim();
            let latitude = item.get("latitude")?.as_f64()?;
            let longitude = item.get("longitude")?.as_f64()?;
            if name.is_empty()
                || !latitude.is_finite()
                || !longitude.is_finite()
                || !(-90.0..=90.0).contains(&latitude)
                || !(-180.0..=180.0).contains(&longitude)
            {
                return None;
            }
            Some(WeatherLocation {
                name: name.to_string(),
                admin1: item
                    .get("admin1")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                country: item
                    .get("country")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                latitude,
                longitude,
            })
        })
        .collect()
}

#[tauri::command]
pub async fn weather_search(query: String) -> Result<Vec<WeatherLocation>, String> {
    let query = query.trim();
    if query.chars().count() < 2 {
        return Ok(Vec::new());
    }
    if query.chars().count() > 80 {
        return Err("City search is too long".into());
    }
    let response = client()
        .get("https://geocoding-api.open-meteo.com/v1/search")
        .query(&[
            ("name", query),
            ("count", "8"),
            ("language", "en"),
            ("format", "json"),
        ])
        .send()
        .await
        .map_err(|_| "Could not search for that city".to_string())?;
    if !response.status().is_success() {
        return Err("City search is unavailable right now".into());
    }
    let value: Value = response
        .json()
        .await
        .map_err(|_| "City search returned invalid data".to_string())?;
    Ok(parse_locations(&value))
}

/// Map a WMO weather code to a short human label.
pub fn wmo_label(code: i32) -> &'static str {
    match code {
        0 => "Clear",
        1 => "Mostly Clear",
        2 => "Partly Cloudy",
        3 => "Cloudy",
        45 | 48 => "Fog",
        51 | 53 | 55 => "Drizzle",
        56 | 57 => "Freezing Drizzle",
        61 | 63 | 65 => "Rain",
        66 | 67 => "Freezing Rain",
        71 | 73 | 75 => "Snow",
        77 => "Snow Grains",
        80 | 81 | 82 => "Rain Showers",
        85 | 86 => "Snow Showers",
        95 | 96 | 99 => "Thunderstorm",
        _ => "Unknown",
    }
}

pub fn aqi_label(aqi: u16) -> String {
    let band = match aqi {
        0..=50 => "Good",
        51..=100 => "Moderate",
        101..=150 => "Unhealthy for Sensitive Groups",
        151..=200 => "Unhealthy",
        201..=300 => "Very Unhealthy",
        _ => "Hazardous",
    };
    format!("US AQI · {band}")
}

#[tauri::command]
pub async fn weather_get(app: AppHandle) -> WeatherSnapshot {
    let manual_location = {
        let state = app.state::<AppState>();
        let settings = state.settings.lock().unwrap();
        match (settings.weather_lat, settings.weather_lon) {
            (Some(lat), Some(lon)) if lat.is_finite() && lon.is_finite() => settings
                .weather_city
                .clone()
                .filter(|city| !city.trim().is_empty())
                .map(|city| (lat, lon, city)),
            _ => None,
        }
    };
    let location = if let Some((lat, lon, city)) = manual_location {
        Some((lat, lon, city, MANUAL_SOURCE))
    } else {
        approximate_location()
            .await
            .map(|(lat, lon, city)| (lat, lon, city, APPROXIMATE_SOURCE))
    };
    let Some((lat, lon, city, source)) = location else {
        return unavailable(
            String::new(),
            "Nearby location unavailable. Search for a city to continue.",
            UNKNOWN_SOURCE,
        );
    };

    let now = now_millis();
    let key = location_key(lat, lon, &city, source);
    let (cached, fresh) = CACHE.lock().ok().map_or((None, false), |cache| {
        let cached = cache
            .as_ref()
            .filter(|(_, cached_key, _)| cached_key == &key)
            .map(|entry| entry.2.clone());
        let fresh = cache.as_ref().is_some_and(|(at, cached_key, _)| {
            cached_key == &key && now.saturating_sub(*at) < CACHE_TTL_MS
        });
        (cached, fresh)
    });
    if fresh {
        if let Some(snapshot) = cached.as_ref() {
            return snapshot.clone();
        }
    }

    match fetch(lat, lon, &city, source).await {
        Ok(snapshot) => {
            if let Ok(mut cache) = CACHE.lock() {
                *cache = Some((now, key, snapshot.clone()));
            }
            snapshot
        }
        Err(reason) => {
            if let Some(mut snapshot) = cached {
                snapshot.stale = Some(true);
                snapshot
            } else {
                unavailable(city, reason, source)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_common_wmo_codes() {
        assert_eq!(wmo_label(0), "Clear");
        assert_eq!(wmo_label(3), "Cloudy");
        assert_eq!(wmo_label(61), "Rain");
        assert_eq!(wmo_label(71), "Snow");
        assert_eq!(wmo_label(95), "Thunderstorm");
        assert_eq!(wmo_label(1234), "Unknown");
    }

    #[test]
    fn location_results_are_validated_and_keep_disambiguating_names() {
        let value = serde_json::json!({"results": [
            {"name":"Springfield", "admin1":"Illinois", "country":"United States", "latitude":39.8, "longitude":-89.6},
            {"name":"", "latitude":0.0, "longitude":0.0},
            {"name":"Bad coordinates", "latitude":91.0, "longitude":0.0}
        ]});
        let locations = parse_locations(&value);
        assert_eq!(locations.len(), 1);
        assert_eq!(locations[0].name, "Springfield");
        assert_eq!(locations[0].admin1.as_deref(), Some("Illinois"));
        assert_eq!(locations[0].country.as_deref(), Some("United States"));
    }

    #[test]
    fn parses_coarse_ip_location_and_rejects_failed_or_invalid_responses() {
        let sample = serde_json::json!({
            "success": true,
            "city": "Bengaluru",
            "region": "Karnataka",
            "country": "India",
            "latitude": 12.97,
            "longitude": 77.59
        });
        assert_eq!(
            parse_approximate_location(&sample),
            Some((12.97, 77.59, "Bengaluru, Karnataka, India".into()))
        );
        assert!(parse_approximate_location(&serde_json::json!({"success":false})).is_none());
        assert!(parse_approximate_location(&serde_json::json!({
            "success": true, "city":"Somewhere", "latitude": 180, "longitude": 0
        }))
        .is_none());
    }

    #[test]
    fn accepts_city_or_name_from_ip_geolocation_and_prefers_nonempty_city() {
        let payload = |city: Value, name: Value| {
            serde_json::json!({
                "success": true, "city": city, "name": name,
                "region": "Karnataka", "country": "India",
                "latitude": 12.97, "longitude": 77.59
            })
        };
        assert_eq!(
            parse_approximate_location(&payload(Value::Null, Value::String("Bengaluru".into()))),
            Some((12.97, 77.59, "Bengaluru, Karnataka, India".into()))
        );
        assert_eq!(
            parse_approximate_location(&payload(
                Value::String("".into()),
                Value::String("Bengaluru".into())
            )),
            Some((12.97, 77.59, "Bengaluru, Karnataka, India".into()))
        );
        assert_eq!(
            parse_approximate_location(&payload(
                Value::String("Bengaluru".into()),
                Value::String("Fallback".into())
            )),
            Some((12.97, 77.59, "Bengaluru, Karnataka, India".into()))
        );
    }

    #[test]
    fn labels_standard_us_aqi_bands_without_claiming_measurement() {
        assert_eq!(aqi_label(50), "US AQI · Good");
        assert_eq!(aqi_label(100), "US AQI · Moderate");
        assert_eq!(aqi_label(101), "US AQI · Unhealthy for Sensitive Groups");
        assert_eq!(aqi_label(301), "US AQI · Hazardous");
    }

    #[test]
    fn weather_cache_keys_separate_manual_and_approximate_locations() {
        assert_ne!(
            location_key(40.7, -74.0, "New York", MANUAL_SOURCE),
            location_key(40.7, -74.0, "New York", APPROXIMATE_SOURCE)
        );
    }
}
