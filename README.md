<div align="center">

# Hover Island

**The notch, for Windows.** A small pill at the top of your screen that opens into a workspace when you hover and gets out of the way when you don't.

[Website and download](https://hover-island.vercel.app) · [Report a bug](https://github.com/a-catsuki/hover-island/issues) · [Contribute](CONTRIBUTING.md)

Free and open source (MIT). Built with Rust, Tauri 2 and SolidJS.

</div>

## Why it's open source

Hover Island reads your media sessions, your notifications and the files you beam to your phone. That kind of app should be readable. Everything is here: the Rust backend, the UI, the packaging scripts and the update flow. Build it yourself, fork it, or send a fix.

## What it does

- **Media.** Album art, controls, a speaker-output visualizer (never the mic) and lyrics that scroll in time with the song. Pick how the cover looks: classic, spinning vinyl, CD, polaroid, stack or float. Works with Spotify, Apple Music and anything that reports to Windows.
- **Today, Desk, Activity.** Widgets you can drag around: weather with AQI, calendar (local plus read-only Google, Outlook and ICS), world clock, to-dos, AI usage, notifications, PC controls and more.
- **AI tools.** Codex and Claude Code activity, session and weekly limits, and a toast when an agent finishes.
- **Spotlight.** Ctrl + Space searches apps and files, ranked by what you actually open.
- **Quick settings.** Volume and brightness, Wi-Fi, Bluetooth with paired devices, Do Not Disturb, power mode.
- **Beam.** Drop files on the notch and move them to your phone over your own Wi-Fi, no cloud. Scan a QR code once, then approved phones can reconnect without it.
- **Ambient mode.** After you step away, a calm full-screen clock, now playing and weather page appears. Any input closes it.
- **Keep me awake and timed reminders.** Pick a finish time, or say "Call Ana at 4pm".
- **Windows alerts in the notch.** Hide the Windows banners and still see every alert on the island.
- **Docks anywhere.** Top, left or right edge, a full-width bar, or a side rail. It hides behind maximized windows and fades in when your cursor gets near.

## Install

Grab the latest signed package from the [site](https://hover-island.vercel.app), unzip it and run `Install.cmd`. It checks the hash and signature, asks once to trust the publisher, and installs with a Windows package identity (needed for notification access). Then open Settings, Notifications and allow Windows alerts.

Requires Windows 11, or Windows 10 with the WebView2 runtime.

## Build from source

You need Node.js 20+, Rust (stable, MSVC toolchain) and the Windows SDK.

```powershell
git clone https://github.com/a-catsuki/hover-island.git
cd hover-island
npm install
npm run dev            # browser preview with sample data
```

Native features need the desktop build:

```powershell
npm run typecheck
npm test
cargo test --manifest-path src-tauri/Cargo.toml --lib
powershell -ExecutionPolicy Bypass -File .\Rebuild.ps1        # build, package, install
powershell -ExecutionPolicy Bypass -File .\Rebuild.ps1 -Fast  # quicker local build, no LTO
```

`Rebuild.ps1` writes `build-log.txt`. Each local build gets the next package version (0.1.6.1, 0.1.6.2, ...), so Windows updates the installed app in place.

## Project layout

| Path | What lives there |
| --- | --- |
| `src/` | SolidJS front end: the island, widgets, settings window and ambient page |
| `src-tauri/src/` | Rust backend: media, notifications, Bluetooth, Beam server, usage trackers, window placement |
| `packaging/windows/` | MSIX packaging and update publishing scripts |
| `marketing/` | The landing page, deployed separately on Vercel |
| `tests/` | Front end tests (`npm test`) |
| `docs/`, `DESIGN.md`, `PRODUCT.md` | Design notes and product principles |

## Privacy

- Everything runs on your PC. There is no Hover Island account and no analytics.
- The visualizer reads speaker output, never the microphone.
- Beam is plain HTTP on your local network. Only phones you approve on the PC can use it.
- Network requests are limited to features you turn on: weather, lyrics (LRCLIB), calendar feeds you add, update checks, and Claude usage limits if you leave that option on.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to set up, what to run before sending a change, and what makes a good bug report.

## Shipping an update

1. Bump `version` in `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`.
2. Run `Rebuild.ps1`.
3. Run `packaging\windows\Publish-Update.ps1 -Notes "What changed"`. It copies the package and a `latest.json` (version, URL, SHA-256) into `marketing/updates`.
4. Run `packaging\windows\Deploy-Site.ps1`. It deploys `marketing/` from a copy outside the repo, because the Vercel CLI applies `.gitignore` and would leave the `.msix` out. Installed apps see it under Settings, General.

## Honest limits

- AirDrop is not supported. Beam is plain local HTTP.
- The webview adds memory. Collapsed is light, expanded is heavier because it is a full WebView2 page.
- Notification listening needs the installed package and your Windows consent.
- The Windows lock screen is closed to apps, so nothing can draw there. Ambient mode covers the idle screen instead.
- Weather location is approximate unless you set it. AQI is modeled, not a sensor reading.

## License

[MIT](LICENSE).
