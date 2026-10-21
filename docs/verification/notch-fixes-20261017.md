# Notch fixes — 17 October 2026

## Implemented

1. **Interaction-aware alerts:** defer the latest alert while a control is held, then wait 600 ms after interaction ends. File drags release their interaction hold even when they never enter the visible notch.
2. **Approach and collapse motion:** native proximity prepares the notch width; collapse has a small spring response. Width changes are interruptible.
3. **Weather:** compact, wide and full layouts; one primary condition icon; subtle background motion that stops when hidden or reduced motion is enabled. Device location requires an explicit action and Windows permission. The saved coarse area remains local, but forecast requests send those coordinates to Open-Meteo; manual city selection and clearing the saved area are available.
4. **File hover:** transparent window space does not activate the notch. Native hover handling suppresses accidental expansion while a file is being dragged.
5. **Customization:** standard presets share a fixed expanded height and native host envelope, so resizing changes width without clipping the transition. Custom sizes retain their explicit dimensions.
6. **Memory:** cap media artwork dimensions before renderer delivery; bound palette cache by bytes as well as count; release extraction images and canvas pixels; unmount costly closed widget/scene content; destroy closed settings windows; request WebView2's low memory mode while compact/inactive. These changes do not establish a 60–80 MB process-group maximum.
7. **Spotlight:** empty-query suggestions use locally recorded recent/frequent launches. Legacy usage counts migrate without inventing recent-use timestamps.
8. **Added app alerts:** exact source rules take precedence over broad name matches; enabling a connection enables its capture dependencies.
9. **Notification access:** distinguish Windows access from paused capture, refresh access when returning from Windows settings, and provide a recovery path for denied or unavailable permission.
10. **Placement:** reassert topmost placement when other windows become foreground, except while interacting with Settings. Side status is vertical; bottom placement is removed for notch mode while bottom bars remain supported.
11. **Shortcuts:** island and Spotlight bindings are configurable, validated as distinct combinations, and updated together with rollback on registration failure.
12. **Onboarding:** an absent completion marker means first run. The tour keeps the notch open until it is completed or skipped.

## Verification boundaries

- Browser smoke: eight flow groups passed with zero page errors; see [recorded results](interaction-weather-smoke-20261017.json). The record includes screenshot paths.
- Frontend regression suite: 114 tests passed. TypeScript passed.
- Native source check: `cargo check --all-targets` passed; see `native-check-final-20261017.log`.
- Native regression suite: 165 passed, zero failed, 11 opt-in hardware/network tests ignored; see `native-tests-final-boundary-20261017.log`. Includes preset/custom-size migration, native host and collapsed/expanded edge anchors, shortcuts, notification access and location consent boundaries.
- The notch host envelope is bounded to the standard maximum of 960 × 560 logical pixels. Custom dimensions above that envelope still resize the native surface; standard presets retain the same host while the visible width animates.
- Browser checks do not prove native drag behavior, topmost placement, a real Windows location prompt, or alerts from a newly installed package.
- The screenshot's original RAM figure is not a measurement of the updated app. `scripts/profile-runtime-memory.ps1` measures the owned process tree's private resident RAM separately from private commit, without forcing memory trimming.
- Existing installed-app notification diagnostics showed packaged identity and allowed access. That does not prove the updated routing or a fresh installation.

## Installed test update — 19 October 2026

- Signed Windows test package **0.1.5.1** installed in place over 0.1.5.0, using the existing publisher certificate and package family. The package revision identifies this test update; the application source version remains 0.1.5.
- Installed executable SHA-256 matches the final embedded release build: `5FFF167F29449FFAAACC092821BBF187DEFD3752A1DBB6F2C742CBA342D6EBBB`.
- Windows reports package status `Ok`; the installed executable is running and responding. It remains open for user testing.
- Settings and notes in both the standalone and packaged data locations retained their exact pre-update hashes. No onboarding completion marker was reset.
- The installed notification diagnostic reports packaged identity, Windows access `allowed`, and four current toasts. This verifies the listener grant; it does not prove newly arriving app-specific alert routing.
- Two process-tree samples measured **95.3 and 102.1 MiB private resident RAM**, including all seven owned processes. Private commit was 283.2 and 262.2 MiB. The PC had only about 1 GiB free physical RAM, so these idle samples do not establish a maximum or a controlled improvement over the earlier screenshot. **The requested 60–80 MB ceiling is not achieved.**
- Evidence: `install-proof-20261019.json`, `installed-notification-diagnostics-20261019.json`, and `runtime-memory-installed-20261019-{1,2}.json`.

Fresh-install onboarding, native file dragging, full-screen topmost behavior, and a real location permission prompt remain user/platform checks.
