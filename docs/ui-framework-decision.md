# Hover Island — UI Framework Decision Document

**Status:** Decision record
**Date:** 2026-10-13
**App:** Hover Island — a macOS-notch / Dynamic-Island-style always-on-top utility for Windows
**Author:** Engineering
**Scope:** Choose the UI stack for the notch surface and settings UI; quantify the real runtime cost of the current stack.

---

## TL;DR

**Keep Tauri v2 + SolidJS + WebView2. Do not rewrite the UI in a native Rust toolkit.**

The current architecture is already Rust-native at runtime. The Rust core process owns the window, tray, global shortcut, SMTC/media, and notifications, and the WebView2 process is *the UI renderer only*. There is **no Node.js process at runtime** — Node/npm are build-time tools (Vite bundles the SolidJS frontend to static assets, which a Vite build step emits into `dist/`; Tauri loads those into the OS webview).

Yes, WebView2 adds roughly **30–80 MB of helper processes** over a zero-webview toolkit. That is the entire measurable downside, and it buys the styling/animation fidelity (`border-radius`, gradients, blur/acrylic, CSS spring animations, a real WebGL `<canvas>`) that would otherwise cost **weeks of custom rendering work per feature** in egui/Slint/Iced to match. For a small, single-window notch panel that is idle almost all the time, that tradeoff is correct.

The realistic steady-state footprint for this app is roughly **Rust core ~10–25 MB + WebView2 helpers ~40–90 MB ≈ 50–120 MB working set**, dominated by the webview. A zero-webview toolkit could get the whole app to **~30–60 MB**, i.e. it saves a few tens of MB — not hundreds. That is not worth a from-scratch UI rewrite, and it would sacrifice the visual quality that is this app's entire reason to exist.

**If the footprint ever becomes a hard problem, optimize Tauri (see §7) before switching frameworks.**

---

## 1. The critical clarification: there is no Node.js at runtime

This misconception needs to be killed explicitly, because it drives the wrong decision.

**Claim:** "Tauri apps run Node.js at runtime, so Hover Island actually eats the same RAM as an Electron app."
**Verdict:** **False.** Electron bundles and runs Chromium **+ a Node.js runtime** in every app. Tauri bundles **neither** — it compiles a Rust binary and reuses the Chromium engine the OS already ships (Microsoft Edge **WebView2**, pre-installed on Windows 11).

Evidence:

- Tauri's own **Process Model** doc: each Tauri app is a **Core process** (Rust, full OS access) plus one or more **WebView processes** that "leverage WebView libraries provided by the operating system." The webview is **not** shipped in the executable and is **dynamically linked at runtime**. It names exactly three webviews: **WebView2 on Windows**, WKWebView on macOS, WebKitGTK on Linux. No Node anywhere in the runtime model. — *Tauri v2, Process Model* [1]
- Tauri's **Architecture** doc: "They do not ship a runtime since the final binary is compiled from Rust." The JS API is an optional thin layer that talks to the Rust core over IPC. — *Tauri v2, Architecture* [2]
- Node is present only as a **build-time** dependency. In this repo, `package.json` scripts (`vite`, `tauri build`) and `tauri.conf.json`'s `beforeBuildCommand: "npm run build"` run Node/Vite **during the build**; the output (`frontendDist: "../dist"`) is a folder of static HTML/CSS/JS that the webview loads. Node exits when the build ends.

**Consequence:** Hover Island's runtime process tree is **[Rust core] + [msedgewebview2.exe helpers]**. It is *not* **[Chromium] + [Node] + [renderers]** like Electron. The "it uses Node at runtime / eats RAM" argument is simply incorrect.

### Where the RAM actually goes (and how it is measured)

Any RAM number is only meaningful with its measurement method. The rproc deep-dive explains the trap: a process's headline number is **RSS (Resident Set Size)** = your data + **all linked code** + libraries your dependencies drag in + **graphics driver memory**. A tiny Rust app can still show a big RSS because a GPU driver or a font stack got mapped in behind its back. — *Trystan Sarrade, "135 MB → 30 MB"* [3]

This is why "Rust-native = 3 MB" and "Tauri = 500 MB" can both be technically quoted and both be misleading. We use **idle working set / resident** as the consistent unit below and label it as approximate.

---

## 2. What Hover Island actually needs (requirements that constrain the choice)

| Capability | Why it matters | Web-tech answer | Native-toolkit cost |
|---|---|---|---|
| Transparent, frameless, always-on-top, top-center, rounded | The notch look | Trivial in CSS (`border-radius`, transparent window) | Doable but manual (see §4) |
| Acrylic / blur / Mica material | "Premium, Apple-like" | CSS `backdrop-filter` + `window-vibrancy` (Mica/Acrylic) crate | egui: custom shaders; Slint: not first-class; Iced: custom wgpu |
| Smooth spring/scale animations | Dynamic-Island feel | CSS/WAAPI spring curves, GPU-composited | egui: manual per-frame tweening; Slint: has animation DSL; Iced: manual |
| Live audio-reactive **canvas** visualizer @ 60 fps (WebGL/2D) | Signature feature | Native `<canvas>` + WebGL/2D, well-trodden | egui: `Painter`/wgpu callback; Iced: `Canvas` widget (wgpu); Slint: **software renderer cannot host WebGL** |
| Fast reactive settings UI | Iteration speed | SolidJS fine-grained reactivity | Rebuild UI in DSL/retained widgets |
| System tray | Required | `tauri` `tray-icon` feature (already enabled) | Each toolkit needs its own tray crate |
| Global hotkey | Required | `tauri-plugin-global-shortcut` (already installed) | `global-hotkey` crate (works, more glue) |
| Native media/SMTC + notifications | Required | Windows crate `Media/Media_Control` + `UI_Notifications` binding from Rust (already in `Cargo.toml`) | Same Rust bindings — **identical either way** |
| File transfer (later) | Roadmap | Rust streaming over IPC | Same — do it in Rust either way |

Key observation: **everything below the UI is Rust and is identical across all options.** The framework choice only decides *how the pixels are drawn*. Native integrations (SMTC, tray, hotkey, notifications, future file transfer) do **not** get easier by switching to egui/Slint — they are already Rust code in this repo.

---

## 3. Option A — Tauri v2 + WebView2 (the current stack)

**Runtime model:** one Rust core process + WebView2 processes (`msedgewebview2.exe`). Frontend = static assets (SolidJS compiled by Vite).

**Rendering model:** Chromium (WebView2) — full HTML/CSS/JS, GPU-composited, real canvas/WebGL.
**Windows backend:** Microsoft Edge WebView2 (Chromium), OS-provided.

**Runtime RAM (idle, approximate):**

- WebView2 helper processes: **~40–90 MB**. One maintainer-thread report cites **~53 MB** for a minimal Tauri/wry app, with the (fair) reply that "WebView2 is similar in size … as running Google Chrome or Edge." — *tauri-apps/wry Discussion #921* [4]
- Rust core: **~10–25 MB** (small binary, no GC, no JS engine).
- A default Tauri app on Linux measured **USS ~125 MB / PSS ~185 MB** when accounting for the full process tree (this is a *default app with a webview*, not a minimal notch panel; Windows heavy web apps measured higher). — *Tauri Issue #5889* [5]
- **Realistic Hover Island budget: ~50–120 MB working set**, dominated by the webview.

**Binary size:** Tiny — the webview is not bundled. Tauri docs frame this as a core strength ("significantly smaller"); a hello-world release binary measured **~5 MB** in an independent comparison. — *Tauri App Size / Lukas Kalbertodt* [6][7]

**CPU:** Near-zero at idle if the frontend does no work while hidden. The visualizer costs real CPU/GPU only while visible and animating (same as any toolkit).

**Pros**

- Best-in-class styling/animation for the least effort: CSS, `backdrop-filter`, rounded rects, gradients, shadows, spring curves, and a first-class `<canvas>`/WebGL visualizer.
- Acrylic/Mica is a crate away (`window-vibrancy`), not a shader project.
- Already Rust-native; tray/hotkey/SMTC/notifications already wired in this repo.
- Frontend talent and libraries are abundant; SolidJS compiles to a very small bundle.
- WebView2 is already present on Windows 11 — no runtime to ship.

**Cons**

- WebView2's ~30–80 MB helper overhead vs a zero-webview toolkit; RSS is method-sensitive and shared-memory accounting is genuinely subtle (Chromium shares read-only pages; naive tools overcount). — *Tauri Issue #5889* [5]
- WebView2 is an extra dependency on the OS (fine on Win11; Win10 needs the Evergreen runtime).
- Transparent + backdrop-filter on a WebView2 window occasionally has platform quirks (paint/clear color, resize flicker) that need care.

---

## 4. Option B — Rust-native, no webview

For each: rendering model, Windows backend, baseline RAM, animation ceiling, styling capability, 60 fps canvas capability, maturity, and effort to reproduce *this specific notch UI*.

### egui / eframe
- **Rendering:** immediate-mode; UI re-run and re-tessellated **every frame**; default backends `egui-glow` (OpenGL) / `egui-wgpu`. — *pistack* [8]
- **Windows backend:** winit + OpenGL/wgpu.
- **Baseline RAM:** egui's *own* allocations are **~3.1 MiB**; whole-app **resident ~35.9 MB** for hello-world (macOS), and users report **~30 MB** for small apps. But the GPU pipeline is the real cost: one production app built on egui measured **~135 MB RSS** largely because of the OpenGL/wgpu context + graphics driver + texture atlas. — *egui #3689, Sarrade* [9][3]
- **Animation ceiling:** Good if you drive it every frame (immediate mode is frame-driven by nature), but you hand-roll easing/springs.
- **Styling (acrylic/blur, rounded, gradients, shadows):** Rounded rects, gradients, shadows: yes (painter API). Real OS **acrylic/Mica/blur**: not first-class — needs custom shaders or a winit-level backdrop hack.
- **60 fps canvas visualizer:** Yes — `Painter`, or a custom wgpu paint callback for GPU visualizations.
- **Maturity/ecosystem:** Large and production-proven for tools/dashboards (Rerun's viewer). Apache-2.0. But it "looks like a debug UI that grew up"; custom premium styling is not its point. — *wrenlearnsrust* [10]
- **Effort to reproduce the notch UI:** **High.** Everything is custom-painted; acrylic, the soft-shadow polish, and the exact Apple-like motion would each be significant manual work. Weeks.

### Slint
- **Rendering:** retained-mode declarative `.slint` DSL, compiled ahead of time. Renderers: **wgpu**, **Skia**, **software (CPU)**, plus DMA2D/framebuffer/line-by-line for embedded. — *slint.dev, pistack* [11][8]
- **Windows backend:** wgpu / Skia / software.
- **Baseline RAM:** The **software renderer** is the headline: one monitor app went from **~135 MB (egui, GPU) to ~30 MB (Slint, GPU off)**; Slint claims the runtime fits in **< 300 KiB RAM** for embedded targets. — *Sarrade, slint.dev* [3][11]
- **Animation ceiling:** Has a built-in animation/property system — decent and declarative, appropriate for UI transitions.
- **Styling:** Rounded rects, gradients, shadows, theming — good. **Acrylic/blur is not a first-class OS material**; you'd rely on winit-level window backdrop support.
- **60 fps canvas visualizer:** **This is the problem.** The software renderer will not accept a runtime-built path/canvas and cannot host WebGL; you must pre-declare fixed geometry and bind coordinates. A live audio-reactive visualizer with arbitrary 60 fps drawing is awkward at best under the software renderer, and under the GPU renderer you are back to paying GPU memory. — *Sarrade* [3]
- **Maturity/ecosystem:** Commercial backing, 20k+ stars, embedded-strong, multi-language (Rust/C++/JS/Python), Figma + live-preview tooling. **Licensing caveat:** royalty-free excludes embedded; GPLv3 or commercial otherwise. — *slint.dev, pistack* [11][8]
- **Effort to reproduce the notch UI:** **Medium-high.** The declarative DSL helps, but the WebGL visualizer requirement conflicts with Slint's strengths, and you'd rebuild the frontend and lose the web canvas ecosystem.

### Iced
- **Rendering:** retained-mode, Elm architecture (Model/Message/View); renders via **wgpu**. — *pistack* [8]
- **Windows backend:** wgpu.
- **Baseline RAM:** GPU-backed like egui (no exact published idle figure); expect the same class (tens of MB + graphics stack). Richer widget set than egui.
- **Animation ceiling:** Retained-mode with a built-in `Canvas` widget; animations are more work than CSS but feasible.
- **Styling:** Custom widgets/shaders; **no first-class OS acrylic**.
- **60 fps canvas:** Yes — the `Canvas` widget runs on wgpu, suitable for a GPU visualizer.
- **Maturity/ecosystem:** "Most product-grade" of the Rust-native trio in feel, but heavier compile times and a lighter ecosystem than the web. — *pistack* [8]
- **Effort to reproduce the notch UI:** **High.** Full rewrite; all styling/animation custom; acrylic absent.

### Dioxus (native/desktop) — brief
- Ships a **webview-based** renderer (WebView2 on Windows). Practically, desktop Dioxus has the **same webview cost class as Tauri** plus its own runtime layer, so it does **not** solve the RAM question. Accessibility and IME are strong (webview-derived). — *wrenlearnsrust* [10]
- **Verdict:** Not a memory win over Tauri; only a DX/framework-philosophy change.

### Xilem — brief
- From the Druid lineage; new architecture (view tree / reactive). **Not production-ready**; Windows maturity unproven. Watch, don't adopt. — *wrenlearnsrust* [10]

### Floem — brief
- Reactive, retained-mode Rust UI (used by Lapce). Small community, documentation gaps, GPU-backed; no first-class acrylic; would be a from-scratch rebuild.

### gpui (Zed's toolkit) — brief
- GPU-first, extremely fast, retained-mode; powers Zed. Very capable but effectively **one team's internal toolkit**, historically macOS/Linux-first with a less mature, less documented Windows story; not a safe foundation for a Windows-only shipping product today.

---

## 5. Option C — Baselines and contrast

### WinUI 3 / WPF (.NET)
- **WinUI 3** renders through the **system compositor** (`Windows.UI.Composition`) — the same engine that draws the taskbar/Start — giving **native Mica/Acrylic**, independent composition animations, and ~58–60 fps where WPF drops frames. In a line-of-business app benchmark it idled at **~155 MB working set vs WPF's ~185 MB** (WinUI 3 ~15–20% lower), though these are data-grid apps, not a thin notch. — *CTCO (WinUI 3 vs WPF, 2026)* [12]
- Microsoft has **publicly acknowledged** WinUI 3 apps over-consuming RAM and is reworking memory management (system compositor work at Build 2026). — *9to5Windows* [13]
- **WPF:** ~185 MB idle in the same benchmark; mature, huge ecosystem, but heavier and its Fluent theme does **not** use the compositor backdrop APIs (no true through-window Mica). [12]
- **Verdict:** Both are *heavier* than Tauri here, Windows-only, and would mean throwing away the existing Rust frontend; they beat Tauri only on "purest native acrylic," which `window-vibrancy` already approximates.

### Qt (C++)
- Mature, C++, large widget set; strong in industrial/embedded/scientific and resource-constrained use. "When raw performance and fine control matter more than development speed, and your team has C++ strength." — *essenn* [14]
- **RAM:** highly module-dependent; a minimal Qt Widgets app is typically tens of MB resident (varies by which modules are linked — WebEngine inflates it dramatically). *Illustrative, not a primary benchmark — verify with your own link set.*
- **Verdict:** Powerful and light **for a C++ team**, but QML heavy blur/acrylic and the C++ toolchain cost make it a poor fit versus the existing Rust/web stack.

### Electron (contrast)
- Bundles **Chromium + Node.js** in *every* app; processes never share across apps. Multiple Electron apps (Slack, Discord, VS Code) each load a full browser engine. A typical Electron app idles far higher than native; a renderer reported **~120 MB at startup**, and "each instance ~150 MB" is commonly quoted; heavy V8 GC churn causes page-file thrash on 8 GB machines. — *How-To Geek, Stack Overflow, pistack* [15][16][8]
- **Verdict:** The actual baseline Hover Island is *not* in. Tauri reuses the OS webview; Electron ships its own. This is the comparison that matters and the current stack wins it.

---

## 6. Comparison table

Idle RAM figures are **approximate, Windows-oriented, and method-dependent** (working set / RSS). A small Rust app's RSS is inflated by linked code + graphics drivers (see §1). Use ranges, not precision.

| Option | Rendering model / Windows backend | Baseline idle RAM (approx.) | Acrylic/blur + rounded + premium styling | 60 fps canvas visualizer | Maturity / ecosystem | Effort to reproduce THIS notch UI |
|---|---|---|---|---|---|---|
| **A) Tauri v2 + WebView2 (current)** | Chromium WebView2, HTML/CSS/JS, GPU-composited | **~50–120 MB** (Rust ~10–25 + WebView2 ~40–90); default-app USS ~125 / PSS ~185 on Linux [5] | **Best** — CSS + `backdrop-filter` + `window-vibrancy` (Mica/Acrylic) | **Trivial** — native `<canvas>`/WebGL | Mature, huge ecosystem; already wired here | **Zero (already built)** |
| egui / eframe | Immediate-mode, OpenGL/wgpu | **~30–40 MB** small; **~135 MB** with its GPU stack in a real app [9][3] | Rounded/gradients/shadows **yes**; OS acrylic **no** (custom) | Yes (`Painter` / wgpu callback) | Large, proven for tools; Apache-2.0 | **High** (weeks, custom paint) |
| Slint | Retained-mode DSL; wgpu / Skia / **software** | **~30 MB** (software renderer); runtime <300 KiB (embedded) [3][11] | Rounded/gradients/theming yes; OS acrylic **no** | **Poor under software renderer** (no WebGL, no runtime-built paths) [3] | Commercial backing, embedded-strong; **license caveats** | **Medium-high** |
| Iced | Retained (Elm), wgpu | Tens of MB + GPU stack (comparable class to egui) | Custom; OS acrylic **no** | Yes (`Canvas`/wgpu) | Growing, "product-grade" feel; slow compiles | **High** |
| Dioxus desktop | **WebView2** (webview-based) | **≈ Tauri class** (same webview cost) | Web styling (good) | Yes (webview canvas) | Very active; React-like | Medium (rewrite, no RAM win) |
| Xilem / Floem / gpui | Native GPU, evolving architectures | varies; little published data | custom | gpui yes; others partial | **Immature / niche / vendor-internal** | High + risk |
| WinUI 3 (.NET) | System compositor (`Windows.UI.Composition`) | **~155 MB** idle (LOB app) [12] | **Native Mica/Acrylic**, Fluent | Yes (composition) | Microsoft-backed, Windows-only | High (rewrite in C#/XAML) |
| WPF (.NET) | milcore → DirectX | **~185 MB** idle (LOB app) [12] | Fluent theme, **not** true Mica | Yes (custom) | Very mature, Windows-only | High (rewrite in C#/XAML) |
| Qt (C++) | QWidgets / QML (Qt Quick, GPU) | Tens of MB minimal widgets (module-dependent, illustrative) | QML effects; blur heavier | Yes (QML/Qt Quick) | Very mature; C++ toolchain | High (rewrite in C++) |
| Electron (contrast) | Bundled Chromium **+ Node.js** | **~120–300 MB** per app; ~150 MB typical [15][16] | Best web styling | Yes | Massive | High (and heavier) |

**Sources for each bracket are listed in §8.**

---

## 7. Recommendation

### Recommendation: **Keep Tauri v2 + SolidJS + WebView2. Optimize, don't rewrite.**

**Reasoning**

1. **It is already Rust-native where it counts.** Tray, global hotkey, SMTC/media, notifications, and (future) file transfer are Rust code in `src-tauri`. The framework switch would not make any of those faster or lighter — it would only change the renderer while forcing a full UI rewrite.
2. **There is no Node at runtime.** The RAM argument against the current stack is based on a false premise (§1). Tauri ships no Chromium and no Node; it reuses the Windows 11 WebView2 runtime.
3. **The webview tax is tens of MB, not hundreds.** ~30–80 MB of WebView2 helpers versus a native toolkit buys native `<canvas>`/WebGL for the flagship visualizer, trivial acrylic/rounded/premium styling, and CSS spring animation. Recreating those in egui/Slint/Iced is weeks of custom rendering with visibly worse styling fidelity — and in Slint's case the visualizer requirement actively fights the framework.
4. **The app is idle almost always.** A single small top-center panel that is hidden most of the time has near-zero CPU when idle; the WebView2 overhead is a fixed, predictable cost, and WebView2 can be dropped to a **`Low` memory target level** (even suspended) when hidden.
5. **The comparison that matters is Electron, and Tauri wins it decisively** (no bundled browser, no Node). Against native toolkits it is modestly heavier in RAM and dramatically cheaper to build and iterate.

### If switching were ever justified

Only switch if **RAM becomes a hard, measured constraint** (e.g. an 8 GB target machine where the webview's tens of MB demonstrably break the budget) **and** you accept a rewrite. The cheapest realistic rewrite is **Slint with the software renderer** for the chrome — **but only if the audio visualizer can be redesigned to fixed geometry**, since Slint's software renderer cannot host a live WebGL canvas. Otherwise the rewrite is **egui or Iced**, at **weeks of effort**, with custom acrylic and hand-rolled motion. Estimate: **4–8 engineer-weeks** for a faithful port, plus ongoing ownership of a much thinner ecosystem.

### Optimization checklist (do this regardless; all native to Tauri v2)

**Window / WebView2**
- Keep **one window and one webview.** Render the settings UI as an in-window overlay/route, not a second window, unless it is open — each additional webview spawns another helper set.
- Use `window-vibrancy` for real **Mica/Acrylic** instead of heavy CSS blur where possible (cheaper than a big `backdrop-filter` surface).
- Set WebView2 to **`Low` memory target level / suspend when hidden** (wry exposes `set_memory_usage_level`; WebView2 API `MemoryUsageTargetLevel = Low` and `TrySuspend`). Ideal for an always-on-top panel that is usually hidden. — *wry 0.35.0 release notes, WebView2 spec* [17][18]
- Disable unused WebView2 features via `additionalBrowserArgs` (e.g. media autoplay/DRM/GPU features you don't use). Audit with `msedgewebview2.exe` in Task Manager.
- Keep the window `visible: false`/hidden and skip rendering until the notch is expanded.

**Frontend (SolidJS)**
- Keep the bundle small (SolidJS is already fine-grained); **code-split the settings UI** so it isn't parsed/executed at startup.
- Drive the visualizer with **`requestAnimationFrame` inside a single `<canvas>`** (WebGL preferred), and **stop the RAF loop entirely when hidden** — this is the #1 idle-CPU lever.
- Avoid DOM churn and layout thrash during animation; animate `transform`/`opacity` (GPU-composited) rather than layout properties.
- Throttle Rust→JS event/state pushes (media metadata, levels) to the display refresh rate, not unbounded.

**Rust / build (mostly already set)**
- `Cargo.toml` already ships an optimized profile: `codegen-units = 1`, `lto = true`, `opt-level = "s"`, `panic = "abort"`, `strip = true`. Good — keep it (consider `opt-level = 3` if CPU of the visualizer path becomes hot; measure first).
- Keep `withGlobalTauri: false` (already set) to avoid injecting the global JS API surface.
- Do **file transfer in Rust** (streaming, chunked over IPC) — never buffer whole files in JS.
- Use Tauri's **`removeUnusedCommands`** build option to strip ACL/commands you don't use. — *Tauri App Size* [6]

**Verify, don't guess**
- Measure with the *whole process tree* (`hover-island.exe` + all `msedgewebview2.exe`) using working set, and cross-check before/after each optimization — memory accounting is easy to fool (§1).

---

## 8. Sources

1. Tauri v2 — Process Model (Core process + OS WebView; WebView2 on Windows; no Node) — https://v2.tauri.app/concept/process-model/
2. Tauri v2 — Architecture ("They do not ship a runtime"; WRY/TAO; no Node at runtime) — https://v2.tauri.app/concept/architecture/
3. Trystan Sarrade — "How I took my Rust GUI from 135 MB to 30 MB by ditching the GPU" (egui→Slint software renderer; RSS explained; Slint software renderer can't build paths at runtime) — https://trystan-sarrade.com/article/rust-gui-135mb-to-30mb-egui-to-slint/
4. tauri-apps/wry Discussion #921 — WebView2 minimal app ~53 MB ("similar in size … as running Google Chrome or Edge") — https://github.com/tauri-apps/wry/discussions/921
5. tauri-apps/tauri Issue #5889 — Memory benchmark discussion (Tauri default app USS ~125 MB / PSS ~185 MB on Linux; Windows web-app figures 370–399 MB; shared-memory accounting caveats) — https://github.com/tauri-apps/tauri/issues/5889
6. Tauri v2 — App Size (binary-size guidance; `removeUnusedCommands`) — https://v2.tauri.app/concept/size/
7. Lukas Kalbertodt — "Tauri vs Iced vs egui: Rust GUI framework performance comparison" (Tauri binary ~5 MB, Iced ~17 MB, egui ~18 MB; startup/input-lag/resize) — https://lukaskalbertodt.github.io/2023/02/03/tauri-iced-egui-performance-comparison.html
8. Pi Stack — "Rust GUI Frameworks in 2026: egui vs iced vs Slint" (paradigms, renderers, maturity; Electron ~150 MB/app) — https://www.pistack.xyz/posts/2026-08-25-rust-gui-frameworks-egui-iced-slint-comparison/
9. emilk/egui Issue #3689 — RAM usage of egui (counted ~3.1 MiB, resident ~35.9 MiB; "~30 MB with strip"; GPU stack the real overhead) — https://github.com/emilk/egui/issues/3689
10. Wren Learns Rust — "The Rust GUI Landscape in 2026" (Dioxus desktop = WebView; Xilem not production-ready; egui "looks like a debug UI") — https://wrenlearnsrust.com/posts/2026-03-11-rust-gui-landscape-2026.html
11. Slint — official site (declarative DSL, wgpu/Skia/software renderers, runtime <300 KiB RAM, licensing) — https://slint.dev/
12. CTCO — "WinUI vs WPF in 2026: A Practical Comparison" (LOB benchmark: WinUI 3 ~155 MB vs WPF ~185 MB idle; compositor-backed rendering; Mica/Acrylic native only in WinUI 3) — https://www.ctco.blog/posts/winui-vs-wpf-2026-practical-comparison/
13. 9to5Windows — "Microsoft Admits Windows 11 Apps Hog RAM, Promises WinUI 3 Fix" — https://9to5windows.com/microsoft-admits-windows-11-apps-hog-ram-winui-3-fix/
14. ESS ENN Associates — "Desktop App Frameworks Compared (2026)" (Qt: high-performance C++, module-dependent; Electron memory/size tradeoff) — https://essenn.associates/blog-desktop-app-frameworks-compared.html
15. How-To Geek — "Hate Windows' RAM usage? Wait until you find out about Electron apps" (Chromium + Node per app; no sharing; idle-heavy) — https://www.howtogeek.com/hate-windows-ram-usage-wait-until-you-find-out-about-electron-apps/
16. Stack Overflow — "electron memory usage profiling" (~120 MB at startup, JS heap growth) — https://stackoverflow.com/questions/59931495/electron-memory-usage-profiling
17. Tauri — wry@0.35.0 release notes (`WebViewExtWindows::set_memory_usage_level`; set `Low` when inactive to cut memory) — https://v2.tauri.app/release/wry/v0.35.0/
18. MicrosoftEdge/WebView2Feedback — `MemoryUsageTargetLevel` spec (`Low`/`Normal`, `TrySuspend`/`Resume` for hidden apps running scripts) — https://github.com/MicrosoftEdge/WebView2Feedback/blob/main/specs/MemoryUsageTargetLevel.md
19. Rust for Windows (community guide) — "Windows GUI in Rust — egui, WinUI, iced & Slint" (windows-rs/WinUI 3 via WinRT; framework fit) — https://rust-pc.github.io/rust-windows-gui.html

> **Measurement caveat:** all RAM figures above are approximate and method-dependent (working set vs RSS vs PSS vs USS). The same app can be quoted with wildly different numbers depending on whether shared/library/driver memory is counted. Treat the table as *relative ordering and rough magnitude*, and confirm against Hover Island's own process tree on the target machine.
