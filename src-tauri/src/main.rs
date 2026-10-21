// Packaged desktop builds must never open a spare console window.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

fn main() {
    if std::env::args_os()
        .any(|argument| argument == std::ffi::OsStr::new("--audio-diagnostics"))
    {
        std::process::exit(hover_island_lib::run_audio_diagnostics());
    }
    if std::env::args_os()
        .any(|argument| argument == std::ffi::OsStr::new("--notification-diagnostics"))
    {
        std::process::exit(hover_island_lib::run_notification_diagnostics());
    }
    hover_island_lib::run()
}
