// One-click email sign-in uses OAuth clients baked in at compile time. Values
// come from the environment or from the gitignored `src-tauri/.env.oauth`
// (KEY=VALUE lines; see `oauth.env.example`). Missing keys just hide the
// one-click buttons.
const OAUTH_KEYS: [&str; 3] = [
    "HOVER_GOOGLE_CLIENT_ID",
    "HOVER_GOOGLE_CLIENT_SECRET",
    "HOVER_MICROSOFT_CLIENT_ID",
];

fn embed_oauth_clients() {
    let file =
        std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap()).join(".env.oauth");
    println!("cargo:rerun-if-changed={}", file.display());
    let from_file = std::fs::read_to_string(&file).unwrap_or_default();
    for key in OAUTH_KEYS {
        println!("cargo:rerun-if-env-changed={key}");
        if std::env::var(key).is_ok_and(|value| !value.trim().is_empty()) {
            continue;
        }
        let value = from_file.lines().find_map(|line| {
            let (name, value) = line.trim().split_once('=')?;
            (name.trim() == key).then(|| value.trim().trim_matches('"').to_string())
        });
        if let Some(value) = value.filter(|value| !value.is_empty()) {
            println!("cargo:rustc-env={key}={value}");
        }
    }
}

fn main() {
    embed_oauth_clients();
    // Link the same control manifest into both the application and its library
    // harness. Keep icons/version resources in Tauri's normal resource library.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest()),
    )
    .expect("Tauri build setup failed");
    // The library test harness also links Tauri's native controls. Without a
    // v6 activation manifest, Windows loads legacy comctl32 before tests start
    // and cannot resolve TaskDialogIndirect (STATUS_ENTRYPOINT_NOT_FOUND).
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let manifest = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap())
            .join("windows-test.manifest");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        // The Windows bindings can exceed MSVC's PDB type-table limit in the
        // native test harness. Symbols are optional for these local builds.
        if std::env::var("PROFILE").as_deref() == Ok("debug") {
            println!("cargo:rustc-link-arg=/DEBUG:NONE");
        }
    }
}
