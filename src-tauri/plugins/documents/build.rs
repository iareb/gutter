const COMMANDS: &[&str] = &[
    "pick_files",
    "pick_folder",
    "list_folder",
    "describe",
    "held",
    "release",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
