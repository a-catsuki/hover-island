mod airdrop;
mod apps;
mod audio;
mod bluetooth;
mod calendar;
mod calendar_sources;
mod connections;
mod devices;
mod email_codes;
mod erp;
mod lyrics;
mod media;
mod memory_reclaim;
mod nearby;
mod notes;
mod notifications;
mod paired_devices;
mod placement;
mod quick_controls;
mod recycle;
mod reset_watch;
mod runtime_memory;
mod settings;
mod sound;
mod spotlight;
mod state;
mod system;
mod system_events;
mod transfer;
mod tray;
mod types;
mod usage;
mod weather;
mod window;

use std::str::FromStr;
use std::sync::atomic::Ordering;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use settings::Settings;
use state::AppState;
use types::{NowPlaying, UsageSnapshot};

static SETTINGS_MUTATION_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
#[derive(Clone)]
struct HotkeyBindings {
    island: String,
    spotlight: String,
}
static ACTIVE_HOTKEYS: std::sync::Mutex<Option<HotkeyBindings>> = std::sync::Mutex::new(None);

fn validate_shortcuts(island: &str, spotlight: &str) -> Result<(), String> {
    let island = Shortcut::from_str(island).map_err(|e| format!("Invalid island shortcut: {e}"))?;
    let spotlight =
        Shortcut::from_str(spotlight).map_err(|e| format!("Invalid search shortcut: {e}"))?;
    let required = Modifiers::CONTROL | Modifiers::ALT | Modifiers::SUPER;
    if !island.mods.intersects(required) || !spotlight.mods.intersects(required) {
        return Err("Use Control, Alt, or Windows with another key for each shortcut.".into());
    }
    if island == spotlight {
        return Err("Island and search shortcuts must be different.".into());
    }
    Ok(())
}

#[cfg(test)]
mod shortcut_tests {
    use super::validate_shortcuts;

    #[test]
    fn distinct_configurable_shortcuts_accept_aliases_and_swaps() {
        assert!(validate_shortcuts("Alt+Space", "Control+Space").is_ok());
        assert!(validate_shortcuts("Control+Space", "Alt+Space").is_ok());
        assert!(validate_shortcuts("Control+Shift+K", "Alt+J").is_ok());
    }

    #[test]
    fn conflicts_plain_keys_and_invalid_shortcuts_are_rejected() {
        assert!(validate_shortcuts("Ctrl+Space", "Control+Space").is_err());
        assert!(validate_shortcuts("Escape", "Control+Space").is_err());
        assert!(validate_shortcuts("Shift+K", "Control+Space").is_err());
        assert!(validate_shortcuts("not a shortcut", "Control+Space").is_err());
    }
}

fn register_shortcut(app: &AppHandle, hotkey: &str, search: bool) -> Result<(), String> {
    let shortcut = Shortcut::from_str(hotkey).map_err(|e| format!("Invalid shortcut: {e}"))?;
    app.global_shortcut()
        .on_shortcut(shortcut, move |app, _sc, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            let expanded = app.state::<AppState>().expanded.load(Ordering::Relaxed);
            let _ = window::apply_expanded(app, if search { true } else { !expanded });
            let _ = window::show_main(app);
            if search {
                let _ = app.emit("spotlight://open", expanded);
            }
        })
        .map_err(|e| e.to_string())
}

// Runs only on the registration worker. Both shortcuts are one transaction so
// swaps work, conflicts leave the previous bindings in place, and no UI callback
// waits for plugin work dispatched onto the main event loop.
fn replace_shortcuts(app: &AppHandle, island: &str, spotlight: &str) -> Result<(), String> {
    validate_shortcuts(island, spotlight)?;
    let previous = ACTIVE_HOTKEYS.lock().unwrap().clone();
    if previous
        .as_ref()
        .is_some_and(|old| old.island == island && old.spotlight == spotlight)
    {
        return Ok(());
    }
    app.global_shortcut()
        .unregister_all()
        .map_err(|e| e.to_string())?;
    let registration = register_shortcut(app, island, false)
        .and_then(|()| register_shortcut(app, spotlight, true));
    if let Err(error) = registration {
        let _ = app.global_shortcut().unregister_all();
        if let Some(old) = previous.as_ref() {
            if let Err(rollback) = register_shortcut(app, &old.island, false)
                .and_then(|()| register_shortcut(app, &old.spotlight, true))
            {
                let _ = app.global_shortcut().unregister_all();
                *ACTIVE_HOTKEYS.lock().unwrap() = None;
                return Err(format!("Shortcut unavailable: {error}. Previous shortcuts could not be restored: {rollback}"));
            }
        }
        *ACTIVE_HOTKEYS.lock().unwrap() = previous;
        return Err(format!(
            "Shortcut unavailable: {error}. Choose another combination."
        ));
    }
    *ACTIVE_HOTKEYS.lock().unwrap() = Some(HotkeyBindings {
        island: island.into(),
        spotlight: spotlight.into(),
    });
    Ok(())
}

fn update_shortcut_on_worker(
    app: AppHandle,
    island: String,
    spotlight: String,
) -> Result<(), String> {
    replace_shortcuts(&app, &island, &spotlight)
}

fn schedule_shortcut_registration(app: AppHandle) {
    std::thread::spawn(move || {
        if app.state::<AppState>().shutdown.load(Ordering::Relaxed) {
            return;
        }
        let _mutation = SETTINGS_MUTATION_LOCK.blocking_lock();
        if app.state::<AppState>().shutdown.load(Ordering::Relaxed) {
            return;
        }
        let settings = app.state::<AppState>().settings.lock().unwrap().clone();
        if replace_shortcuts(&app, &settings.hotkey, &settings.spotlight_hotkey).is_err() {
            let defaults = Settings::default();
            if replace_shortcuts(&app, &defaults.hotkey, &defaults.spotlight_hotkey).is_ok() {
                let state = app.state::<AppState>();
                let mut settings = state.settings.lock().unwrap();
                settings.hotkey = defaults.hotkey;
                settings.spotlight_hotkey = defaults.spotlight_hotkey;
                let _ = settings::save(&app, &settings);
                let _ = app.emit("settings://changed", &*settings);
            }
        }
        if app.state::<AppState>().shutdown.load(Ordering::Relaxed) {
            let _ = app.global_shortcut().unregister_all();
            *ACTIVE_HOTKEYS.lock().unwrap() = None;
        }
    });
}

fn apply_autostart(app: &AppHandle, enabled: bool) {
    let mgr = app.autolaunch();
    let _ = if enabled { mgr.enable() } else { mgr.disable() };
}

fn spawn_background(app: AppHandle) {
    let usage_app = app.clone();
    std::thread::spawn(move || {
        let mut last_media: Option<NowPlaying> = None;
        let mut last_foreground: Option<bool> = None;
        let mut notification_tick = 0u8;
        let mut last_notification_error: Option<String> = None;
        loop {
            if app.state::<AppState>().shutdown.load(Ordering::Relaxed) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(1000));
            notification_tick = notification_tick.wrapping_add(1);
            if app.state::<AppState>().shutdown.load(Ordering::Relaxed) {
                break;
            }
            let (media_enabled, notifications_enabled, email_enabled, dnd) = {
                let state = app.state::<AppState>();
                let settings = state.settings.lock().unwrap();
                (
                    settings.modules.media,
                    settings.modules.notifications
                        && settings.notifications.enabled
                        && settings.notifications.system_listener,
                    settings.modules.notifications && settings.notifications.enabled,
                    settings.dnd,
                )
            };

            if notification_tick % 25 == 0 {
                let email_app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = email_codes::poll(&email_app, email_enabled, dnd).await;
                });
            }

            // Diff-before-emit: only publish when the foreground posture changes.
            let foreground = window::foreground_maximized();
            if last_foreground != Some(foreground) {
                last_foreground = Some(foreground);
                let _ = app.emit("window://foreground", foreground);
            }

            if media_enabled {
                if let Ok(current) = media::get_checked() {
                    if current != last_media {
                        last_media = current.clone();
                        let _ = app.emit("media://changed", &current);
                    }
                }
            } else if last_media.take().is_some() {
                let _ = app.emit("media://changed", &Option::<NowPlaying>::None);
            }

            if notifications_enabled && notification_tick % 5 == 0 {
                let state = app.state::<AppState>();
                let poll_generation = state.notification_clear_generation.load(Ordering::Relaxed);
                let incoming = match notifications::poll() {
                    Ok(incoming) => {
                        if last_notification_error.take().is_some() {
                            let _ = app.emit("notifications://error", "");
                        }
                        incoming
                    }
                    Err(error) => {
                        if last_notification_error.as_ref() != Some(&error) {
                            let _ = app.emit("notifications://error", &error);
                            last_notification_error = Some(error);
                        }
                        // Permission and API failures must not erase an existing inbox.
                        continue;
                    }
                };
                let observed_now: std::collections::HashSet<String> =
                    incoming.iter().map(|n| n.id.clone()).collect();
                let mut dismissed = state.dismissed_notification_ids.lock().unwrap();
                let mut observed = state.observed_notification_ids.lock().unwrap();
                let mut cur = state.notifications.lock().unwrap();
                if state.notification_clear_generation.load(Ordering::Acquire) != poll_generation {
                    dismissed.extend(observed_now);
                    while dismissed.len() > 1024 {
                        let Some(oldest) = dismissed.iter().next().cloned() else {
                            break;
                        };
                        dismissed.remove(&oldest);
                    }
                    continue;
                }
                *observed = observed_now;
                while observed.len() > 1024 {
                    let Some(oldest) = observed.iter().next().cloned() else {
                        break;
                    };
                    observed.remove(&oldest);
                }
                let (changed, fresh) = notifications::merge_poll(&mut cur, incoming, &dismissed);
                if cur.len() > 50 {
                    let drop_n = cur.len() - 50;
                    dismissed.extend(cur.drain(0..drop_n).map(|n| n.id));
                    while dismissed.len() > 1024 {
                        let Some(oldest) = dismissed.iter().next().cloned() else {
                            break;
                        };
                        dismissed.remove(&oldest);
                    }
                }
                if changed {
                    let snapshot = cur.clone();
                    drop(cur);
                    let _ = app.emit("notifications://changed", &snapshot);
                    // Temporary "peek" expansion, suppressed while Do Not Disturb is on.
                    if !dnd {
                        for notification in fresh {
                            let _ = app.emit("notifications://popup", &notification);
                        }
                    }
                }
            }
        }
    });

    std::thread::spawn(move || {
        let mut last_usage: Vec<UsageSnapshot> = Vec::new();
        loop {
            if usage_app
                .state::<AppState>()
                .shutdown
                .load(Ordering::Relaxed)
            {
                break;
            }
            let settings = usage_app
                .state::<AppState>()
                .settings
                .lock()
                .unwrap()
                .clone();
            let snaps = usage::refresh(&settings);
            if snaps != last_usage {
                last_usage = snaps.clone();
                *usage_app.state::<AppState>().usage.lock().unwrap() = snaps.clone();
                let _ = usage_app.emit("usage://changed", &snaps);
            }
            for _ in 0..60 {
                if usage_app
                    .state::<AppState>()
                    .shutdown
                    .load(Ordering::Relaxed)
                {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_secs(1));
            }
        }
    });
}

/* ------------------------------- commands ------------------------------- */

#[tauri::command]
fn quit_app(app: AppHandle) -> Result<(), String> {
    quick_controls::restore_previous_power_plan()?;
    window::exit_app(app);
    Ok(())
}

#[tauri::command]
fn settings_get(app: AppHandle) -> Settings {
    app.state::<AppState>().settings.lock().unwrap().clone()
}

#[tauri::command]
async fn settings_set(app: AppHandle, patch: serde_json::Value) -> Result<Settings, String> {
    let _mutation = SETTINGS_MUTATION_LOCK.lock().await;
    let current = app.state::<AppState>().settings.lock().unwrap().clone();
    let next = settings::merge_patch(&current, patch);

    let shortcut_changed =
        next.hotkey != current.hotkey || next.spotlight_hotkey != current.spotlight_hotkey;
    if shortcut_changed {
        let worker_app = app.clone();
        let island = next.hotkey.clone();
        let spotlight = next.spotlight_hotkey.clone();
        tokio::task::spawn_blocking(move || {
            update_shortcut_on_worker(worker_app, island, spotlight)
        })
        .await
        .map_err(|e| e.to_string())??;
    }
    if let Err(error) = settings::save(&app, &next) {
        if shortcut_changed {
            let worker_app = app.clone();
            let island = current.hotkey.clone();
            let spotlight = current.spotlight_hotkey.clone();
            let rollback = tokio::task::spawn_blocking(move || {
                update_shortcut_on_worker(worker_app, island, spotlight)
            })
            .await
            .map_err(|e| e.to_string())
            .and_then(|result| result);
            if let Err(rollback_error) = rollback {
                let state = app.state::<AppState>();
                let mut settings = state.settings.lock().unwrap();
                settings.hotkey = next.hotkey.clone();
                settings.spotlight_hotkey = next.spotlight_hotkey.clone();
                return Err(format!(
                    "{error}; previous hotkey could not be restored: {rollback_error}"
                ));
            }
        }
        return Err(error);
    }
    *app.state::<AppState>().settings.lock().unwrap() = next.clone();
    if next.expanded != current.expanded {
        *app.state::<AppState>().interaction_bounds.lock().unwrap() = None;
    }
    if next.launch_at_login != current.launch_at_login {
        apply_autostart(&app, next.launch_at_login);
    }
    let geometry_result = if next.collapsed != current.collapsed
        || next.expanded != current.expanded
        || next.placement != current.placement
    {
        window::apply_bounds(&app).map_err(|e| e.to_string())
    } else {
        Ok(())
    };
    let _ = app.emit("settings://changed", &next);
    geometry_result?;

    Ok(next)
}

#[tauri::command]
async fn settings_reset(app: AppHandle) -> Result<Settings, String> {
    let _mutation = SETTINGS_MUTATION_LOCK.lock().await;
    let current = app.state::<AppState>().settings.lock().unwrap().clone();
    let def = Settings::default();
    if current.hotkey != def.hotkey || current.spotlight_hotkey != def.spotlight_hotkey {
        let worker_app = app.clone();
        let island = def.hotkey.clone();
        let spotlight = def.spotlight_hotkey.clone();
        tokio::task::spawn_blocking(move || {
            update_shortcut_on_worker(worker_app, island, spotlight)
        })
        .await
        .map_err(|e| e.to_string())??;
    }
    if let Err(error) = settings::save(&app, &def) {
        if current.hotkey != def.hotkey || current.spotlight_hotkey != def.spotlight_hotkey {
            let worker_app = app.clone();
            let island = current.hotkey.clone();
            let spotlight = current.spotlight_hotkey.clone();
            let rollback = tokio::task::spawn_blocking(move || {
                update_shortcut_on_worker(worker_app, island, spotlight)
            })
            .await
            .map_err(|e| e.to_string())
            .and_then(|result| result);
            if let Err(rollback_error) = rollback {
                let state = app.state::<AppState>();
                let mut settings = state.settings.lock().unwrap();
                settings.hotkey = def.hotkey.clone();
                settings.spotlight_hotkey = def.spotlight_hotkey.clone();
                return Err(format!(
                    "{error}; previous hotkey could not be restored: {rollback_error}"
                ));
            }
        }
        return Err(error);
    }
    *app.state::<AppState>().settings.lock().unwrap() = def.clone();
    *app.state::<AppState>().interaction_bounds.lock().unwrap() = None;
    apply_autostart(&app, def.launch_at_login);
    let geometry_result = window::apply_bounds(&app).map_err(|e| e.to_string());
    let _ = app.emit("settings://changed", &def);
    geometry_result?;
    Ok(def)
}

/* --------------------------------- run --------------------------------- */

/// Prints a privacy-minimal notification diagnostics snapshot and returns its
/// process exit code. Called by `main` before Tauri initializes any UI state.
pub fn run_notification_diagnostics() -> i32 {
    let (json, code) = notifications::diagnostics_json();
    println!("{json}");
    code
}

pub fn run_audio_diagnostics() -> i32 {
    match audio::diagnostics() {
        Ok(report) => { println!("{report}"); 0 }
        Err(error) => { println!("{}", serde_json::json!({ "ok": false, "error": error })); 1 }
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            let mut loaded = settings::load(app.handle());
            if validate_shortcuts(&loaded.hotkey, &loaded.spotlight_hotkey).is_err() {
                loaded.hotkey = Settings::default().hotkey;
                loaded.spotlight_hotkey = Settings::default().spotlight_hotkey;
                let _ = settings::save(app.handle(), &loaded);
            }
            app.manage(AppState::new(loaded.clone()));

            let index_app = app.handle().clone();
            std::thread::spawn(move || {
                let apps_list = apps::list();
                if index_app
                    .state::<AppState>()
                    .shutdown
                    .load(Ordering::Relaxed)
                {
                    return;
                }
                let files = spotlight::build_file_index();
                if index_app
                    .state::<AppState>()
                    .shutdown
                    .load(Ordering::Relaxed)
                {
                    return;
                }
                let state = index_app.state::<AppState>();
                *state.apps.lock().unwrap() = std::sync::Arc::new(apps_list);
                *state.files.lock().unwrap() = std::sync::Arc::new(files);
            });

            let _ = window::apply_bounds(app.handle());
            window::apply_effects_impl(app.handle());
            runtime_memory::set_main_active(app.handle(), loaded.onboarding_version == 0);
            if loaded.onboarding_version == 0 {
                let _ = window::apply_expanded(app.handle(), true);
                let _ = window::show_main(app.handle());
            }
            schedule_shortcut_registration(app.handle().clone());
            let _ = tray::build(app.handle());

            spawn_background(app.handle().clone());
            window::spawn_ignore_poll(app.handle().clone());
            devices::spawn(app.handle().clone());
            system_events::spawn(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            calendar_sources::calendar_sources_get,
            calendar_sources::calendar_source_add,
            calendar_sources::calendar_source_remove,
            placement::placement_begin_drag,
            placement::placement_move,
            placement::placement_snap,
            placement::placement_end_drag,
            erp::website_connections_get,
            erp::website_connection_add,
            erp::website_connection_remove,
            erp::website_alerts_get,
            sound::play_alert_sound,
            sound::send_test_alert,
            window::anchor_island,
            window::set_expanded,
            window::apply_geometry,
            window::resize_island,
            window::apply_effects,
            window::set_click_through,
            window::set_interaction_bounds,
            quit_app,
            window::open_devtools,
            window::open_settings_window,
            window::toggle_settings_window,
            tray::acknowledge_quit_request,
            weather::weather_get,
            weather::weather_detect_location,
            weather::weather_search,
            calendar::calendar_get,
            calendar::calendar_save,
            calendar::calendar_delete,
            calendar::calendar_import_ics,
            notes::notes_get,
            notes::notes_set,
            connections::connections_list,
            apps::apps_list,
            apps::apps_launch,
            apps::apps_open_url,
            apps::apps_open_web_app,
            spotlight::spotlight_search,
            spotlight::spotlight_reindex,
            nearby::nearby_status,
            nearby::nearby_start,
            nearby::nearby_stop,
            nearby::nearby_approve,
            nearby::nearby_send,
            airdrop::airdrop_capability,
            media::media_get,
            lyrics::lyrics_lookup,
            email_codes::email_codes_accounts,
            email_codes::email_codes_authorize,
            email_codes::email_codes_remove,
            email_codes::email_codes_set_paused,
            audio::audio_loopback_start,
            audio::audio_loopback_stop,
            bluetooth::bluetooth_devices_list,
            bluetooth::bluetooth_connect,
            bluetooth::bluetooth_disconnect,
            bluetooth::bluetooth_unpair,
            bluetooth::bluetooth_open_settings,
            devices::devices_get,
            reset_watch::reset_watch_get,
            transfer::transfer_status,
            transfer::transfer_start,
            transfer::transfer_stage_dropped_paths,
            transfer::transfer_stop,
            transfer::transfer_pairing_status,
            transfer::transfer_pairing_decide,
            transfer::transfer_pairing_remove,
            transfer::transfer_open_folder,
            recycle::recycle_dropped_paths,
            media::media_control,
            notifications::notifications_get,
            notifications::notifications_clear,
            notifications::notifications_request_access,
            notifications::notifications_access_status,
            notifications::notifications_test_connection,
            usage::usage_get,
            usage::usage_refresh,
            usage::usage_detect,
            system::system_stats,
            quick_controls::quick_controls_get,
            quick_controls::open_night_light_settings,
            quick_controls::open_bluetooth_settings,
            quick_controls::open_power_settings,
            quick_controls::open_windows_settings,
            quick_controls::set_bluetooth_radio,
            quick_controls::set_power_saver_plan,
            quick_controls::set_master_volume,
            quick_controls::set_mute,
            quick_controls::set_brightness,
            quick_controls::set_night_light,
            quick_controls::set_do_not_disturb,
            memory_reclaim::memory_scan,
            memory_reclaim::memory_reclaim,
            settings_get,
            settings_set,
            settings_reset
        ])
        .build(tauri::generate_context!())
        .expect("error building Hover Island")
        .run(|_, event| match event {
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::DragDrop(drag_event),
                ..
            } if label == "main" => match drag_event {
                tauri::DragDropEvent::Enter { .. } | tauri::DragDropEvent::Over { .. } => {
                    recycle::set_native_file_drag_active(true);
                }
                tauri::DragDropEvent::Leave => recycle::set_native_file_drag_active(false),
                tauri::DragDropEvent::Drop { paths, .. } => {
                    recycle::record_native_drop(&paths);
                    recycle::set_native_file_drag_active(false);
                }
                _ => {}
            },
            tauri::RunEvent::Exit => {
                let _ = quick_controls::restore_previous_power_plan();
            }
            _ => {}
        });
}
