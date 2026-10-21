# Hover Island revamp, round 2 (Oct 2026)

Read `docs/REVAMP-BRIEF.md` first (visual language, verification, preview mode, screenshot tool at /home/claude/tools/shot.mjs). This round adds fixes and features. Same rules: edit only files you own; Rust can't be compiled in this container, so write careful `windows` 0.52 / tauri 2 code and list every Rust change in your report; run `npx tsc --noEmit` and the relevant tests (`timeout 60 node --test tests/<file>`; `frontend-state.test.mjs` works now, run it if you touch state/*.ts). Do not commit. Kill your own Vite when done. Round 1 is committed in git (`git diff` shows only your changes).

## Shared-file protocol (10 agents work at once)
Shared files: `src/lib/ipc.ts`, `src/lib/preview.ts`, `src-tauri/src/lib.rs` (mod lines + invoke_handler entries only, unless you own it), `src-tauri/src/settings.rs`, `src-tauri/src/types.rs`, `src/state/settings.ts`, `src/settings/SettingsApp.tsx` (nav entries only, unless you own it).
- ONLY use the Edit tool with small unique old_string anchors on shared files. NEVER Write/overwrite a whole shared file. Re-Read the exact region right before each edit; if an Edit fails because the text changed, re-read and retry.
- New settings fields: add to BOTH `src-tauri/src/settings.rs` (struct + Default + validation, serde camelCase, `#[serde(default)]`) and `src/lib/ipc.ts` `Settings` type + `DEFAULT_SETTINGS`. Keep field names unique and prefixed by your feature.
- New tauri commands: add `#[tauri::command]` in your own Rust file, register in lib.rs `invoke_handler` with one Edit, add `cmd.xxx` in ipc.ts, add a preview stub in preview.ts.

## Ownership
| Agent | Owns |
|---|---|
| Native | `src-tauri/src/lib.rs` (full), `window.rs`, `placement.rs`, `state.rs`, `tray.rs`, `main.rs`, `memory_reclaim.rs`, `runtime_memory.rs`, `sound.rs`, `system.rs`, `system_events.rs`, `tauri.conf.json`, `Cargo.toml`, `capabilities/*` |
| Shell | `src/styles/*`, `src/App.tsx`, `src/components/shell/{Island,ExpandedPanel,IslandPlacement.css,AmbientBackground.css,FileDropToast}.*`, `src/state/{motion,ui,panel,hover,window,placement}.ts`, `src/lib/{panels,magneticShape,placementPointerDrag}.ts` |
| Tour | `src/components/shell/FirstRunTour.*`, `src/state/onboarding.ts`, `src/lib/onboardingConfig.ts`, new `src/components/shell/TourCursor.*` |
| Media | `src/components/views/{MediaView,Visualizer,LiveBars}.*`, `src/lib/visualizer*.ts`, `src/lib/albumPalette.ts`, `src/state/{audio,media}.ts`, `src-tauri/src/{audio,media,lyrics}.rs`, `AmbientBackground.tsx` |
| Weather | `src/components/widgets/Weather*.{tsx,css}`, `src/lib/weatherLayout.ts`, `src-tauri/src/weather.rs`, new `src/settings/LocationPanel.{tsx,css}` |
| System | `src/components/views/QuickSettingsView.*`, `src/components/widgets/Bluetooth*.{tsx,css}`, `src/components/widgets/SystemView.*`, `src-tauri/src/{quick_controls,bluetooth,devices,paired_devices}.rs`, `src-tauri/src/notifications.rs`, `src/components/shell/NotificationAppIcon.*`, `src/components/views/NotificationsView.*` |
| Widgets | `src/components/widgets/*` except Weather*/Bluetooth*/SystemView/AiView*, `src/lib/{widgetPages,widgetPlacement,widgetPointerDrag}.ts`, `src/settings/{WidgetManager.*,widgetOrder.ts}`, new `src-tauri/src/network.rs` |
| AI | `src-tauri/src/usage/*`, `src/components/widgets/AiView.*`, `src/components/views/UsageView.*`, `src/components/shell/{EventPeek,CollapsedPill}.*`, `src/state/{peek,usage}.ts`, `src/lib/usageDisplay.ts`, new `src-tauri/src/agent_events.rs`, new `src/state/aiActivity.ts`, new `src/components/shell/AiActivity*.{tsx,css}` |
| Views | `src/components/views/{SpotlightView,BeamBucket,NearbyView,DockView}.*`, `src/state/{spotlight,transfer,nearby}.ts`, `src/lib/{searchHistory,droppedFiles,fileDropTargets}.ts`, `src-tauri/src/{spotlight,transfer,nearby,apps,recycle}.rs`, `phone-*.html` |
| Settings | `src/settings/*` except WidgetManager/widgetOrder/LocationPanel, `src/components/settings/*`, `src/state/settings.ts`, `src/lib/{shortcuts,themes,connectionSources}.ts`, `src-tauri/src/{settings,connections,calendar,calendar_sources,email_codes,erp,reset_watch}.rs` |

## Cross-agent contracts
- **Open Settings at a page**: Native adds optional `page` to `open_settings_window(app, page: Option<String>)` (loads/navigates the settings window to `settings.html#<page>`, and if already open emits event `settings://navigate` with the page id) and `cmd.openSettings(page?)` in ipc.ts. Settings agent makes SettingsApp read `location.hash` on load and listen to `settings://navigate`, and adds a "Location" page (id `location`) rendering `import LocationPanel from './LocationPanel'` (Weather agent writes it: no props, default export). Other page ids: `shortcuts`, `connections`, `notifications`, `ai`.
- **AI activity events**: AI agent defines the payload (kind: `started|progress|question|completed|failed`, provider id, title, detail, percent?, durationMs?) and emits Tauri event `ai://activity`; collapsed-notch AI stats are driven by new setting fields they add (`compactAiStat`: usage-left | response-time | active-count | off).
- **Collapsed pill**: AI agent owns CollapsedPill.*; Shell agent must not edit it (Shell handles the side-mode look through IslandPlacement.css / shell.css, using the class names CollapsedPill already emits; AI agent keeps existing side-mode class names intact).
- **Honest limits**: do not claim anything works that you could only verify in browser preview. Say what needs a Windows check.
