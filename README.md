# Hover Island

A notch for Windows. It sits at the top of your screen as a small pill, opens into a workspace when you hover, and gets out of the way when you don't. Free, local, built with Rust, Tauri 2 and SolidJS.

Site and download: https://hover-island.vercel.app

## What it does

- **Media.** Album art, controls, a speaker-output visualizer (never the mic) and lyrics that scroll in time with the song. Works with Spotify, Apple Music and anything that reports to Windows.
- **Today, Desk, Activity.** Widgets you can drag around: weather with AQI, calendar (local plus read-only Google, Outlook and ICS), world clock, to-dos, AI usage, notifications, PC controls and more. Rename the pages however you like.
- **Spotlight.** Ctrl + Space searches apps and files, ranked by what you actually open. Every installed app is searchable and pinnable, with its real logo.
- **Quick settings.** Volume and brightness sliders, Wi-Fi, Bluetooth, Do Not Disturb, power mode.
- **Beam.** Drop files on the notch, scan the QR on your phone, same Wi-Fi, no cloud. Links expire after 30 minutes.
- **Keep me awake.** Pick a finish time. The PC stays on and a gentle alarm nudges you until it is done.
- **Timed reminders.** "Call Ana at 4pm" and the notch taps you at 4pm.
- **Windows alerts in the notch.** Hide the Windows banners and still see every alert on the island.
- **Docks anywhere.** Notch on the top, left or right edge, a full-width bar, or a side rail. It hides behind maximized windows, fades in when your cursor gets near, and opens when you are on it.
- **Updates itself.** Settings, then About, then Check for updates. It installs over the old version and keeps your settings.

## Install

Grab the latest signed package from the site, unzip it and run `Install.cmd`. It checks the hash and signature, asks once to trust the publisher, and installs with a Windows package identity (needed for notification access). Then open Settings, Notifications and allow Windows alerts.

Windows 11, or Windows 10 with the WebView2 runtime.

## Build from source

```powershell
npm install
npm run typecheck
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib
powershell -ExecutionPolicy Bypass -File .\Rebuild.ps1   # build, package, install
```

`npm run dev` opens a browser preview with sample data. Native features need the desktop build.

`Rebuild.ps1` writes `build-log.txt`. Each local build gets the next package version (0.1.6.1, 0.1.6.2, ...), so Windows updates the installed app in place and you never have to uninstall.

## Shipping an update

1. Bump `version` in `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`.
2. Run `Rebuild.ps1`.
3. Run `packaging\windows\Publish-Update.ps1 -Notes "What changed"`. It copies the package and a `latest.json` (version, URL, SHA-256) into `marketing/updates`.
4. Deploy the site from `marketing/`. Installed apps see it under Settings, About.

## Honest limits

- AirDrop is not supported. Beam is plain local HTTP with a random link.
- The webview adds memory. Collapsed is light, expanded is heavier because it is a full WebView2 page.
- Notification listening needs the installed package and your Windows consent. The bare exe cannot do it.
- Weather location is approximate unless you set it. AQI is modeled, not a sensor reading.
- Usage numbers come from provider reports and local logs, and never refill on their own after a reset time passes.

More detail lives in `docs/`, `DESIGN.md` and `PRODUCT.md`.
