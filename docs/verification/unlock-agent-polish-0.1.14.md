# Hover Island 0.1.14

## Changes

- Ambient lock shows a recognizable Face ID glyph and label before input, with a persistent press-any-key hint. The face remains visible during scanning; verified success becomes a check. PIN remains available during scanning. No minimum scan duration was added.
- The notch keeps its interruptible, independent springs, with a faster, nearly critically damped response. Content fades in immediately; the long staggered widget reveal is removed. Saved hover preferences are preserved.
- Claude logs use structural roles and explicit `end_turn`, rather than six seconds of silence. A slow tool is not treated as a permission prompt. Explicit question/approval events remain supported.
- Claude child-agent hooks, sidechain messages, background-task stops, and Codex child-rollout metadata cannot complete the parent task. Codex rollout and hook IDs normalize to the same thread UUID. Hook authority is scoped to final results in that session, leaving explicit log questions and progress available.
- Generic idle/auth notifications do not become input requests. Resuming work clears queued input prompts, and startup history retains each session's latest state. Generic desktop task-status popups defer to verified agent events; their inbox entries remain.
- Windows Claude Desktop sign-in is supported alongside the existing CLI/status-line sources. Its account-bound encrypted credential is read only, used exclusively with Anthropic's usage endpoint, and never refreshed or saved by Hover Island. Requests share a minimum interval and rate-limit backoff. Partial status-line reports preserve the other quota window.
- Hook commands use curl's Windows NUL output target rather than shell-specific `/dev/null` and `|| true`. Only explicit question tools match the new tool hook.

## Why the reverted memory experiment could cause lag

The reverted commit `5be8ae9` globally added `--disable-gpu`. That moved the notch's animated clipping, gradients, blur, and raster work away from normal hardware acceleration. It also replaced the active/compact memory-target distinction with an unconditional low-memory target, encouraging cache eviction even while a view was being used. Destroying ambient renderers additionally discarded warmed models and camera state.

These are concrete source changes that explain the observed regression. Their individual effects were not quantified with a controlled native A/B, so this report does not attribute every dropped frame to one flag. The experiment remains reverted: this release retains hardware acceleration, normal memory hints for active views, and the working camera/model lifecycle. It does not claim a universal 60–80 MB memory footprint.

## Validation

- Native unit suite: 267 passed, 12 explicitly ignored integration/interactive checks.
- Explicit native live usage check: passed against Anthropic using the existing Windows Desktop sign-in. Account details and credentials are excluded from this report.
- Frontend typecheck, all 183 regression tests, and production build pass.
- Actual Solid ambient UI with simulated camera/model/native responses: idle Face ID and key hint, first-frame match, camera/model/frame stalls reaching PIN in roughly 2.5 seconds, immediate mismatch, cancellation, hide/reuse, reduced motion, and hidden prewarm behavior pass.
- Actual Solid notch fixture: first response about 25 ms, 90% height about 210 ms, no overshoot, continuous reversal, and reduced motion pass. Native WebView/GPU latency and physical camera recognition are separate from this fixture evidence.

References: [Claude hook event semantics](https://code.claude.com/docs/en/hooks), [Claude status-line rate-limit data](https://code.claude.com/docs/en/statusline).

## Delivery verification

The signed 0.1.14.1 package is installed and running. Its executable matches the built executable, its local agent endpoint responds, and its WebViews do not carry the GPU-disable switch. All five saved JSON/DPAPI files were byte-identical across installation, before first launch. Only Hover Island's existing Claude hook entries were refreshed; unrelated configuration passed a preservation check.

The public update manifest, installer, publisher certificate, and download ZIP were fetched from production and checked against the signed local artifacts. Source fingerprints match across compilation; the package revision counter was incremented afterward. See `polish-release-0.1.14.json` for artifact hashes and check results.
