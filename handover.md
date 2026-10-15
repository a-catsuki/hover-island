# Hover Island handover

Updated 15 October 2026. This supersedes the earlier debug/unsigned build notes. Final artifact paths, hashes and verification results are recorded in `docs/verification/current-build.json`. No Git metadata is present; the initial source snapshot remains in `backups/before-revamp-20261013.zip`.

## Interface and behavior

- Small, Medium and Large presets replace raw sizing controls. Named panels use fixed-height pages, with paging rather than outer scrolling. The month calendar has its own readable page; a lone row of companion widgets fills the available height. Separate Settings offers draggable panel previews, cross-panel moves, keyboard alternatives and widget options.
- Appearance uses five complete scene presets, a collapsed/expanded configuration preview and primary compact-item selection. Clock, visualizer and fine material settings remain available under Advanced appearance. Fresh installs use Graphite; existing saved preferences are retained.
- Deeper blacks, nine scene choices including contours, dots, grids and waves, functional widget colors and higher opacity give the surface its character. Width, height and radius springs retain velocity when interrupted; the native host stays fixed during hover. Reduced motion disables elasticity and parallax.
- The closed island supports configurable clock, media with/without controls, weather, battery and usage combinations. Country/city clocks offer analog/digital presentation and typography choices.
- Maximized/fullscreen veiling retains external-window context when our own window receives focus. The edge region reveals the collapsed island; sustained hover expands it. Dragging snaps to monitor edge centers.
- Dock style and screen edge are separate choices. Notch keeps the compact pill, Bar uses a monitor-wide top/bottom shelf, and Sidebar uses a full-height 72 px rail that opens into a narrow workspace. Native hit testing follows the visible shelf/rail; crossing horizontal/vertical edges while dragging converts Bar/Sidebar appropriately.
- A side-attached Notch becomes a 56 by 200 px vertical capsule, retaining space for compact essentials, Beam and the drag handle. A small collapsed cursor attraction uses interruptible X/Y springs; proximity updates reuse the existing native cursor worker. It resets on open, drag, reduced motion and leaving range.
- Beam is directly accessible from the closed notch and expanded toolbar; Ctrl+Shift+B opens the same bucket while the app has keyboard focus.
- Device, power, media, focus, website and transfer events share bounded temporary peeks, burst coalescing, adoption on deliberate interaction and DND-aware sounds. DND uses a neutral crescent. Connected-alert badges expire with the temporary peek unless the user opens them first.
- The first-run introduction explains the island and can request native notification access.
- The former scratchpad is a compact to-do list: add, complete, reopen and delete items; existing scratchpad lines migrate into open tasks.

## Media and desktop controls

A shared WASAPI stream captures only the default speaker/render endpoint and produces 24 spectrum bands. Subscribers release capture when inactive; recovery is serialized with backoff. Ten visualizer choices include reactive ambient lighting, waves, bloom, silk, halo and orbit. Synthetic preview is explicitly labeled, and unsupported audio capture is not presented as a real signal. No microphone is used.

Media controls and seeking follow the active Windows session's reported capabilities and timeline; native seek validates/clamps again. Unavailable controls are disabled. Bluetooth reads/toggle and paired-device information use native APIs. Volume uses Core Audio and supported internal displays expose WMI brightness; slider writes are serialized and coalesced. Volume endpoint callbacks and WMI brightness events trigger temporary, DND-aware notch expansions with a quiet initial baseline. The workers reconnect after endpoint/subscription failures. Night Light and Windows DND use guarded compatibility controls; unsupported state formats fall back to Windows settings instead of rewriting unknown data. Energy Saver opens its Windows settings page. The separate Best power efficiency control uses Windows' documented AC/DC power-mode API; it does not toggle Energy Saver, whose documented app API exposes status only. Memory optimization scans and trims up to eight eligible background apps with identity revalidation and strict same-user/session, visibility, critical-process and app-child exclusions. It closes or suspends nothing, reports live measured working-set changes and completion counts, and notes that Windows may page the memory back in. No trim was run during verification.

## Connections and data

Website connections are opt-in and empty by default. A generic HTTPS notification-feed contract and an ERP adapter poll without an open website window. Tokens and subscription URLs are protected with Windows DPAPI. Requests are bounded, redirects disabled and last-good data retained through errors. Shortcuts are explicitly separate from inbox/API connections. See `docs/website-alerts.md`.

Windows desktop alerts require installed package identity, declared notification-listener capability and the user's Windows permission. Settings allows selecting observed source applications. Merely running the raw executable does not establish this capability.

Calendar supports local editing plus optional read-only Google/Outlook/other ICS subscriptions, refreshed every five minutes. Recurrence, time zones, all-day exclusive ends, exclusions and moved/cancelled instances are handled with bounded expansion. No two-way sync or inbox OAuth is claimed. See `docs/calendar-sync.md`.

Weather offers approximate public-IP location, persistent manual location, forecast and modeled US AQI with stale/offline states. Usage prioritizes remaining allowance, maps 168 hours to Weekly and shows report age/reset countdown. A passed reset timestamp does not manufacture a quota refill.

Reset Radar prioritizes the next official personal reset time and one latest linked announcement. Feed history opens deliberately in a detail view; counts, repeated quota percentages and the feed-status footer are removed from the compact card. Report provenance and stale state remain accessible. It polls a credited public feed every 15 minutes, validates original X source links, distinguishes explicit forthcoming announcements, quietly establishes its baseline and surfaces new eligible posts through DND-aware peeks. It does not know the user's credit balance, redeem grants or change account limits.

## Phone sharing

Dragging/picking files starts a temporary bucket session; folder drops preserve relative paths. A locally generated QR opens a simple bidirectional phone page. Phone uploads save without overwrite to Downloads / Hover Island; PC files can be downloaded individually or together as ZIP. Transfer stages and progress use native notch peeks. Session tokens expire after 30 minutes; Stop cancels queued/in-flight work. See `docs/phone-sharing.md`.

This is local HTTP sharing on the same reachable network. Physical iPhone, Wi-Fi/firewall behavior and iPhone Dynamic Island integration are not proven. AirDrop is hidden in the UI and remains unavailable; protocol groundwork does not constitute a working AirDrop service. See `docs/airdrop-implementation.md`.

## Release and validation

Version 0.1.2.0 was built, signed, verified, installed and launched on this PC on 15 October. The installed binary matches the release and packaged payload, and contains the current production JS/CSS assets. The existing publisher trust was reused; this run did not change certificate trust. The frozen 168-file source passes 56 frontend tests, 113 native tests (5 ignored), 11 production-browser result groups, ten layout captures and two side-notch motion cases. The installed WindowsApps process was checked again after launch and was responding.

For another installation, use the final signed personal MSIX kit linked by `docs/verification/current-build.json`, extract it and run `Install.cmd`. The installer verifies the package hash/signature/publisher, asks before trusting the signing leaf in LocalMachine TrustedPeople, installs for the original user and copies standalone settings/notes only into an absent package destination. No Root certificate or private signing key is shipped. Building and `-VerifyOnly` do not install or trust anything. Enable native alert access under Settings > Notifications > Allow Windows alerts and select desktop sources under Connections.

Verification logs and screenshots live in `docs/verification`. They distinguish frontend/native regression tests, read-only Windows control/audio smokes, simulated browser event checks and a phone browser using the real Rust HTTP router. Live notification consent/delivery, physical Bluetooth/charging transitions, a music signal, actual memory reclamation, account pairing and physical phone networking remain separate device/runtime checks.

The Windows build keeps the Common Controls v6 resource needed by native tests, uses ThinLTO for the optimized release, excludes debug-only devtools from production and uses the GUI subsystem. Native test linking disables PDB generation to avoid the linker type-table limit. Luna subagents reviewed interface/media behavior, source inspiration and installation contracts; review notes accompany the verification records.
