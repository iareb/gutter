// Spike S3: can Rust open a file picked on Android (a content:// URI) and read
// a single page from a CBZ without loading the whole archive?
// Throwaway code, lives only on the spike/s3 branch.

use std::fs::File;
use std::io::Read;
use std::time::Instant;

use serde::Serialize;
use tauri::AppHandle;
use tauri::ipc::Response;
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};
use zip::ZipArchive;

const IMAGE_EXTENSIONS: [&str; 5] = ["jpg", "jpeg", "png", "webp", "avif"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveInfo {
    size_bytes: u64,
    entries: usize,
    pages: usize,
    first_page: String,
    open_ms: f64,
    index_ms: f64,
}

fn open_file(app: &AppHandle, path: FilePath) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    app.fs().open(path, options).map_err(|e| format!("open failed: {e}"))
}

fn is_image(name: &str) -> bool {
    name.rsplit_once('.')
        .is_some_and(|(_, ext)| IMAGE_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
}

/// Image entries sorted by name, as (name, index in archive).
fn page_entries(archive: &ZipArchive<File>) -> Vec<(String, usize)> {
    let mut pages: Vec<(String, usize)> = archive
        .file_names()
        .enumerate()
        .filter_map(|(index, name)| Some((name.ok()?.into_owned(), index)))
        .filter(|(name, _)| is_image(name))
        .collect();
    pages.sort();
    pages
}

#[tauri::command]
fn inspect_archive(app: AppHandle, path: FilePath) -> Result<ArchiveInfo, String> {
    let t0 = Instant::now();
    let file = open_file(&app, path)?;
    let size_bytes = file.metadata().map(|m| m.len()).unwrap_or(0);
    let open_ms = t0.elapsed().as_secs_f64() * 1000.0;

    let t1 = Instant::now();
    let archive = ZipArchive::new(file).map_err(|e| format!("not a valid CBZ: {e}"))?;
    let pages = page_entries(&archive);
    let index_ms = t1.elapsed().as_secs_f64() * 1000.0;

    Ok(ArchiveInfo {
        size_bytes,
        entries: archive.len(),
        pages: pages.len(),
        first_page: pages.first().map(|(name, _)| name.clone()).unwrap_or_default(),
        open_ms,
        index_ms,
    })
}

/// Returns the raw bytes of the first page, sent to the webview without JSON encoding.
#[tauri::command]
fn read_first_page(app: AppHandle, path: FilePath) -> Result<Response, String> {
    let file = open_file(&app, path)?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("not a valid CBZ: {e}"))?;
    let (_, index) = page_entries(&archive)
        .into_iter()
        .next()
        .ok_or("no images in archive")?;

    let mut entry = archive.by_index(index).map_err(|e| e.to_string())?;
    let mut bytes = Vec::with_capacity(entry.size() as usize);
    entry.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    Ok(Response::new(bytes))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![inspect_archive, read_first_page])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
