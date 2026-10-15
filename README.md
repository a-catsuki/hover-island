# Hover Island

A Windows notch workspace built with Rust, Tauri 2 and SolidJS.

## Current pass: 14 October 2026

The latest source and browser UI implement named panels, ambient/reactive scenes, higher opacity, Small/Medium/Large sizing, drag-and-drop widget arrangement, weather with approximate auto-location and US AQI, an interactive local month calendar, remaining AI allowance/reset details, and sourced global/banked Codex reset monitoring.

Media seeking checks the active Windows session's capabilities and timeline bounds. The visualizer uses shared 24-band WASAPI speaker-output capture with an explicitly named ambient fallback. Bluetooth connection/disconnection and power transitions have quiet startup baselines, cached status, and compact temporary notch expansions. No microphone input is used.

**Windows installation:** use the signed MSIX installation kit recorded in `docs/verification/current-build.json`. Extract its ZIP and run `Install.cmd`. This checks the hash, package signature and publisher, requests approval for the personal signing certificate when needed, and installs Hover Island with a Windows package identity. Then choose Settings → Alerts → Request access and allow Windows notifications. The raw executable alone does not have notification-listener package identity.

The Apple design pass adds interruptible jelly-like springs, deeper blacks, red calendar accents, an ochre analog/digital clock and colored functional cards. Event bursts coalesce, deliberate hover/focus/pin adopts a peek, and expiry preserves user-open panels. Native host bounds stay fixed. The Files shortcut reveals the bucket in its custom panel.

**Phone sharing:** scan a locally generated QR on the same Wi-Fi. The temporary phone page stages files/photos before Send, and downloads files added from the PC. PC picker/drop uploads start a session automatically; received files save to Downloads / Hover Island and produce DND-aware notch peeks. Stop cancels queued uploads; links expire after 30 minutes. This is local HTTP with a random session link, not AirDrop. See `docs/phone-sharing.md`.

The current source includes contour, dot, grid and wave themes; ten visualizer styles including real reactive ambient light; separate clock typography/hour-cycle/seconds controls; city selection; draggable page previews; optional website feeds; Google/Outlook calendar subscriptions; and the Reset radar widget. Current verification is recorded in `docs/verification/current-build.json`. Physical iPhone/Wi-Fi/firewall and notification consent remain separate runtime checks.

```powershell
npm run typecheck
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib --offline --locked
cargo test --manifest-path src-tauri/Cargo.toml --lib --offline --locked audio::tests::default_render_loopback_opens_reads_and_stops -- --ignored --nocapture
npm run tauri:build -- --debug --no-bundle
```

`npm run dev` provides a clearly labeled sample-data preview. `npm run test:ui` requires that server or `UI_URL` pointing at the production preview, and an installed Playwright/browser runtime.

## Integration limits

- AirDrop remains unavailable. Current Owl lists AX211 as unverified, and an upstream report describes firmware limitations on a different AX211 hardware ID. This PC also lacks the required Windows raw-radio path. Existing codecs are not a working AirDrop service. See `docs/airdrop-implementation.md`.
- The signed personal MSIX declares notification listener, Bluetooth/radio and network capabilities. Notification listening requires installation and the user's Windows consent. Certificate trust is requested only by the installer; building does not trust a certificate or install an app.
- Optional native website feeds, including the ERP adapter, keep polling without a website window. Desktop alerts use real Windows notifications. Website shortcuts do not create inbox/API connections. See `docs/website-alerts.md`.
- Google/Outlook calendar subscriptions refresh every five minutes and support recurring events and time zones. They are read-only; local events remain editable. See `docs/calendar-sync.md`.
- Automatic weather location is approximate and derived from the public IP, with persistent manual override. AQI is a modeled US AQI value from CAMS ENSEMBLE/Open-Meteo, not a local sensor measurement.
- Usage comes from recorded provider reports and local logs. A passed reset time does not automatically refill the displayed quota. Reset Watch polls a credited public feed every 15 minutes while the app runs, links original X posts, and distinguishes banked grants from global resets. It does not redeem credits or change account limits.

See `handover.md`, `docs/design-references.md`, and `docs/verification/current-build.json`. The original source snapshot remains in `backups/before-revamp-20261013.zip`.
