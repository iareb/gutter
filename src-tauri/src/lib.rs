pub mod archive;
pub mod volume;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(volume::Volumes::default())
        .invoke_handler(tauri::generate_handler![volume::open_volume])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
