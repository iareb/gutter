//! Files and folders the reader chose on Android, kept readable after the app closes.
//!
//! The dialog plugin asks Android for a file with `ACTION_GET_CONTENT`, whose address
//! can stop working once the app is gone. This plugin asks with `ACTION_OPEN_DOCUMENT`
//! and `ACTION_OPEN_DOCUMENT_TREE`, keeps the permission the system grants, and lists
//! the files of a folder. On other platforms its commands fail: the desktop has paths.

use serde_json::Value;
use tauri::{
    AppHandle, Runtime,
    plugin::{Builder, TauriPlugin},
};

#[cfg(target_os = "android")]
struct Documents<R: Runtime>(tauri::plugin::PluginHandle<R>);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("documents")
        .invoke_handler(tauri::generate_handler![
            pick_files,
            pick_folder,
            list_folder,
            describe,
            held,
            release
        ])
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                let handle = _api.register_android_plugin(
                    "io.github.iareb.gutter.documents",
                    "DocumentsPlugin",
                )?;
                _app.manage(Documents(handle));
            }
            Ok(())
        })
        .build()
}

/// Runs a command of the Kotlin side, off the async runtime: a picker waits for the reader.
async fn run<R: Runtime>(
    app: AppHandle<R>,
    command: &'static str,
    args: Value,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "android")]
        {
            use tauri::Manager;
            app.state::<Documents<R>>()
                .0
                .run_mobile_plugin::<Value>(command, args)
                .map_err(|e| e.to_string())
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = (app, command, args);
            Err("Only on Android.".to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Picks files: `{ action: "open" | "get", multiple }`. Each file comes with its name,
/// its size and whether the permission to read it was kept.
#[tauri::command]
async fn pick_files<R: Runtime>(app: AppHandle<R>, args: Value) -> Result<Value, String> {
    run(app, "pickFiles", args).await
}

/// Picks a folder and keeps the permission to read everything in it.
#[tauri::command]
async fn pick_folder<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    run(app, "pickFolder", Value::Null).await
}

/// Every file in a picked folder and its subfolders: `{ uri }`.
#[tauri::command]
async fn list_folder<R: Runtime>(app: AppHandle<R>, uri: String) -> Result<Value, String> {
    run(app, "listFolder", serde_json::json!({ "uri": uri })).await
}

/// Name and size of a file, and whether it can be read now.
#[tauri::command]
async fn describe<R: Runtime>(app: AppHandle<R>, uri: String) -> Result<Value, String> {
    run(app, "describe", serde_json::json!({ "uri": uri })).await
}

/// The permissions the app keeps.
#[tauri::command]
async fn held<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    run(app, "held", Value::Null).await
}

/// Gives a kept permission back.
#[tauri::command]
async fn release<R: Runtime>(app: AppHandle<R>, uri: String) -> Result<Value, String> {
    run(app, "release", serde_json::json!({ "uri": uri })).await
}
