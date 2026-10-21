# Hover Island revamp brief (Oct 2026)

Goal: Hover Island should look and feel like a first-party Apple product that happens to run on Windows (think macOS Sequoia/Tahoe Dynamic Island + Control Center + System Settings), and every feature must work reliably. Stack: Tauri 2 (Rust, `src-tauri/`) + SolidJS + Vite (`src/`). Browser preview mode (`npx vite`) uses `src/lib/preview.ts` sample data.

## Visual language (all agents follow this)

- **Material**: the island itself is pure black (#000) like the real Dynamic Island, no visible border, very soft outer shadow. Inside the expanded island, content sits on "platters": `rgba(255,255,255,0.06)` fills with 18-22px continuous-feeling corner radii, no hard 1px outlines (use at most a 0.5px `rgba(255,255,255,0.06)` inner hairline). No glowing orbs, no busy patterns, no gradient-noise backgrounds by default. Ambient/album colour is allowed only as a subtle wash on the media platter.
- **Type**: SF-style hierarchy using the existing Inter Variable stack with tight tracking. Large title 22-28px semibold (-0.02em), title 15-17px semibold, body 13px regular, caption 11-12px medium at `--text-3`. Tabular numerals for times/temps. Never ALL CAPS labels except tiny 10-11px section captions; prefer sentence case.
- **Colour**: monochrome first. System accent = Apple blue `#0A84FF`. Semantic: green `#30D158`, red `#FF453A`, orange `#FF9F0A`, yellow `#FFD60A`, teal `#64D2FF`, purple `#BF5AF2`, pink `#FF375F`. Text: `rgba(255,255,255,.92/.60/.38)`. Separators `rgba(255,255,255,.08)`.
- **Controls**: Control Center style circular toggle buttons (44px, filled white with black glyph when on, `rgba(255,255,255,.12)` when off), capsule sliders (thick 28-32px track, fill white, glyph inside the track), segmented controls with a sliding white/grey thumb, pill buttons. Hit targets ≥ 28px. Icons: lucide-solid at 1.75 stroke, 16-18px; SF-Symbols-like weight.
- **Motion**: spring everything (see `.agents/skills/apple-design/SKILL.md`). Island open/close: width/height/radius springs (already in `src/state/motion.ts`), content fades + slight scale (0.96→1) and blur(4px→0) on enter, 180-260ms. Press feedback `transform: scale(.96)` on `:active`. Respect `prefers-reduced-motion`.
- **Layout**: generous but compact. Expanded padding 16-20px; gaps 10-12px. Nothing may clip, overflow or overlap at Small/Medium/Large presets. No horizontal scrollbars. Empty/error states are short, centred, one line plus a single action.
- **Copy**: short, human, sentence case, no em dashes, no jargon like "modeled", "envelope", "synthetic". Error text says what to do.

## Shared tokens

`src/styles/tokens.css` is owned by the Shell agent. Existing variable names must keep working (other agents reference them); new tokens may be added. Other agents should use the tokens, not hard-coded colours, and may add component-scoped CSS only in their own files.

## File ownership (do not edit files you do not own; if you need a change elsewhere, write it in your final report)

| Agent | Owns |
|---|---|
| Shell | `src/styles/*`, `src/App.tsx`, `src/main.tsx`, `index.html`, `src/components/shell/*` EXCEPT `EventPeek.*`, `src/state/motion.ts`, `src/state/ui.ts`, `src/state/panel.ts`, `src/lib/panels.ts`, `src/components/BrandIcon.tsx` |
| Notifications | `src-tauri/src/notifications.rs`, the notification poll section of `src-tauri/src/lib.rs` (lines ~240-305 only), `src-tauri/src/types.rs` (AppNotification only), `src/state/notifications.ts`, `src/state/peek.ts`, `src/lib/connectionSources.ts`, `src/components/shell/EventPeek.*`, `src/components/views/NotificationsView.*`, `src/settings/NotificationAccessPanel.tsx`, `src/settings/ConnectionsPanel.tsx`, notification-related tests |
| Media | `src-tauri/src/audio.rs`, `src-tauri/src/media.rs`, `src-tauri/src/lyrics.rs`, `src/state/audio.ts`, `src/state/media.ts`, `src/lib/visualizer*.ts`, `src/lib/albumPalette.ts`, `src/components/views/MediaView.*`, `src/components/views/Visualizer.*`, `src/components/shell/AmbientBackground.*` (shared read; Media owns edits) |
| Widgets | `src/components/widgets/*`, `src/lib/weatherLayout.ts`, `src/lib/widgetPages.ts`, `src/lib/widgetPlacement.ts` |
| Views | `src/components/views/*` except Media/Visualizer/Notifications, `src/state/spotlight.ts`, `src/state/nearby.ts`, `src/state/transfer.ts` |
| Settings | `src/settings/*` except NotificationAccessPanel/ConnectionsPanel, `src/components/settings/*`, `settings.html` |

`src/lib/ipc.ts` and `src/lib/preview.ts` are shared: only make additive edits (new commands/fields/sample data) and keep them minimal; re-read the file immediately before editing because another agent may have changed it.

## Verification

- `cd /home/claude/hi && npx tsc --noEmit` must pass.
- Tests: run individual files with a timeout: `timeout 60 node --test tests/<file>.test.mjs` (`frontend-state.test.mjs` hangs in this container; skip it unless you are fixing it). Update tests your changes legitimately break.
- Visual check: start your own Vite on your assigned port, e.g. `cd /home/claude/hi && (npx vite --port 51xx --strictPort > /tmp/vite-51xx.log 2>&1 &)`, then `node /home/claude/tools/shot.mjs http://127.0.0.1:51xx/ /tmp/<name>.png open 1100 760` (states: `open`, `collapsed`, or `custom:/abs/path/module.mjs` exporting `async (page) => {}` for custom interaction). Look at the PNG with the Read tool. Iterate until it looks right. Kill your Vite when done.
- Rust cannot be compiled in this container (no Windows target). Rust edits must be small, careful, idiomatic `windows` crate 0.52 code, consistent with surrounding code. Re-read every Rust edit for borrow/type errors. List every Rust change in your report so it can be compiled on the user's PC.
- Never use git commands that rewrite history; you may run `git diff` to review your own work. Do not commit.
