# Hover Island — Implementation Plan & Backlog

> Living document. Append new features here as they come up; never delete history — move
> items between status sections and record decisions in the Decision Log.
> Last updated: 15 October 2026 · app version **0.1.4**.

---

## 0. How to use this document

1. Pick an item from **§3 Backlog** (respect the suggested priority).
2. Read its **§5 Feature plan** for approach, files, and verification.
3. Resolve any **open decisions** listed on the item (log the answer in **§4**).
4. Implement, then run the **§6 Verification** commands and paste results into the item.
5. Move the item to *Done* and update the baseline in §6.

**Status legend:** `idea` → `planned` → `blocked` → `in-progress` → `implemented` (external validation recorded separately) → `done`

**Conventions / guardrails (apply to every task):**
- `src/lib/ipc.ts` is a **frozen IPC contract** — command strings and event names must be
  updated on both the Rust and TS sides together.
- Native work runs off the UI thread (`spawn_blocking` / dedicated workers); all `unsafe`
  is guarded and must not panic. Secrets go through **DPAPI** (`erp.rs::protect/unprotect`),
  never logged, never returned to the UI.
- Network calls: bounded size, redirects disabled, timeouts, HTTPS-only (HTTP for localhost).
- UI: Apple design language — instant press feedback, interruptible springs, spatial
  consistency, and **everything non-essential gated behind `prefers-reduced-motion`**.
  Reference: `.agents/skills/apple-design/SKILL.md`.
- Don't add dependencies without justification; the crate already has `reqwest`, `axum`,
  `tokio`, `serde`, `sha2`, `base64`, `qrcode`, `ical.js`, and the `windows` crate with
  `Devices_Bluetooth` / `Devices_Enumeration` / `Win32_*` features enabled.

---

## 1. Repo orientation — the seams every feature plugs into

| Concern | Where | Notes |
|---|---|---|
| IPC contract (commands/types/events) | `src/lib/ipc.ts` | Single source of truth; keep in sync with `src-tauri/src/lib.rs` `generate_handler!` |
| Native settings schema + validation | `src-tauri/src/settings.rs` | `#[serde(default)]` struct; unknown enum values are repaired. Add fields here for new prefs |
| Secure connector storage | `src-tauri/src/erp.rs` (`protect`/`unprotect`, `app_data_dir()`) | DPAPI pattern to reuse for any credentials |
| Background pollers / HTTP | `src-tauri/src/erp.rs`, `reset_watch.rs`, `devices.rs` | Bounded reads, redirects off, last-good retention |
| Native → frontend events | emitted via `app.emit("...")`, consumed with `listen()`/`on*()` in `ipc.ts` | e.g. `ai://event`, `device://event`, `website://connections-changed` |
| Toast / peek system | `src/state/peek.ts` + `src/components/shell/EventPeek.tsx/.css` | `ingest*Peek` helpers; categories `erp/website/transfer/ai/preference`; **no close button** (timeout/tap/swipe) |
| Peek sizing / notch expansion | `src/components/shell/Island.tsx` `targetFrame()` | device peek 84, normal 112, transfer 148; **add a size here for a new peek** |
| Collapsed pill | `src/components/shell/CollapsedPill.tsx/.css` | compact items, alert badge |
| Audio capture (WASAPI loopback) | `src-tauri/src/audio.rs` → `audio://spectrum` (24 bands, ~24 fps) | frontend `src/state/audio.ts`, `src/lib/audioMetrics.ts` |
| Visualizers | `src/components/views/Visualizer.tsx`, `src/lib/visualizerStyles.ts`, `Visualizer.css` | styles + `normalizeVisualizerStyle` |
| Ambient background / scenes | `src/components/shell/AmbientBackground.tsx/.css` | scenes incl. `reactive`, `artwork`, patterns |
| Media + album art | `src-tauri/src/media.rs`, `src/components/views/MediaView.tsx` | `NowPlaying.thumbnail` is a `data:` URL |
| Calendar (local + ICS subscriptions) | `calendar.rs`, `calendar_sources.rs`, `CalendarConnectionsPanel.tsx` | read-only ICS; **no OAuth** |
| Website/alerts connectors | `src-tauri/src/erp.rs`, `src/state/erp.ts`, `WebsiteConnectionsPanel.tsx` | generic feed + ERP adapter |
| Bluetooth (read-only today) | `src-tauri/src/devices.rs`, `quick_controls.rs`, `BluetoothView.tsx` | monitoring + radio toggle only |
| Quick controls | `src-tauri/src/quick_controls.rs`, `QuickSettingsView.tsx` | volume/brightness/DND/night-light/power/BT-radio |
| Settings window UI | `src/settings/SettingsApp.tsx`, `src/settings/*`, `src/components/settings/*` | panel components; `Group`/`Toggle`/`Field`/`Slider` from `controls.tsx` |
| Widgets | `src/components/widgets/registry.tsx` | kind → render + detail page via `requestWidgetDetail()` |
| Verification harnesses | `scripts/*.mjs`, `docs/verification/*` | Playwright-based browser checks; screenshots + measured results |

---

## 2. Verification baseline (re-confirm on each pass)

| Command | Expected |
|---|---|
| `npm run typecheck` | clean |
| `npm test` | **81 pass / 0 fail** (16 October final pass) |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib --offline --locked` | **153 pass / 0 fail / 11 ignored**; selected live checks run separately |
| `npm run build` | succeeds |

Browser/visual verification uses Playwright with the locally cached browsers:
`chromium.launch({ executablePath: "%LOCALAPPDATA%\ms-playwright\chromium-1243\chrome-win64\chrome.exe" })`
(install driver with `npm i --no-save playwright`; browsers are already cached). Prefer
**measured DOM/canvas assertions** (sizes, `getImageData` stats, overflow) over screenshots,
since the reviewing agent cannot view images.

> Known pre-existing flaky native test: `transfer::tests::local_http_bucket_uploads_lists_and_downloads_without_overwrite`
> (tiny zip buffers fully before the second request, so the 429 guard races). Not caused by
> feature work; either skip locally or make the race deterministic separately.

---

## 3. Backlog

| ID | Feature | Status | Blocked on | Suggested priority |
|----|---------|--------|-----------|--------------------|
| P1 | Email verification/2FA codes → notch toast | **implemented** | Live OAuth requires provider registration/sign-in | High (user-requested) |
| P2 | Weather: data expansion + animation/UI overhaul | **implemented** | Native parser and browser forecast checks pass | High |
| P3 | App connections actually working | **implemented** | Native sources + supported background feeds; universal account adapters are not claimed | Medium |
| P4 | Windows desktop alerts live consent/delivery | **implemented** | Installed 0.1.4 package reports allowed access and two actual Windows toasts; new third-party arrival remains separate | Medium |
| P5 | UI/UX overhaul passes | **implemented** | Device interaction remains separately validated | Continuous |
| P6 | Media visualizers: true audio reactivity + album-art ambient | **implemented** | Owned real audio capture + injected-render checks pass; physical switching remains separate | High |
| P7 | Bluetooth device management (connect/disconnect/etc.) | **implemented** | Paired inventory read passes; driver-dependent actions need actual user/device interaction | High (user-requested) |

---

## 4. Decision Log

Record resolved choices here (date + decision) so they are not relitigated.

| Date | Feature | Decision |
|------|---------|----------|
| 2026-10-17 | P6 | Capture every distinct default render endpoint (Console/Multimedia/Communications) at once and merge bands by per-band peak; hold the last frame through packet gaps (160 ms) and re-open when the default device set changes. A single endpoint can sit on a silent role while playback runs on another. |
| 2026-10-17 | Widgets | The grid cell a user drops a widget into is persisted (`slot`) and pinned ahead of flow packing; equal-size tiles trade places (cells when sized or already placed, flow order for legacy unsized pairs so their full-column look survives), unequal pairs insert before the target. Pointer capture is the only drag path in the editor because native HTML5 drag cancels pointer streams in WebView2. |
| 2026-10-17 | Shell | The resting collapsed notch is MacBook-exact: flush with the screen top, straight sides, bottom corners rounded ~10.6 px at the 320x38 preset. No pinched teardrop; magnetic deformation moves the outline without changing the resting silhouette. |
| 2026-10-16 | P1 | Google and Microsoft authorization code + PKCE with a loopback callback; user-supplied desktop client registration. Read-only metadata/previews, opt-in per-account pause, DPAPI tokens, codes in memory up to ten minutes. |
| 2026-10-16 | P2 | Now/Hourly/7-day modes in a single widget, 24 hours and seven days, metric default with saved imperial switch. Real feels-like, wind, humidity, pressure, UV, solar and AQ particulate data. |
| 2026-10-16 | P6 | Reactive album ambient upgrades Artwork; media surface adds Mirror, Radial and Particles. Audio capture stops when closed. Raw signal drives light envelopes, adaptive gain drives geometry; endpoint polling recovers changed output. |
| 2026-10-15 | P7 | Implement paired-device list in the Bluetooth widget and Quick Settings; allow guarded audio endpoint connect/disconnect only when the Windows BtAudio KS properties are supported; use Windows Settings for new pairing and as the fallback for other device types; require a separate in-app confirmation before unpairing; show battery only when Windows supplies a percentage. |
| 2026-10-15 | — | **All plans live in this single file** (`docs/PLAN.md`) |

---

## 5. Feature plans

### P1 — Email verification / 2FA codes → notch toast

**Goal.** Connect email account(s); when a new message contains a one-time/2FA code, show it
as a notch toast with a *slight* expansion and mirror it in the collapsed pill (iOS-style).

**Open decisions.** (a) Gmail auth path — **OAuth (PKCE, loopback)** vs **IMAP + App
Password**; (b) providers now (Gmail only, or Gmail + Outlook/Microsoft Graph); (c) retention
(hold until copied/expired vs auto-dismiss ~4s); show sender/subject or code only; (d) OK to
keep codes in memory ~10 min only.

**Approach.**
- **Native** `src-tauri/src/email_codes.rs`:
  - DPAPI store `email-codes.dpapi` (reuse `erp::protect/unprotect`); credentials never
    returned to the UI/logs.
  - Background poller (while app runs, ~20–30 s). Provider adapters:
    - *Gmail API*: OAuth 2.0 PKCE with loopback redirect (host with `axum`), `gmail.readonly`,
      `users.messages.list?q=...` + `messages.get` (headers/snippet only).
    - *IMAP*: `imap.gmail.com:993` + App Password (add an IMAP crate; `native-tls`/rustls).
    - *Outlook/M365*: Microsoft Graph OAuth (basic-auth IMAP is disabled).
  - **Code extraction**: senders (`no-reply@`, `security@`, `accounts.google.com`…), keywords
    (code/OTP/verification/one-time/2FA/sign-in), regex 4–8 digits or alphanumeric near a
    keyword; drop years/prices/phone numbers; dedupe by message id; ignore messages older than
    the connection baseline. Unit-test the extractor with fixtures.
  - Emit `auth://code` `{ id, code, sender, subject, account, receivedAt }`.
- **Frontend** `src/state/emailCodes.ts` → `ingestTwoFactorPeek`.
  - `peek.ts`: `ingestTwoFactorPeek` (honors DND + `notifications.enabled` + new toggle;
    sets pending alert; plays chime).
  - `Island.tsx` `targetFrame`: new `otpPeek()` → e.g. `{ width: min(360, expanded.w), height: ~96, radius: 22 }`.
  - `EventPeek.tsx/.css`: `.peek--otp` variant — large tabular code, sender line, **Copy**
    button, expiry hint; reuse jelly motion; no close button.
  - `CollapsedPill.tsx`: reuse `pill__alert-badge` to show the code when collapsed.
- **Settings**: new `EmailCodesPanel` (provider, label, credential/OAuth, test, remove, pause)
  under Connections; notifications toggle.
- **IPC**: `AppNotification.category: 'auth'`, `code?`/`sender?`; `EVT.authCode`, `onAuthCode`,
  `cmd.emailCodes*`; register commands in `lib.rs`.
- **Docs**: `docs/email-codes.md` with the security model.

**Security.** Read-only; headers/snippet only; bounded sizes; codes held in memory only and
expire; removing a connection deletes its local credentials (prompt to revoke upstream).

**Verification.** Native unit tests for extraction + storage validation; ignored live smoke
against a test inbox; browser harness with a synthetic `auth://code` event.

---

### P2 — Weather: data expansion + animation/UI overhaul

**Goal.** Present *all* weather information well, with major animation improvements.

**Current gap.** `weather.rs` fetches only current `temperature_2m` + `weather_code`, today's
`temperature_2m_max/min`, and `us_aqi`. `WeatherView.tsx` already has an animated SVG icon, a
particle atmosphere, an AQI meter, and a hover/Details reveal.

**Open decisions.** (a) Rich forecast in the **detail page**, the small tile, or **both**
(recommended both); (b) add a **°C/°F** (+ km/h vs mph) setting, default metric; (c) hourly
**12h vs 24h**; daily **5 vs 7 days**; (d) extra must-haves.

**Approach.**
- **Native** (`weather.rs`, `types.rs` → `WeatherSnapshot`, `ipc.ts`):
  - `current`: `apparent_temperature`, `relative_humidity_2m`, `wind_speed_10m`,
    `wind_direction_10m`, `precipitation`, `is_day`, `surface_pressure`, `cloud_cover`.
  - `hourly` (next N): `temperature_2m`, `weather_code`, `precipitation_probability`.
  - `daily` (5–7): `weather_code`, `temperature_2m_max/min`, `sunrise`, `sunset`,
    `precipitation_probability_max`, `uv_index_max`, `wind_speed_10m_max`.
  - Optional AQ: keep `us_aqi`, add PM2.5/PM10. Keep 15-min cache; extend tests; keep
    backward-compatible fields.
- **Frontend** (`WeatherView.tsx/.css`):
  - **Summary tile**: hero temp + animated condition icon, feels-like, condition, city,
    today hi/lo, mini hourly peek.
  - **Detail page** (`requestWidgetDetail('weather')`): hourly strip (scrollable, current-hour
    highlight), 7-day rows with gradient hi/lo range bars + precip chance, and a detail grid
    (humidity, wind + rotating compass, UV bar, pressure, cloud cover, sunrise/sunset with an
    animated **sun-arc** showing the current position).
  - Animated scene tied to `is_day` + code; particle-capped; paused when closed/off-screen
    (`sceneActive`/`islandOpen`); reduced-motion gated.
  - Interactivity: Now/Hourly/7-day segmented control, scrubable hourly strip, unit toggle,
    skeletons, stale states.
- **Settings**: units + which sections to show.

**Verification.** Native parse tests; browser harness feeding a fixed snapshot; screenshots +
measured layout at tile and detail sizes.

---

### P3 — App connections actually working

**Decision.** Use Windows notification-source matching for installed apps and keep the existing
read-only website-feed connector for services that publish a compatible feed. Do not build a
browser extension in this pass. Keep the curated web catalog as a collapsed shortcut list; saving
a shortcut never means an account is connected. Browser notifications can only be matched under
the browser's Windows source name unless an extension is added later.

**Current boundaries.** Native source matching works only for alerts Windows actually delivers
and attributes to that source; it does not sign in to apps. Generic website feeds validate a
same-origin read-only feed and may use a user-supplied bearer key, encrypted in Windows storage.
They do not import browser cookies, use an account session, or provide universal Gmail/Instagram/
Slack integrations. A website must publish the compatible feed itself.

**Implementation.** Settings now prioritizes observed Windows notification sources, supports
adding a source directly or by name, and preserves per-source routing tests. The curated web
catalog is a separate collapsed shortcut section. Website feed setup starts with name and origin;
feed path and bearer key are under advanced settings. Connected feeds show health, recent alert
count, last successful poll, retry, and remove controls. The backend keeps its existing poll,
secure secret storage, and feed validation.

**Verification.** Run the browser Connections workflow with mock IPC to verify observed-source
addition, native routing-test state/disabled states, shortcut disclosure, feed setup progressive
disclosure, successful/error status, refresh/retry and removal. This proves the frontend contract
only; native notification delivery still needs Windows permission and an installed app, and a
real feed needs an externally hosted compatible endpoint.

---

### P4 — Windows desktop alerts live consent/delivery

**Goal.** Make reading real Windows toasts work end-to-end.

**Reality.** Requires MSIX **package identity**, the declared `userNotificationListener`
capability, and the user's Windows permission. Packaging exists
(`packaging/windows/Build-Msix.ps1`, signed kit recorded in `docs/verification/current-build.json`).

**Approach.** Verify on an installed package: request access on the UI thread, re-check status
each poll, handle revocation (empty result, not an error). Add a clear in-app status + guidance
in Settings → Notifications. Source selection already exists under Connections.
Files: `notifications.rs`, `NotificationsView.tsx`, `SettingsApp.tsx`, `docs/notifications.md`.

---

### P5 — UI/UX overhaul passes

**Goal.** Driven by user feedback; keep polishing layouts, icon/spacing consistency, and motion.

**Known items to re-check.** Weather tile overflow (`.widget--weather`), any remaining clutter
in the expanded panel, empty/edge states, and the dock/bar/sidebar transitions.
Files: `styles/shell.css`, `styles/dashboard.css`, `styles/polish.css`, `ExpandedPanel.tsx`.
(Add specific findings here as the user reports them.)

---

### P6 — Media visualizers: true audio reactivity + album-art ambient

**Goal.** Make every visualizer genuinely move with the music; add a YouTube-style ambient
scene derived from the album art and its colours.

**Root causes found (why it isn't reactive today).**
- **Native** (`audio.rs`): only the `eMultimedia` endpoint role is tried (no fallback) → silence
  if the active device differs per role; **no device-change recovery** (headphones switch leaves
  a silent-but-alive stream); 512-pt FFT; fixed gain `rms*36`.
- **Frontend**: `audioMetrics.adaptSpectrumLevels` applies up to **24× makeup gain** that
  flattens dynamics; `energy = sqrt(all-0.012)*2.6` **saturates at 1** so the ambient light looks
  constant; smoothing is per-frame, not `dt`-based.
- **No album-art colour extraction exists** (`artwork` scene is just a CSS-blurred image).

**Open decisions.** (a) bars placement (strip / whole-notch background / dedicated full page /
several); (b) album ambient as a **new** scene or replace `artwork`; (c) glow while collapsed or
quiet until open; (d) style shortlist (Album Ambient, Mirror Bars, Radial Spectrum, Particles).

**Approach.**
- **Native**: role fallback (`eConsole → eMultimedia → eCommunications`); endpoint-change
  recovery via `IMMNotificationClient` (+ 2s default-device-id poll fallback); `FFT_SIZE 1024`
  Hann; emit `{ bands[24], rms, bass, mid, treble, peak }`; zeros when silent; unit tests for
  endpoint selection/change; extend the ignored live smoke.
- **Frontend dynamics** (`audioMetrics.ts`, `Visualizer.tsx`): slow **AGC** (attack ~5ms /
  release ~250ms) preserving relative dynamics; per-band noise gate; **onset/beat** detection on
  bass → `punch`; **dB-mapped** `energy` (no saturation); **`dt`-based** smoothing; expose
  `--audio-bass/mid/treble/punch/energy` CSS vars.
- **Styles** (`Visualizer.tsx`, `visualizerStyles.ts`, `Visualizer.css`): rebuild on new
  dynamics; add peak-hold caps + kick to `bars`; new **Album Ambient** (YouTube-style),
  **Mirror Bars**, **Radial Spectrum**, **Particles-to-beat**; first-class sized surfaces
  (media strip + optional full visualizer page).
- **Album palette** (new `src/lib/albumPalette.ts`): on track change, draw
  `nowPlaying().thumbnail` (a `data:` URL, untainted) to a ~32px canvas; median-cut/k-means for
  dominant + vibrant colours (3 stops, OKLCH interpolation); cache by thumbnail identity;
  expose `--album-1/2/3`; **Artwork/Album Ambient** = blurred+scaled cover + palette light
  fields driven by bass/mid/treble + beat; fall back to theme accent when no art.
- **Wiring/settings**: `AmbientBackground` uses improved metrics; add "Reactive album ambient"
  + glow/tilt controls in Appearance.

**Verification.** Native live loopback smoke printing bands with real audio; browser harness
feeding synthetic spectra **and** a sample image, asserting palette colour count + non-idle
canvas pixel variance; acceptance: band rises with a tone, `energy` spans quiet/normal/loud,
palette stable, device switch recovers ≤ ~2 s.

**Risks.** True reactivity needs the desktop build; exclusive-mode audio is silent (document a
clear "audio unavailable" state); virtual/Bluetooth endpoints add latency.

---

### P7 — Bluetooth device management from the notch

**Goal.** Connect/disconnect (and otherwise manage) Bluetooth devices directly from the notch.

**Current state.** Read-only: `devices.rs` monitors connected device names + power; radio
on/off only (`quick_controls.rs`); `BluetoothView.tsx` is a read-only list.

**Capability reality.**
| Action | Feasible | How |
|---|---|---|
| List **paired** devices | Yes | WinRT `DeviceInformation` paired-state selectors (classic + LE) |
| Connect/Disconnect | **Audio only** | Microsoft-documented Bluetooth audio KSPROPERTY one-shot on the device's audio endpoint (via `IDeviceTopology`/`IConnector`), on a dedicated **STA** thread; availability remains driver-dependent |
| Connect input/HID/BLE on demand | No supported API | Windows connects automatically; open Settings |
| Unpair / Forget | Yes | WinRT `DeviceInformation.Pairing.UnpairAsync()` |
| Pair new | Partly | `ms-settings:bluetooth` |
| Battery % | Optional | `System.Devices.BatteryLife` only when Windows exposes a valid percentage |

**Decisions (2026-10-15).** Manage paired devices from the Connections widget and a Quick
Settings device-list section. Use the documented Bluetooth audio KS reconnect/disconnect
properties only when Windows reports support and an exact device-container match exists; verify
the endpoint state after each user-requested action. Pair new devices in Windows Settings.
Unpairing has an explicit in-app confirmation. Read battery only from Windows' documented
`System.Devices.BatteryLife` property and omit it when unavailable.

**Approach.**
- **Native** (`src-tauri/src/bluetooth.rs`): enumerate paired classic + LE devices with opaque
  frontend keys, pairing/connection state and optional battery percentage. Audio controls are
  advertised only when an exact container match and the driver's one-shot KS property support
  are confirmed. Connect/disconnect run on a dedicated STA worker and return only after endpoint
  state readback. Forget rechecks paired state and verifies the device left the paired list.
  New commands: `bluetooth_devices_list`, `bluetooth_connect`, `bluetooth_disconnect`,
  `bluetooth_unpair`, `bluetooth_open_settings`.
- **Frontend**: `ipc.ts` types/commands; interactive `BluetoothView.tsx` with state, optional
  battery, guarded Connect/Disconnect, a two-step Forget confirmation, and a Windows Settings
  fallback for pairing or unsupported device actions. Quick Settings exposes the paired-device
  list beneath its Bluetooth device link; it does not optimistically claim connection changes.
- **Docs**: `docs/bluetooth.md` records the capability matrix and limitations.

**Risks.** Audio connect/disconnect remains driver-dependent and has a Settings fallback;
topology objects are STA-bound; some paths need the MSIX radio/Bluetooth capability.

---

## 6. Historical open questions — defaults now resolved in §4

**P1** Gmail auth (OAuth vs IMAP app-password)? Providers now? Retention/visibility? In-memory
only OK?
**P2** Tile vs detail page (recommend both)? Unit setting + default? Hourly/daily span? Extra
fields?
**P6** Bars placement? Album ambient new vs replace? Closed-notch glow? Style shortlist?
**P7** Scope? Surfaces? Pairing flow? Undocumented audio connect OK? Battery %?

---

## 7. Suggested execution order

1. **P6 — Visualizers** (visible, self-contained; unblocks the "reactive" complaint).
2. **P2 — Weather** (data + UI; medium effort).
3. **P7 — Bluetooth** (native, higher risk; do after the above).
4. **P1 — Email 2FA** (needs an auth decision; heaviest setup).
5. **P3/P4/P5** as follow-ups / continuous.

## 8. Implementation record — 16 October 2026

The earlier proposals above remain as design history. Routine choices have been resolved in the decision log. Current source is 0.1.4; installer validation is recorded separately in `verification/current-build.json` only after installation.

- Beam: replaced the stacked QR/drop/status/file sections with a bounded two-column layout. Empty, one-file and 24-file cases fit at Small/Medium/Large; file pages use the available list height. Pairing approval and remembered phones remain real native actions.
- Motion: the cursor spring deforms the whole tethered notch outline. Side attachment remains vertical; the pinned edge stays flush. Reduced motion neutralizes magnetic movement.
- Settings: large editable page previews, direct widget/page operations, resize and cross-page drag; redundant global activity controls removed. Long tab labels no longer overlap the toolbar.
- Reliability: native brightness WMI parameter types and readback are fixed; transient errors expire; Bluetooth discovery aliases are stabilized; file-release actions show real/indeterminate progress.
- P3 scope: supported background alert feeds plus observed Windows source matching. Shortcuts are separate and collapsed. A generic website cannot provide private account events without a feed/provider integration; none are fabricated or auto-connected.
- Remaining external validation: OAuth registration and user consent, actual email delivery, a new third-party Windows toast, physical Bluetooth action/audio switching, and phone Wi-Fi/firewall behaviour.

Final code checks: 81 frontend tests and 153 native tests pass (11 live/device tests ignored in the unit suite). Selected brightness round-trip, paired Bluetooth inventory and actual loopback capture pass separately. The loopback proof uses a quiet owned four-tone WAV generated in memory and records 33 packets / 15,840 frames. No microphone, private inbox or third-party song was used. Production-browser checks cover eleven workflow groups; full-notch email-code copy/expiry is also exercised with an owned event fixture.

Release 0.1.4.0 was signed, verified, installed and launched on 16 October. Installed notification diagnostics returned `packaged=true`, `access=allowed`, `toastCount=2`, exit code 0. The selected sources remain user-controlled; none were auto-added. Final artifact and matching executable/source hashes are in `verification/current-build.json`.

## 9. Implementation record — 17 October 2026

Unreleased fixes on top of 0.1.4 (branch worktree at `0f379b5` plus pending changes).

- Collapsed notch: the resting island is MacBook-exact — flush with the screen top, straight sides, both bottom corners rounded (~10.6 px at the 320x38 preset). The cursor spring still deforms the outline, but the resting clip no longer pinches into a teardrop. The mask-diff harness `docs/verification/notch-silhouette.mjs` reports mismatch 0 on every edge.
- System-audio visualizers: the 0-packet regression came from opening a single render endpoint (first openable role), which could sit on a silent device while playback ran on another. The native loop now opens every distinct default render endpoint, merges their bands by per-band peak, holds the last frame across packet gaps (160 ms), emits at ~42 ms, and re-opens when the default device set changes (~500 ms poll). The owned quiet four-tone WAV smoke now records 36 packets / 17,280 frames / sample_peak 0.00300 / max_band 0.02861 (previously 0 packets); the identical native bands are relayed through the preview bridge into the renderer check (`visualizer-live-events.json` → `nativeCaptureBridge`).
- Widget arrangement: widgets persist the grid cell they were dropped into (`slot` on `WidgetConfig`, sanitized and clamped to the 2x2 grid natively). Pointer capture is the only drag path in the settings editor — native HTML5 drag cancelled the pointer stream in WebView2 and every drop silently failed. Dropping on an empty cell pins it; dropping on an equal-size tile trades places (cells for sized or already-placed tiles, flow order for legacy unsized pairs so their full-column look survives); unequal pairs fall back to insert-before so nothing is lost; dropping on a page shortcut pins that page's first free cell; a size change that no longer fits clears the pin. Legacy unsized first-row layouts keep their saved full-column appearance. Native packing (`flat_panel_groups`) now uses the same 2x2 geometry as the editor, folding and repacking generated duplicate pages while renamed pages stay user-owned.
- Verification: 87 frontend tests (four new slot/packing tests) and 154 native tests pass; `tsc --noEmit` and the production build pass; `widget-editor-regression.mjs` exercises pointer-capture dragging across pages and onto an empty cell and proves both survive a reload (one-shot fixture seed + a wait for the debounced write); `notch-silhouette.mjs` and `visualizer-live-events.mjs` pass with no page errors.
