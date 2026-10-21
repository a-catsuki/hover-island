//! Open-Meteo forecast and air quality, cached per selected location.
//! Device location is requested only on an explicit action; coarse coordinates stay local until a forecast request.
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::state::AppState;
use crate::types::{now_millis, WeatherDay, WeatherHour, WeatherLocation, WeatherSnapshot};

const CACHE_TTL_MS: u64 = 15 * 60 * 1000;
const MANUAL_SOURCE: &str = "manual";
const DEVICE_SOURCE: &str = "device";
const UNKNOWN_SOURCE: &str = "unknown";
const MAX_RESPONSE_BYTES: usize = 512 * 1024;

static CACHE: Mutex<Option<(u64, String, WeatherSnapshot)>> = Mutex::new(None);

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("Hover-Island/", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

async fn response_json(
    mut response: reqwest::Response,
    description: &str,
) -> Result<Value, String> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(format!("{description} response is too large"));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| format!("{description} returned invalid data"))?
    {
        if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err(format!("{description} response is too large"));
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| format!("{description} returned invalid data"))
}

fn finite_number(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
}

fn bounded_percent(value: Option<&Value>) -> Option<u8> {
    finite_number(value).map(|value| value.round().clamp(0.0, 100.0) as u8)
}

fn wmo_code(value: Option<&Value>) -> i32 {
    value
        .and_then(Value::as_i64)
        .and_then(|value| i32::try_from(value).ok())
        .unwrap_or(-1)
}

fn array_value<'a>(array: Option<&'a Vec<Value>>, index: usize) -> Option<&'a Value> {
    array.and_then(|array| array.get(index))
}

fn valid_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    if !bytes[0..4].iter().all(u8::is_ascii_digit)
        || !bytes[5..7].iter().all(u8::is_ascii_digit)
        || !bytes[8..10].iter().all(u8::is_ascii_digit)
    {
        return false;
    }
    let year = value[0..4].parse::<u32>().ok();
    let month = value[5..7].parse::<u32>().ok();
    let day = value[8..10].parse::<u32>().ok();
    let (Some(year), Some(month), Some(day)) = (year, month, day) else {
        return false;
    };
    if year == 0 {
        return false;
    }
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        _ => return false,
    };
    (1..=days_in_month).contains(&day)
}

fn valid_hourly_time(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 16
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || !bytes[11..13].iter().all(u8::is_ascii_digit)
        || !bytes[14..16].iter().all(u8::is_ascii_digit)
    {
        return false;
    }
    let Some(date) = value.get(..10) else {
        return false;
    };
    if !valid_date(date) {
        return false;
    }
    let hour = value[11..13].parse::<u32>().ok();
    let minute = value[14..16].parse::<u32>().ok();
    matches!((hour, minute), (Some(hour), Some(minute)) if hour <= 23 && minute <= 59)
}

fn parse_hourly(value: &Value) -> Vec<WeatherHour> {
    let hourly = &value["hourly"];
    let times = hourly["time"].as_array();
    let temperatures = hourly["temperature_2m"].as_array();
    let codes = hourly["weather_code"].as_array();
    let precipitation = hourly["precipitation_probability"].as_array();
    let Some(times) = times else {
        return Vec::new();
    };

    times
        .iter()
        .enumerate()
        .take(24)
        .filter_map(|(index, time)| {
            let time = time.as_str()?;
            if !valid_hourly_time(time) {
                return None;
            }
            let time = time.to_string();
            let temperature_c = finite_number(array_value(temperatures, index))?;
            Some(WeatherHour {
                time,
                temperature_c,
                code: wmo_code(array_value(codes, index)),
                precipitation_probability: bounded_percent(array_value(precipitation, index)),
            })
        })
        .collect()
}

fn parse_daily(value: &Value) -> Vec<WeatherDay> {
    let daily = &value["daily"];
    let dates = daily["time"].as_array();
    let highs = daily["temperature_2m_max"].as_array();
    let lows = daily["temperature_2m_min"].as_array();
    let codes = daily["weather_code"].as_array();
    let sunrises = daily["sunrise"].as_array();
    let sunsets = daily["sunset"].as_array();
    let precipitation = daily["precipitation_probability_max"].as_array();
    let uv = daily["uv_index_max"].as_array();
    let winds = daily["wind_speed_10m_max"].as_array();
    let Some(dates) = dates else {
        return Vec::new();
    };

    dates
        .iter()
        .enumerate()
        .take(7)
        .filter_map(|(index, date)| {
            let date = date.as_str()?;
            if !valid_date(date) {
                return None;
            }
            let date = date.to_string();
            let high = finite_number(array_value(highs, index));
            let low = finite_number(array_value(lows, index));
            let (high_c, low_c) = match (high, low) {
                (Some(high), Some(low)) => (high, low),
                // A half-populated day must not be rendered as a fabricated flat range.
                _ => return None,
            };
            Some(WeatherDay {
                date,
                code: wmo_code(array_value(codes, index)),
                high_c,
                low_c,
                sunrise: array_value(sunrises, index)
                    .and_then(Value::as_str)
                    .map(str::to_string),
                sunset: array_value(sunsets, index)
                    .and_then(Value::as_str)
                    .map(str::to_string),
                precipitation_probability: bounded_percent(array_value(precipitation, index)),
                uv_index_max: finite_number(array_value(uv, index)).filter(|value| *value >= 0.0),
                wind_speed_max_kmh: finite_number(array_value(winds, index))
                    .filter(|value| *value >= 0.0),
            })
        })
        .collect()
}

fn parse_forecast(value: &Value, city: &str) -> Result<WeatherSnapshot, String> {
    let current = &value["current"];
    let temp = finite_number(current.get("temperature_2m"))
        .ok_or_else(|| "Current temperature is unavailable".to_string())?;
    let code = wmo_code(current.get("weather_code"));
    let first_day = parse_daily(value).into_iter().next();
    let hi = first_day.as_ref().map_or(temp, |day| day.high_c);
    let lo = first_day.as_ref().map_or(temp, |day| day.low_c);
    let humidity = bounded_percent(current.get("relative_humidity_2m"));
    let wind_direction = current
        .get("wind_direction_10m")
        .and_then(Value::as_i64)
        .filter(|value| (0..=360).contains(value))
        .map(|value| (value % 360) as u16);

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
        feels_like_c: finite_number(current.get("apparent_temperature")),
        humidity_pct: humidity,
        wind_speed_kmh: finite_number(current.get("wind_speed_10m")).filter(|value| *value >= 0.0),
        wind_direction_deg: wind_direction,
        precipitation_mm: finite_number(current.get("precipitation")).filter(|value| *value >= 0.0),
        is_day: current
            .get("is_day")
            .and_then(Value::as_i64)
            .map(|value| value != 0),
        pressure_hpa: finite_number(current.get("surface_pressure")).filter(|value| *value > 0.0),
        cloud_cover_pct: bounded_percent(current.get("cloud_cover")),
        timezone: value
            .get("timezone")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        hourly: parse_hourly(value),
        daily: parse_daily(value),
        pm2_5: None,
        pm10: None,
    })
}

async fn fetch_forecast(lat: f64, lon: f64, city: &str) -> Result<WeatherSnapshot, String> {
    let response = client()
        .get("https://api.open-meteo.com/v1/forecast")
        .query(&[
            ("latitude", lat.to_string()),
            ("longitude", lon.to_string()),
            ("current", "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,precipitation,is_day,surface_pressure,cloud_cover".to_string()),
            ("hourly", "temperature_2m,weather_code,precipitation_probability".to_string()),
            ("forecast_hours", "24".to_string()),
            ("daily", "weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_probability_max,uv_index_max,wind_speed_10m_max".to_string()),
            ("forecast_days", "7".to_string()),
            ("timezone", "auto".to_string()),
        ])
        .send()
        .await
        .map_err(|_| "Weather service is offline".to_string())?;
    if !response.status().is_success() {
        return Err("Weather service is unavailable".into());
    }
    let value = response_json(response, "Weather service").await?;
    parse_forecast(&value, city)
}

#[derive(Default)]
struct AirQuality {
    aqi: Option<u16>,
    pm2_5: Option<f64>,
    pm10: Option<f64>,
}

fn parse_air_quality(value: &Value) -> AirQuality {
    let current = &value["current"];
    let aqi = finite_number(current.get("us_aqi"))
        .filter(|value| *value >= 0.0)
        .map(|value| value.round().min(u16::MAX as f64) as u16);
    AirQuality {
        aqi,
        pm2_5: finite_number(current.get("pm2_5")).filter(|value| *value >= 0.0),
        pm10: finite_number(current.get("pm10")).filter(|value| *value >= 0.0),
    }
}

async fn fetch_aqi(lat: f64, lon: f64) -> AirQuality {
    let response = client()
        .get("https://air-quality-api.open-meteo.com/v1/air-quality")
        .query(&[
            ("latitude", lat.to_string()),
            ("longitude", lon.to_string()),
            ("current", "us_aqi,pm2_5,pm10".to_string()),
            ("timezone", "auto".to_string()),
        ])
        .send()
        .await;
    let Ok(response) = response else {
        return AirQuality::default();
    };
    if !response.status().is_success() {
        return AirQuality::default();
    }
    response_json(response, "Air quality service")
        .await
        .map_or_else(|_| AirQuality::default(), |value| parse_air_quality(&value))
}

async fn fetch(lat: f64, lon: f64, city: &str, source: &str) -> Result<WeatherSnapshot, String> {
    let (forecast, air_quality) = tokio::join!(fetch_forecast(lat, lon, city), fetch_aqi(lat, lon));
    let mut snapshot = forecast?;
    snapshot.aqi = air_quality.aqi;
    snapshot.aqi_label = air_quality.aqi.map(aqi_label);
    snapshot.pm2_5 = air_quality.pm2_5;
    snapshot.pm10 = air_quality.pm10;
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
        feels_like_c: None,
        humidity_pct: None,
        wind_speed_kmh: None,
        wind_direction_deg: None,
        precipitation_mm: None,
        is_day: None,
        pressure_hpa: None,
        cloud_cover_pct: None,
        timezone: None,
        hourly: Vec::new(),
        daily: Vec::new(),
        pm2_5: None,
        pm10: None,
    }
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

fn coarse_device_location(
    latitude: f64,
    longitude: f64,
    city: String,
) -> Result<WeatherLocation, String> {
    if !latitude.is_finite()
        || !longitude.is_finite()
        || !(-90.0..=90.0).contains(&latitude)
        || !(-180.0..=180.0).contains(&longitude)
    {
        return Err("Windows returned an invalid location. Choose a city instead.".into());
    }
    Ok(WeatherLocation {
        name: if city.trim().is_empty() {
            "Current location".into()
        } else {
            city
        },
        admin1: None,
        country: None,
        latitude: (latitude * 100.0).round() / 100.0,
        longitude: (longitude * 100.0).round() / 100.0,
    })
}

async fn bounded_location<T>(
    future: impl std::future::Future<Output = Result<T, String>>,
    limit: Duration,
) -> Result<T, String> {
    tokio::time::timeout(limit, future)
        .await
        .map_err(|_| "Windows location timed out. Try again or choose a city.".to_string())?
}

#[cfg(windows)]
fn require_location_access(
    status: windows::Devices::Geolocation::GeolocationAccessStatus,
) -> Result<(), String> {
    use windows::Devices::Geolocation::GeolocationAccessStatus;
    if status == GeolocationAccessStatus::Allowed {
        Ok(())
    } else {
        Err("Windows location access was not allowed. Enable Location in Windows privacy settings, then try again, or choose a city.".into())
    }
}

/// One explicit location read. No IP lookup, server relay, or background tracking.
#[tauri::command]
pub async fn weather_detect_location(app: AppHandle) -> Result<WeatherLocation, String> {
    #[cfg(windows)]
    {
        use windows::Devices::Geolocation::{Geolocator, PositionAccuracy};
        use windows::Foundation::TimeSpan;
        let (tx, rx) = tokio::sync::oneshot::channel();
        let foreground_app = app.clone();
        app.run_on_main_thread(move || {
            let result = (|| {
                if let Some(window) = foreground_app.get_webview_window("main") {
                    window.show().map_err(|error| error.to_string())?;
                    window.set_focus().map_err(|error| error.to_string())?;
                }
                let locator = Geolocator::new()
                    .map_err(|error| format!("Windows location is unavailable: {error}"))?;
                locator
                    .SetDesiredAccuracy(PositionAccuracy::Default)
                    .map_err(|error| format!("Could not configure Windows location: {error}"))?;
                let access = Geolocator::RequestAccessAsync().map_err(|error| {
                    format!("Could not ask Windows for location permission: {error}")
                })?;
                Ok((locator, access))
            })();
            let _ = tx.send(result);
        })
        .map_err(|error| format!("Could not start Windows location permission request: {error}"))?;
        let (locator, access) = bounded_location(
            async {
                rx.await.map_err(|_| {
                    "Windows location request was interrupted. Try again.".to_string()
                })?
            },
            Duration::from_secs(10),
        )
        .await?;
        let cancel_access = access.clone();
        let status = bounded_location(
            async {
                access
                    .await
                    .map_err(|error| format!("Windows location permission request failed: {error}"))
            },
            Duration::from_secs(60),
        )
        .await;
        let status = match status {
            Ok(status) => status,
            Err(error) => {
                let _ = cancel_access.Cancel();
                return Err(error);
            }
        };
        require_location_access(status)?;
        let position = locator
            .GetGeopositionAsyncWithAgeAndTimeout(
                TimeSpan {
                    Duration: 5 * 60 * 10_000_000,
                },
                TimeSpan {
                    Duration: 15 * 10_000_000,
                },
            )
            .map_err(|error| {
                format!("Could not read Windows location: {error}. Choose a city instead.")
            })?;
        let cancel_position = position.clone();
        let result = bounded_location(async {
            position.await.map_err(|error| format!("Windows could not find your location: {error}. Try again or choose a city."))
        }, Duration::from_secs(20)).await;
        let position = match result {
            Ok(position) => position,
            Err(error) => {
                let _ = cancel_position.Cancel();
                return Err(error);
            }
        };
        let coordinate = position
            .Coordinate()
            .and_then(|coordinate| coordinate.Point())
            .and_then(|point| point.Position())
            .map_err(|error| format!("Windows location could not be read: {error}"))?;
        let city = position
            .CivicAddress()
            .and_then(|address| address.City())
            .map(|city| city.to_string())
            .unwrap_or_default();
        coarse_device_location(coordinate.Latitude, coordinate.Longitude, city)
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("Device location is available in the Windows app. Choose a city instead.".into())
    }
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

#[derive(Debug, PartialEq)]
enum LocationChoice {
    Manual(f64, f64, String),

    Unconfigured,
}

fn location_choice(settings: &crate::settings::Settings) -> LocationChoice {
    let manual = match (settings.weather_lat, settings.weather_lon) {
        (Some(lat), Some(lon))
            if lat.is_finite()
                && lon.is_finite()
                && (-90.0..=90.0).contains(&lat)
                && (-180.0..=180.0).contains(&lon) =>
        {
            settings
                .weather_city
                .clone()
                .filter(|city| !city.trim().is_empty())
                .map(|city| (lat, lon, city))
        }
        _ => None,
    };
    if let Some((lat, lon, city)) = manual {
        LocationChoice::Manual(lat, lon, city)
    } else {
        LocationChoice::Unconfigured
    }
}

#[tauri::command]
pub async fn weather_get(app: AppHandle) -> WeatherSnapshot {
    let (choice, device_location) = {
        let state = app.state::<AppState>();
        let settings = state.settings.lock().unwrap();
        (location_choice(&settings), settings.weather_auto_location)
    };
    let location = match choice {
        LocationChoice::Manual(lat, lon, city) => Some((
            lat,
            lon,
            city,
            if device_location {
                DEVICE_SOURCE
            } else {
                MANUAL_SOURCE
            },
        )),

        LocationChoice::Unconfigured => {
            // Enforce consent here as well as in the UI: compact weather consumers
            // and background callers must never perform an implicit IP lookup.
            return unavailable(
                String::new(),
                "Choose a city or use device location.",
                UNKNOWN_SOURCE,
            );
        }
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
    fn device_coordinates_are_coarsened_before_leaving_the_location_reader() {
        let location = coarse_device_location(28.6139, 77.2090, String::new()).unwrap();
        assert_eq!(location.latitude, 28.61);
        assert_eq!(location.longitude, 77.21);
        assert_eq!(location.name, "Current location");
        assert!(coarse_device_location(f64::NAN, 77.2, String::new()).is_err());
        assert!(coarse_device_location(91.0, 77.2, String::new()).is_err());
    }

    #[tokio::test]
    async fn location_timeout_is_recoverable_and_a_retry_can_succeed() {
        let result: Result<(), String> =
            bounded_location(std::future::pending(), Duration::from_millis(1)).await;
        assert!(result.unwrap_err().contains("Try again or choose a city"));
        assert_eq!(
            bounded_location(async { Ok(42) }, Duration::from_secs(1)).await,
            Ok(42)
        );
    }

    #[cfg(windows)]
    #[test]
    fn location_denial_and_unspecified_access_cannot_proceed_to_position_read() {
        use windows::Devices::Geolocation::GeolocationAccessStatus;
        assert!(require_location_access(GeolocationAccessStatus::Allowed).is_ok());
        assert!(require_location_access(GeolocationAccessStatus::Denied).is_err());
        assert!(require_location_access(GeolocationAccessStatus::Unspecified).is_err());
    }

    #[test]
    fn automatic_location_is_opt_in_and_never_a_silent_fallback_for_invalid_city() {
        let mut settings = crate::settings::Settings::default();
        assert_eq!(location_choice(&settings), LocationChoice::Unconfigured);
        settings.weather_auto_location = true;
        assert_eq!(location_choice(&settings), LocationChoice::Unconfigured);
        settings.weather_auto_location = false;
        settings.weather_lat = Some(0.0);
        settings.weather_lon = Some(0.0);
        settings.weather_city = Some("Null Island".into());
        assert_eq!(
            location_choice(&settings),
            LocationChoice::Manual(0.0, 0.0, "Null Island".into())
        );
        settings.weather_lat = Some(91.0);
        assert_eq!(location_choice(&settings), LocationChoice::Unconfigured);
    }

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
    fn labels_standard_us_aqi_bands_without_claiming_measurement() {
        assert_eq!(aqi_label(50), "US AQI · Good");
        assert_eq!(aqi_label(100), "US AQI · Moderate");
        assert_eq!(aqi_label(101), "US AQI · Unhealthy for Sensitive Groups");
        assert_eq!(aqi_label(301), "US AQI · Hazardous");
    }

    #[test]
    fn parses_extended_weather_snapshot_and_caps_forecasts_to_requested_horizons() {
        let hourly = (0..28)
            .map(|index| {
                serde_json::json!({
                    "time": format!("2026-10-15T{index:02}:00"),
                    "temperature_2m": 20.0 + index as f64 / 2.0,
                    "weather_code": if index % 2 == 0 { 2 } else { 61 },
                    "precipitation_probability": if index == 0 { 105 } else { index }
                })
            })
            .collect::<Vec<_>>();
        let daily = (0..9)
            .map(|index| {
                serde_json::json!({
                    "time": format!("2026-10-{day:02}", day = 15 + index),
                    "weather_code": 2,
                    "temperature_2m_max": 30.0 + index as f64,
                    "temperature_2m_min": 20.0 + index as f64,
                    "sunrise": "2026-10-15T06:00",
                    "sunset": "2026-10-15T18:00",
                    "precipitation_probability_max": index * 15,
                    "uv_index_max": 7.5,
                    "wind_speed_10m_max": 25.0
                })
            })
            .collect::<Vec<_>>();
        let value = serde_json::json!({
            "timezone": "Asia/Kolkata",
            "current": {
                "temperature_2m": 26.0,
                "apparent_temperature": 29.5,
                "relative_humidity_2m": 58,
                "weather_code": 2,
                "wind_speed_10m": 13.5,
                "wind_direction_10m": 360,
                "precipitation": 0.0,
                "is_day": 1,
                "surface_pressure": 1008.2,
                "cloud_cover": 32
            },
            "hourly": {
                "time": hourly.iter().map(|item| item["time"].clone()).collect::<Vec<_>>(),
                "temperature_2m": hourly.iter().map(|item| item["temperature_2m"].clone()).collect::<Vec<_>>(),
                "weather_code": hourly.iter().map(|item| item["weather_code"].clone()).collect::<Vec<_>>(),
                "precipitation_probability": hourly.iter().map(|item| item["precipitation_probability"].clone()).collect::<Vec<_>>()
            },
            "daily": {
                "time": daily.iter().map(|item| item["time"].clone()).collect::<Vec<_>>(),
                "weather_code": daily.iter().map(|item| item["weather_code"].clone()).collect::<Vec<_>>(),
                "temperature_2m_max": daily.iter().map(|item| item["temperature_2m_max"].clone()).collect::<Vec<_>>(),
                "temperature_2m_min": daily.iter().map(|item| item["temperature_2m_min"].clone()).collect::<Vec<_>>(),
                "sunrise": daily.iter().map(|item| item["sunrise"].clone()).collect::<Vec<_>>(),
                "sunset": daily.iter().map(|item| item["sunset"].clone()).collect::<Vec<_>>(),
                "precipitation_probability_max": daily.iter().map(|item| item["precipitation_probability_max"].clone()).collect::<Vec<_>>(),
                "uv_index_max": daily.iter().map(|item| item["uv_index_max"].clone()).collect::<Vec<_>>(),
                "wind_speed_10m_max": daily.iter().map(|item| item["wind_speed_10m_max"].clone()).collect::<Vec<_>>()
            }
        });

        let snapshot = parse_forecast(&value, "Bengaluru").unwrap();
        assert_eq!(snapshot.city, "Bengaluru");
        assert_eq!(snapshot.feels_like_c, Some(29.5));
        assert_eq!(snapshot.humidity_pct, Some(58));
        assert_eq!(snapshot.wind_direction_deg, Some(0));
        assert_eq!(snapshot.is_day, Some(true));
        assert_eq!(snapshot.timezone.as_deref(), Some("Asia/Kolkata"));
        assert_eq!(snapshot.hourly.len(), 24);
        assert_eq!(snapshot.hourly[0].precipitation_probability, Some(100));
        assert_eq!(snapshot.daily.len(), 7);
        assert_eq!(snapshot.daily[1].precipitation_probability, Some(15));
        assert_eq!(
            snapshot.daily[0].sunrise.as_deref(),
            Some("2026-10-15T06:00")
        );
    }

    #[test]
    fn optional_forecast_fields_and_particulate_data_tolerate_partial_payloads() {
        let value = serde_json::json!({
            "current": { "temperature_2m": 12.0, "weather_code": 0, "cloud_cover": 120 },
            "hourly": { "time": ["2026-10-15T09:00", "invalid"], "temperature_2m": [13.0, 14.0] },
            "daily": { "time": ["2026-10-15", "2026-10-16"], "temperature_2m_max": [18.0], "temperature_2m_min": [10.0, 9.0] }
        });
        let snapshot = parse_forecast(&value, "Test").unwrap();
        assert_eq!(snapshot.cloud_cover_pct, Some(100));
        assert_eq!(snapshot.hourly.len(), 1);
        assert_eq!(snapshot.hourly[0].time, "2026-10-15T09:00");
        assert_eq!(snapshot.hourly[0].code, -1);
        assert_eq!(snapshot.daily.len(), 1);
        assert_eq!(snapshot.daily[0].high_c, 18.0);
        assert_eq!(snapshot.daily[0].low_c, 10.0);
        assert_eq!(snapshot.pressure_hpa, None);

        let aqi = parse_air_quality(
            &serde_json::json!({ "current": { "us_aqi": 62.4, "pm2_5": 12.4, "pm10": -1.0 } }),
        );
        assert_eq!(aqi.aqi, Some(62));
        assert_eq!(aqi.pm2_5, Some(12.4));
        assert_eq!(aqi.pm10, None);
        assert_eq!(parse_air_quality(&serde_json::json!({})).aqi, None);
    }

    #[test]
    fn weather_cache_keys_separate_manual_and_device_locations() {
        assert_ne!(
            location_key(40.7, -74.0, "New York", MANUAL_SOURCE),
            location_key(40.7, -74.0, "New York", DEVICE_SOURCE)
        );
    }
}
