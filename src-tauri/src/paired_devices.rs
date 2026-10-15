//! Small persistent trust store and short-lived in-memory phone pairing flow.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub const MAX_PAIRED_DEVICES: usize = 16;
pub const MAX_PENDING_PAIRS: usize = 4;
const PAIR_TTL: Duration = Duration::from_secs(120);
const MAX_STORE_BYTES: u64 = 16 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedDeviceView {
    pub id: String,
    pub name: String,
    pub last_seen: Option<u64>,
    pub online: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingPairView {
    pub id: String,
    pub name: String,
    pub code: String,
    pub expires_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingStatus {
    pub devices: Vec<PairedDeviceView>,
    pub pending: Vec<PendingPairView>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PairRequestCreated {
    pub id: String,
    pub name: String,
    pub code: String,
    pub expires_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairedDevice {
    id: String,
    name: String,
    cookie_hash: String,
    last_seen: Option<u64>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedDeviceStore {
    devices: Vec<PairedDevice>,
    #[serde(skip)]
    path: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PairState {
    Pending,
    Approved,
    Denied,
}

struct PendingPair {
    public: PairRequestCreated,
    cookie: String,
    expires: Instant,
    remote_ip: IpAddr,
    state: PairState,
}

#[derive(Default)]
pub struct PendingPairs {
    entries: Vec<PendingPair>,
    completed: std::collections::HashMap<String, (PairState, Instant)>,
}

impl PairedDeviceStore {
    pub fn load(path: PathBuf) -> Result<Self, String> {
        let mut store = match fs::metadata(&path) {
            Ok(metadata) if metadata.len() > MAX_STORE_BYTES => {
                return Err("The saved phone list is larger than expected.".into());
            }
            Ok(_) => {
                let bytes = fs::read(&path)
                    .map_err(|error| format!("Could not read saved phones: {error}"))?;
                serde_json::from_slice::<Self>(&bytes)
                    .map_err(|_| "The saved phone list could not be read safely.".to_string())?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Self::default(),
            Err(error) => return Err(format!("Could not read saved phones: {error}")),
        };
        if store.devices.len() > MAX_PAIRED_DEVICES
            || store.devices.iter().any(|device| {
                !valid_device_id(&device.id)
                    || safe_device_name(&device.name).as_deref() != Some(device.name.as_str())
                    || !valid_hash(&device.cookie_hash)
            })
        {
            return Err("The saved phone list contains an invalid entry.".into());
        }
        store.path = Some(path);
        Ok(store)
    }

    pub fn views(&self, now_ms: u64) -> Vec<PairedDeviceView> {
        let mut devices = self
            .devices
            .iter()
            .map(|device| PairedDeviceView {
                id: device.id.clone(),
                name: device.name.clone(),
                last_seen: device.last_seen,
                online: device
                    .last_seen
                    .is_some_and(|seen| now_ms.saturating_sub(seen) <= 30_000),
            })
            .collect::<Vec<_>>();
        devices.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        devices
    }

    pub fn authenticated_id(&self, cookie: &str) -> Option<String> {
        if !valid_cookie(cookie) {
            return None;
        }
        let digest = hash_cookie(cookie);
        self.devices
            .iter()
            .find(|device| constant_time_equal(device.cookie_hash.as_bytes(), digest.as_bytes()))
            .map(|device| device.id.clone())
    }

    pub fn remember(&mut self, id: String, name: String, cookie: &str) -> Result<(), String> {
        let name = safe_device_name(&name)
            .ok_or_else(|| "Choose a phone name between 1 and 30 characters.".to_string())?;
        if !valid_device_id(&id) || !valid_cookie(cookie) {
            return Err("The phone pairing details are invalid.".into());
        }
        if !self.devices.iter().any(|device| device.id == id)
            && self.devices.len() >= MAX_PAIRED_DEVICES
        {
            return Err(
                "You can remember up to 16 phones. Remove one before adding another.".into(),
            );
        }
        let previous = self.devices.clone();
        self.devices.retain(|device| device.id != id);
        self.devices.push(PairedDevice {
            id,
            name,
            cookie_hash: hash_cookie(cookie),
            last_seen: None,
        });
        if let Err(error) = self.save() {
            self.devices = previous;
            return Err(error);
        }
        Ok(())
    }

    pub fn touch(&mut self, id: &str, now_ms: u64) -> Result<(), String> {
        let Some(device) = self.devices.iter_mut().find(|device| device.id == id) else {
            return Ok(());
        };
        if device
            .last_seen
            .is_some_and(|seen| now_ms.saturating_sub(seen) < 10_000)
        {
            return Ok(());
        }
        device.last_seen = Some(now_ms);
        self.save()
    }

    pub fn remove(&mut self, id: &str) -> Result<bool, String> {
        let previous = self.devices.clone();
        let old_len = self.devices.len();
        self.devices.retain(|device| device.id != id);
        if old_len == self.devices.len() {
            return Ok(false);
        }
        if let Err(error) = self.save() {
            self.devices = previous;
            return Err(error);
        }
        Ok(true)
    }

    fn save(&self) -> Result<(), String> {
        let Some(path) = &self.path else {
            return Err("Saved phone storage is unavailable.".into());
        };
        let bytes =
            serde_json::to_vec(self).map_err(|_| "Could not save the phone list.".to_string())?;
        if bytes.len() as u64 > MAX_STORE_BYTES {
            return Err("The saved phone list is full.".into());
        }
        let parent = path
            .parent()
            .ok_or_else(|| "Saved phone storage is unavailable.".to_string())?;
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create saved phone storage: {error}"))?;
        let temp = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4().simple()));
        fs::write(&temp, bytes).map_err(|error| format!("Could not save phones: {error}"))?;
        let result = replace_store(&temp, path);
        if result.is_err() {
            let _ = fs::remove_file(&temp);
        }
        result.map_err(|error| format!("Could not save phones: {error}"))
    }
}

#[cfg(windows)]
fn replace_store(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    if unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), 0x1 | 0x8) } == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_store(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

impl PendingPairs {
    pub fn request(
        &mut self,
        name: &str,
        cookie: String,
        remote_ip: IpAddr,
        now: Instant,
        now_ms: u64,
    ) -> Result<PairRequestCreated, String> {
        self.prune(now);
        if self.entries.len() >= MAX_PENDING_PAIRS {
            return Err(
                "There are already four phone requests. Finish or wait for one to expire.".into(),
            );
        }
        let name = safe_device_name(name)
            .ok_or_else(|| "Choose a phone name between 1 and 30 characters.".to_string())?;
        if !valid_cookie(&cookie) {
            return Err("Could not create a secure phone pairing.".into());
        }
        let id = uuid::Uuid::new_v4().simple().to_string();
        let code = format!("{:06}", (uuid::Uuid::new_v4().as_u128() % 1_000_000) as u32);
        let public = PairRequestCreated {
            id,
            name,
            code,
            expires_at: now_ms.saturating_add(PAIR_TTL.as_millis() as u64),
        };
        self.entries.push(PendingPair {
            public: public.clone(),
            cookie,
            expires: now + PAIR_TTL,
            remote_ip,
            state: PairState::Pending,
        });
        Ok(public)
    }

    pub fn views(&mut self, now: Instant) -> Vec<PendingPairView> {
        self.prune(now);
        self.entries
            .iter()
            .filter(|entry| entry.state == PairState::Pending)
            .map(|entry| PendingPairView {
                id: entry.public.id.clone(),
                name: entry.public.name.clone(),
                code: entry.public.code.clone(),
                expires_at: entry.public.expires_at,
            })
            .collect()
    }

    pub fn decide(&mut self, id: &str, allow: bool, now: Instant) -> Result<(), String> {
        self.prune(now);
        let entry = self
            .entries
            .iter_mut()
            .find(|entry| entry.public.id == id)
            .ok_or_else(|| "That phone request has expired.".to_string())?;
        if entry.state != PairState::Pending {
            return Err("That phone request was already decided.".into());
        }
        entry.state = if allow {
            PairState::Approved
        } else {
            PairState::Denied
        };
        if !allow {
            entry.cookie.clear();
            self.entries.retain(|entry| entry.public.id != id);
            self.completed
                .insert(id.to_string(), (PairState::Denied, now + PAIR_TTL));
        }
        Ok(())
    }

    pub fn state(&mut self, id: &str, remote_ip: IpAddr, now: Instant) -> String {
        self.prune(now);
        match self
            .entries
            .iter()
            .find(|entry| entry.public.id == id && entry.remote_ip == remote_ip)
            .map(|entry| entry.state)
            .or_else(|| self.completed.get(id).map(|(state, _)| *state))
        {
            Some(PairState::Pending) => "pending",
            Some(PairState::Approved) => "approved",
            Some(PairState::Denied) => "denied",
            None => "expired",
        }
        .into()
    }

    pub fn claim(
        &mut self,
        id: &str,
        remote_ip: IpAddr,
        now: Instant,
    ) -> Result<(PairRequestCreated, String), String> {
        self.prune(now);
        let index = self
            .entries
            .iter()
            .position(|entry| entry.public.id == id && entry.remote_ip == remote_ip)
            .ok_or_else(|| "That phone request has expired.".to_string())?;
        if self.entries[index].state != PairState::Approved {
            return Err("This phone has not been approved yet.".into());
        }
        let entry = self.entries.remove(index);
        Ok((entry.public, entry.cookie))
    }

    fn prune(&mut self, now: Instant) {
        self.entries.retain(|entry| entry.expires > now);
        self.completed.retain(|_, (_, expires)| *expires > now);
    }
}

pub fn new_cookie() -> String {
    let entropy = format!(
        "{}{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    hash_cookie(&entropy)
}

pub fn valid_cookie(cookie: &str) -> bool {
    cookie.len() == 64 && cookie.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub fn hash_cookie(cookie: &str) -> String {
    let digest = Sha256::digest(cookie.as_bytes());
    digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<Vec<_>>()
        .join("")
}

pub fn safe_device_name(name: &str) -> Option<String> {
    let cleaned = name.chars().filter(|c| !c.is_control()).collect::<String>();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() || cleaned.chars().count() > 30 {
        return None;
    }
    Some(cleaned.to_string())
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}
fn valid_device_id(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}
fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .fold(0u8, |diff, (a, b)| diff | (*a ^ *b))
            == 0
}

pub fn storage_path(app_data: &Path) -> PathBuf {
    app_data.join("paired-phones.json")
}

#[cfg(test)]
mod tests {
    use super::{
        new_cookie, safe_device_name, storage_path, valid_cookie, PairedDeviceStore, PendingPairs,
    };
    use std::net::{IpAddr, Ipv4Addr};
    use std::time::{Duration, Instant};

    fn phone_ip() -> IpAddr {
        Ipv4Addr::new(192, 168, 1, 42).into()
    }

    #[test]
    fn cookies_are_opaque_64_hex_chars_and_unknown_cookies_do_not_authenticate() {
        let cookie = new_cookie();
        assert!(valid_cookie(&cookie));
        assert_eq!(cookie.len(), 64);
        assert_eq!(PairedDeviceStore::default().authenticated_id(&cookie), None);
        assert!(!valid_cookie("short"));
    }

    #[test]
    fn pairing_requires_allow_and_expires_after_two_minutes() {
        let now = Instant::now();
        let mut pending = PendingPairs::default();
        let request = pending
            .request("  My phone  ", new_cookie(), phone_ip(), now, 10)
            .unwrap();
        assert_eq!(request.name, "My phone");
        assert_eq!(pending.state(&request.id, phone_ip(), now), "pending");
        assert!(pending
            .claim(&request.id, Ipv4Addr::LOCALHOST.into(), now)
            .is_err());
        assert!(pending.claim(&request.id, phone_ip(), now).is_err());
        pending.decide(&request.id, true, now).unwrap();
        assert_eq!(pending.state(&request.id, phone_ip(), now), "approved");
        let (_, cookie) = pending.claim(&request.id, phone_ip(), now).unwrap();
        assert!(valid_cookie(&cookie));
        assert_eq!(pending.state(&request.id, phone_ip(), now), "expired");

        let expiring = pending
            .request("Phone", new_cookie(), phone_ip(), now, 10)
            .unwrap();
        assert_eq!(
            pending.state(&expiring.id, phone_ip(), now + Duration::from_secs(121)),
            "expired"
        );
    }

    #[test]
    fn rejected_pairing_never_releases_its_cookie_and_device_names_are_bounded() {
        let now = Instant::now();
        let mut pending = PendingPairs::default();
        let request = pending
            .request("Phone", new_cookie(), phone_ip(), now, 10)
            .unwrap();
        pending.decide(&request.id, false, now).unwrap();
        assert_eq!(pending.state(&request.id, phone_ip(), now), "denied");
        assert!(pending.claim(&request.id, phone_ip(), now).is_err());
        assert_eq!(safe_device_name("  "), None);
        assert_eq!(safe_device_name(&"x".repeat(31)), None);
        assert_eq!(safe_device_name("Phone\nA").as_deref(), Some("PhoneA"));
    }

    #[test]
    fn pending_pair_queue_is_bounded_and_denials_free_a_slot() {
        let now = Instant::now();
        let mut pending = PendingPairs::default();
        let requests = (0..4)
            .map(|_| {
                pending
                    .request("Phone", new_cookie(), phone_ip(), now, 10)
                    .unwrap()
            })
            .collect::<Vec<_>>();
        assert!(pending
            .request("Fifth", new_cookie(), phone_ip(), now, 10)
            .is_err());
        pending.decide(&requests[0].id, false, now).unwrap();
        assert!(pending
            .request("Replacement", new_cookie(), phone_ip(), now, 10)
            .is_ok());
    }

    #[test]
    fn saved_device_authentication_uses_hashes_and_revoke_removes_access() {
        let root = std::env::temp_dir().join(format!("hover-pair-test-{}", uuid::Uuid::new_v4()));
        let mut store = PairedDeviceStore::load(storage_path(&root)).unwrap();
        let cookie = new_cookie();
        let id = uuid::Uuid::new_v4().simple().to_string();
        store.remember(id.clone(), "Phone".into(), &cookie).unwrap();
        assert_ne!(store.devices[0].cookie_hash, cookie);
        drop(store);
        let mut reloaded = PairedDeviceStore::load(storage_path(&root)).unwrap();
        assert_eq!(reloaded.authenticated_id(&cookie), Some(id.clone()));
        assert!(reloaded.remove(&id).unwrap());
        assert_eq!(reloaded.authenticated_id(&cookie), None);
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn failed_store_replacement_preserves_saved_and_in_memory_devices() {
        use std::io::{Read, Seek, SeekFrom};
        use std::os::windows::fs::OpenOptionsExt;

        let root = std::env::temp_dir().join(format!("hover-pair-test-{}", uuid::Uuid::new_v4()));
        let path = storage_path(&root);
        let mut store = PairedDeviceStore::load(path.clone()).unwrap();
        let original_cookie = new_cookie();
        let original_id = uuid::Uuid::new_v4().simple().to_string();
        store
            .remember(
                original_id.clone(),
                "Original phone".into(),
                &original_cookie,
            )
            .unwrap();
        let original_bytes = std::fs::read(&path).unwrap();

        let mut locked_file = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path)
            .unwrap();
        assert!(store.remove(&original_id).is_err());
        let replacement_cookie = new_cookie();
        let replacement_id = uuid::Uuid::new_v4().simple().to_string();
        assert!(store
            .remember(
                replacement_id.clone(),
                "Replacement phone".into(),
                &replacement_cookie,
            )
            .is_err());

        assert_eq!(
            store.authenticated_id(&original_cookie),
            Some(original_id.clone())
        );
        assert_eq!(store.authenticated_id(&replacement_cookie), None);
        let mut locked_bytes = Vec::new();
        locked_file.seek(SeekFrom::Start(0)).unwrap();
        locked_file.read_to_end(&mut locked_bytes).unwrap();
        assert_eq!(locked_bytes, original_bytes);

        drop(locked_file);
        assert_eq!(std::fs::read(&path).unwrap(), original_bytes);
        let reloaded = PairedDeviceStore::load(path).unwrap();
        assert_eq!(
            reloaded.authenticated_id(&original_cookie),
            Some(original_id)
        );
        assert_eq!(reloaded.authenticated_id(&replacement_cookie), None);
        let _ = std::fs::remove_dir_all(root);
    }
}
