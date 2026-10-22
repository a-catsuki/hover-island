# Hover Island 0.1.11: ambient face unlock

Integrated the supplied `07-instant-unlock-ambient-styles.patch` (already published as upstream commit `88b64b1`) with the local warm-window work from `e939ac4`.

## Unlock behavior

- Match the first usable face immediately, with a higher similarity threshold for a single frame. Native matching, anti-spoof/liveness checks and the five-attempt limit remain in place.
- Keep the model window warm between ambient sessions and preload it ahead of idle activation. The optional **Keep the camera ready** preference only opens the camera while ambient is visible; its default remains off.
- Share one 2.5 second budget across camera startup, model loading, inference and native verification. The optional blink requirement uses 6 seconds. A clear mismatch finishes after three probes and one counted final check.
- Offer **Use PIN** throughout a scan. Hide/unmount/PIN cancellation stops the camera and discards delayed frames; late camera permission results release their tracks. A native session identifier prevents an earlier unlock animation closing a later ambient session.
- Failed and successful attempts appear in the existing last-unlock timing diagnostic. Model loading and camera startup are reported separately.

The deadline rejects late results and bounds asynchronous waits. JavaScript timers cannot interrupt synchronous shader compilation or a blocked renderer thread; prewarming reduces that risk. Physical webcam/owner-recognition latency has not been measured by this automated run.

## Ambient styles and updates

Includes the patch's five scenes, four clock styles, palettes, note and music response. Hidden canvas/audio work pauses, reduced-motion mode freezes canvas animation, and older preview style names migrate to their new equivalents.

The in-app updater now flushes pending preferences before installation and asks Windows to close the running package during replacement. The signed update retains the existing package identity and publisher. Older builds that lack this updater fix may need their app closed for their first upgrade.

## Verification

- TypeScript typecheck passed.
- Frontend tests: 174 passed.
- Native tests: 259 passed, 11 opt-in hardware/service tests ignored.
- `scripts/face-unlock-smoke.mjs`: ten real-UI flows passed using simulated camera/model/native responses. A fixture first-frame match returned in 55 ms; stalled camera/model/frame paths exposed PIN fallback in 2.91–2.92 seconds including UI/browser overhead. These numbers are not physical recognition measurements.
- All five scenes and all four clocks rendered. Reduced-motion canvas pixels remained unchanged across samples.
- Hidden prewarming loaded models with the webcam off, including with **Keep the camera ready** enabled. Showing ambient opened the camera; hiding it stopped the camera.
- Corrected an obsolete Claude statistics test expectation to match the existing provider-limit display contract; no production usage-provider behavior changed.

See `instant-unlock-smoke.json` for browser results and `instant-unlock-install.json` for the signed package, installed version, data-preservation and published-download checks.

## Installed and published

- Built the optimized Tauri executable and signed MSIX **0.1.11.1** with the existing `CN=Hover Island` publisher. Windows verified the signature; the installed executable's SHA-256 matches the release executable.
- Updated the installed **0.1.10.1** package in place and launched **0.1.11.1**. The process is responding and retains the same package family.
- Settings, notes and encrypted face enrollment retained their exact pre-update hashes. Website connection contents are unchanged; normal polling refreshed that file's DPAPI ciphertext.
- Published the verified package and refreshed Windows installer ZIP at `https://hover-island.vercel.app`. The live `updates/latest.json` advertises **0.1.11**; its downloaded package matches the signed build's SHA-256.
- Production deployment: `dpl_12sFvSjuoHTWDWtWSFezfrKqph4F`, built from source commit `cfd9d16`. No physical owner face-unlock trial was performed.
