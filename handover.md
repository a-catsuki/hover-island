# Hover Island handover

Updated 16 October 2026. This supersedes the earlier debug/unsigned build notes. Final artifact paths, hashes and verification results are recorded in `docs/verification/current-build.json`. Private GitHub backup: https://github.com/a-catsuki/hover-island. The initial source snapshot remains in `backups/before-revamp-20261013.zip`.

## Interface and behavior

- Small, Medium and Large presets replace raw sizing controls. Named panels are flat fixed-height grids. Overflow migrates into additional editable panels rather than nested pages. The month calendar has its own readable page; a lone row of companion widgets fills the available height. Separate Settings offers draggable panel previews, cross-panel moves, keyboard alternatives and widget options.
- Appearance uses five complete scene presets, a collapsed/expanded configuration preview and primary compact-item selection. Clock, visualizer and fine material settings remain available under Advanced appearance. Fresh installs use Graphite; existing saved preferences are retained.
- Deeper blacks, nine scene choices including contours, dots, grids and waves, functional widget colors and higher opacity give the surface its character. Width, height and radius springs retain velocity when interrupted; the native host stays fixed during hover. Reduced motion disables elasticity and parallax.
- The closed island supports configurable clock, media with/without controls, weather, battery and usage combinations. Country/city clocks offer analog/digital presentation and typography choices.
- Maximized/fullscreen veiling retains external-window context when our own window receives focus. The edge region reveals the collapsed island; sustained hover expands it. Dragging snaps to monitor edge centers.
- Dock style and screen edge are separate choices. Notch keeps the compact pill, Bar uses a monitor-wide top/bottom shelf, and Sidebar uses a full-height 72 px rail that opens into a narrow workspace. Native hit testing follows the visible shelf/rail; crossing horizontal/vertical edges while dragging converts Bar/Sidebar appropriately.
- A side-attached Notch becomes a 56 by 144 px vertical capsule. The entire noninteractive collapsed surface is draggable; no extra Beam icon or handle occupies it. A small collapsed cursor attraction uses interruptible X/Y springs; proximity updates reuse the existing native cursor worker. It resets on open, drag, reduced motion and leaving range.
- Beam is directly accessible from the expanded toolbar and the temporary file-drag chooser; Ctrl+Shift+B opens the same bucket while the app has keyboard focus.
- Device, power, media, focus, website and transfer events share bounded temporary peeks, burst coalescing, adoption on deliberate interaction and DND-aware sounds. DND uses a neutral crescent. Connected-alert badges expire with the temporary peek unless the user opens them first.
- The first-run introduction explains the island and can request native notification access.
- The former scratchpad is a compact to-do list: add, complete, reopen and delete items; existing scratchpad lines migrate into open tasks.

## Media and desktop controls

A shared WASAPI stream captures only the default speaker/render endpoint and produces 24 spectrum bands. Subscribers release capture when inactive; recovery is serialized with backoff. Ten visualizer choices include reactive ambient lighting, waves, bloom, silk, halo and orbit. Synthetic preview is explicitly labeled, and unsupported audio capture is not presented as a real signal. No microphone is used.

Media controls and seeking follow the active Windows session's reported capabilities and timeline; native seek validates/clamps again. Unavailable controls are disabled. Bluetooth reads/toggle and paired-device information use native APIs. Volume uses Core Audio and supported internal displays expose WMI brightness; slider writes are serialized and coalesced. Volume endpoint callbacks and WMI brightness events trigger temporary, DND-aware notch expansions with a quiet initial baseline. The workers reconnect after endpoint/subscription failures. Night Light and Windows DND use guarded compatibility controls; unsupported state formats fall back to Windows settings instead of rewriting unknown data. Energy Saver opens its Windows settings page. The separate Best power efficiency control uses Windows' documented AC/DC power-mode API; it does not toggle Energy Saver, whose documented app API exposes status only. Memory optimization scans and trims up to eight eligible background apps with identity revalidation and strict same-user/session, visibility, critical-process and app-child exclusions. It closes or suspends nothing, reports live measured working-set changes and completion counts, and notes that Windows may page the memory back in. No trim was run during verification.

## Connections and data

Website connections are opt-in and empty by default. A generic HTTPS notification-feed contract and an ERP adapter poll without an open website window. Tokens and subscription URLs are protected with Windows DPAPI. Requests are bounded, redirects disabled and last-good data retained through errors. Shortcuts are explicitly separate from inbox/API connections. See `docs/website-alerts.md`.

Windows desktop alerts require installed package identity, declared notification-listener capability and the user's Windows permission. Settings allows selecting observed source applications. Merely running the raw executable does not establish this capability.

Calendar supports local editing plus optional read-only Google/Outlook/other ICS subscriptions, refreshed every five minutes. Recurrence, time zones, all-day exclusive ends, exclusions and moved/cancelled instances are handled with bounded expansion. Calendar subscriptions remain read-only. Optional Gmail/Outlook email-code OAuth is separate and requires a configured desktop client and user sign-in. See `docs/calendar-sync.md`.

Weather offers approximate public-IP location, persistent manual location, forecast and modeled US AQI with stale/offline states. Usage prioritizes remaining allowance, maps 168 hours to Weekly and shows report age/reset countdown. A passed reset timestamp does not manufacture a quota refill.

Reset Radar shows one latest linked global/banked announcement from codex-resets.com, credited to Tibo. It does not repeat personal quota clocks, history counts or news panels. UTC publication/estimated landing times are parsed separately; passing an estimate requires confirmation rather than inventing a landing. New announcements produce DND-aware full-notch activities after a quiet baseline. It does not redeem grants or modify quotas.

## Phone sharing

Dragging/picking files starts a temporary bucket session; folder drops preserve relative paths. A locally generated QR opens a simple bidirectional phone page. Phone uploads save without overwrite to Downloads / Hover Island; PC files can be downloaded individually or together as ZIP. Transfer stages and progress use native notch peeks. Session tokens expire after 30 minutes; Stop cancels queued/in-flight work. See `docs/phone-sharing.md`.

This is local HTTP sharing on the same reachable network. Physical iPhone, Wi-Fi/firewall behavior and iPhone Dynamic Island integration are not proven. AirDrop is hidden in the UI and remains unavailable; protocol groundwork does not constitute a working AirDrop service. See `docs/airdrop-implementation.md`.

## Release and validation

Version 0.1.4.0 was built, signed, verified, installed and launched on this PC on 16 October. The installed binary matches the release and packaged payload, and contains the current production JS/CSS assets. The existing publisher trust was reused; this run did not change certificate trust. The frozen 188-file source passes 81 frontend tests, 153 native tests (11 ignored), eleven production-browser workflow groups, fourteen widget/editor layout captures, nine Beam size/file fixtures, four header-width checks and two side-notch motion cases. The installed WindowsApps process was checked again after launch and was responding.

For another installation, use the final signed personal MSIX kit linked by `docs/verification/current-build.json`, extract it and run `Install.cmd`. The installer verifies the package hash/signature/publisher, asks before trusting the signing leaf in LocalMachine TrustedPeople, installs for the original user and copies standalone settings/notes only into an absent package destination. No Root certificate or private signing key is shipped. Building and `-VerifyOnly` do not install or trust anything. Enable native alert access under Settings > Notifications > Allow Windows alerts and select desktop sources under Connections.

Verification logs and screenshots live in `docs/verification`. They distinguish frontend/native regression tests, read-only Windows control/audio smokes, simulated browser event checks and a phone browser using the real Rust HTTP router. Read-only live reset/provider scans and the native controls snapshot passed. The owned native server/browser flow passed approved phone pairing, upload/download, remembered-cookie reconnection and unpaired API denial. The installed MSIX notification diagnostic reports packaged=true, access=allowed and toastCount=2. Native brightness was moved by one point and restored. Paired Bluetooth enumeration passed without mutations. Actual WASAPI capture of a quiet owned four-tone signal recorded 33 packets, 15,840 frames, sample peak 0.00298 and maximum band 0.02856. A new third-party toast arrival, physical Bluetooth/charging transitions, player aesthetics/audio switching, actual memory reclamation and physical phone networking remain separate checks.

The Windows build keeps the Common Controls v6 resource needed by native tests, uses ThinLTO for the optimized release, excludes debug-only devtools from production and uses the GUI subsystem. Native test linking disables PDB generation to avoid the linker type-table limit. Luna subagents reviewed interface/media behavior, source inspiration and installation contracts; review notes accompany the verification records.



## 0.1.4 implementation details

- The complete collapsed material uses a tethered, cursor-driven outline; the pinned edge stays flush. Reduced motion removes the magnetic movement.
- Beam uses a compact connection column beside a bounded file list. File paging adapts to available height; empty and populated states no longer overlap. File releases replace chooser targets with action/progress feedback.
- Phone-style widget editor previews support adding, removing, sizing and moving widgets/pages, including cross-page drag and keyboard alternatives.
- Album-derived ambient fields respond to raw low/mid/high audio envelopes and bass onsets. Geometry has independent gain so quiet music remains visible without saturating the lighting. Mirror, Radial and Particles are saved native styles; output endpoint changes trigger capture recovery.
- Weather includes current details, a 24-hour strip, seven-day ranges, precipitation/UV/solar data and modeled AQ particulate values. Units persist; condition/day-driven scenes pause while closed.
- Bluetooth management lists paired devices and supplied battery data, with guarded driver-supported audio actions, confirmed Forget and Windows pairing fallback.
- Connections prioritizes observed Windows sources and source-routing tests. Authenticated website feeds keep working in the background; shortcuts are separate and collapsed. No services are connected by default.
- Email verification-code detection supports opt-in Google/Microsoft OAuth PKCE, DPAPI credentials, bounded preview-only polling, safe reconnect/pause/removal, copied codes and expiry-aware full-notch activities. Provider registration and actual inbox sign-in remain user setup. See `docs/email-codes.md`.

Signed installer ZIP: `releases/HoverIsland-0.1.5.2-x64-20261019-095519-329-263ccf5e.zip`. The optimized executable, the packaged executable and the installed executable share the SHA-256 `c8036b40…`. Evidence is in `docs/verification/current-build.json` and `docs/verification/installer-proof.json`. Older kits, ZIPs and staging folders were removed on 19 October; only this 0.1.5.2 kit is retained. The 0.1.4.0 test gate in `current-build.json` was not re-run for 0.1.5.2.
