# Hover Island: handoff for Claude Code

Paste or point Claude Code at this file. Everything below is state as of 2026-10-21 evening.

## What this is
**Hover Island** is a macOS-notch-style overlay for Windows. Tauri 2 (Rust, `src-tauri/`) plus SolidJS and Vite (`src/`).
- Repo: `C:\Users\HP\source\hover-island`, origin `github.com/a-catsuki/hover-island`, branch `main`.
- Packaged as a signed MSIX. Install and rebuild: `powershell -ExecutionPolicy Bypass -File .\Rebuild.ps1 -Fast` (log goes to `build-log.txt`).
- Open source (MIT). `README.md`, `LICENSE`, `CONTRIBUTING.md` exist. Landing page lives in `marketing/`, deployed to Vercel project `hover-island`.
- Owner preference: casual, human copy, no em dashes.

## The most important caveat
**None of the recent Rust has been compiled.** The earlier sessions ran in a Linux container that cannot build the Windows Rust. Frontend was verified (tsc, 169 node tests, Playwright screenshots). First job: run `Rebuild.ps1 -Fast`, fix any compile errors in the files below.

Rust files edited but never compiled: `bluetooth.rs`, `media.rs`, `transfer.rs`, `ambient.rs`, `single_instance.rs`, `settings.rs`, `lib.rs`, `main.rs`, `devices.rs`, `lyrics.rs`. Also two new windows crate features were added in `Cargo.toml`.

Also run `cargo test` in `src-tauri` and `npm test` (expects 169 passing) and `npm run test:ui` (Playwright smoke, `scripts/ui-smoke.mjs`).

## Sync lesson
Earlier files were pushed to the PC one by one and some silently never landed (an old `NativeAppsPanel.tsx` and old jelly-physics files were found on the PC). They were fixed, and the repo now matches the last known good copy. If something "didn't update", compare file hashes before debugging the code.

## What was built or changed (all in the repo now)
1. **Bluetooth** (`bluetooth.rs`, `BluetoothView.tsx/.css`): paired-device list now has `available` (via `System.Devices.Aep.IsPresent`), a PowerShell WinRT reader and a PnP fallback. UI shows only **Connected** and **Available (in range)** groups. "Other paired devices" was removed on purpose. The hexnode script the user linked only lists PnP entries and does not check connection, so it was not adopted.
2. **Jelly physics** (`src/state/motion.ts`, `Island.tsx`, `magneticShape.ts`, `placement.rs`): magnet is subtle (`MAGNET_MAX = 4`); the jelly feel lives mainly in expand/collapse via a softer height spring. User said earlier versions were "too wiggly".
3. **Media** (`media.rs`, `src/state/media.ts`, `MediaView.tsx/.css`, `lyricsSync.ts`):
   - Smooth position clock with seek hold; backend stops re-sending a stale anchored position; stale-cover hold on automatic track changes.
   - Lyrics now highlight the whole current line (Spotify style); the old karaoke fill was removed.
   - Seek fix (uncompiled): `timeline_from_ticks` treats an empty seek window as the full track when position control is enabled (Apple Music reports an empty window).
4. **Lyrics lookup** (`lyrics.rs`, uncompiled): `/api/get` result that is plain-only now falls back to a search (`track_name+artist`, then free text `q`) to find a timed LRC. The user saw "Not timed · LRCLIB" before. Results cache in memory for 12 h.
5. **Album cover styles** (classic, vinyl, cd, polaroid, stack, float): `coverStyle` setting, CSS in `MediaView.css`.
6. **File Beam** (`transfer.rs`, `BeamBucket.tsx`): trusted-phones toggle (no QR for approved phones), 30-day cookie, IP bookmark URL. The user said: if it does not work properly, fall back to QR only. Unverified on real devices.
7. **Ambient mode** (`ambient.rs`, `src/ambient/*`, `ambient.html`, capability `ambient.json`):
   - Redesigned: aurora background in album colours (or time-of-day colours), huge thin clock, minute line, weather, frosted now-playing card with live progress.
   - Idle detection via `GetLastInputInfo`.
   - New setting `ambient.takeOverScreensaver` (default true): opens ~20 s before the Windows screensaver would (`SystemParametersInfoW`) and holds the display awake with `SetThreadExecutionState` while shown. Apps cannot draw above the screensaver or lock screen; this replaces it instead.
8. **Single instance guard** (`single_instance.rs`): fixes the duplicate collapsed and expanded windows.
9. **Hover watchdog** in `Island.tsx`: fixes the notch stuck expanded.
10. **Connections page** (`NativeAppsPanel.tsx/.css`): bento layout (tiles, suggested, browse). The user complained it was still the old list; that was the sync issue above. Re-check on the real build.
11. **Settings** (`SettingsApp.tsx`): 9 sections; Shortcuts and About are their own pages. Ambient and Album cover groups sit under Appearance. Updates panel shows the build time.
12. **Widget layout editor** (`WidgetManager.tsx`, `widgetPlacement.ts` `fitShapeAt`): compact widgets can go in any free cell. Layout patches now save as one unit. Test added in `tests/panels.test.mjs`.
13. **World clock** (`ClockView.tsx/.css`): pills with sun/moon glyph, offset caption, analog or digital. Globe button opens a picker with region tabs (Americas, Europe, Africa, Asia, Oceania, Selected), search, tick-to-toggle, Add all / Clear per region, and a toggle to hide the local clock. Storage keys: `hover-island.clock.cities.v1`, `hover-island.clock.local.v1`. The smoke test now clicks "Choose cities".
14. **Network widget** (`NetworkWidget.tsx/.css`): compact; Download and Upload side by side with live bars, Start/Stop in the header, ping row with sparkline, avg/jitter/loss when tall, recent tests when tall or wide. Backend (`network.rs`) unchanged (Cloudflare test, capped transfer).
15. **Charging notifications** (`devices.rs`, uncompiled): battery is polled every 250 ms; Bluetooth every 12th tick (3 s). Before, alerts waited behind the slow Bluetooth scan.
16. `Rebuild.ps1` stops stray non-WindowsApps `hover-island` processes and relaunches the installed package.

## Open issues and unverified items
- **Wi-Fi and Bluetooth quick settings "not working as intended"**: not diagnosed. Code is in `quick_controls.rs` (WinRT `Windows.Devices.Radios`, `ensure_radio_access`, `set_radio_kind`) and `QuickSettingsView.tsx`. `AppxManifest.xml` already declares the `radios` and `bluetooth` capabilities. Needs the actual symptom or toast text from the user.
- **Claude Code AI activity "still wrong"** (should look like Codex): not diagnosed. Relevant: `src-tauri/src/usage/claude_limits.rs` (reads `~/.claude/.credentials.json`; returns nothing when the token is expired because it never refreshes), `agent_events.rs`, `AiView.tsx`. Ask for a screenshot and what Codex shows that Claude does not.
- **Vercel deploy failing**: root cause unknown. Two untracked files were created on the PC, `vercel.json` (root, `outputDirectory: "marketing"`, no install or build) and `marketing/vercel.json` (`outputDirectory: "."`). They are not committed or pushed. Next step: commit and push, check Project Settings > Root Directory (empty or `marketing`, no trailing slash) and build overrides, then read the failing build log. There is also a stray untracked `.pc-md5.txt` in the repo root to delete.
- **Auto-update depends on that deploy**: `updater.rs` polls `https://hover-island.vercel.app/updates/latest.json` (45 s after launch, then every 24 h, never installs without a click; verifies SHA-256 of the `.msix`). Packages and the manifest live in `marketing/updates`. There is no confirmed script that publishes new versions there.
- Things to confirm on the real build: duplicate "Today 2 / Recovered N" pages fold back; Beam no-QR works; lyric sync on Apple Music (if off by a constant, add an offset); ambient mode and screensaver takeover; scrubbing.
- Not done, offered: Atmosphere swatches rendering blank in Settings; checking the README and FAQ claims ("no account, no analytics") before publishing; Telegram's generic icon.
- Uncommitted work: git HEAD is `e51a5c9 "widget fixes"`. Everything after it is uncommitted on the PC.

## Useful facts
- Beam: axum server on port 47692, device approval by cookie tied to the exact origin or IP.
- Widget grid: 2x2 pages; `widgetPages`, `SHAPE_SPAN`, `WIDGET_SHAPES`, `fitShapeAt`, `fitPanelLayout`.
- Landing page: pinned scroll story, SVG path drawing, IntersectionObserver reveals, notch-style nav that collapses to name + download + star and expands on hover. Old version backed up in `backups/marketing-before-redesign/`. `assets/foot-cursor.png` and `foot-wordmark.png` were cut from `assets/logo.png` for the footer.
- Visual checks: Playwright with Chromium at `/opt/pw-browsers/chromium` against `npx vite --port 5199`. Preview mode (`src/lib/preview.ts`) mocks the backend in a plain browser. Pages: `index.html`, `settings.html`, `ambient.html`.
- The container could not reach Google Fonts or GitHub, so screenshots used fallback fonts and a star count of 1.
