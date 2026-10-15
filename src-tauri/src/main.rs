// Packaged desktop builds must never open a spare console window.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

fn main() {
    hover_island_lib::run()
}
