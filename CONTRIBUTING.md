# Contributing to Hover Island

Thanks for helping. Hover Island is a small project, so the bar for contributing is low: if it makes the app better, send it.

## Set up

1. Install Node.js 20+, Rust (stable, MSVC) and the Windows SDK.
2. `git clone https://github.com/a-catsuki/hover-island.git && cd hover-island`
3. `npm install`
4. `npm run dev` for a browser preview with sample data. Native features (media, notifications, Bluetooth, Beam) need the desktop build: `powershell -ExecutionPolicy Bypass -File .\Rebuild.ps1 -Fast`.

## Before you open a pull request

- `npm run typecheck` and `npm test` pass.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib` passes if you touched Rust.
- Keep changes focused. One fix or feature per pull request is easiest to review.
- Match the surrounding code style. No new dependencies without a reason in the description.
- Screenshots or a short clip help a lot for anything visual.

## Good bug reports

Include your Windows version, the Hover Island version (Settings, General), what you expected, what happened, and steps to reproduce. For build problems, attach `build-log.txt`.

## Ideas welcome

Open an issue before starting anything big (new widget, new dock style, a big refactor) so we can agree on the shape first.

## Privacy rules

Hover Island runs locally and keeps it that way. Changes that send data off the PC need to be opt-in, clearly labeled in Settings, and documented in the README.

## License

By contributing you agree your work is released under the MIT license.
