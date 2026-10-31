// Spike S1: serve CBZ pages to the webview through a custom protocol
// (page://<volume>/<n>) and compare it with IPC.
// Throwaway code, lives only on the spike/s1 branch.

use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::Serialize;
use tauri::http::{Response as HttpResponse, StatusCode, header};
use tauri::ipc::Response;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};
use zip::ZipArchive;

const IMAGE_EXTENSIONS: [&str; 5] = ["jpg", "jpeg", "png", "webp", "avif"];

/// An open archive: only the ZIP index is in memory, pages are read on demand.
struct Volume {
    archive: Mutex<ZipArchive<File>>,
    /// Image entries sorted by name, as (name, index in archive).
    pages: Vec<(String, usize)>,
}

#[derive(Default)]
struct Volumes {
    next_id: AtomicU32,
    open: Mutex<HashMap<u32, Arc<Volume>>>,
}

impl Volumes {
    fn get(&self, id: u32) -> Result<Arc<Volume>, String> {
        self.open
            .lock()
            .unwrap()
            .get(&id)
            .cloned()
            .ok_or_else(|| format!("volume {id} is not open"))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VolumeInfo {
    id: u32,
    size_bytes: u64,
    pages: usize,
    open_ms: f64,
    index_ms: f64,
}

fn open_file(app: &AppHandle, path: FilePath) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    app.fs().open(path, options).map_err(|e| format!("open failed: {e}"))
}

fn extension(name: &str) -> String {
    name.rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .unwrap_or_default()
}

fn mime_type(name: &str) -> &'static str {
    match extension(name).as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

fn page_entries(archive: &ZipArchive<File>) -> Vec<(String, usize)> {
    let mut pages: Vec<(String, usize)> = archive
        .file_names()
        .enumerate()
        .filter_map(|(index, name)| Some((name.ok()?.into_owned(), index)))
        .filter(|(name, _)| IMAGE_EXTENSIONS.contains(&extension(name).as_str()))
        .collect();
    pages.sort();
    pages
}

/// Reads one page from the archive. Returns its bytes and MIME type.
fn read_page_bytes(volume: &Volume, page: usize) -> Result<(Vec<u8>, &'static str), String> {
    let (name, index) = volume
        .pages
        .get(page)
        .ok_or_else(|| format!("page {page} out of range"))?;
    let mut archive = volume.archive.lock().unwrap();
    let mut entry = archive.by_index(*index).map_err(|e| e.to_string())?;
    let mut bytes = Vec::with_capacity(entry.size() as usize);
    entry.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    Ok((bytes, mime_type(name)))
}

#[tauri::command]
fn open_volume(app: AppHandle, volumes: State<Volumes>, path: FilePath) -> Result<VolumeInfo, String> {
    let t0 = Instant::now();
    let file = open_file(&app, path)?;
    let size_bytes = file.metadata().map(|m| m.len()).unwrap_or(0);
    let open_ms = t0.elapsed().as_secs_f64() * 1000.0;

    let t1 = Instant::now();
    let archive = ZipArchive::new(file).map_err(|e| format!("not a valid CBZ: {e}"))?;
    let pages = page_entries(&archive);
    let index_ms = t1.elapsed().as_secs_f64() * 1000.0;

    let id = volumes.next_id.fetch_add(1, Ordering::Relaxed);
    let page_count = pages.len();
    let mut open = volumes.open.lock().unwrap();
    open.clear(); // spike: one volume at a time
    open.insert(id, Arc::new(Volume { archive: Mutex::new(archive), pages }));

    Ok(VolumeInfo { id, size_bytes, pages: page_count, open_ms, index_ms })
}

/// IPC path, kept only to compare with the custom protocol.
#[tauri::command]
fn read_page(volumes: State<Volumes>, id: u32, page: usize) -> Result<Response, String> {
    let volume = volumes.get(id)?;
    let (bytes, _) = read_page_bytes(&volume, page)?;
    Ok(Response::new(bytes))
}

/// Serves `<scheme>://localhost/<volume>/<page>`.
fn serve_page(app: &AppHandle, path: &str) -> HttpResponse<Vec<u8>> {
    let result = (|| {
        let mut parts = path.trim_start_matches('/').split('/');
        let id: u32 = parts.next().and_then(|s| s.parse().ok()).ok_or("bad volume id")?;
        let page: usize = parts.next().and_then(|s| s.parse().ok()).ok_or("bad page number")?;
        let volume = app.state::<Volumes>().get(id)?;
        read_page_bytes(&volume, page)
    })();

    match result {
        Ok((bytes, mime)) => HttpResponse::builder()
            .header(header::CONTENT_TYPE, mime)
            // Measure Rust every time, not the webview cache
            .header(header::CACHE_CONTROL, "no-store")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(bytes)
            .unwrap(),
        Err(message) => HttpResponse::builder()
            .status(StatusCode::NOT_FOUND)
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(message.into_bytes())
            .unwrap(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Volumes::default())
        .register_asynchronous_uri_scheme_protocol("page", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let path = request.uri().path().to_string();
            // Off the webview's thread: archive reads must never block the UI
            std::thread::spawn(move || responder.respond(serve_page(&app, &path)));
        })
        .invoke_handler(tauri::generate_handler![open_volume, read_page])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
