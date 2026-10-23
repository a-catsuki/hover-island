//! App icons for Windows notifications.
//!
//! The listener hands us an `AppInfo` for most toasts, but its logo is missing for many
//! desktop apps, so the lookup runs a chain and never lets a failure repeat every second:
//!
//! 1. the packaged-app logo from `AppInfo.DisplayInfo` (UWP / MSIX apps),
//! 2. the Start menu icon for the AppUserModelId (`shell:AppsFolder\<id>`), which covers
//!    desktop apps registered through a shortcut,
//! 3. the executable's icon when the id is itself a file path.
//!
//! Every result is a `data:image/png;base64,...` string. Hits are cached by app id for
//! the life of the process; misses are retried after a few minutes. When nothing works
//! the caller gets `None` and the interface draws a coloured letter tile.

use base64::Engine;
use std::collections::HashMap;
use std::io::Write;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const ICON_PX: i32 = 96;
const MAX_ICON_BYTES: usize = 256 * 1024;
const MISS_RETRY: Duration = Duration::from_secs(300);
const SHELL_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_CACHE_ENTRIES: usize = 256;

enum Entry {
    Hit(String),
    Miss(Instant),
}

static CACHE: Mutex<Option<HashMap<String, Entry>>> = Mutex::new(None);

/// Icon for one app, cached by AppUserModelId (or display name when Windows gave no id).
pub fn resolve(app_key: &str, info: Option<&windows::ApplicationModel::AppInfo>) -> Option<String> {
    if let Ok(guard) = CACHE.lock() {
        match guard.as_ref().and_then(|cache| cache.get(app_key)) {
            Some(Entry::Hit(icon)) => return Some(icon.clone()),
            Some(Entry::Miss(when)) if when.elapsed() < MISS_RETRY => return None,
            _ => {}
        }
    }
    let icon = info
        .and_then(|info| package_logo(info).ok().flatten())
        .or_else(|| shell_icon(app_key));
    if let Ok(mut guard) = CACHE.lock() {
        let cache = guard.get_or_insert_with(HashMap::new);
        if cache.len() >= MAX_CACHE_ENTRIES {
            cache.clear();
        }
        cache.insert(
            app_key.to_string(),
            match &icon {
                Some(icon) => Entry::Hit(icon.clone()),
                None => Entry::Miss(Instant::now()),
            },
        );
    }
    icon
}

fn data_url(mime: &str, bytes: &[u8]) -> String {
    format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

fn image_mime(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0xFF, 0xD8]) {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF8") {
        "image/gif"
    } else if bytes.starts_with(b"BM") {
        "image/bmp"
    } else {
        "image/png"
    }
}

/* ------------------------------------------------------------ packaged apps */

fn package_logo(
    info: &windows::ApplicationModel::AppInfo,
) -> windows::core::Result<Option<String>> {
    use windows::Foundation::Size;
    use windows::Storage::Streams::DataReader;
    let logo = info.DisplayInfo()?.GetLogo(Size {
        Width: ICON_PX as f32,
        Height: ICON_PX as f32,
    })?;
    let stream = logo.OpenReadAsync()?.get()?;
    let size = stream.Size()? as usize;
    if size == 0 || size > MAX_ICON_BYTES {
        return Ok(None);
    }
    let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0)?)?;
    let mut bytes: Vec<u8> = Vec::with_capacity(size);
    let mut remaining = size;
    while remaining > 0 {
        let want = remaining.min(64 * 1024) as u32;
        let loaded = reader.LoadAsync(want)?.get()? as usize;
        if loaded == 0 {
            break;
        }
        let start = bytes.len();
        bytes.resize(start + loaded, 0);
        reader.ReadBytes(&mut bytes[start..])?;
        remaining = remaining.saturating_sub(loaded);
    }
    if bytes.is_empty() {
        return Ok(None);
    }
    Ok(Some(data_url(image_mime(&bytes), &bytes)))
}

/* --------------------------------------------------------------- shell icon */

/// AppUserModelIds of classic desktop apps are sometimes just an executable path.
fn looks_like_executable_path(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.len() > 4
        && (lower.ends_with(".exe") || lower.ends_with(".lnk"))
        && (lower.contains(":\\") || lower.starts_with("\\\\"))
}

fn shell_parsing_name(app_key: &str) -> Option<String> {
    let trimmed = app_key.trim();
    if trimmed.is_empty() || trimmed.len() > 512 || trimmed.chars().any(|ch| ch.is_control()) {
        return None;
    }
    if looks_like_executable_path(trimmed) {
        return std::path::Path::new(trimmed)
            .is_file()
            .then(|| trimmed.to_string());
    }
    // Display names (no id from Windows) never resolve in the Apps folder.
    if trimmed.contains(' ') && !trimmed.contains('!') && !trimmed.contains('.') {
        return None;
    }
    Some(format!("shell:AppsFolder\\{trimmed}"))
}

/// Runs the Shell lookup on a short-lived STA thread so a slow or hung icon handler can
/// never stall the notification poll.
fn shell_icon(app_key: &str) -> Option<String> {
    let parsing_name = shell_parsing_name(app_key)?;
    shell_icon_sized(&parsing_name, ICON_PX, SHELL_TIMEOUT)
}

/// Icon (PNG data URL) for a Shell parsing name such as a .lnk or .exe path
/// or `shell:AppsFolder\<AUMID>`, at roughly `px` pixels. Runs on its own STA thread and gives
/// up after `timeout`, so it can never hang the caller. Callers must only pass names they
/// built themselves from a trusted list.
pub fn shell_icon_sized(parsing_name: &str, px: i32, timeout: Duration) -> Option<String> {
    let parsing_name = parsing_name.to_string();
    let px = px.clamp(16, 256);
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .name("hover-island-app-icon".into())
        .spawn(move || {
            let _ = sender.send(platform::shell_icon_png(&parsing_name, px));
        })
        .ok()?;
    let png = receiver.recv_timeout(timeout).ok()??;
    if png.len() > MAX_ICON_BYTES {
        return None;
    }
    Some(data_url("image/png", &png))
}

mod platform {
    use super::{encode_png, rgba_from_bgra};
    use std::ffi::c_void;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::SIZE;
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP,
    };
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::{
        IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_BIGGERSIZEOK, SIIGBF_ICONONLY,
    };

    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    pub(super) fn shell_icon_png(parsing_name: &str, px: i32) -> Option<Vec<u8>> {
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.ok()?;
        let _apartment = Apartment;
        let wide: Vec<u16> = parsing_name
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let factory: IShellItemImageFactory =
            unsafe { SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None) }.ok()?;
        let bitmap = unsafe {
            factory.GetImage(
                SIZE { cx: px, cy: px },
                SIIGBF_BIGGERSIZEOK | SIIGBF_ICONONLY,
            )
        }
        .ok()?;
        let png = unsafe { bitmap_to_png(bitmap) };
        let _ = unsafe { DeleteObject(bitmap) };
        png
    }

    unsafe fn bitmap_to_png(bitmap: HBITMAP) -> Option<Vec<u8>> {
        let mut info = BITMAP::default();
        if GetObjectW(
            bitmap,
            std::mem::size_of::<BITMAP>() as i32,
            Some((&mut info as *mut BITMAP).cast::<c_void>()),
        ) == 0
        {
            return None;
        }
        let width = info.bmWidth;
        let height = info.bmHeight.abs();
        if width <= 0 || height <= 0 || width > 512 || height > 512 {
            return None;
        }
        let mut header = BITMAPINFO::default();
        header.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            // Negative height asks for top-down rows, which is what PNG expects.
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        };
        let mut pixels = vec![0u8; width as usize * height as usize * 4];
        let dc = CreateCompatibleDC(None);
        if dc.is_invalid() {
            return None;
        }
        let rows = GetDIBits(
            dc,
            bitmap,
            0,
            height as u32,
            Some(pixels.as_mut_ptr().cast::<c_void>()),
            &mut header,
            DIB_RGB_COLORS,
        );
        let _ = DeleteDC(dc);
        if rows == 0 {
            return None;
        }
        let rgba = rgba_from_bgra(&pixels)?;
        encode_png(width as u32, height as u32, &rgba)
    }
}

/// BGRA from a Windows bitmap to straight-alpha RGBA. The Shell hands back premultiplied
/// pixels for icons with alpha and an all-zero alpha channel for icons without it.
fn rgba_from_bgra(bgra: &[u8]) -> Option<Vec<u8>> {
    if bgra.is_empty() || bgra.len() % 4 != 0 {
        return None;
    }
    let any_alpha = bgra.chunks_exact(4).any(|px| px[3] != 0);
    let any_color = bgra.chunks_exact(4).any(|px| px[0] | px[1] | px[2] != 0);
    if !any_alpha && !any_color {
        return None;
    }
    // Premultiplied pixels never have a colour channel above alpha.
    let premultiplied = any_alpha
        && bgra
            .chunks_exact(4)
            .all(|px| px[0] <= px[3] && px[1] <= px[3] && px[2] <= px[3]);
    let mut out = Vec::with_capacity(bgra.len());
    for px in bgra.chunks_exact(4) {
        let (b, g, r, a) = (px[0], px[1], px[2], px[3]);
        if !any_alpha {
            out.extend_from_slice(&[r, g, b, 255]);
        } else if premultiplied && a != 0 && a != 255 {
            let un = |c: u8| ((c as u32 * 255 + a as u32 / 2) / a as u32).min(255) as u8;
            out.extend_from_slice(&[un(r), un(g), un(b), a]);
        } else {
            out.extend_from_slice(&[r, g, b, a]);
        }
    }
    Some(out)
}

fn png_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let mut crc = flate2::Crc::new();
    crc.update(kind);
    crc.update(data);
    out.extend_from_slice(&crc.sum().to_be_bytes());
}

/// Minimal 8-bit RGBA PNG writer (no extra dependency; `flate2` is already in the build).
fn encode_png(width: u32, height: u32, rgba: &[u8]) -> Option<Vec<u8>> {
    let row = width as usize * 4;
    if row == 0 || rgba.len() != row * height as usize {
        return None;
    }
    let mut raw = Vec::with_capacity((row + 1) * height as usize);
    for line in rgba.chunks_exact(row) {
        raw.push(0); // filter type: none
        raw.extend_from_slice(line);
    }
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::fast());
    encoder.write_all(&raw).ok()?;
    let compressed = encoder.finish().ok()?;
    let mut out = Vec::with_capacity(compressed.len() + 64);
    out.extend_from_slice(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
    let mut header = Vec::with_capacity(13);
    header.extend_from_slice(&width.to_be_bytes());
    header.extend_from_slice(&height.to_be_bytes());
    header.extend_from_slice(&[8, 6, 0, 0, 0]); // 8-bit RGBA, no interlace
    png_chunk(&mut out, b"IHDR", &header);
    png_chunk(&mut out, b"IDAT", &compressed);
    png_chunk(&mut out, b"IEND", &[]);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::{encode_png, looks_like_executable_path, rgba_from_bgra, shell_parsing_name};
    use std::io::Read;

    #[test]
    fn png_writer_produces_a_decodable_image() {
        let rgba = [255u8, 0, 0, 255, 0, 255, 0, 128];
        let png = encode_png(2, 1, &rgba).expect("encode");
        assert_eq!(&png[..8], &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
        assert_eq!(&png[12..16], b"IHDR");
        assert_eq!(u32::from_be_bytes([png[16], png[17], png[18], png[19]]), 2);
        assert_eq!(&png[png.len() - 8..png.len() - 4], b"IEND");
        // The IDAT payload inflates back to one filter byte plus the pixels.
        let idat_len = u32::from_be_bytes([png[33], png[34], png[35], png[36]]) as usize;
        assert_eq!(&png[37..41], b"IDAT");
        let mut raw = Vec::new();
        flate2::read::ZlibDecoder::new(&png[41..41 + idat_len])
            .read_to_end(&mut raw)
            .expect("inflate");
        assert_eq!(raw.len(), 1 + rgba.len());
        assert_eq!(&raw[1..], &rgba);
        assert!(encode_png(2, 2, &rgba).is_none());
    }

    #[test]
    fn premultiplied_pixels_are_restored_and_opaque_icons_get_full_alpha() {
        // One half-transparent white pixel stored premultiplied (BGRA).
        let premul = [128u8, 128, 128, 128, 0, 0, 0, 0];
        let straight = rgba_from_bgra(&premul).expect("convert");
        assert_eq!(&straight[..4], &[255, 255, 255, 128]);
        // No alpha channel at all: colours are kept and made opaque.
        let flat = rgba_from_bgra(&[10, 20, 30, 0]).expect("convert");
        assert_eq!(flat, vec![30, 20, 10, 255]);
        // Entirely empty bitmaps are rejected so a blank tile is never produced.
        assert!(rgba_from_bgra(&[0, 0, 0, 0]).is_none());
        // Straight alpha (colour above alpha) is passed through untouched.
        let pass = rgba_from_bgra(&[200, 100, 50, 100]).expect("convert");
        assert_eq!(pass, vec![50, 100, 200, 100]);
    }

    #[test]
    fn shell_names_are_only_built_for_plausible_ids() {
        assert!(looks_like_executable_path("C:\\Apps\\Chat\\chat.exe"));
        assert!(!looks_like_executable_path("Microsoft.WindowsTerminal_8wekyb3d8bbwe!App"));
        assert_eq!(
            shell_parsing_name("Microsoft.WindowsTerminal_8wekyb3d8bbwe!App").as_deref(),
            Some("shell:AppsFolder\\Microsoft.WindowsTerminal_8wekyb3d8bbwe!App")
        );
        assert_eq!(shell_parsing_name("Microsoft Teams"), None);
        assert_eq!(shell_parsing_name(""), None);
        assert_eq!(shell_parsing_name("bad\nname"), None);
    }
}
