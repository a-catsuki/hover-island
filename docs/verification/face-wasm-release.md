# Hover Island 0.1.12: faster offline face unlock

## Actual cause

The installed 0.1.11 timing records showed the 2.5 second deadline expiring with zero completed frames. One attempt spent 2.39 seconds starting the camera. Shortening that deadline alone did not fix the cold camera or the first WebGL inference.

On this HP laptop, the previous WebGL backend took 29.49 seconds for its first full recognition frame on Human's public sample face. The same models on SIMD WebAssembly took 628 ms initially and 358–406 ms on following frames. A separate production-engine check under the exact app CSP completed warm frames in 286–297 ms, with one face, an embedding, anti-spoof 0.81 and liveness 1. These are Chromium measurements of the public sample, not an installed-app owner-unlock measurement.

The webcam itself took 4.25 seconds to open cold and 1.07 seconds to reopen in the baseline; a camera already delivering frames returned immediately. Under concurrent compilation, a later diagnostic took 12.20 seconds to open. Software cannot guarantee instant hardware power-up.

## Resulting behavior

- Prefer the bundled TensorFlow.js 4.22.0 WASM backend, including SIMD. All binaries, face models and the public warmup image ship locally. The GPU remains a compatibility fallback if WASM initialization fails; unaccelerated JavaScript CPU inference is removed.
- Preserve the recognition model and existing encrypted enrollment. Native identity, liveness, anti-spoof, deadline and attempt-limit decisions remain in place.
- Start the camera as soon as an enrolled ambient screen is visible, before unlock input. The default is now **Keep the camera ready** enabled; the current machine is explicitly updated to this preference. Its light stays on during ambient and turns off on leaving ambient. Hidden model prewarming never opens the camera.
- Use the first current video frame without waiting for additional buffered frames. Keep a ready camera running after an inference timeout so a retry does not repeat startup.
- Match the first usable frame and close after a 180 ms success animation. Keep the 2.5 second scan budget and immediate PIN fallback. Camera startup exhaustion says **Camera is getting ready**; diagnostics record the failing stage and completed frame count.
- Prepare the enrollment camera and models concurrently.

## Verification

- TypeScript typecheck passed; 176 frontend tests passed.
- Native tests: 259 passed, 11 opt-in hardware/service tests ignored.
- Eleven UI smoke flows passed with simulated camera/native responses: first-frame match, bounded stalled camera/models/inference, mismatch, PIN cancellation, hide/reuse, ambient styles and camera readiness lifecycle. See `face-wasm-smoke.json`.
- Actual production engine loaded local WASM and recognized the public sample under the exact app CSP with zero CSP violations and zero external requests. See `face-wasm-csp.json`.
- Live camera frames had normal brightness and contrast but no detected face. The user confirmed being away or off camera, so this does not demonstrate an owner mismatch. No camera images or face descriptors were saved. A real owner-unlock trial remains pending. See `face-live-diagnostic.json`.

## Alternatives considered

OpenCV YuNet plus SFace was reviewed as a lightweight native alternative. It produces different identity embeddings and would require enrollment migration or re-enrollment. The measured WASM improvement resolves the observed shader startup bottleneck while retaining existing enrollment, so this release keeps the current recognition model.

Primary references: [Human backends](https://github.com/vladmandic/human/wiki/Backends), [TensorFlow.js WASM](https://github.com/tensorflow/tfjs/tree/master/tfjs-backend-wasm), [OpenCV SFace](https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface), [OpenCV YuNet](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet).
