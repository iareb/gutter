//! Saves input recordings made with the development-only recorder in the UI.
//! Compiled into debug builds only: release builds have no such command.

use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};

/// Writes a recording to `<app data>/recordings/<timestamp>.json` and returns
/// the full path. On Android that is inside the app's private storage:
/// `adb exec-out run-as io.github.iareb.gutter cat <path>` copies it out.
#[tauri::command]
pub fn save_recording(app: AppHandle, json: String) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("recordings");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    let path = dir.join(format!("{millis}.json"));
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}
