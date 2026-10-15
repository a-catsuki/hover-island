# Hover Island widget references

These references inform interaction patterns for Hover Island's compact
widgets. They are examples, not feature or interoperability claims for this
Windows app.

## Patterns worth adapting

- **NotchNook:** its official product page is [`lo.cafe/notchnook`](https://lo.cafe/notchnook). The page did not provide usable product details during this review, so no specific interface behavior is attributed to it here. The current [`lo.cafe` landing page](https://lo.cafe/) confirms the product association but is not functioning as a feature reference.
- **Boring Notch:** the [project README](https://github.com/TheBoredTeam/boring.notch) combines a hover-expanded notch surface with media controls, a visualizer, calendar access, a file shelf, and system HUDs. The useful pattern is one quiet resting state that expands into a few task-specific actions; keep drop, preview, and send as separate, legible states.
- **Atoll:** the [project README](https://github.com/Atoll-Labs/Atoll) describes tabs for Media, Stats, Timers, and Clipboard, plus a shelf, per-feature controls, shortcuts, and gesture options. For Hover Island, this supports keeping widgets independently selectable and configurable instead of putting every control into one dense panel.
- **Apple's widget guidance:** the [Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/widgets) frame widgets as timely, glanceable information with focused interactions. Use that as a constraint: show the next useful fact immediately, and make the click action obvious rather than shrinking a full app screen into the island.

## Hover Island direction

The world clock and Codex Reset Watch are now available as widgets. Keep each
glanceable: show the selected time zones or the newest sourced reset notice,
with a clear stale/source age where data can lag. Reset Watch reports
community announcements from its linked source; it is not account usage or a
prediction.

Clipboard history remains a future idea. The file bucket now stages dropped
files and provides a temporary QR page for bidirectional phone sharing.
It uses local HTTP and is presented separately from the unavailable AirDrop
transport; see [phone sharing](phone-sharing.md).

## Apple motion and character, 14 October

- [Designing Fluid Interfaces](https://developer.apple.com/videos/play/wwdc2018/803/)
  emphasizes immediate response, interruption, velocity continuity and elastic
  behavior. The island now uses independent width/height/radius springs that
  retain their presentation values and velocity when retargeted. Native host
  bounds remain fixed. Event bursts replace older peeks and share one timer.
- [Design dynamic Live Activities](https://developer.apple.com/videos/play/wwdc2023/10194/)
  informs the distinct compact and expanded presentations: events take a small
  temporary shape, while a deliberate hover/focus adopts the workspace.
- [DynamicLake](https://www.dynamiclake.com/) demonstrates task-specific file,
  Bluetooth and system-event surfaces in a notch. Hover Island adapts the
  compact event feedback and file-drop interaction rather than implying any
  macOS or AirDrop interoperability.

Deeper blacks give the shell its silhouette. Red dates, an ochre analog or
digital clock, a cool weather card, warm notes and a green focus surface make
widgets recognizable without relying on branding. Reduced motion removes
elasticity and parallax; contrast/transparency preferences strengthen surfaces.

## Reset feed runtime check

At 2026-10-13 18:04 UTC, a read-only GET of the [codex-reset.com feed](https://codex-reset.com/api/feed)
returned 78 event rows. Applying the app's global-scope, announced-state,
linked-X-post filters yielded 14 global announcements. In the same feed, 13
credit rows included 11 linked X posts classified as banked (the two
monitoring-only observations had no X URL and were excluded). The timeline
endpoint also returned 11 X-linked credit records, including 8 explicitly
marked `banked_grant`; plan-specific notices remain eligible because their
titles describe the applicable cohort. The response's
`fetched_at` was `2026-10-13T12:33:24Z`, about 331 minutes old, although the
feed's own `stale` field was `false`. Hover Island therefore treats the data as
stale by its 15-minute source-age rule while retaining the upstream flag for
diagnosis. The local check time and source refresh time are separate fields.

## AirDrop capability status

The checked-in AirDrop capability probe reports `ready: false` and
`hardwareSupportedByOmdropOwl: false` for this PC's built-in Intel AX211
(`8086:51f0`). This is a conservative verified-support flag, not a claim that
every AX211 revision has been experimentally tested. The probe only reads
Windows WLAN capability output; it does not change radio, driver, firmware, or
security settings. See [the implementation status](airdrop-implementation.md)
for the protocol groundwork and remaining backend requirement.
