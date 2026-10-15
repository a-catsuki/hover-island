# Genuine AirDrop on this Windows PC

**Current status: unavailable.** This PC has one Wi-Fi adapter, its built-in
Intel Wi-Fi 6E AX211 (`8086:51f0`). Windows reports monitor mode and promiscuous
mode unsupported for the installed driver. The app therefore reports
`ready: false`; it does not advertise a simulated AirDrop device or send
through LocalSend, Wi-Fi Direct, a router, or another adapter. No AirDrop
transfer has been verified with an iPhone.

Current Omdrop Owl does **not** list AX211 as supported: the `iwlwifi` AX211
profile is untested, and the upstream card report describes firmware behavior
that prevented AirDrop even on its tested AX211 variant. That report is for
PCI ID `8086:51f1`; this PC's AX211 is `8086:51f0`, so its exact hardware
variant has not been tested. Either way, Windows on this PC reports monitor
mode and promiscuous mode unsupported, and there is no Windows OWL/AWDL
backend in this app. References: [Omdrop Owl hardware and design](https://github.com/t4t5/omdrop-owl/blob/main/README.md),
[AX211 card report](https://github.com/t4t5/omdrop-owl/issues/4),
[Omdrop radio backend contract](https://github.com/brentkearney/omdrop-plugin/blob/main/docs/radio-backend.md),
[OWL requirements](https://github.com/seemoo-lab/owl/blob/master/README.md).

## Implemented groundwork

`src-tauri/src/airdrop_protocol.rs` contains transport-independent codecs for
binary-plist `/Discover` and `/Ask` messages and OpenDrop gzip-cpio and current
Omdrop DVZip upload framing. Its receive helper requires an explicit approval
permit, bounds metadata and archive sizes, rejects unsafe archive paths, and
stages files for no-overwrite commits. These components are not connected to a
network listener or sender; they are not an AirDrop runtime, and passing their
tests does not prove iPhone interoperability. Upstream protocol references:
[OpenDrop client](https://github.com/seemoo-lab/opendrop/blob/master/opendrop/client.py),
[OpenDrop server](https://github.com/seemoo-lab/opendrop/blob/master/opendrop/server.py),
[Omdrop sender](https://github.com/brentkearney/omdrop-awdl/blob/main/userspace/airdrop-send.py),
[Omdrop receiver](https://github.com/brentkearney/omdrop-plugin/blob/main/bin/airdrop-serve.py).

## Remaining work with the built-in AX211 only

The present blocker is earlier than porting the packet engine: Windows reports
no monitor/promiscuous mode, and Omdrop Owl has no verified-working AX211
profile (the upstream AX211 report identifies firmware behavior that blocked
AWDL). A Windows runtime would still need a driver/API path for AWDL-capable
raw radio access, an OWL-equivalent backend that exposes AWDL link/IP and
discovery, then TLS/HTTPS AirDrop service flows connected to the existing
codecs, explicit receive approval, progress/cancel/error handling, and
recovery. Finally, both directions need real iPhone tests. No OS radio, driver,
firmware, or security settings were changed. There is no demonstrated software
only path for this built-in AX211; an Intel-supported driver/firmware capability
or a change to the hardware constraint would be needed before a genuine Windows
AirDrop implementation can be completed.

Wi-Fi Direct is available on this PC, but Microsoft's APIs establish Wi-Fi
Direct sessions, not Apple's AWDL AirDrop link. Apple documents AirDrop as BLE
discovery followed by Apple's peer-to-peer Wi-Fi and TLS. Apple's separate
Wi-Fi Aware framework is app-specific, entitlement-gated, and paired-device
based; no public Windows API or AirDrop service contract makes it a substitute
here. Google's Quick Share/AirDrop interoperability is implemented as a Quick
Share feature on supported Android devices, not as a Windows backend. Sources:
[Apple AirDrop security](https://support.apple.com/guide/security/airdrop-security-sec2261183f4/web),
[Apple Wi-Fi Aware](https://developer.apple.com/documentation/WiFiAware),
[Microsoft Wi-Fi Direct API](https://learn.microsoft.com/en-us/windows/win32/nativewifi/about-the-wi-fi-direct-api),
[Google Quick Share interoperability announcement](https://blog.google/products-and-platforms/platforms/android/quick-share-airdrop/).
