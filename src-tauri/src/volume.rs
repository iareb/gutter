//! Open volumes: an archive whose index is in memory, pages read on demand.

use std::fs::File;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};
use zip::ZipArchive;

use crate::archive::{self, Page};

/// An open archive. Only the ZIP index is in memory.
pub struct Volume {
    #[expect(dead_code, reason = "read by the page protocol, roadmap step 1.2")]
    archive: Mutex<ZipArchive<File>>,
    pages: Vec<Page>,
}

impl Volume {
    /// Reads the archive index and lists the pages. Fails on anything that is
    /// not a readable ZIP with at least one page.
    pub fn open(file: File) -> Result<Volume, String> {
        let archive = ZipArchive::new(file)
            .map_err(|e| format!("This file is not a CBZ archive, or it is damaged ({e})."))?;
        let pages = archive::pages(&archive);
        if pages.is_empty() {
            return Err("This archive contains no pages.".into());
        }
        Ok(Volume {
            archive: Mutex::new(archive),
            pages,
        })
    }
}

/// The volume being read. Opening another one replaces it.
#[derive(Default)]
pub struct Volumes {
    next_id: AtomicU32,
    current: Mutex<Option<(u32, Arc<Volume>)>>,
}

#[derive(Serialize)]
pub struct VolumeInfo {
    id: u32,
    /// Entry names in reading order.
    pages: Vec<String>,
}

/// Opens the file chosen in the picker: a path on desktop, a `content://` URI on Android.
#[tauri::command]
pub fn open_volume(
    app: AppHandle,
    volumes: State<Volumes>,
    path: FilePath,
) -> Result<VolumeInfo, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    let file = app
        .fs()
        .open(path, options)
        .map_err(|e| format!("The file could not be opened ({e})."))?;
    let volume = Volume::open(file)?;

    let id = volumes.next_id.fetch_add(1, Ordering::Relaxed);
    let pages = volume.pages.iter().map(|p| p.name.clone()).collect();
    *volumes.current.lock().unwrap() = Some((id, Arc::new(volume)));
    Ok(VolumeInfo { id, pages })
}

#[cfg(test)]
mod tests {
    use std::io::{Seek, Write};

    use zip::write::{SimpleFileOptions, ZipWriter};

    use super::Volume;

    fn temp_file(bytes: &[u8]) -> std::fs::File {
        let mut file = tempfile::tempfile().unwrap();
        file.write_all(bytes).unwrap();
        file.rewind().unwrap();
        file
    }

    fn zip_file(names: &[&str]) -> std::fs::File {
        let mut writer = ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for name in names {
            writer
                .start_file(*name, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(b"x").unwrap();
        }
        temp_file(&writer.finish().unwrap().into_inner())
    }

    #[test]
    fn opens_an_archive_with_pages() {
        let volume = Volume::open(zip_file(&["2.jpg", "1.jpg"])).unwrap();
        assert_eq!(volume.pages.len(), 2);
        assert_eq!(volume.pages[0].name, "1.jpg");
    }

    #[test]
    fn rejects_files_that_are_not_zip() {
        let error = Volume::open(temp_file(b"plain text")).err().unwrap();
        assert!(
            error.starts_with("This file is not a CBZ archive"),
            "{error}"
        );
    }

    #[test]
    fn rejects_truncated_archives() {
        let mut bytes = Vec::new();
        let mut file = zip_file(&["1.jpg", "2.jpg", "3.jpg"]);
        std::io::Read::read_to_end(&mut file, &mut bytes).unwrap();
        bytes.truncate(bytes.len() * 6 / 10);
        assert!(Volume::open(temp_file(&bytes)).is_err());
    }

    #[test]
    fn rejects_archives_without_pages() {
        let error = Volume::open(zip_file(&["ComicInfo.xml"])).err().unwrap();
        assert_eq!(error, "This archive contains no pages.");
    }
}
