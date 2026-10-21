//! Open-Meteo forecast and air quality, cached per selected location.
//! Device location is looked up only on an explicit action (Windows Location first, then an
//! approximate IP lookup). Coarse coordinates are saved locally and sent to Open-Meteo for forecasts.
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::state::AppState;
use crate::types::{now_millis, WeatherDay, WeatherHour, WeatherLocation, WeatherSnapshot};

/// Forecasts change slowly; ten minutes keeps the widget fresh without hammering Open-Meteo.
const CACHE_TTL_MS: u64 = 10 * 60 * 1000;
const MANUAL_SOURCE: &str = "manual";
const DEVICE_SOURCE: &str = "device";
const UNKNOWN_SOURCE: &str = "unknown";
const MAX_RESPONSE_BYTES: usize = 512 * 1024;

static CACHE: Mutex<Option<(u64, String, WeatherSnapshot)>> = Mutex::new(None);
static FETCH_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

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
    // Open-Meteo sends integers, but accept 3.0 as well so a format tweak cannot blank the widget.
    finite_number(value)
        .map(f64::round)
        .filter(|code| (0.0..=1000.0).contains(code))
        .map_or(-1, |code| code as i32)
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
    let wind_direction = finite_number(current.get("wind_direction_10m"))
        .map(f64::round)
        .filter(|value| (0.0..=360.0).contains(value))
        .map(|value| (value as u16) % 360);

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
        is_day: finite_number(current.get("is_day")).map(|value| value != 0.0),
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
            ("temperature_unit", "celsius".to_string()),
            ("wind_speed_unit", "kmh".to_string()),
            ("precipitation_unit", "mm".to_string()),
            ("timeformat", "iso8601".to_string()),
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

/// How a device location was found, so the UI can say how precise it is.
const METHOD_WINDOWS: &str = "windows";
const METHOD_NETWORK: &str = "network";

/// A successful device lookup. `notice` explains a fallback in one short line.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceLocation {
    pub location: WeatherLocation,
    /// "windows" (Windows Location) or "network" (approximate, from the IP address).
    pub method: String,
    pub notice: Option<String>,
    /// True when turning on Windows location would make the result more precise.
    pub can_open_settings: bool,
}

/// A failed device lookup. The UI shows `message` and, when `can_open_settings`
/// is set, a button wired to `weather_open_location_settings`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocationFailure {
    /// "windows_disabled" | "offline" | "timeout" | "unavailable"
    pub code: String,
    pub message: String,
    pub can_open_settings: bool,
}

/// What the Windows location stack said, before any network fallback.
#[derive(Debug, PartialEq)]
enum NativeOutcome {
    Found {
        latitude: f64,
        longitude: f64,
        city: String,
    },
    /// Location is off for the system or for desktop apps.
    Disabled,
    TimedOut,
    Failed(String),
    /// Not running on Windows (development builds).
    Unsupported,
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
            city.trim().to_string()
        },
        admin1: None,
        country: None,
        latitude: (latitude * 100.0).round() / 100.0,
        longitude: (longitude * 100.0).round() / 100.0,
    })
}

fn clean_text(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn json_text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// Some IP services send coordinates as strings, others as numbers.
fn json_coordinate(value: Option<&Value>) -> Option<f64> {
    let number = match value? {
        Value::Number(number) => number.as_f64()?,
        Value::String(text) => text.trim().parse::<f64>().ok()?,
        _ => return None,
    };
    number.is_finite().then_some(number)
}

/// Build a coarse location from an IP lookup. The (0, 0) pair is what several
/// services return when they know nothing, so it is never trusted.
fn network_candidate(
    latitude: Option<f64>,
    longitude: Option<f64>,
    city: Option<&str>,
    region: Option<&str>,
    country: Option<&str>,
) -> Option<WeatherLocation> {
    let (latitude, longitude) = (latitude?, longitude?);
    if latitude == 0.0 && longitude == 0.0 {
        return None;
    }
    let city = clean_text(city);
    let region = clean_text(region);
    let name = city.clone().or_else(|| region.clone()).unwrap_or_default();
    let mut location = coarse_device_location(latitude, longitude, name).ok()?;
    location.admin1 = if city.is_some() { region } else { None };
    location.country = clean_text(country);
    Some(location)
}

fn parse_ipwho(value: &Value) -> Option<WeatherLocation> {
    if value.get("success").and_then(Value::as_bool) == Some(false) {
        return None;
    }
    network_candidate(
        json_coordinate(value.get("latitude")),
        json_coordinate(value.get("longitude")),
        json_text(value, "city"),
        json_text(value, "region"),
        json_text(value, "country"),
    )
}

fn parse_geojs(value: &Value) -> Option<WeatherLocation> {
    network_candidate(
        json_coordinate(value.get("latitude")),
        json_coordinate(value.get("longitude")),
        json_text(value, "city"),
        json_text(value, "region"),
        json_text(value, "country"),
    )
}

fn parse_ipapi(value: &Value) -> Option<WeatherLocation> {
    if value.get("error").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    network_candidate(
        json_coordinate(value.get("latitude")),
        json_coordinate(value.get("longitude")),
        json_text(value, "city"),
        json_text(value, "region"),
        json_text(value, "country_name"),
    )
}

type NetworkParser = fn(&Value) -> Option<WeatherLocation>;

/// Keyless HTTPS geolocation services, tried in order.
const NETWORK_PROVIDERS: [(&str, NetworkParser); 3] = [
    (
        "https://ipwho.is/?fields=success,latitude,longitude,city,region,country",
        parse_ipwho,
    ),
    ("https://get.geojs.io/v1/ip/geo.json", parse_geojs),
    ("https://ipapi.co/json/", parse_ipapi),
];

/// Approximate location from the public IP address. `Err(true)` means no
/// service answered at all, which almost always means the PC is offline.
async fn network_location() -> Result<WeatherLocation, bool> {
    let mut reached = false;
    for (url, parse) in NETWORK_PROVIDERS {
        let Ok(response) = client()
            .get(url)
            .timeout(Duration::from_secs(6))
            .send()
            .await
        else {
            continue;
        };
        reached = true;
        if !response.status().is_success() {
            continue;
        }
        let Ok(value) = response_json(response, "Location service").await else {
            continue;
        };
        if let Some(location) = parse(&value) {
            return Ok(location);
        }
    }
    Err(!reached)
}

/// Name a coordinate pair (Windows often returns coordinates without a city).
fn parse_reverse_geocode(value: &Value) -> Option<(String, Option<String>, Option<String>)> {
    let name = clean_text(json_text(value, "city"))
        .or_else(|| clean_text(json_text(value, "locality")))?;
    Some((
        name,
        clean_text(json_text(value, "principalSubdivision")),
        clean_text(json_text(value, "countryName")),
    ))
}

async fn reverse_geocode(
    latitude: f64,
    longitude: f64,
) -> Option<(String, Option<String>, Option<String>)> {
    let response = client()
        .get("https://api.bigdatacloud.net/data/reverse-geocode-client")
        .query(&[
            ("latitude", latitude.to_string()),
            ("longitude", longitude.to_string()),
            ("localityLanguage", "en".to_string()),
        ])
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let value = response_json(response, "Place lookup").await.ok()?;
    parse_reverse_geocode(&value)
}

fn network_notice(native: &NativeOutcome) -> Option<String> {
    match native {
        NativeOutcome::Disabled => Some(
            "Windows location is off, so this is based on your network. Turn it on for a precise spot."
                .to_string(),
        ),
        NativeOutcome::TimedOut | NativeOutcome::Failed(_) => Some(
            "Windows did not return a location, so this is based on your network.".to_string(),
        ),
        NativeOutcome::Found { .. } => Some(
            "Windows returned an unusable location, so this is based on your network.".to_string(),
        ),
        NativeOutcome::Unsupported => None,
    }
}

fn location_failure(native: &NativeOutcome, offline: bool) -> LocationFailure {
    let (code, message, can_open_settings) = match native {
        NativeOutcome::Disabled => (
            "windows_disabled",
            "Location is turned off in Windows. Turn it on, or pick a city.",
            true,
        ),
        _ if offline => (
            "offline",
            "No internet connection. Check your network, or pick a city.",
            false,
        ),
        NativeOutcome::TimedOut => (
            "timeout",
            "Windows could not find your location in time. Try again, or pick a city.",
            false,
        ),
        _ => (
            "unavailable",
            "Could not work out where you are. Pick a city instead.",
            false,
        ),
    };
    LocationFailure {
        code: code.to_string(),
        message: message.to_string(),
        can_open_settings,
    }
}

#[cfg(windows)]
mod win_location {
    //! Windows Location through `Windows.Devices.Geolocation`.
    //!
    //! `RequestAccessAsync` is started on the UI thread (the documented
    //! requirement for the consent flow), then every wait happens on a worker
    //! thread with an explicit deadline and cancellation, so a stuck location
    //! service can never freeze the UI or hang the command.
    use super::NativeOutcome;
    use std::thread;
    use std::time::{Duration, Instant};
    use tauri::AppHandle;
    use windows::core::{w, ComInterface, Error, HRESULT, PCWSTR};
    use windows::Devices::Geolocation::{
        GeolocationAccessStatus, Geolocator, Geoposition, PositionAccuracy, PositionStatus,
    };
    use windows::Foundation::{AsyncStatus, IAsyncInfo, IAsyncOperation, TimeSpan};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    /// E_ACCESSDENIED: location is off for the system or for desktop apps.
    const ACCESS_DENIED: HRESULT = HRESULT(0x8007_0005_u32 as i32);
    const POLL: Duration = Duration::from_millis(40);
    const ACCESS_WAIT: Duration = Duration::from_secs(20);
    const POSITION_WAIT: Duration = Duration::from_secs(20);
    /// 100 ns ticks.
    const TICKS_PER_SECOND: i64 = 10_000_000;

    enum Wait {
        Denied,
        TimedOut,
        Failed(String),
    }

    fn describe(error: &Error) -> String {
        format!("HRESULT 0x{:08X}", error.code().0 as u32)
    }

    fn classify(error: &Error) -> Wait {
        if error.code() == ACCESS_DENIED {
            Wait::Denied
        } else {
            Wait::Failed(describe(error))
        }
    }

    /// Wait for a WinRT operation without blocking forever. Must not run on an STA thread.
    fn wait<T: windows::core::RuntimeType + 'static>(
        operation: &IAsyncOperation<T>,
        limit: Duration,
    ) -> Result<T, Wait> {
        let info: IAsyncInfo = operation.cast().map_err(|error| classify(&error))?;
        let deadline = Instant::now() + limit;
        loop {
            match info.Status().map_err(|error| classify(&error))? {
                AsyncStatus::Completed => return operation.get().map_err(|error| classify(&error)),
                AsyncStatus::Error => {
                    let code = info.ErrorCode().unwrap_or_default();
                    return Err(classify(&Error::from(code)));
                }
                AsyncStatus::Canceled => return Err(Wait::Failed("canceled".into())),
                _ if Instant::now() >= deadline => {
                    let _ = info.Cancel();
                    let _ = info.Close();
                    return Err(Wait::TimedOut);
                }
                _ => thread::sleep(POLL),
            }
        }
    }

    pub(super) async fn read(app: &AppHandle) -> NativeOutcome {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let scheduled = app.run_on_main_thread(move || {
            let _ = tx.send(Geolocator::RequestAccessAsync().ok());
        });
        // If the UI thread is busy or the call fails, the position read below
        // still reports a disabled state accurately, so this step is optional.
        let access = if scheduled.is_ok() {
            match tokio::time::timeout(Duration::from_secs(5), rx).await {
                Ok(Ok(access)) => access,
                _ => None,
            }
        } else {
            None
        };
        match tokio::task::spawn_blocking(move || read_blocking(access)).await {
            Ok(outcome) => outcome,
            Err(_) => NativeOutcome::Failed("location worker stopped".into()),
        }
    }

    fn read_blocking(access: Option<IAsyncOperation<GeolocationAccessStatus>>) -> NativeOutcome {
        if let Some(access) = access {
            // Desktop apps can report Unspecified while location works, so only
            // an explicit denial stops here.
            match wait(&access, ACCESS_WAIT) {
                Err(Wait::Denied) => return NativeOutcome::Disabled,
                Ok(status) if status == GeolocationAccessStatus::Denied => {
                    return NativeOutcome::Disabled;
                }
                _ => {}
            }
        }
        let locator = match Geolocator::new() {
            Ok(locator) => locator,
            Err(error) => return NativeOutcome::Failed(describe(&error)),
        };
        let _ = locator.SetDesiredAccuracy(PositionAccuracy::Default);
        let disabled = |locator: &Geolocator| {
            locator
                .LocationStatus()
                .map_or(false, |status| status == PositionStatus::Disabled)
        };
        let operation = match locator.GetGeopositionAsyncWithAgeAndTimeout(
            TimeSpan {
                Duration: 10 * 60 * TICKS_PER_SECOND,
            },
            TimeSpan {
                Duration: 12 * TICKS_PER_SECOND,
            },
        ) {
            Ok(operation) => operation,
            Err(error) => {
                return match classify(&error) {
                    Wait::Denied => NativeOutcome::Disabled,
                    _ if disabled(&locator) => NativeOutcome::Disabled,
                    _ => NativeOutcome::Failed(describe(&error)),
                };
            }
        };
        match wait(&operation, POSITION_WAIT) {
            Ok(position) => match coordinates(&position) {
                Ok((latitude, longitude, city)) => NativeOutcome::Found {
                    latitude,
                    longitude,
                    city,
                },
                Err(error) => NativeOutcome::Failed(describe(&error)),
            },
            Err(Wait::Denied) => NativeOutcome::Disabled,
            Err(_) if disabled(&locator) => NativeOutcome::Disabled,
            Err(Wait::TimedOut) => NativeOutcome::TimedOut,
            Err(Wait::Failed(detail)) => {
                // The service reports a timeout as a failed operation as well.
                if detail.ends_with("800705B4") {
                    NativeOutcome::TimedOut
                } else {
                    NativeOutcome::Failed(detail)
                }
            }
        }
    }

    fn coordinates(position: &Geoposition) -> Result<(f64, f64, String), Error> {
        let point = position.Coordinate()?.Point()?.Position()?;
        let city = position
            .CivicAddress()
            .and_then(|address| address.City())
            .map(|city| city.to_string())
            .unwrap_or_default();
        Ok((point.Latitude, point.Longitude, city))
    }

    pub(super) fn open_privacy_settings() -> Result<(), String> {
        let result = unsafe {
            ShellExecuteW(
                HWND::default(),
                w!("open"),
                w!("ms-settings:privacy-location"),
                PCWSTR::null(),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            )
        };
        if result.0 <= 32 {
            Err("Windows could not open the location settings.".into())
        } else {
            Ok(())
        }
    }
}

async fn native_location(app: &AppHandle) -> NativeOutcome {
    #[cfg(windows)]
    {
        win_location::read(app).await
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        NativeOutcome::Unsupported
    }
}

/// Opens Windows Settings at Privacy > Location.
#[tauri::command]
pub fn weather_open_location_settings() -> Result<(), String> {
    #[cfg(windows)]
    {
        win_location::open_privacy_settings()
    }
    #[cfg(not(windows))]
    {
        Err("Location settings are available in the Windows app.".into())
    }
}

/// One explicit device-location read, started by the user.
///
/// Chain: Windows Location (with an access check and hard timeouts), then an
/// approximate IP lookup through keyless HTTPS services. Only coarse coordinates
/// (about 1 km) are returned and stored. The caller keeps the last saved city
/// when this fails, so the forecast never disappears because a lookup did.
#[tauri::command]
pub async fn weather_detect_location(app: AppHandle) -> Result<DeviceLocation, LocationFailure> {
    let native = native_location(&app).await;
    if let NativeOutcome::Found {
        latitude,
        longitude,
        city,
    } = &native
    {
        if let Ok(mut location) = coarse_device_location(*latitude, *longitude, city.clone()) {
            if city.trim().is_empty() {
                if let Some((name, admin1, country)) =
                    reverse_geocode(location.latitude, location.longitude).await
                {
                    location.name = name;
                    location.admin1 = admin1;
                    location.country = country;
                }
            }
            return Ok(DeviceLocation {
                location,
                method: METHOD_WINDOWS.into(),
                notice: None,
                can_open_settings: false,
            });
        }
    }
    if let NativeOutcome::Failed(detail) = &native {
        eprintln!("[weather] Windows location failed: {detail}");
    }
    match network_location().await {
        Ok(location) => Ok(DeviceLocation {
            location,
            method: METHOD_NETWORK.into(),
            notice: network_notice(&native),
            can_open_settings: native == NativeOutcome::Disabled,
        }),
        Err(offline) => Err(location_failure(&native, offline)),
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

    let key = location_key(lat, lon, &city, source);
    let (cached, fresh) = cached_snapshot(&key);
    if fresh {
        if let Some(snapshot) = cached {
            return snapshot;
        }
    }

    // One fetch at a time: the island widget, the compact pill and the settings
    // preview can all ask at once, and they should share a single request.
    let _fetching = FETCH_LOCK.lock().await;
    let (cached, fresh) = cached_snapshot(&key);
    if fresh {
        if let Some(snapshot) = cached {
            return snapshot;
        }
    }

    match fetch(lat, lon, &city, source).await {
        Ok(snapshot) => {
            if let Ok(mut cache) = CACHE.lock() {
                *cache = Some((now_millis(), key, snapshot.clone()));
            }
            snapshot
        }
        Err(reason) => {
            // Keep showing the last good forecast, marked as cached, instead of an error.
            if let Some(mut snapshot) = cached {
                snapshot.stale = Some(true);
                snapshot
            } else {
                unavailable(city, reason, source)
            }
        }
    }
}

fn cached_snapshot(key: &str) -> (Option<WeatherSnapshot>, bool) {
    let now = now_millis();
    CACHE.lock().ok().map_or((None, false), |cache| {
        let entry = cache
            .as_ref()
            .filter(|(_, cached_key, _)| cached_key == key);
        let fresh = entry.is_some_and(|(at, _, _)| now.saturating_sub(*at) < CACHE_TTL_MS);
        (entry.map(|(_, _, snapshot)| snapshot.clone()), fresh)
    })
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

    #[test]
    fn ip_services_with_different_shapes_all_parse_to_coarse_locations() {
        let ipwho = serde_json::json!({"success": true, "latitude": -37.8136, "longitude": 144.9631, "city": "Melbourne", "region": "Victoria", "country": "Australia"});
        let location = parse_ipwho(&ipwho).unwrap();
        assert_eq!(location.name, "Melbourne");
        assert_eq!(location.admin1.as_deref(), Some("Victoria"));
        assert_eq!(location.country.as_deref(), Some("Australia"));
        assert_eq!(location.latitude, -37.81);
        assert_eq!(location.longitude, 144.96);

        let geojs = serde_json::json!({"latitude": "28.6139", "longitude": "77.2090", "city": "New Delhi", "country": "India"});
        assert_eq!(parse_geojs(&geojs).unwrap().latitude, 28.61);

        let ipapi = serde_json::json!({"latitude": 51.5, "longitude": -0.12, "city": "", "region": "England", "country_name": "United Kingdom"});
        let location = parse_ipapi(&ipapi).unwrap();
        assert_eq!(location.name, "England");
        assert_eq!(location.admin1, None);
    }

    #[test]
    fn ip_services_that_know_nothing_are_rejected() {
        assert!(parse_ipwho(&serde_json::json!({"success": false, "message": "limit"})).is_none());
        assert!(
            parse_ipapi(&serde_json::json!({"error": true, "reason": "RateLimited"})).is_none()
        );
        assert!(parse_geojs(&serde_json::json!({"latitude": "0", "longitude": "0"})).is_none());
        assert!(parse_geojs(&serde_json::json!({"latitude": "abc", "longitude": "1"})).is_none());
        assert!(parse_geojs(&serde_json::json!({"latitude": 95.0, "longitude": 1.0})).is_none());
        assert!(parse_geojs(&serde_json::json!({})).is_none());
    }

    #[test]
    fn reverse_geocode_prefers_city_then_locality() {
        let value = serde_json::json!({"city": "", "locality": "Fitzroy", "principalSubdivision": "Victoria", "countryName": "Australia"});
        let (name, admin1, country) = parse_reverse_geocode(&value).unwrap();
        assert_eq!(name, "Fitzroy");
        assert_eq!(admin1.as_deref(), Some("Victoria"));
        assert_eq!(country.as_deref(), Some("Australia"));
        assert!(parse_reverse_geocode(&serde_json::json!({"city": " "})).is_none());
    }

    #[test]
    fn failures_tell_the_user_what_to_do() {
        let disabled = location_failure(&NativeOutcome::Disabled, true);
        assert_eq!(disabled.code, "windows_disabled");
        assert!(disabled.can_open_settings);
        assert!(disabled.message.contains("Turn it on"));
        assert_eq!(
            location_failure(&NativeOutcome::TimedOut, true).code,
            "offline"
        );
        assert_eq!(
            location_failure(&NativeOutcome::TimedOut, false).code,
            "timeout"
        );
        assert_eq!(
            location_failure(&NativeOutcome::Unsupported, false).code,
            "unavailable"
        );
        assert!(!location_failure(&NativeOutcome::Unsupported, false).can_open_settings);
    }

    #[test]
    fn fallback_notice_explains_why_the_network_was_used() {
        assert!(network_notice(&NativeOutcome::Disabled)
            .unwrap()
            .contains("off"));
        assert!(network_notice(&NativeOutcome::TimedOut).is_some());
        assert!(network_notice(&NativeOutcome::Unsupported).is_none());
    }

    #[test]
    fn numeric_fields_tolerate_float_encodings() {
        let value = serde_json::json!({
            "current": { "temperature_2m": 20.0, "weather_code": 61.0, "wind_direction_10m": 235.0, "is_day": 0.0 }
        });
        let snapshot = parse_forecast(&value, "Test").unwrap();
        assert_eq!(snapshot.code, 61);
        assert_eq!(snapshot.wind_direction_deg, Some(235));
        assert_eq!(snapshot.is_day, Some(false));
    }

    #[test]
    fn cache_reports_fresh_stale_and_missing_entries() {
        let key = "test-cache-key".to_string();
        assert_eq!(cached_snapshot(&key), (None, false));
        let snapshot = unavailable("Test".into(), "x", MANUAL_SOURCE);
        *CACHE.lock().unwrap() = Some((now_millis(), key.clone(), snapshot.clone()));
        assert_eq!(cached_snapshot(&key), (Some(snapshot.clone()), true));
        *CACHE.lock().unwrap() = Some((
            now_millis().saturating_sub(CACHE_TTL_MS + 1),
            key.clone(),
            snapshot.clone(),
        ));
        assert_eq!(cached_snapshot(&key), (Some(snapshot), false));
        assert_eq!(cached_snapshot("another-key"), (None, false));
        *CACHE.lock().unwrap() = None;
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
