fn main() {
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
