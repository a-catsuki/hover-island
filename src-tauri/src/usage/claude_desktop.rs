//! Read Claude Desktop's existing, account-bound Code credential on Windows.
//! Nothing is modified or refreshed; the caller only uses Anthropic's usage endpoint.

use serde_json::Value;

fn select_token(cache: &Value, account: &str, now: u64) -> Option<String> {
    if account.is_empty() {
        return None;
    }
    cache
        .as_object()?
        .iter()
        .filter_map(|(key, entry)| {
            let (owner, spec) = key.strip_prefix("acct:")?.split_once('|')?;
            if !owner.eq_ignore_ascii_case(account) || !spec.contains(":https://api.anthropic.com:")
            {
                return None;
            }
            let expires = entry.get("expiresAt")?.as_u64()?;
            let token = entry.get("token")?.as_str()?;
            (expires > now && !token.is_empty()).then_some((expires, token))
        })
        .max_by_key(|(expires, _)| *expires)
        .map(|(_, token)| token.to_string())
}

#[cfg(windows)]
pub(super) fn token(now: u64) -> Option<String> {
    use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
    use base64::Engine;
    use zeroize::{Zeroize, Zeroizing};
    fn bounded_json(path: &std::path::Path) -> Option<Value> {
        if std::fs::metadata(path).ok()?.len() > 1024 * 1024 {
            return None;
        }
        serde_json::from_slice(&std::fs::read(path).ok()?).ok()
    }
    fn scrub(value: &mut Value) {
        match value {
            Value::String(text) => text.zeroize(),
            Value::Array(items) => items.iter_mut().for_each(scrub),
            Value::Object(items) => items.values_mut().for_each(scrub),
            _ => {}
        }
    }
    let mut profiles = Vec::new();
    if let Some(local) = dirs::data_local_dir() {
        profiles.push(local.join("Claude-Data").join("claude_pzs8sxrjxfjjc"));
    }
    if let Some(roaming) = dirs::config_dir() {
        profiles.push(roaming.join("Claude"));
    }
    for profile in profiles {
        let Some(config) = bounded_json(&profile.join("config.json")) else {
            continue;
        };
        let Some(account) = config.get("lastKnownAccountUuid").and_then(Value::as_str) else {
            continue;
        };
        let Some(encoded) = config.get("oauth:tokenCacheV2").and_then(Value::as_str) else {
            continue;
        };
        let Some(local_state) = bounded_json(&profile.join("Local State")) else {
            continue;
        };
        let Some(wrapped) = local_state
            .pointer("/os_crypt/encrypted_key")
            .and_then(Value::as_str)
            .and_then(|key| base64::engine::general_purpose::STANDARD.decode(key).ok())
        else {
            continue;
        };
        let Some(wrapped) = wrapped.strip_prefix(b"DPAPI") else {
            continue;
        };
        let Some(key) = unprotect_key(wrapped).map(Zeroizing::new) else {
            continue;
        };
        let Ok(encrypted) = base64::engine::general_purpose::STANDARD.decode(encoded) else {
            continue;
        };
        // Windows safeStorage: v10, 12-byte nonce, authenticated ciphertext + tag.
        if encrypted.len() < 31 || !encrypted.starts_with(b"v10") {
            continue;
        }
        let Ok(cipher) = Aes256Gcm::new_from_slice(&key) else {
            continue;
        };
        let Ok(clear) = cipher.decrypt(Nonce::from_slice(&encrypted[3..15]), &encrypted[15..])
        else {
            continue;
        };
        let clear = Zeroizing::new(clear);
        let Ok(mut cache) = serde_json::from_slice::<Value>(&clear) else {
            continue;
        };
        let token = select_token(&cache, account, now);
        scrub(&mut cache);
        if token.is_some() {
            return token;
        }
    }
    None
}

#[cfg(windows)]
fn unprotect_key(input: &[u8]) -> Option<Vec<u8>> {
    #[repr(C)]
    struct Blob {
        size: u32,
        data: *mut u8,
    }
    #[link(name = "Crypt32")]
    extern "system" {
        fn CryptUnprotectData(
            input: *const Blob,
            description: *mut *mut u16,
            entropy: *const Blob,
            reserved: *mut std::ffi::c_void,
            prompt: *mut std::ffi::c_void,
            flags: u32,
            output: *mut Blob,
        ) -> i32;
    }
    #[link(name = "Kernel32")]
    extern "system" {
        fn LocalFree(memory: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
    }
    let input = Blob {
        size: u32::try_from(input.len()).ok()?,
        data: input.as_ptr() as *mut u8,
    };
    let mut output = Blob {
        size: 0,
        data: std::ptr::null_mut(),
    };
    let ok = unsafe {
        CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            1,
            &mut output,
        )
    };
    if ok == 0 || output.data.is_null() {
        return None;
    }
    let bytes = unsafe { std::slice::from_raw_parts_mut(output.data, output.size as usize) };
    let key = bytes.to_vec();
    use zeroize::Zeroize;
    bytes.zeroize();
    unsafe {
        LocalFree(output.data.cast());
    }
    Some(key)
}

#[cfg(not(windows))]
pub(super) fn token(_: u64) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn desktop_token_must_match_active_account_host_and_expiry() {
        let cache = json!({
            "acct:other|client:org:https://api.anthropic.com:user:profile": {"token":"other", "expiresAt":900},
            "acct:active|client:org:https://gateway.invalid:user:profile": {"token":"gateway", "expiresAt":900},
            "acct:active|client:org:https://api.anthropic.com:user:profile": {"token":"expired", "expiresAt":10},
            "acct:active|client:org:https://api.anthropic.com:user:inference": {"token":"valid", "expiresAt":900}
        });
        assert_eq!(
            select_token(&cache, "active", 100).as_deref(),
            Some("valid")
        );
        assert_eq!(select_token(&cache, "", 100), None);
        assert_eq!(select_token(&cache, "active", 901), None);
    }
}
