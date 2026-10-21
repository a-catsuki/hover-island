# Performance notes, round 2

What the native side now does to use less CPU and memory, what to measure on Windows, and what is realistic.

## Honest expectations

Hover Island is a Tauri app, so it is one Rust process plus WebView2. WebView2 is a full Chromium: the browser process, a GPU process, the renderer, a crashpad/utility process. Even an empty page costs roughly 40 to 60 MB across those processes. The target of 60 to 80 MB total is therefore only reachable in the best case (collapsed, one WebView, nothing playing, no settings window). A more honest range for a collapsed island on a typical machine:

| State | Expected total (all Hover Island processes, Details tab "Private working set" summed) |
|---|---|
| Collapsed, idle, settings closed | about 90 to 140 MB, after the 5 second trim |
| Expanded with widgets visible | about 130 to 190 MB |
| Settings window open | adds 30 to 60 MB (less now, see renderer limit below) |

CPU while idle and collapsed should sit at 0.0 to 0.3 percent of one core. The old build spent most of its idle CPU in the hover poll and in a media event that fired every second.

These ranges are estimates from how the pieces behave, not measurements; nothing here could be run in the build container.

## What changed (native)

### Hover poll (`window.rs`, `spawn_ignore_poll`)
- It used to wake every 48 ms (12 ms while hovered) and made roughly a dozen Tauri window queries per wake (`outer_position`, `outer_size`, `scale_factor`, each a round trip to the UI thread). Window geometry now comes from a 400 ms cache, invalidated by `anchor`/`apply_bounds` and bypassed while the user is dragging.
- Adaptive interval: 24 ms while the pointer is on the island, in the reveal band, or dragging; 32 ms while the magnetic pull is animating; 48 ms within 240 logical px of the pill; 64 ms farther away; 160 ms when the pointer has been still for 1.5 s and the island is collapsed; 250 ms while the island is hidden from the tray.
- The settings window is probed at most five times a second instead of every tick.
- Only changes are emitted (this was already true for hover/proximity/foreground).

### Background loop (`lib.rs`, `spawn_background`)
- Half second base tick. Media: every 1 s while something is playing or the island is open, 3 s when idle and collapsed, 5 s when hidden. Windows alerts: 1 s open, 1.5 s collapsed, 5 s hidden. Email codes every 25 s as before.
- `window://foreground` was computed and emitted by both this loop and the hover poll. The duplicate is gone.
- `media://changed` was emitted every second while music played, because the playback position changes every second. Each event carries the album art as a data URL, so that was a megabyte-class JSON payload per minute into the WebView, plus a Solid update. The WebView already interpolates position from the time it received the last event (`interpolatedPosition` in `src/state/media.ts`), so now an event is sent only when metadata or status changes, when a seek or stall moves the position more than 2 s away from the interpolated value, and as a 30 s heartbeat to re-anchor the clock. Unit tests cover this (`media_event_tests`).
- Usage refresh thread wakes every 2 s instead of every 1 s while it waits.

### Tokio and threads (`lib.rs`, `configure_process_resources`)
- Tauri's default runtime starts one worker per CPU core, 2 MiB stacks and up to 512 blocking threads. Replaced by a runtime with 3 workers, 1 MiB stacks, at most 24 blocking threads, released after 5 s idle, installed with `tauri::async_runtime::set` before Tauri starts.
- Stacks are only committed when touched, so the saving in working set is small; the benefit is fewer idle threads and a cap on thread explosions.

### WebView2 flags (`lib.rs`, `configure_process_resources`)
Set through `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` so the island and settings windows always share identical arguments (WebView2 refuses to start a second window on the same profile with different arguments). Any value already in the environment is kept and appended.

- `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection` (Tauri's defaults) plus `Translate,OptimizationHints,MediaRouter,AutofillServerCommunication`.
- `--autoplay-policy=no-user-gesture-required` (Tauri's default when autoplay is on).
- `--renderer-process-limit=1`: the settings window shares the island's renderer process instead of spawning another. Trade-off: a heavy settings page can briefly share a main thread with the island.
- `--disable-background-networking --disable-breakpad --no-pings --disable-gpu-shader-disk-cache`: less background work and disk writes.
- `--js-flags="--max-old-space-size=96 --max-semi-space-size=4"`: caps the V8 heap at 96 MB and the young generation at 4 MB per semi-space (default is up to 16 MB), so garbage is collected sooner. The app's JS heap should be well under 40 MB; if the renderer ever shows an out-of-memory crash, raise 96.

I deliberately did not add `--in-process-gpu`, `--enable-low-end-device-mode`, `--disable-gpu` or `--disable-site-isolation-trials`: they can change rendering, animation smoothness or stability and cannot be verified here.

### Working set trim (`runtime_memory.rs`)
- Existing: WebView2 memory target is set to LOW while collapsed (this makes Edge trim the renderer).
- New: 5 s after the island settles collapsed, the host process calls `EmptyWorkingSet` on itself, at most once every 30 s, from a single short-lived thread. Pages fault back in on demand. This lowers the number Task Manager shows for the Rust process without changing behaviour.

### Caches
Existing caps were reviewed and left alone: notification history 50 with a 1024 id set, notification icon cache 256, thumbnail cache by track.

## What to measure on Windows

1. Task Manager, Details tab. Add columns "Memory (private working set)" and "CPU". Hover Island is `hover-island.exe` plus several `msedgewebview2.exe` children (expand the group in the Processes tab to see them all). Sum the group.
2. Collapsed idle: wait 15 s after launch, note total memory and CPU. Expect CPU near 0. Hover the pill, collapse, wait 10 s: memory should fall back (WebView2 LOW target plus the trim).
3. Play music in Spotify or the browser with the island collapsed: CPU should stay below about 0.5 percent. Before, `media://changed` fired once per second.
4. Open Settings: the process count should not grow by a whole extra renderer.
5. `Resource Monitor > CPU > Associated Handles/Threads` on `hover-island.exe`: thread count should be noticeably lower than before (roughly 25 to 35 versus 45+ on a 12-core machine, estimate).
6. Move the mouse quickly onto the pill from far away on a normal display: hover should still feel immediate. If the first hover after a long idle feels late, lower the 160 ms idle interval in `spawn_ignore_poll`.

Frontend timers that still run while collapsed, for the owners of those files: `App.tsx` focus tick (1 s), `CollapsedPill.tsx` clock (1 s), `MediaView.tsx` 250 ms tick and 1 s lyrics clock (only while that view is mounted), `SystemView` 2 s, `ClockView` 1 s. Pausing these while the island is collapsed or the document is hidden would help further.

## Fixed, non-draggable island (`window.rs`, `placement.rs`, `tauri.conf.json`, `capabilities/default.json`)

- `resizable: false`, `maximizable: false`, `minimizable: false` for the main window.
- At startup `install_main_guard` strips `WS_THICKFRAME`, `WS_CAPTION`, `WS_SYSMENU`, `WS_MINIMIZEBOX` and `WS_MAXIMIZEBOX` from the HWND and subclasses it (`SetWindowSubclass`): `WM_NCHITTEST` never reports a border, caption or system button, and `WM_SYSCOMMAND` refuses `SC_MOVE`, `SC_SIZE`, `SC_MAXIMIZE`, `SC_MINIMIZE` and `SC_KEYMENU` (keyboard move/size, Win+Arrow, the Alt+Space menu). The hover poll re-checks the styles twice a second.
- `placement::enforce_anchor` runs about twice a second from the hover poll. If the window is not at the position `anchor` last gave it, it re-anchors from the live monitor layout (so a display change is followed too). It skips while the deliberate placement drag is active and for 2 s after it ends, and backs off if Windows keeps refusing the target.
- The main capability no longer grants `set-size`, `set-position` or `start-dragging` to the WebView. Nothing in the frontend used them. The deliberate edge-to-edge placement drag still works, because it runs through the Rust `placement_*` commands.
- No `data-tauri-drag-region` is used anywhere in `src` or the HTML files.

## Settings deep links

`open_settings_window(page?: string)` (and the tray) accept an optional page id. A new window loads `settings.html#<page>`; an open one gets the event `settings://navigate` with the page id (a string) and is focused. Ids are limited to letters, digits, `-` and `_`, 32 characters. Frontend: `cmd.openSettings(page?)`. The Settings agent reads `location.hash` and listens for the event.

## MSIX

There is no `packaging/windows` folder or AppxManifest template in this checkout (docs refer to `packaging/windows/Build-Msix.ps1`, which lives with the signed kit). For the location feature, the manifest used by that script needs, inside `<Capabilities>`:

```xml
<DeviceCapability Name="location" />
```

and the existing `<rescap:Capability Name="userNotificationListener" />` must stay. `Windows.Devices.Geolocation` is already enabled in `Cargo.toml`.
