use tauri::Manager;

pub mod archive;
pub mod cbz;
pub mod convert;
#[cfg(test)]
mod fixtures;
pub mod format;
pub mod library;
pub mod pinch;
pub mod protocol;
pub mod rar;
#[cfg(debug_assertions)]
pub mod recording;
pub mod volume;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_documents::init())
        .manage(volume::Volumes::default())
        .setup(|app| {
            // A library that cannot be opened leaves the reader working: its commands say why
            let opened = app
                .path()
                .app_data_dir()
                .map_err(|e| e.to_string())
                .and_then(|dir| library::open(&dir.join("library.sqlite3")));
            if let Err(e) = &opened {
                eprintln!("The library could not be opened: {e}");
            }
            app.manage(library::Library::new(opened));
            // WebKitGTK keeps touchpad pinch from the page: read it from the widget
            #[cfg(target_os = "linux")]
            pinch::forward(app);
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol("page", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let path = request.uri().path().to_owned();
            // Reading the archive blocks: keep it off the webview's thread
            tauri::async_runtime::spawn_blocking(move || {
                let volumes = app.state::<volume::Volumes>();
                responder.respond(protocol::respond(&volumes, &path));
            });
        })
        .invoke_handler(handler())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// The input recorder exists only in debug builds
#[cfg(debug_assertions)]
fn handler() -> impl Fn(tauri::ipc::Invoke) -> bool {
    tauri::generate_handler![
        volume::open_volume,
        volume::page_sizes,
        library::library_add,
        library::library_list,
        library::library_opened,
        library::library_save,
        library::library_remove,
        recording::save_recording
    ]
}

#[cfg(not(debug_assertions))]
fn handler() -> impl Fn(tauri::ipc::Invoke) -> bool {
    tauri::generate_handler![
        volume::open_volume,
        volume::page_sizes,
        library::library_add,
        library::library_list,
        library::library_opened,
        library::library_save,
        library::library_remove
    ]
}
