//! Honest capability reporting for Apple's AWDL-based AirDrop on Windows.
//!
//! The Wi-Fi chipset in this laptop (Intel AX211, PCI ID 8086:51f0) is not a
//! currently working Omdrop Owl target. Upstream's AX211 report identifies
//! firmware limitations even on Linux; Windows also does not expose monitor
//! mode on this installation. This probe reports those blockers instead of
//! advertising app-layer codecs as a working AirDrop implementation.

use serde::Serialize;
#[cfg(target_os = "windows")]
use std::path::Path;
#[cfg(target_os = "windows")]
use std::process::{Command, Stdio};
#[cfg(target_os = "windows")]
use std::time::{Duration, Instant};

/// The upstream profile marks AX211 untested and its matching card report
/// documents firmware limitations. Chipset family alone is not proof of
/// support.
const AX211_OMDROP_OWL_VERIFIED_SUPPORTED: bool = false;

#[path = "airdrop_protocol.rs"]
pub mod protocol;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AirDropCapability {
    /// The actual Apple transport. This is not LocalSend or another substitute.
    pub protocol: &'static str,
    pub backend: &'static str,
    pub adapter: String,
    pub hardware_supported_by_omdrop_owl: bool,
    pub windows_monitor_mode: Option<bool>,
    pub npcap_wlan_helper_present: bool,
    /// True only when this process can use a real AirDrop radio backend now.
    pub ready: bool,
    pub reason: String,
}

/// Read-only capability probe. It does not switch radio modes, install a
/// driver, start discovery, or alter the current Wi-Fi connection.
#[tauri::command]
pub async fn airdrop_capability() -> AirDropCapability {
    #[cfg(target_os = "windows")]
    {
        let wlan_capabilities = tauri::async_runtime::spawn_blocking(windows_wlan_capabilities)
            .await
            .ok()
            .flatten();
        let monitor_mode = wlan_capabilities.as_deref().and_then(parse_monitor_mode);
        let npcap_helper = npcap_wlan_helper_present();

        let reason = match monitor_mode {
            Some(true) => format!(
                "Windows reports monitor mode, but this app has no Windows OWL/AWDL backend. Omdrop Owl lists AX211 as untested; an upstream AX211 report found firmware behavior that blocks AWDL on that tested variant. This PC's exact AX211 variant has not been verified working. Npcap helper present: {npcap_helper}."
            ),
            Some(false) => format!(
                "Windows reports monitor mode unsupported for this AX211 driver. Omdrop Owl lists AX211 as untested; an upstream report for a different AX211 variant found firmware behavior that blocks AWDL. This PC's exact AX211 variant has not been verified working, and this app has no Windows AWDL backend. AirDrop discovery and transfer are unavailable. Npcap helper present: {npcap_helper}."
            ),
            None => "Windows did not provide a readable WLAN monitor-mode result. Omdrop Owl lists AX211 as untested, and this app has no Windows AWDL backend; AirDrop readiness cannot be established.".to_string(),
        };

        AirDropCapability {
            protocol: "Apple AirDrop over AWDL",
            backend: "Omdrop + Omdrop Owl / OWL",
            adapter: "Intel Wi-Fi 6E AX211 (PCI 8086:51f0)".to_string(),
            hardware_supported_by_omdrop_owl: AX211_OMDROP_OWL_VERIFIED_SUPPORTED,
            windows_monitor_mode: monitor_mode,
            npcap_wlan_helper_present: npcap_helper,
            ready: false,
            reason,
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        AirDropCapability {
            protocol: "Apple AirDrop over AWDL",
            backend: "Omdrop + Omdrop Owl / OWL",
            adapter: "Unknown".to_string(),
            hardware_supported_by_omdrop_owl: AX211_OMDROP_OWL_VERIFIED_SUPPORTED,
            windows_monitor_mode: None,
            npcap_wlan_helper_present: false,
            ready: false,
            reason: "This capability probe currently describes the Windows host. A Linux Omdrop Owl/OWL runtime and a supported radio must be detected before AirDrop can be reported ready.".to_string(),
        }
    }
}

#[cfg(target_os = "windows")]
fn windows_wlan_capabilities() -> Option<String> {
    // Use the fixed system executable, never a shell or caller-provided command.
    let system_root = std::env::var_os("SystemRoot")?;
    let netsh = Path::new(&system_root).join("System32").join("netsh.exe");
    let mut child = Command::new(netsh)
        .args(["wlan", "show", "wirelesscapabilities"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match child.try_wait().ok()? {
            Some(status) if status.success() => break,
            Some(_) => return None,
            None => {}
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let output = child.wait_with_output().ok()?;
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    Some(text)
}

#[cfg(target_os = "windows")]
fn npcap_wlan_helper_present() -> bool {
    std::env::var_os("SystemRoot")
        .map(|root| Path::new(&root).to_path_buf())
        .map(|root| {
            root.join("System32")
                .join("Npcap")
                .join("WlanHelper.exe")
                .is_file()
        })
        .unwrap_or(false)
}

/// Interpret the English `netsh wlan show wirelesscapabilities` monitor-mode
/// field. Unknown/localized output remains `None` and therefore cannot produce
/// a false positive.
fn parse_monitor_mode(output: &str) -> Option<bool> {
    output.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        let key = key.trim().to_ascii_lowercase();
        if !key.contains("network monitor mode") {
            return None;
        }
        let value = value.trim().to_ascii_lowercase();
        if value == "supported" {
            Some(true)
        } else if value == "not supported" {
            Some(false)
        } else {
            None
        }
    })
}

#[cfg(test)]
mod tests {
    use super::{parse_monitor_mode, AX211_OMDROP_OWL_VERIFIED_SUPPORTED};

    #[test]
    fn unverified_ax211_does_not_claim_omdrop_support() {
        assert!(!AX211_OMDROP_OWL_VERIFIED_SUPPORTED);
    }

    #[test]
    fn parses_supported_monitor_mode() {
        assert_eq!(
            parse_monitor_mode("Network monitor mode : Supported"),
            Some(true)
        );
    }

    #[test]
    fn rejects_unsupported_monitor_mode() {
        assert_eq!(
            parse_monitor_mode("Network monitor mode : Not Supported"),
            Some(false)
        );
    }

    #[test]
    fn unknown_or_localized_capability_does_not_claim_ready() {
        assert_eq!(parse_monitor_mode("Network monitor mode : Unknown"), None);
        assert_eq!(parse_monitor_mode("Mode réseau : Pris en charge"), None);
    }
}
