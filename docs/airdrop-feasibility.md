# AirDrop / "Nearby" on Windows — Feasibility Report for Hover Island

**Status:** Research deliverable (no source/config changed, no builds run)
**App under study:** Hover Island — Tauri v2 Windows "notch" utility
**Feature considered:** a "Nearby / AirDrop" panel for drag-and-drop send/receive
**Date:** 2026-10-13

---

## 0. TL;DR / verdict

* **True AirDrop on stock Windows is effectively blocked today.** AirDrop rides on **AWDL** (Apple Wireless Direct Link), a proprietary 802.11 ad-hoc protocol that requires the Wi-Fi adapter to run in **active monitor mode with frame injection** and to create a virtual interface. No such capability exists for Wi-Fi drivers on stock Windows, and the only open AWDL implementation (OWL) explicitly **does not support Windows or WSL** — and was **archived 2026-10-12**. So Option A (wrap OpenDrop/OWL) is **not shippable** on stock hardware.
* **Identity ≠ transport (verified).** `seemoo-lab/airdrop-keychain-extractor` recovers AirDrop's Apple-signed identity secrets (`validation_record.cms` / `certificate.pem` / `key.pem`) for OpenDrop, but it solves only the **identity** half and provides **no AWDL transport**; the Windows blocker is the transport, and it is unchanged. See the appended **Update** section (§9) for the verified detail, the corrected identity/transport analysis, and the one realistic workaround (a WSL2 + USB-passthrough sidecar).
* **A standards-based successor exists (Wi-Fi Aware / NAN) but Windows also does not expose it** as of late 2026 — no Wi-Fi Aware API in Windows 10/11, and Wi-Fi-Direct support in `netsh wlan show wirelesscapabilities` does **not** imply NAN. This is a Windows WLAN-stack limitation, not just a chip limitation.
* **The pragmatic option is real and iPhone-capable.** Implement the **LocalSend protocol v2.2** (Apache-2.0, cross-platform, actively maintained) natively in Rust inside Hover Island. It reaches **iPhones** (LocalSend iOS app, or the browser "download" API in Safari), **Android**, **macOS**, **Linux**, and other Windows boxes — today, with no exotic drivers.
* **Recommendation: ship Option B (LocalSend-compatible "Nearby")**, and keep an eye on Wi-Fi Aware as the eventual standards path. Rough MVP effort: **~2–4 engineering weeks**.

---

## 1. How AirDrop actually works (end to end)

### 1.1 Transport: AWDL, not normal Wi-Fi

AirDrop does **not** use an access point or the internet. It uses **Apple Wireless Direct Link (AWDL)**, a proprietary, undocumented IEEE 802.11 (Wi-Fi) ad-hoc protocol that Apple introduced ~2014 and ships across iPhone/iPad/Mac/Watch. AWDL is the same transport behind AirPlay and Continuity features.

The authoritative reverse-engineering reference is Stute, Kreitschmann & Hollick, *"One Billion Apples' Secret Sauce: Recipe for the Apple Wireless Direct Link Ad hoc Protocol"* (MobiCom '18): <https://arxiv.org/abs/1808.03156> (DOI <https://doi.org/10.1145/3241539.3241566>). Key mechanics:

* Each AWDL node advertises a repeating **Availability Window (AW)** schedule; an **elected master node** synchronizes all nodes.
* Outside availability windows, a node can hop its radio back to its regular AP channel — AWDL **time-shares a single Wi-Fi radio** via channel hopping (Apple uses channels **6/44/149**).
* Nodes use generated **link-local IPv6** addresses rather than the fixed MAC, and advertise via **mDNS/DNS-SD**. The AirDrop service type is **`_airdrop._tcp.local.`** (confirmed in OpenDrop's source, `opendrop/client.py`, which browses `_airdrop._tcp.local.` with an IPv6-only zeroconf browser bound to the AWDL interface).
* Security work on the same protocol: Stute et al., *"A Billion Open Interfaces for Eve and Mallory…"*, USENIX Security '19 — <https://www.usenix.org/conference/usenixsecurity19/presentation/stute>.

Because it is a link-layer protocol, using it means **transmitting and receiving raw 802.11 frames and controlling the radio channel** — exactly the thing normal OS Wi-Fi stacks refuse to expose to apps.

### 1.2 The AirDrop application handshake (HTTPS + Apple plists)

Once AWDL gives peers link-local IPv6 connectivity, AirDrop is an **HTTPS** exchange between the devices over that interface. From OpenDrop's implementation (`opendrop/client.py`, <https://github.com/seemoo-lab/opendrop>):

* **`POST /Discover`** — probe whether a receiver is willing to be seen; returns the receiver's computer name if discoverable.
* **`POST /Ask`** — the real "accept?" request. A **binary plist** (`plistlib.FMT_BINARY`) containing fields such as `SenderComputerName`, `SenderModelName`, `SenderID`, `BundleID` (`com.apple.finder`), `Files`/`Items`, and an optional `FileIcon`. This is what produces the accept/reject prompt.
* **`POST /Upload`** — the payload, sent as a **gzip cpio archive** (`Content-Type: application/x-cpio`); Apple unpacks and materialises the files.
* Requests carry AirDrop-shaped headers (`User-Agent: AirDrop/1.0`, etc.). OpenDrop also supports sending a **URL** so the receiver's browser opens it.

### 1.3 "Contacts Only" and the iCloud identity layer

Apple's own description is the primary source: **"AirDrop security," Apple Platform Security** — <https://support.apple.com/guide/security/airdrop-security-sec2261183f4/web>. Summary:

* Signing into iCloud creates a **2048-bit RSA identity** on the device.
* AirDrop builds an **"AirDrop short identity hash"** from the emails/phone numbers on the Apple ID. This hash is broadcast over **BLE** to wake nearby AirDrop devices.
* In **Contacts Only** mode, the receiver compares the incoming short hash against hashes of its own Contacts; only a match triggers an AWDL response. **Everyone** mode responds regardless.
* If hashes verify, devices open the encrypted (TLS) connection and **exchange iCloud identity certificates**; certificates are verified against Contacts, then the accept prompt appears.

Consequences for third parties:

* **"Everyone" receivers are reachable** without Apple credentials (this is what OpenDrop targets).
* **"Contacts Only" needs Apple-signed certificates.** OpenDrop's README states it can only talk to Contacts-Only devices by using **credentials extracted from a real Mac** via the `airdrop-keychain-extractor` (<https://github.com/seemoo-lab/airdrop-keychain-extractor>) — i.e. you must own/authorize an Apple device and export its keys/certs. Distribution of such material is legally and practically fraught (see §6).

### 1.4 The landscape is shifting (important context)

In late 2025 the EU's Digital Markets Act pressure pushed Apple to **deprecate AWDL in favor of the open Wi-Fi Aware standard**, and Google shipped **AirDrop interop in Quick Share** (starting Pixel 10, iPhone needing iOS 26 in "Everyone for 10 minutes" mode):

* Google blog: <https://blog.google/products/android/quick-share-airdrop/>
* Wikipedia summary of AWDL→Wi-Fi Aware deprecation and Quick Share/AirDrop interop: <https://en.wikipedia.org/wiki/AirDrop>
* Wi-Fi Aware overview: <https://www.wi-fi.org/discover-wi-fi/wi-fi-aware>

This is strategically relevant: the *open* future path is **Wi-Fi Aware**, not AWDL. See §4.3.

---

## 2. Open-source implementations and their status

| Project | Protocol | Platforms | Windows support | Maintenance (as of Oct 2026) | iPhone interop? |
|---|---|---|---|---|---|
| **OpenDrop** ([seemoo-lab/opendrop](https://github.com/seemoo-lab/opendrop)) | Real AirDrop (AWDL + HTTPS/plist) | Linux (with OWL), macOS | **No** (Python CLI; needs AWDL interface) | Active-ish: last push 2026-08-17; not archived; GPL-3.0; 9.9k★ | **Send to iPhone/Mac** discoverable as *Everyone* (and Contacts-Only only with extracted Apple certs). Receiving from Apple → OpenDrop works for files. |
| **OWL** ([seemoo-lab/owl](https://github.com/seemoo-lab/owl)) | AWDL link-layer (C) | Linux, macOS | **No**; explicitly **no WSL/VM** without USB/PCIe passthrough | **Archived 2026-10-12**, "no longer maintained"; GPL-3.0; 1.6k★ | n/a (transport only) |
| **NearDrop** ([grishka/NearDrop](https://github.com/grishka/NearDrop)) | Google Nearby Share / **Quick Share** (not AirDrop) | **macOS only** (Swift) | No (macOS menu-bar app) | Active: last push 2026-09-19; Unlicense; 6.3k★ | Talks to **Android**, not iPhone. README itself says "AirDrop on Android is nigh-impossible… AWDL … requires messing with Wi-Fi adapter drivers and raw packets." |
| **LocalSend** ([localsend/localsend](https://github.com/localsend/localsend)) | Own REST/HTTPS protocol v2.2 ([spec](https://github.com/localsend/protocol)) | Win/macOS/Linux/Android/iOS/FireOS | **Yes** (10+; winget/scoop/choco/MSIX) | Very active: last push 2026-10-10; Apache-2.0; 94k★ | Yes — official **iOS app** (App Store) + browser download API. Cross-platform, not AirDrop-compatible. |
| **PairDrop** ([schlagmichdoch/PairDrop](https://github.com/schlagmichdoch/PairDrop)) | **WebRTC** + WebSockets (fork of Snapdrop) | Any modern browser | Yes (browser / Node server / Docker) | Active: last push 2026-04-22; GPL-3.0; 11.6k★ | Yes — an iPhone Safari tab uses it with **zero install**; also paired-device/public-room mode over the internet. |
| **Snapdrop** ([RobinLinus/snapdrop](https://github.com/RobinLinus/snapdrop)) | WebRTC + WebSockets | Browser | Yes | Older lineage of PairDrop | Yes (browser). |
| **KDE Connect** ([KDE/kdeconnect-kde](https://github.com/KDE/kdeconnect-kde)) | Custom JSON packets over TLS | Linux/Android/Windows/iOS | Yes (Microsoft Store) | Maintained; GPL-2/3; 4.1k★ | Has iOS app, but **App Store sandboxing limits** sharing; pairing-centric, not AirDrop-like discovery. |

**Takeaways**

* The only true-AirDrop code (OpenDrop + OWL) is **Linux/macOS-only** and depends on a Wi-Fi driver that Windows does not offer.
* The closest "works everywhere including iPhone" products are **LocalSend** (native apps + browser) and **PairDrop** (browser/WebRTC).
* Google's own macOS implementation (NearDrop) **deliberately avoided AWDL** and instead re-implemented **Nearby Share**, and its maintainer states AWDL on non-Apple hardware is not practical.

---

## 3. The hardware/driver blocker: can Windows do AWDL?

### 3.1 What AWDL requires at the driver level

From OWL's README (<https://github.com/seemoo-lab/owl>) and its issue tracker:

* A Wi-Fi card supporting **active monitor mode with frame injection** (OWL developed/tested on Atheros AR9280). Cards with only *passive* monitor mode suffer throughput loss.
* The implementation **runs in user space** but needs raw frame TX/RX and **channel switching** via the OS Wi-Fi API (Linux `nl80211`/Netlink). It then presents a **virtual network interface** (`awdl0`) with a link-local IPv6 so ordinary IPv6 programs work unmodified.
* **No VMs / no WSL.** OWL requires direct access to the Wi-Fi card, so virtualised environments (except with USB/PCIe passthrough) and **Windows Subsystem for Linux are unsupported** (OWL issue #8: <https://github.com/seemoo-lab/owl/issues/8>). Card requirements discussion: issue #9 <https://github.com/seemoo-lab/owl/issues/9>.
* OWL **cannot run a concurrent AP connection** — when started, the Wi-Fi interface is exclusively AWDL.

### 3.2 Why stock Windows fails

* **No monitor-mode + injection Wi-Fi driver stack.** Windows' Wi-Fi stack (`WLAN`/`WiFiCx`/`NDIS`) exposes *Wi-Fi Direct* APIs but **not raw 802.11 frame TX/RX with channel control**. `netsh wlan show wirelesscapabilities` reporting Wi-Fi Direct does **not** mean AWDL is possible. In the Intel community thread, an Intel Wi-Fi 6E AX211 user (driver 24.50, Win11 build 26200) reports **Wi-Fi Direct = yes, Wi-Fi Aware/NAN = no**, and the community answer concludes the limitation is the Windows WLAN stack, not the adapter: <https://community.intel.com/t5/Wireless/Wi-Fi-Aware-NAN-support-on-Windows-for-the-Wi-Fi-6E-AX211/m-p/1761451>.
* **Npcap/WinPcap is not enough.** Packet-capture libraries on Windows can capture/inject frames via a special driver, but they do not provide the **timed channel-hopping + AWDL scheduling + virtual-interface + link-local-IPv6** plumbing that OWL builds on Linux `nl80211`. Porting OWL to Windows would be a substantial driver/framework effort (a user in OpenDrop issue #108: "it is not easy to port OWL to Windows… once you have ported AWDL to Windows it will be easy" — <https://github.com/seemoo-lab/opendrop/issues/108>).
* **WSL2 does not rescue you.** WSL2 is a VM; it cannot see the host Wi-Fi adapter's raw frames without USB passthrough of a dedicated Wi-Fi dongle, and even then needs that dongle's Linux driver to support active monitor mode. OpenDrop issue #108 shows a WSL user hitting `Interface awdl0 does not have an IPv6 address. Make sure that owl is running.`
* **Consequence:** there is **no known working AWDL implementation on stock Windows hardware**, and none of the projects surveyed target it.

### 3.3 What *is* supported on Windows (and doesn't help)

* **Windows "Nearby Sharing"** (Settings → System → Nearby sharing) transfers files between **Windows PCs** using Bluetooth + Wi-Fi Direct; it does **not** talk to iPhones and is not AirDrop: <https://support.microsoft.com/en-us/windows/experience/connectivity-networking/share-things-with-nearby-devices-in-windows>.
* **Wi-Fi Direct** works on Windows but is a *different* protocol; iPhones do not use Wi-Fi Direct for AirDrop.

---

## 4. What is realistically achievable on stock Windows today

### 4.1 Not possible (without exotic drivers/hardware)

| Capability | On stock Windows |
|---|---|
| True AirDrop send to iPhone/Mac (AWDL) | ❌ Blocked (no AWDL on Windows; OWL is Linux/macOS + archived) |
| True AirDrop receive from iPhone | ❌ Blocked (same reason) |
| AirDrop "Contacts Only" without a Mac | ❌ Blocked (needs Apple-signed certs / keychain extraction) |
| Wi-Fi Aware (NAN) peer discovery | ❌ Windows exposes no Wi-Fi Aware API (as of 2026) |

### 4.2 Possible today

| Capability | On stock Windows | How |
|---|---|---|
| LocalSend ↔ iPhone | ✅ | LocalSend iOS app, or phone browser hitting our HTTP download endpoint |
| LocalSend ↔ Android/macOS/Linux/Windows | ✅ | Native LocalSend protocol |
| Browser-based P2P (PairDrop/Snapdrop) | ✅ | WebRTC in any browser (server or hosted instance) |
| Windows↔Windows Nearby Sharing | ✅ (built-in) | Bluetooth + Wi-Fi Direct (Microsoft feature) |
| KDE Connect to Android/iOS | ✅ (with app) | Store app; pairing model |

### 4.3 The forward-looking standards path (watch, don't build on yet)

* Apple is being pushed (EU DMA) to **replace AWDL with the open Wi-Fi Aware** standard, and **Android already supports Wi-Fi Aware**. Google's Quick Share↔AirDrop interop is the first visible result.
* **However, Windows still exposes no Wi-Fi Aware/NAN API.** A Microsoft Q&A answer (Jul 2025) states there is no official support and no public roadmap: <https://learn.microsoft.com/en-us/answers/questions/2284386/does-windows-have-plans-to-support-wifi-aware>. The Intel thread (Oct 2026) confirms the same for current adapters/drivers.
* **Implication:** the standards-based "real" path will only become usable on Windows once **Microsoft adds Wi-Fi Aware to the WLAN stack and OEMs ship capable drivers**. Track it, but it is not something Hover Island can implement on stock Windows now.

---

## 5. Practical AirDrop-like alternatives for Windows

### 5.1 LocalSend (recommended foundation)

* Open-source (Apache-2.0), cross-platform, extremely active (94k★), with **official iOS/Android apps** and a documented **REST protocol** (`https://github.com/localsend/protocol`).
* Discovery: **multicast UDP 224.0.0.167:53317** announcing a JSON device descriptor, with peers replying via `POST /api/localsend/v2/register` (or a multicast fallback). If multicast is blocked, "legacy mode" probes all local IPs.
* Transfer: **HTTPS on TCP 53317** with a **per-device self-signed cert generated on the fly**; `POST /prepare-upload` (metadata, optional `?pin=`), then `POST /upload?sessionId=…&fileId=…&token=…` (binary, optional `sha256` verification), plus `POST /cancel`.
* **Reverse/download API** lets a device that has *no* LocalSend app download files from **any browser**: sender runs an HTTP server; receiver opens `http://<sender-ip>:53317`. This is the **zero-install iPhone path** (works in Safari), though it's plain HTTP because browsers reject the self-signed cert.
* Firewall: allow inbound **TCP+UDP 53317**, and be on a **Private** network profile; disable AP-isolation on the router.

### 5.2 PairDrop / Snapdrop (browser/WebRTC)

* Pure web app (PWA): an iPhone opens the site in **Safari** and can send/receive with **no install**; PairDrop adds persistent pairing, public rooms, and TURN for NAT traversal.
* Downside for a native desktop feature: embedding it means shipping/hosting a Node server and a **WebRTC stack**; not a clean Rust/Tauri integration.

### 5.3 Windows "AirDrop" attempts (context)

* **SRhinzler/NearDrop** — native Windows/Android LAN sharing (discovery + approval + concurrent transfers). Useful reference, **not** AirDrop-compatible.
* **UvejsGj/WinDrop** — an open-source Windows file-sharing app whose author is explicitly blocked by Windows' lack of NAN/AWDL frame access (see the Intel thread). It confirms the blocker is real and current.
* **grishka/NearDrop** — macOS only; deliberately re-implements Nearby/Quick Share instead of AWDL.

**Bottom line:** nothing on Windows talks to an iPhone via *AirDrop*; several things talk to an iPhone via *other* protocols, and **LocalSend's browser-download path is the most reliable zero-install way to reach an iPhone today.**

---

## 6. Security and legal notes

* **Licensing / GPL risk.** OpenDrop and OWL are **GPL-3.0**; NearDrop is Unlicense; LocalSend is **Apache-2.0**; PairDrop is **GPL-3.0**. If Hover Island (a Tauri app you may ship as proprietary) *embedded or linked* GPL code, GPL obligations would likely attach to the combined work. **Using the LocalSend protocol/Apache-2.0 stack avoids this**; reverse-engineering a protocol for interoperability is generally a lower-risk posture than copying GPL code.
* **Interoperability legality.** Reverse engineering for interoperability has protections in several jurisdictions (e.g. US DMCA §1201 interoperability exception; EU Software Directive decompilation for interoperability), but it is **fact-specific** and Apple's ToS/EULA is hostile to clone implementations. OpenDrop's own posture is explicit: *"experimental… result of reverse engineering… not affiliated with or endorsed by Apple Inc. Use this code at your own risk."*
* **Contacts-Only credentials.** Reaching Contacts-Only devices requires **Apple-signed certificates/keys extracted from a real Mac** (`airdrop-keychain-extractor`). That ties the feature to a user's Apple identity and raises redistribution concerns. **Only "Everyone" mode is realistically supportable** in a generic product.
* **Privacy/security of AirDrop itself.** Apple's handshake historically transmitted **SHA-256 hashes of phone numbers/emails** that can be correlated (Ars Technica 2021; the 2024 Beijing forensic "rainbow table" case). Building on a clone inherits those privacy weaknesses.
* **LocalSend/PairDrop security posture.** LocalSend uses on-the-fly TLS with certificate fingerprints (fingerprint = SHA-256 of cert) and optional PINs; PairDrop uses WebRTC DTLS and is explicit that the public instance/rooms are shared discovery. Both are sensible defaults for a "Nearby" feature, but treat all LAN peers as untrusted and **prompt before accepting** (mirror AirDrop's accept/reject UX).
* **Practical hardening for Hover Island:** require explicit accept; show sender name + file list + size; write to a temp/quarantine dir; verify `sha256`; allow a PIN; never auto-run received content.

---

## 7. Integration plan for Hover Island (Tauri v2)

### Option A — True AirDrop (Rust sidecar wrapping OpenDrop/OWL)

**Idea:** ship `owl` (C, AWDL) + `opendrop` (Python, AirDrop protocol) as Tauri sidecars; use `owl` to create an AWDL interface, `opendrop find` for discovery, `opendrop send/receive` for transfers; the island UI handles drag-drop and accept/reject, writing into a temp dir.

**What each piece needs**

| Piece | Requirement | Windows reality |
|---|---|---|
| `owl` sidecar | Active-monitor-mode Wi-Fi + frame injection + channel control; Linux `nl80211` | **Not available on Windows**; archived 2026-10-12; no WSL without USB passthrough |
| `opendrop` sidecar | Python ≥3.6, `libarchive`, an `awdl0`-style IPv6 interface | No interface on Windows → fails (`awdl0 does not have an IPv6 address`) |
| Sidecar launch | `tauri-plugin-shell` (`Command::new_sidecar`) | Works — but the binaries can't function on Windows |
| mDNS discovery | IPv6 zeroconf on the AWDL interface | Requires the AWDL interface that doesn't exist |

**Honest feasibility rating: ❌ Not feasible on stock Windows today.**
*Prerequisites that would change this:* a working **Windows AWDL** port (raw 802.11 TX/RX + timed channel hopping + virtual interface on Windows WiFiCx/NDIS), plus a maintained OWL (it is archived). Neither exists. Porting OWL is a multi-month, driver-level research project with no guarantee of success. **Do not build this as the shipped feature.**

### Option B — Pragmatic "Nearby" (LocalSend-compatible, Rust-native)

**Idea:** implement a **LocalSend v2.2-compatible** endpoint natively in Rust inside Hover Island. No sidecars, no exotic drivers. Reaches iPhone (iOS app or Safari download), Android, macOS, Linux, and other Windows PCs.

```
                 Hover Island (Tauri v2, Rust core)
   ┌──────────────────────────────────────────────────────────────┐
   │  Island UI (React)                                            │
   │    • Nearby list   • drag-drop send   • accept/reject sheet   │
   │    • progress + PIN prompt            • Tauri events          │
   └───────────────▲───────────────────────────────▲──────────────┘
                   │ commands/events               │ fs / dialogs
   ┌───────────────┴───────────────────────────────┴──────────────┐
   │  Rust "nearby" module (tokio tasks)                          │
   │   • Discovery:  UDP 224.0.0.167:53317 announce/listen        │
   │   • Register:   POST /api/localsend/v2/register              │
   │   • RX server:  axum + rustls (rcgen self-signed) :53317     │
   │        /prepare-upload  /upload  /cancel                     │
   │   • TX client:  reqwest(rustls) → peer :53317                │
   │   • Download API (browser path for iPhones)                  │
   │   • State: peers, sessions, tokens, progress                 │
   └──────────────────────────────────────────────────────────────┘
        temp/quarantine dir  →  user Accept  →  final destination
```

**Architecture notes**

* **Discovery** — bind a UDP socket, join multicast `224.0.0.167`, send the announce JSON, and reconcile peers on `POST /register` (and legacy per-IP probe fallback). Use `socket2` for multicast options, `tokio` for the async loop.
* **Receiving** — an `axum` server on `0.0.0.0:53317` wrapped in TLS (`rustls` + a runtime self-signed cert from `rcgen`). Implement `/prepare-upload` (decide accept/pin/deny), `/upload` (stream to temp, verify `sha256`), `/cancel`.
* **Sending** — `reqwest` over TLS to the peer's advertised port, with `prepare-upload` → parallel `/upload` → progress events to the island.
* **iPhone zero-install path** — expose the download API and show a QR/URL (`http://<our-ip>:53317`) for Safari; plain HTTP for browser download (as LocalSend does), HTTPS for app-to-app.
* **Island UX** — mirror AirDrop: sheet with sender name, file list, size, Accept/Decline; drag file(s)/folders onto the notch to send; progress + cancel; quarantine received files in a temp dir until accepted.
* **Windows integration** — add a firewall rule for **TCP+UDP 53317**; require the network profile to be **Private**; optionally `tauri-plugin-autostart`, `tauri-plugin-dialog`, `tauri-plugin-fs`.

**Rust crates / third-party binaries**

| Need | Choose |
|---|---|
| Async runtime | `tokio` |
| HTTP server | `axum` (or `hyper`) + `axum-server` |
| TLS | `rustls`, `tokio-rustls`, `rcgen` (self-signed), `rustls-pemfile` |
| HTTP client | `reqwest` (rustls backend) |
| UDP/multicast | `socket2` + `tokio::net::UdpSocket` |
| Serialization | `serde`, `serde_json` |
| Hashing / IDs | `sha2`, `uuid` |
| Errors | `anyhow`, `thiserror` |
| Temp/quarantine | `tempfile`, `directories` |
| Tauri glue | `tauri` v2, `tauri-plugin-shell` (only if needed), `tauri-plugin-dialog`, `tauri-plugin-fs`, `tauri-plugin-autostart` |

**Honest feasibility rating: ✅ High — works on stock Windows and reaches iPhones today.**

**Roadmap (rough effort)**

| Phase | Scope | Est. |
|---|---|---|
| 0 | Discovery + `register` handshake; peer list in island | 2–4 d |
| 1 | HTTPS receive server (`prepare-upload`/`upload`/`cancel`), temp quarantine, accept UX | 3–5 d |
| 2 | Send path (client, progress, multi-file) | 2–3 d |
| 3 | Tauri v2 wiring: drag-drop, tray/notch panel, events, firewall/network guidance | 3–5 d |
| 4 | Polish: PIN, `sha256` verify, QR/download page for iPhones, autostart, docs | 3–5 d |
| **Total** | Shippable MVP | **~2–4 weeks** |

### Option comparison

| Criterion | A — True AirDrop (stock) | A′ — True AirDrop (WSL2 + USB passthrough) | B — LocalSend-compatible |
|---|---|---|---|
| Works on stock Windows | ❌ No | ❌ No — needs a specific USB Wi-Fi adapter + WSL2 + driver work | ✅ Yes |
| Works after a driver port | Maybe (months, risky) | n/a | n/a |
| Reaches iPhone | ✅ (Everyone mode; Contacts-only needs Apple certs) | ✅ same, plus Contacts-only with extracted keys | ✅ (iOS app or Safari download) |
| Reaches Android/macOS/Linux | Awkward | Awkward | ✅ |
| Extra hardware | None (blocked) | USB adapter with **active** monitor mode; a Mac for keys | None |
| License risk | GPL-3.0 (OpenDrop/OWL) | GPL-3.0 (+ Apple entitlement/SIP on a Mac) | Low (Apache-2.0 ecosystem) |
| Engineering effort | Very high / blocked | High & fragile (weeks, with driver dead-ends) | ~2–4 weeks |
| Maintenance | Tied to archived OWL | Tied to archived OWL + WSL/usbipd | Healthy upstream |
| Shippable to general users | ❌ | ❌ (power-user / BYO-hardware only) | ✅ |

### Recommendation

**Build Option B: a LocalSend Protocol v2.2-compatible "Nearby" feature, implemented natively in Rust inside Hover Island.** It delivers the AirDrop-like UX (discover → drag-drop → accept/reject → progress) on stock Windows *now*, reaches iPhones via the iOS app or Safari download, carries the least legal/licensing risk, and needs no special hardware or drivers.

**Do not attempt Option A** unless the goal is explicitly a research project: AWDL is unavailable on Windows, OWL is archived, and the transport cannot be brought up without driver-level work. Treat **Wi-Fi Aware / NAN** as the eventual standards-based path to watch — if Microsoft adds a Wi-Fi Aware API, Hover Island can add a "true P2P" transport alongside LocalSend without changing its UX.

---

## 8. Sources

1. Apple — *AirDrop security*, Apple Platform Security: <https://support.apple.com/guide/security/airdrop-security-sec2261183f4/web>
2. Stute, Kreitschmann, Hollick — *One Billion Apples' Secret Sauce: Recipe for AWDL*, MobiCom '18: <https://arxiv.org/abs/1808.03156> · DOI <https://doi.org/10.1145/3241539.3241566>
3. Stute et al. — *A Billion Open Interfaces for Eve and Mallory*, USENIX Security '19: <https://www.usenix.org/conference/usenixsecurity19/presentation/stute>
4. OpenDrop (GPL-3.0): <https://github.com/seemoo-lab/opendrop> (source: `opendrop/client.py`)
5. OWL (GPL-3.0; archived 2026-10-12): <https://github.com/seemoo-lab/owl> · WSL issue #8 · card issue #9
6. OpenDrop Windows compatibility issue #108: <https://github.com/seemoo-lab/opendrop/issues/108>
7. airdrop-keychain-extractor: <https://github.com/seemoo-lab/airdrop-keychain-extractor>
8. NearDrop (grishka; macOS, Unlicense): <https://github.com/grishka/NearDrop>
9. LocalSend (Apache-2.0): <https://github.com/localsend/localsend>
10. LocalSend Protocol v2.2: <https://github.com/localsend/protocol>
11. PairDrop (GPL-3.0): <https://github.com/schlagmichdoch/PairDrop>
12. Snapdrop (GPL-3.0): <https://github.com/RobinLinus/snapdrop>
13. KDE Connect (GPL-2/3): <https://github.com/KDE/kdeconnect-kde>
14. Microsoft Q&A — *Does Windows have plans to support Wi-Fi Aware*: <https://learn.microsoft.com/en-us/answers/questions/2284386/does-windows-have-plans-to-support-wifi-aware>
15. Intel Community — *Wi-Fi Aware (NAN) support on Windows for the Wi-Fi 6E AX211*: <https://community.intel.com/t5/Wireless/Wi-Fi-Aware-NAN-support-on-Windows-for-the-Wi-Fi-6E-AX211/m-p/1761451>
16. Google — *Android Quick Share can now work with iOS's AirDrop*: <https://blog.google/products/android/quick-share-airdrop/>
17. Wi-Fi Alliance — *Alternative Topologies / Wi-Fi Aware*: <https://www.wi-fi.org/discover-wi-fi/wi-fi-aware>
18. Wikipedia — *AirDrop* (AWDL→Wi-Fi Aware deprecation, Quick Share interop, PII/forensics): <https://en.wikipedia.org/wiki/AirDrop>
19. Microsoft Support — *Share things with nearby devices in Windows*: <https://support.microsoft.com/en-us/windows/experience/connectivity-networking/share-things-with-nearby-devices-in-windows>
20. SRhinzler/NearDrop (Windows LAN sharing reference): <https://github.com/SRhinzler/NearDrop>

---

## Update: AirDrop identity (keychain-extractor) vs AWDL transport

**Added:** 2026-10-13 (appended; no source/config changed, no builds run). This section verifies the identity-vs-transport split against the upstream repos and evaluates the one realistic "true AirDrop on Windows" path — a **WSL2 + USB-passthrough sidecar**. It **does not change the shipped recommendation**: **Option B (LocalSend protocol, Rust-native) remains the default.**

### 9.1 What the keychain-extractor actually solves — identity, not transport

`seemoo-lab/airdrop-keychain-extractor` (<https://github.com/seemoo-lab/airdrop-keychain-extractor>) extracts the three AirDrop **identity** secrets from a **Mac's** keychain and feeds them to OpenDrop:

* `validation_record.cms` — the Apple ID validation record.
* `certificate.pem` — the AirDrop identity certificate.
* `key.pem` — the matching private key.

Copying the three files into `~/.opendrop/keys` lets a non-Apple peer appear as one of *your own* devices and reach receivers set to **Contacts Only**. OpenDrop's README states this explicitly: *"Currently (and probably also for the foreseeable future), OpenDrop only supports sending to Apple devices that are discoverable by **everybody** as the default **contacts only** mode requires Apple-signed certificates. We support contacts-only devices by using extracted AirDrop credentials (keys and certificates) from macOS via our keychain extractor."*

**This is the identity half only.** AirDrop = **identity (Apple-signed certs + keys) + transport (AWDL)**. The extractor hands you credentials; it does **not** create an `awdl0` interface, does not transmit a single 802.11 frame, and **does not run on Windows**. On Windows the **AWDL transport is still the blocker**, exactly as in §3. Solving identity does not unlock Windows.

README requirements, quoted verbatim (macOS-only, invasive, one-time):

* *"This procedure should work at least for macOS 10.14, 10.15, and 11.0."*
* *"**Warning:** This procedure requires to temporarily disable some of macOS' security features! Use at your own risk."*
* *"Since this is an Apple-internal entitlement, we have to disable `amfid` that checks binary signatures and enforces the system's policies."* → *"we first need to disable SIP via macOS' recovery mode … `csrutil enable --without nvram` … then add the following boot parameter … `sudo nvram boot-args="amfi_get_out_of_my_way=1"`."*
* *"We build and run the extraction utility (note that you need a developer certificate for this)."*
* Implementation is `main.m` + `entitlements.plist` carrying the Apple-internal entitlement **`com.apple.sharing.appleidauthentication`**.

**Net:** to reach Contacts-Only devices you need (a) a Mac signed into your Apple ID, (b) SIP partially disabled + AMFI bypassed on it, (c) a developer certificate, (d) macOS 10.14–11 — **and** a working AWDL transport at the other end. For a generic Windows product this is not shippable (see §6); it stays an optional *"power user happens to own a Mac"* path, never a product feature.

### 9.2 Verified status of OpenDrop / OWL / Windows (Oct 2026)

| Item | Verified fact | Source |
|---|---|---|
| **OpenDrop platforms** | *"OpenDrop is only supported on macOS or on Linux systems running an open re-implementation of AWDL such as OWL."* No Windows target. Last substantive code ~Dec 2020; the Aug 17 2026 commits are README/`setup.py` only. 9.9k★, GPL-3.0. | <https://github.com/seemoo-lab/opendrop> · <https://github.com/seemoo-lab/opendrop/commits/master> |
| **OWL platforms** | Linux + macOS (C). **Archived by the owner on Oct 12, 2026**; README: *"no longer maintained."* 1.6k★, GPL-3.0. | <https://github.com/seemoo-lab/owl> |
| **OWL hardware requirement** | *"Wi-Fi card with **active** monitor mode … We recommend the Atheros AR9280 chip (IEEE 802.11n)."* Cards without active monitor (no ACK) suffer 7× retransmits → discovery times out. Some USB adapters work (TP-Link Archer T1U; community adapter list). | OWL README · <https://github.com/seemoo-lab/owl/issues/9> · <https://github.com/seemoo-lab/owl/issues/10> · <https://github.com/morrownr/USB-WiFi/issues/73> |
| **OWL virtualization** | *"No support for virtual machines and WSL. OWL requires direct access to the Wi-Fi card which means that virtualized environments (except with USB or PCIe passthrough) and Windows Subsystem for Linux (WSL …) are **not supported**."* | <https://github.com/seemoo-lab/owl> · <https://github.com/seemoo-lab/owl/issues/8> |
| **OpenDrop on Windows** | No Windows port and no Windows PR. Issue #108 open since Apr 2023; a WSL user hits `RuntimeError: Interface awdl0 does not have an IPv6 address. Make sure that `owl` is running.` Maintainers: *"it is not easy to port OWL to Windows. Once you have ported AWDL to Windows it will be very easy."* | <https://github.com/seemoo-lab/opendrop/issues/108> |
| **USB passthrough tooling** | `dorssel/usbipd-win` (6.2k★, GPL-3.0) shares local USB devices into WSL2: `usbipd bind --busid=<BUSID>` then `usbipd attach --wsl --busid=<BUSID>` (no admin needed for attach). `bind` is persistent; `attach` is **not** (re-attach after reboot/reset). WSL kernel may lack the adapter's driver → needs `wsl --update` or a custom WSL kernel. | <https://github.com/dorssel/usbipd-win> · <https://github.com/dorssel/usbipd-win/wiki/WSL-support> |

**Takeaways:** the transport stack is both **Linux-only** and now **unmaintained** (OWL archived; OpenDrop frozen), and the only virtualization exception OWL documents is USB/PCIe passthrough — which is precisely what `usbipd-win` provides for a **USB** Wi-Fi adapter.

### 9.3 The realistic "true AirDrop on Windows" path: WSL2 + USB Wi-Fi passthrough

This is the *only* construct that could give Hover Island real AirDrop without a Windows AWDL port. Hover Island stays a normal Windows/Tauri app; a **WSL2 sidecar** runs the Linux AWDL stack against a **dedicated USB Wi-Fi adapter** passed through from Windows, and talks back to Tauri over a localhost API.

```
  Hover Island (Tauri v2, Windows)                     ┌─ optional, ONE-TIME ─────┐
    island UI  ──► Rust "airdrop" module               │  Mac: SIP off, dev cert  │
                     │  HTTP/JSON over 127.0.0.1      │  run keychain-extractor  │
                     ▼                                │  -> validation_record.cms │
        127.0.0.1:<PORT>  (WSL2 localhost forwarding)  │     certificate.pem       │
                     │                                │     key.pem               │
                     ▼                                └───────────┬─────────────┘
   ┌───────────────────────────────────────────────────────────┐  │ copied to
   │ WSL2 distro (Ubuntu)                                       │  │ ~/.opendrop/keys
   │   • owl -i <iface>            → awdl0 (link-local IPv6)    │◄─┘
   │   • opendrop find / send / receive                         │
   │   • tiny local API (or `wsl.exe` shell-out)  ◄─ Tauri calls │
   └───────────────▲───────────────────────────────────────────┘
                   │ USB/IP  (usbipd attach --wsl --busid=…)
   ┌───────────────┴────────────────┐
   │ USB Wi-Fi adapter              │       AWDL 802.11 frames
   │ (active monitor + injection)   │  ◄────────────────────────►  iPhone / Mac
   └────────────────────────────────┘
```

**Prerequisites**

1. **Windows 10/11** with **WSL2** (`wsl --update` for a recent kernel) and a distro (Ubuntu).
2. **`usbipd-win`** installed; the chosen adapter `bind`-ed and `attach --wsl`-ed.
3. A **USB Wi-Fi adapter whose Linux driver supports *active* monitor mode + frame injection** — the hard constraint. Known-good: Atheros **AR9280** (OWL's own dev/test chip, usually via an older/ALFA USB dongle); community-reported: TP-Link Archer T1U; see the morrownr adapter list. Most modern chips only do *passive* monitor → throughput collapses.
4. The adapter's driver present in the WSL2 kernel (may need a rebuilt WSL kernel / out-of-tree module).
5. **`owl` built from source** (GPL-3.0) inside WSL + **`opendrop`** (`pip3 install opendrop`; needs `libarchive`).
6. **A second network path** (Ethernet or built-in Wi-Fi) because OWL runs the passed-through adapter **exclusively as AWDL** — no concurrent AP.
7. **One-time macOS step** for Contacts-Only keys (§9.1); "Everyone" mode needs no Mac but no keys either.
8. A **localhost bridge**: a small HTTP/JSON service in WSL (or `wsl.exe` shell-outs) that Hover Island calls; WSL2 forwards Windows→WSL listening ports on `127.0.0.1`.

**Risks**

* **Adapter/chipset compatibility is the dominant risk.** If the driver can't do *active* monitor mode, OWL's frames go un-ACKed and AirDrop discovery times out (issue #9). No adapter ⇒ no feature.
* **Driver/kernel fragility.** `usbipd` passes the USB device, but WSL's default kernel may not carry the module; custom WSL kernels are unsupported territory. `attach` must be re-run after every reboot/reset.
* **Exactly one radio.** The adapter is consumed by AWDL; users lose that radio's normal Wi-Fi while AirDrop is active.
* **Latency/throughput.** File bytes cross WSL2↔Windows through localhost; the Wi-Fi link dominates, but the bridge adds latency and a failure surface (session/streaming has to be proxied).
* **Unmaintained upstream.** OWL is **archived** and OpenDrop is effectively frozen; a future macOS/iOS protocol change breaks the feature with no upstream fix.
* **Legal/licensing.** OpenDrop + OWL are **GPL-3.0** (§6) — shipping an integrated product risks GPL obligations; and Contacts-Only requires an Apple entitlement + SIP/AMFI-disabled Mac and redistribution of extracted identity material, which is legally fraught.
* **Not for general users.** Requires specific hardware, a Mac, and multi-step setup — the opposite of a consumer "Nearby" panel.

**Rough effort** (assuming a *known-good* AR9280-class adapter is already in hand)

| Phase | Scope | Est. |
|---|---|---|
| 0 — Spike | WSL2 + `usbipd` + build `owl`/`opendrop`; prove `owl -i …` creates `awdl0` and `opendrop find` sees an Apple device | 3–5 d (high uncertainty) |
| 1 — Bridge | Local API in WSL; Tauri ↔ sidecar discover/send/receive; progress/accept events | 1–2 w |
| 2 — UX + guidance | Hardware detection/`iw` capability check, driver notes, attach automation | 1 w |
| 3 — Packaging | Optional bundle of a WSL distro + `owl`/`opendrop` (GPL review), installer guidance | 1 w |
| **Total** | Power-user proof-of-concept → fragile product | **~3–4 w after the spike**, plus a **hard dependency on user hardware** |

### 9.4 Revised ratings

* **Option A (stock Windows):** ❌ unchanged — no Windows AWDL; OWL archived 2026-10-12.
* **Option A′ (WSL2 + USB passthrough):** **technically realizable but not shippable.** ⚠️ Power-user/BYO-hardware experiment only. Interesting as a research spike; blocked as a product by adapter compatibility, WSL/driver fragility, GPL, the Mac requirement, and an unmaintained upstream.
* **Option B (LocalSend protocol in Rust):** ✅ **unchanged — the default.** Works on stock Windows, reaches iPhones, no exotic drivers, ~2–4 weeks.

### 9.5 Revised roadmap & recommendation

**Recommendation stands: ship Option B.** Nothing in the verification changes the verdict — the keychain-extractor is an *identity* tool (macOS-only, SIP/AMFI-disabled, per-user keys) that does **not** address the *transport* blocker, and the only transport workaround (A′) needs specific hardware plus an archived stack. Build the LocalSend-compatible "Nearby" panel as planned (§7), and treat Wi-Fi Aware as the standards path to watch (§4.3).

If the team wants to keep true-AirDrop alive as an opt-in:

1. **Now → ship Option B** (MVP ~2–4 weeks). No dependency on Apple, Mac, WSL, or special hardware.
2. **Time-boxed Option A′ spike (1 week, separate branch)** *only* if a stakeholder supplies a known-good monitor-mode USB adapter: prove WSL2 + `usbipd` + `owl` + `opendrop` end-to-end to one iPhone. Gate everything on that result.
3. **Only if the spike passes**, integrate as a **clearly-labelled, opt-in "Real AirDrop (experimental, requires compatible USB Wi-Fi adapter + WSL2)"** transport behind the same island UX, with a documented BYO-hardware setup. Do **not** make it the default, and do **not** bundle GPL code without a licensing review.
4. **Track Wi-Fi Aware** (Windows API) as the eventual clean path; add it as a transport behind the same UI when Microsoft ships it (§4.3).

**Additional sources (this update)**

21. airdrop-keychain-extractor README (macOS 10.14–11; SIP/AMFI; entitlement `com.apple.sharing.appleidauthentication`): <https://github.com/seemoo-lab/airdrop-keychain-extractor>
22. OWL — archived 2026-10-12; *"no longer maintained"*: <https://github.com/seemoo-lab/owl>
23. OWL issue #9 — active monitor mode requirement; AR9280; TP-Link Archer T1U; adapter list: <https://github.com/seemoo-lab/owl/issues/9> · <https://github.com/seemoo-lab/owl/issues/10> · <https://github.com/morrownr/USB-WiFi/issues/73>
24. OWL issue #8 — WSL/VM unsupported: <https://github.com/seemoo-lab/owl/issues/8>
25. OpenDrop issue #108 — Windows compatibility; `awdl0 does not have an IPv6 address`: <https://github.com/seemoo-lab/opendrop/issues/108>
26. OpenDrop commit history (Aug 17 2026 = README/`setup.py` only): <https://github.com/seemoo-lab/opendrop/commits/master>
27. usbipd-win — USB `bind`/`attach --wsl` for WSL2; WSL support/drivers: <https://github.com/dorssel/usbipd-win> · <https://github.com/dorssel/usbipd-win/wiki/WSL-support>
28. brentkearney/omdrop-plugin — Omarchy (Linux) AirDrop bar plugin; MIT; 142★: <https://github.com/brentkearney/omdrop-plugin>

---

## Reference: brentkearney/omdrop-plugin

**Added:** 2026-10-13 (appended; no source/config changed, no builds run). This section records what `brentkearney/omdrop-plugin` ("Omdrop") is, what it proves — or does not prove — about Windows, and whether it changes our recommendation. **It does not change the recommendation.**

### 10.1 What it is

Omdrop is a **real-AirDrop** implementation for **Omarchy** — the Arch-Linux-based, Hyprland, "batteries-included" desktop (<https://omarchy.org>). It is an **Omarchy bar plugin**: a QML panel plus a Python backend (`Panel.qml`, `Radar.qml`, `OmdropIcon.qml`, `manifest.json`, and `bin/`, `share/`, `skills/`, `tests/`). Top-level `omdrop` CLI exposes `on/off/peers/send`. It sends **and** receives files with nearby iPhones, iPads and Macs, in both **Everyone** and **Contacts Only** mode — genuinely two-way, which is rarer than the send-only OpenDrop story. 142★, **MIT**, last updated **2026-10-12** (197 commits), 18 forks. It is active and, on its own terms, works.

### 10.2 It still assumes AWDL — via one of two Linux "radio backends"

Omdrop implements no transport itself; it needs an **`awdl0`** interface, supplied by one of two mutually-exclusive **backend packages**, both **Linux and both AWDL**:

| Backend | What it is | Hardware | Transport |
|---|---|---|---|
| **omdrop-awdl** ([brentkearney/omdrop-awdl](https://github.com/brentkearney/omdrop-awdl), GPL-2.0-only) | 14 `brcmfmac` patches + a DKMS package that expose the **Wi-Fi firmware's own AWDL** as `awdl0` (patches proposed upstream to Omarchy's `linux-aurora`) | Apple Silicon Macs, Broadcom **BCM4378/4387/4388** | **Firmware** AWDL (no userspace protocol reimplementation) |
| **omdrop-owl** ([t4t5/omdrop-owl](https://github.com/t4t5/omdrop-owl), wraps [`jedbillyb/owl`](https://github.com/jedbillyb/owl)) | Builds OWL + patches; runs AWDL **in software** through a **monitor-mode** interface with frame injection | Intel `iwlwifi`, MediaTek `mt792x`, Qualcomm `ath*`, etc. | **OWL userspace monitor-mode injection** — exactly the stack in §3.1 |

Key points:

* **"Macs and PCs" means Linux on both.** The "Mac" backend is a Linux driver (`brcmfmac`) that surfs a Broadcom firmware Windows does not expose; it is Asahi-style **Linux on Mac hardware, not macOS**. The "PC" backend is the same **OWL monitor-mode + frame-injection** approach already documented as Linux-only in §2 and §3.
* **The PC path inherits the same driver fragility.** omdrop-owl's README reports Intel cards work only in **"exclusive" mode** (Wi-Fi is turned **off** while the machine is visible) and lists MediaTek/Qualcomm/Realtek/other cards as **"untested (opt-in)"** — i.e. the identical "active monitor mode + frame injection is hard" problem, on Linux.
* **Maintenance nuance to the earlier "OWL archived" note:** what was archived 2026-10-12 is **`seemoo-lab/owl`** (the original). omdrop-owl instead builds the **`jedbillyb/owl` fork** with local patches, so at least one maintained AWDL fork exists — still Linux/monitor-mode, still no help to Windows.

### 10.3 Platform, dependencies, license

* **Host/platform:** **Linux only** (Omarchy/Arch). A Quickshell/QML bar plugin using `pkexec`/polkit, systemd, `ufw`, and NetworkManager rules. No Windows build, no Windows code path.
* **Transport:** **AWDL**, always — firmware (Broadcom) or OWL userspace injection. The radio window needs **root** (vendor firmware commands, or monitor-mode frame injection).
* **Dependencies:** `python-libarchive-c` (the receiver's only non-stdlib library); optionally **BlueZ + `python-dbus` + `python-gobject`** (Bluetooth wake advert to Contacts-Only devices) and the **1Password CLI** (identity storage); plus the chosen radio-backend package. Firewall rule: **TCP 8771 on `awdl0`, IPv6 link-local only**.
* **License:** plugin is **MIT**; backends are **GPL-2.0** (omdrop-awdl) and **GPL-3.0** (OWL, via omdrop-owl). The MIT plugin orchestrates the GPL backends over an `awdl0`/IPC boundary rather than linking them.

### 10.4 Does it prove anything about Windows? No.

* **It targets Linux, not Windows.** Omdrop is an Omarchy bar plugin; neither it nor either backend contains a Windows path.
* **It confirms, not contradicts, the report's core claim.** Omdrop is good evidence that **two-way real AirDrop on desktop is achievable when the OS hands the app an `awdl0` interface** — Linux gets that from (a) a Broadcom Wi-Fi firmware that Windows Wi-FiCx/NDIS does not surface, or (b) OWL's monitor-mode injection, which needs a Linux `nl80211` stack and an active-monitor driver (§3.1–§3.2). **Windows has neither, and Omdrop supplies no Windows AWDL stack.**
* **Identity side-note (§9.1).** Omdrop shows an Apple-issued identity can be obtained **without** `airdrop-keychain-extractor`: its README describes booting a Mac into Recovery to temporarily disable SIP, attaching **Frida** to `sharingd` during a live AirDrop transfer to capture the certificate/key/validation record, then re-enabling SIP; it also supports a **self-signed** identity (Everyone / known-senders receive) and a **1Password-backed** identity cache. This is still a **Mac-in-hand, invasive, per-user, macOS-version-dependent** procedure — the same shippability conclusion as §6/§9.1 — and it does not touch the Windows **transport** blocker.

### 10.5 Verdict: recommendation unchanged

**This does not change the Windows recommendation.** Omdrop is a Linux/Omarchy project whose "PC" story is OWL + monitor-mode injection — precisely the Linux-only path already ruled out for stock Windows in §2–§3 and §9. It neither targets Windows nor supplies a Windows transport.

* **Option A (true AirDrop on stock Windows):** ❌ unchanged — still blocked by the absent Windows AWDL stack.
* **Option A′ (WSL2 + USB passthrough):** ⚠️ unchanged — Omdrop is another data point that the working stack is **Linux + a monitor-mode/AWDL-capable radio**, which is exactly what A′ borrows; it does not make A′ shippable.
* **Option B (LocalSend protocol in Rust):** ✅ **unchanged — remains the default.** Omdrop's most useful contribution is validation that a polished AirDrop-like UX (bar/panel, radar, accept/reject, Contacts-Only sender list) is achievable — which we already deliver Apple-like via Option B. If Hover Island were ever a **Linux** app, Omdrop would be the reference implementation; as a **Windows** Tauri app it is context, not a path.

**Additional sources (this reference)**

29. brentkearney/omdrop-plugin — Omarchy (Linux) AirDrop bar plugin; MIT; 142★; updated 2026-10-12: <https://github.com/brentkearney/omdrop-plugin> (README sections: Requirements, Contacts Only, Your AirDrop identity, Privileges, License)
30. brentkearney/omdrop-awdl — `brcmfmac` DKMS patches exposing Broadcom firmware AWDL as `awdl0`; Apple Silicon BCM4378/4387/4388; GPL-2.0-only: <https://github.com/brentkearney/omdrop-awdl>
31. t4t5/omdrop-owl — OWL-based radio backend for non-Broadcom Wi-Fi (Linux monitor-mode injection; exclusive/shared modes); wraps `jedbillyb/owl`: <https://github.com/t4t5/omdrop-owl>
32. Omarchy — the Arch-Linux/Hyprland desktop Omdrop targets: <https://omarchy.org>

---

## Update: Google Quick Share ↔ AirDrop interop — does it help Windows?

**Added:** 2026-10-13 (appended; no source/config changed, no builds run). This section investigates how Google made Android's Quick Share interoperate with Apple's AirDrop, which **transport** it actually uses, whether anything about it is reachable from a third-party Windows app, and whether it changes our recommendation. **It does not change the shipped recommendation: Option B (LocalSend-protocol "Nearby" in Rust) remains the default** unless the facts below say otherwise — they do not.

> **Date note:** the interop was announced **2025-11-20** (not "~2024"). Prior updates in this doc framed Wi-Fi Aware as an *eventual* standard; the key correction from this research is that Google's AirDrop interop **already runs on Wi-Fi Aware today**, and Apple was forced to adopt it in **iOS/iPadOS 26**. The standard is live, not merely "coming".

### 11.1 The transport Google actually uses: **Wi-Fi Aware (NAN)** — not AWDL, not Wi-Fi Direct

Google's Quick Share ↔ AirDrop interop is built on **Wi-Fi Aware** (a.k.a. **Neighbor Awareness Networking, NAN**), the open Wi-Fi Alliance standard — **not** a reimplementation of Apple's proprietary **AWDL** in Android.

* **Why it works at all:** Under the EU **Digital Markets Act (DMA)**, the Commission adopted specification decisions requiring Apple to support **Wi-Fi Aware 4.0** in iOS 19/iOS 26 (and 5.0 soon after), to **deprecate AWDL**, and to make third-party Wi-Fi Aware solutions as effective as Apple's own. Apple added a **Wi-Fi Aware framework** in iOS/iPadOS 26. This is the regulatory forcing function that opened AirDrop. Ars Technica's headline is literal: *"The EU made Apple adopt new Wi-Fi standards, and now Android can support AirDrop."*
* **Android side:** Android has exposed platform **Wi-Fi Aware APIs since Android 8.0 (Oreo)** (`WifiAwareManager`, publish/subscribe discovery, `NetworkSpecifier` data paths). Google's AirDrop interop rides on that OS capability.
* **Apple side:** the **`WiFiAware`** framework (iOS 26 / iPadOS 26) supports **iPhone 12 and later**, **iPad (10th gen)+**, **iPad Air (4th gen)+**, **iPad Pro 11" (3rd gen)+ / 12.9" (5th gen)+**, **iPad mini (6th gen)+**. Note **macOS 26 is *not* on the list** — consistent with macOS not being a DMA "gatekeeper," so **AirDrop interop is not expected to work with a Mac** (it is an iPhone/iPad story).
* **Not Wi-Fi Direct for this hop:** Wi-Fi Direct and Bluetooth remain Quick Share's transports for *Android↔Windows* and older paths, but the *AirDrop* hop is Wi-Fi Aware.

**Two-way, receive-and-send.** Google's own security post says it "allowing for **two-way** file sharing between Android and iOS devices"; Ars confirms Android devices **also appear in the iPhone's AirDrop sheet**. So it is not receive-only.

**Where the code lives.** Google's interop layer is **OS/Google-Play-Services-level**, not an ordinary app: it requires the device's Wi-Fi chipset + driver to expose Wi-Fi Aware, plus the **Quick Share "extension" app** / updated **Google Play Services**. Google states the interoperability layer is written in **memory-safe Rust** and was independently penetration-tested (NetSPI), which is a useful corroboration that this is a system component rather than a third-party app.

**Rollout (2025 → 2026):**

| When | What |
|---|---|
| 2025-11-20 | Announced for the **Pixel 10 family** (iOS 26+, AirDrop set to **"Everyone for 10 minutes"**). |
| 2026-02 | Expanded to **Pixel 9** via a Google Play Services framework update. |
| 2026-03 | **Samsung Galaxy S26** (One UI 8.5) — first Samsung devices. |
| 2026-05 | One UI 8.5 stable to **Galaxy S25, S24, Z Fold7/Flip7, Z Fold6/Flip6**; "15+" phones queued (incl. **Oppo Find X9**). |

Not supported (as of mid-2026): Galaxy **S23**, **Z Fold5/Flip5**, and mid-range **Galaxy A/F/M** and **Tab A**. Apple was **not involved** in Google's implementation (Google confirmed to The Verge); **"Contacts Only"** is *not* supported — only **"Everyone for 10 minutes."**

### 11.2 Is it an OS-level capability that a third-party Windows app cannot replicate? **Yes.**

* The *discovery + link* half is **Wi-Fi Aware**, a Wi-Fi-radio/OS capability. The *AirDrop-specific* half is implemented **inside Google Play Services on Android** and **inside the OS on iOS** — neither is a public third-party SDK, and both assume the platform owns the Wi-Fi Aware radio.
* A third-party Windows app would need a **Wi-Fi Aware stack in the Windows WLAN/driver layer** to even attempt it. §3 already established that does **not** exist. So the interop is **not reachable from a Windows app** by any route other than the relay in §11.5.

### 11.3 What Windows exposes (unchanged): no Wi-Fi Aware/NAN API

* **No Wi-Fi Aware/NAN.** A Microsoft Q&A answer (Jul 2025) states flatly: Windows does **not** officially support Wi-Fi Aware in Windows 10/11/Server, **no public roadmap**, and **no indication in Insider builds or developer docs**. Our direct query of the **Microsoft Learn search API (Oct 2026)** turns up **no Windows/WinRT Wi-Fi Aware or NAN API** — the only "Wi-Fi Aware" hits are Android (Xamarin bindings) and unrelated Azure docs. There is **no `Windows.Devices.WiFiAware`** namespace. This holds for **24H2/25H2** (no announcement since).
* **Wi-Fi Direct / NDIS / WiFiCx do not help.** Windows exposes **Wi-Fi Direct** and the **WiFiCx/WDI** driver model, but neither surfaces **NAN/Wi-Fi Aware** scheduling (the Intel AX211 thread shows **Wi-Fi Direct = yes, Wi-Fi Aware = no**, and attributes it to the Windows WLAN stack, not the chip). Same class of blocker as AWDL in §3.
* **Google's own Quick Share for Windows app does *not* support AirDrop (verified).** The official help page ("Share files between Android & Windows with Quick Share") covers **Android 6.0+ ↔ Windows only** — Bluetooth + same Wi-Fi/LAN, no iPhone/AirDrop path. Structurally it *couldn't* anyway: it targets a Windows PC that has no Wi-Fi Aware. AirDrop interop is listed as an **Android/Quick-Share-on-device** feature, gated to specific phones, never Windows.

### 11.4 Open-source Quick Share/Nearby implementations — and can any speak AirDrop? **No.**

| Project | Protocol | Platforms | License | Speaks AirDrop? |
|---|---|---|---|---|
| **grishka/NearDrop** | Nearby Share/Quick Share (**LAN/mDNS**) | macOS | **Unlicense** (6.3k★) | **No.** README: AirDrop needs AWDL; "nigh-impossible… would at least require root and possibly a custom kernel." Its `PROTOCOL.md` documents the **Nearby** handshake (mDNS `_FC9F5ED42C8A._tcp.`, UKEY2, protobuf, AES-CBC/HMAC) — **not** AirDrop. |
| **Martichou/rquickshare** | Nearby Share/Quick Share (**LAN/mDNS**), **Rust** | Linux/macOS | **GPL-3.0** (3.6k★) | **No.** Wi-Fi LAN only; no Wi-Fi Aware transport, no Apple handshake. |
| **vicr123/QNearbyShare** | Nearby Share (Qt) | Linux | GPL | **No.** |
| **LocalSend** | Own REST/HTTPS protocol | Win/mac/Linux/Android/iOS | **Apache-2.0** | **No** (but is our Option B baseline). |

None of them implements **AWDL** *or* **Wi-Fi Aware**, and none implements Apple's AirDrop application handshake. They are **Nearby/Quick-Share-over-LAN** clients. The AirDrop hop is a **radio/OS-layer** concern they simply don't touch — so **none can be "extended to speak AirDrop"** without first obtaining a Wi-Fi Aware stack, which is exactly the missing Windows plumbing. (Licensing aside: the Rust one, `rquickshare`, is **GPL-3.0**, so it is *not* a drop-in for a proprietary Tauri app — the Apache-2.0 LocalSend path remains the lower-risk foundation per §6.)

### 11.5 The relay path: iPhone —AirDrop→ Android —Quick Share→ Windows

**This is real and usable today, but it is two native hops, not AirDrop-on-Windows.** The Windows PC never speaks AirDrop; the Android phone acts as the bridge (and must be one of the supported, Wi-Fi-Aware-capable phones).

```
  iPhone (iOS 26+ / iPadOS 26+)
    AirDrop = "Everyone for 10 minutes"   ──AirDrop over Wi-Fi Aware──►   Android
                                                                          (Pixel 10/9, Galaxy S26+,
                                                                           One UI 8.5 models, Oppo X9, …)
                                                                            │
                                                                            │  Quick Share
                                                                            │  (Bluetooth + Wi-Fi/LAN)
                                                                            ▼
                                                                     Windows PC
                                                                     (Quick Share for Windows)
```

**What each side must do:**
1. **iPhone/iPad:** iOS/iPadOS **26+**, hardware supporting Wi-Fi Aware (iPhone 12+), AirDrop set to **"Everyone for 10 minutes."**
2. **Android bridge:** a **supported phone** (Pixel 10/9, Galaxy S26, One UI 8.5 rollouts, etc.) with the **Quick Share extension app / updated Play Services**; it **receives** from the iPhone via AirDrop, then **sends** to the PC with Quick Share.
3. **Windows PC:** install **Quick Share for Windows**, signed in, **Bluetooth on**, both devices on the **same Wi-Fi/LAN** (or the PC on the phone's hotspot), visibility allows the sender.

**Caveats:** requires a compatible Android phone (not just any); constant re-pairing/visibility fiddling; region restrictions (Cuba/Iran/North Korea/Syria); and the whole thing is a **manual two-step user flow**. It does **not** give Hover Island an AirDrop transport — it gives the *user* a workaround if they happen to own the right phone.

### 11.6 2025/2026 news and outlook

* **Apple/Google interop is opening up — via Wi-Fi Aware, not AWDL.** The DMA-derived shift is real and shipping (see §11.1). Apple added the `WiFiAware` framework in iOS/iPadOS 26; Google shipped interop on Android.
* **Windows has gained nothing.** No Microsoft announcement adds **Wi-Fi Aware** to the WLAN stack, and no public roadmap exists (Jul 2025 answer; still true per Learn search, Oct 2026). Wi-Fi Aware requires **OS + chipset + OEM driver** support, so even a future Microsoft announcement would need OEM follow-through.
* **Net for us:** the standards path (Wi-Fi Aware) is now clearly the industry direction, but it remains **absent on Windows**. Nothing in this thread is buildable inside a stock-Windows Tauri app.

### 11.7 Verdict: recommendation unchanged

* **Transport:** Google **did not** implement AWDL in Android, and did not use Wi-Fi Direct for the AirDrop hop. It uses the **open Wi-Fi Aware (NAN)** standard, enabled by the EU forcing Apple to add Wi-Fi Aware in iOS 26 and deprecate AWDL. **Two-way**, iPhone 12+/iPadOS 26+ only, **not** macOS.
* **Reachable from Windows?** **No.** It is an **OS/Play-Services + Wi-Fi-Aware-radio** capability; Windows exposes **no Wi-Fi Aware/NAN API** (24H2/25H2 included), and Google's own **Quick Share for Windows app does not support AirDrop**. No open-source Quick Share/Nearby project (NearDrop, rquickshare, QNearbyShare) speaks AWDL or Wi-Fi Aware, so none can be extended to reach it.
* **The only iPhone-involving route** is the **two-hop relay** (iPhone → compatible Android → Quick Share for Windows). It works today but is a **user-level workaround requiring specific Android hardware** — not a feature Hover Island can implement.
* **Does it change our recommendation?** **No.** It *reinforces* it:
  * **Option A (true AirDrop on stock Windows):** ❌ still blocked — the transport is now **Wi-Fi Aware**, which is *also* missing on Windows (a second OS-level blocker, in addition to AWDL).
  * **Option A′ (WSL2 + USB AWDL passthrough):** ⚠️ unchanged — and note the landscape is shifting *away* from AWDL, so the archived OWL route is both fragile **and** increasingly obsolete.
  * **Option B (LocalSend protocol in Rust):** ✅ **unchanged — ship this.** Google's use of **Rust** for the interop layer validates the language choice for this feature class; the Android/Apple interop validates the demand; neither touches the Windows transport gap. Build the LocalSend-compatible "Nearby" panel (§7) and treat **Wi-Fi Aware on Windows** as the single thing to watch (§4.3) — if Microsoft ever ships it, Hover Island can add a real P2P transport behind the same UX.

**Additional sources (this update)**

33. Google — *Android and iPhone users can now share files, starting with the Pixel 10 family* (2025-11-20): <https://blog.google/products/android/quick-share-airdrop/>
34. Google Security — *Android Quick Share Support for AirDrop: A Secure Approach to Cross-Platform File Sharing* (two-way, Rust, NetSPI assessment, "Everyone for 10 minutes"): <https://security.googleblog.com/2025/11/android-quick-share-support-for-airdrop-security.html> · NetSPI report: <https://www.netspi.com/wp-content/uploads/2025/11/google-feature-review-report.pdf>
35. Ars Technica — *The EU made Apple adopt new Wi-Fi standards, and now Android can support AirDrop* (Wi-Fi Aware; DMA; AWDL deprecation; device list; macOS excluded): <https://arstechnica.com/gadgets/2025/11/the-eu-made-apple-adopt-new-wi-fi-standards-and-now-android-can-support-airdrop/>
36. Ditto — *Cross-Platform P2P Wi-Fi: How the EU Killed AWDL* (AWDL→Wi-Fi Aware history; DMA mandate text): <https://www.ditto.com/blog/cross-platform-p2p-wi-fi-how-the-eu-killed-awdl>
37. Apple Developer — *Wi-Fi Aware* framework (iOS/iPadOS 26; supported iPhone 12+/iPad list; macOS absent): <https://developer.apple.com/documentation/WiFiAware>
38. Android Developers — *Wi-Fi Aware* (platform API since Android 8.0): <https://developer.android.com/develop/connectivity/wifi/wifi-aware> · AOSP: <https://source.android.com/docs/core/connect/wifi-aware>
39. Wi-Fi Alliance — *Alternative Topologies / Wi-Fi Aware*: <https://www.wi-fi.org/alternative-topologies>
40. European Commission — *DMA interoperability* (Wi-Fi Aware 4.0/5.0 requirements; AWDL deprecation): <https://digital-markets-act.ec.europa.eu/questions-and-answers/interoperability_en>
41. Microsoft Q&A — *Does Windows have plans to support WiFi Aware* (no Wi-Fi Aware in Windows 10/11/Server; no roadmap; Jul 2025): <https://learn.microsoft.com/en-us/answers/questions/2284386/does-windows-have-plans-to-support-wifi-aware>
42. Google Support — *Share files between Android & Windows with Quick Share* (Android 6.0+ only; no iPhone/AirDrop): <https://support.google.com/android/answer/13801258> · Android: <https://support.google.com/android/answer/9286773>
43. grishka/NearDrop — *PROTOCOL.md* (Nearby Share protocol reverse-engineering; LAN/mDNS; not AirDrop; AWDL "nigh-impossible"): <https://github.com/grishka/NearDrop/blob/master/PROTOCOL.md>
44. Martichou/rquickshare — Rust NearbyShare/QuickShare client (Linux/macOS; **GPL-3.0**; Wi-Fi LAN only): <https://github.com/Martichou/rquickshare>
45. vicr123/QNearbyShare — Qt Nearby Share client: <https://github.com/vicr123/QNearbyShare>
46. Google UKEY2 (key exchange used by Nearby/Quick Share): <https://github.com/google/ukey2>
47. Wikipedia — *Quick Share* (rollout timeline; Availability; Quick Share for Windows): <https://en.wikipedia.org/wiki/Quick_Share>
48. The Verge — *iPhone AirDrop / Android Quick Share on Pixel 10* (Apple not involved): <https://www.theverge.com/news/825228/iphone-airdrop-android-quick-share-pixel-10>
49. PCMag — *Here Are the 15+ Android Phones Set to Get AirDrop Support Next*: <https://www.pcmag.com/news/here-are-the-15-plus-android-phones-set-to-get-airdrop-support-next> · SamMobile — *One UI 8.5 … now supports AirDrop*: <https://www.sammobile.com/news/one-ui-8-5-your-galaxy-phone-now-supports-airdrop/>
