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
- `scripts/face-unlock-smoke.mjs`: nine real-UI flows passed using simulated camera/model/native responses. A fixture first-frame match returned in 105 ms; stalled camera/model/frame paths exposed PIN fallback in 2.89–2.93 seconds including UI/browser overhead. These numbers are not physical recognition measurements.
- All five scenes and all four clocks rendered. Reduced-motion canvas pixels remained unchanged across samples.
- Corrected an obsolete Claude statistics test expectation to match the existing provider-limit display contract; no production usage-provider behavior changed.

See `instant-unlock-smoke.json` for browser results and `instant-unlock-install.json` for the signed package, installed version, data-preservation and published-download checks.
