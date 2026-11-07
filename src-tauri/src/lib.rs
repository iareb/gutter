use tauri::Manager;

pub mod archive;
pub mod convert;
pub mod protocol;
pub mod volume;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(volume::Volumes::default())
        .register_asynchronous_uri_scheme_protocol("page", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let path = request.uri().path().to_owned();
            // Reading the archive blocks: keep it off the webview's thread
            tauri::async_runtime::spawn_blocking(move || {
                let volumes = app.state::<volume::Volumes>();
                responder.respond(protocol::respond(&volumes, &path));
            });
        })
        .invoke_handler(tauri::generate_handler![volume::open_volume])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
