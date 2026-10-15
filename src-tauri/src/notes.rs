//! Quick notes, persisted to `<app_config_dir>/notes.json`.
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

use crate::types::NotesState;

static NOTES_LOCK: Mutex<()> = Mutex::new(());

fn notes_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("notes.json"))
}

#[tauri::command]
pub fn notes_get(app: AppHandle) -> Result<NotesState, String> {
    let _guard = NOTES_LOCK.lock().unwrap();
    let path = notes_path(&app)?;
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str::<NotesState>(&text)
            .map_err(|error| format!("Could not read saved notes: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(NotesState::default()),
        Err(error) => Err(format!("Could not read saved notes: {error}")),
    }
}

#[tauri::command]
pub fn notes_set(app: AppHandle, text: String) -> Result<(), String> {
    if text.len() > 200_000 {
        return Err("Notes are limited to 200 KB".into());
    }
    let _guard = NOTES_LOCK.lock().unwrap();
    let path = notes_path(&app)?;
    let payload = serde_json::to_string_pretty(&NotesState { text }).map_err(|e| e.to_string())?;
    let temp_path = path.with_extension(format!("json.{}.tmp", uuid::Uuid::new_v4()));
    let write_result = (|| -> std::io::Result<()> {
        let mut file = std::fs::File::create(&temp_path)?;
        file.write_all(payload.as_bytes())?;
        file.sync_all()
    })();
    if let Err(error) = write_result {
        let _ = std::fs::remove_file(&temp_path);
        return Err(error.to_string());
    }
    if let Err(error) = replace_file(&temp_path, &path) {
        let _ = std::fs::remove_file(&temp_path);
        return Err(error);
    }
    Ok(())
}

fn replace_file(temp: &std::path::Path, path: &std::path::Path) -> Result<(), String> {
    match std::fs::rename(temp, path) {
        Ok(()) => Ok(()),
        Err(first) if path.exists() => {
            let backup = path.with_extension(format!("json.{}.bak", uuid::Uuid::new_v4()));
            std::fs::rename(path, &backup).map_err(|_| first.to_string())?;
            match std::fs::rename(temp, path) {
                Ok(()) => {
                    let _ = std::fs::remove_file(backup);
                    Ok(())
                }
                Err(error) => {
                    let _ = std::fs::rename(backup, path);
                    Err(error.to_string())
                }
            }
        }
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replacing_notes_keeps_the_new_complete_payload() {
        let dir = std::env::temp_dir().join(format!("hover-island-notes-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("notes.json");
        let temp = dir.join("notes.next.tmp");
        std::fs::write(&path, "old").unwrap();
        let expected = NotesState {
            text: "Keep this note\nCafé ☕".into(),
        };
        std::fs::write(&temp, serde_json::to_vec(&expected).unwrap()).unwrap();
        replace_file(&temp, &path).unwrap();
        let saved: NotesState = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved, expected);
        let _ = std::fs::remove_dir_all(dir);
    }
}
