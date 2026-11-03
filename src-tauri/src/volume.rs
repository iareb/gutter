//! Open volumes: an archive whose index is in memory, pages read on demand.

use std::fs::File;
use std::io::Read;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};
use zip::ZipArchive;

use crate::archive::{self, Page};

/// An open archive. Only the ZIP index is in memory.
pub struct Volume {
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

    /// Reads one page (counted from 0). Returns its bytes and MIME type.
    pub fn read_page(&self, n: usize) -> Result<(Vec<u8>, &'static str), String> {
        let page = self
            .pages
            .get(n)
            .ok_or_else(|| format!("Page {} does not exist.", n + 1))?;
        let unreadable =
            |e: &dyn std::fmt::Display| format!("Page {} could not be read ({e}).", n + 1);

        let mut archive = self.archive.lock().unwrap();
        let mut entry = archive.by_index(page.index).map_err(|e| unreadable(&e))?;
        // The size comes from the archive and may be wrong: cap what is reserved upfront
        let mut bytes = Vec::with_capacity(entry.size().min(MAX_RESERVE) as usize);
        entry.read_to_end(&mut bytes).map_err(|e| unreadable(&e))?;
        Ok((bytes, archive::mime_type(&page.name)))
    }
}

const MAX_RESERVE: u64 = 64 * 1024 * 1024;

/// The volume being read. Opening another one replaces it.
#[derive(Default)]
pub struct Volumes {
    next_id: AtomicU32,
    current: Mutex<Option<(u32, Arc<Volume>)>>,
}

impl Volumes {
    /// Makes `volume` the current one. Ids are never reused, so the page
    /// address of a closed volume can never show a page of another one.
    pub fn insert(&self, volume: Volume) -> u32 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        *self.current.lock().unwrap() = Some((id, Arc::new(volume)));
        id
    }

    /// The volume with this id, if it is still open.
    pub fn get(&self, id: u32) -> Option<Arc<Volume>> {
        match &*self.current.lock().unwrap() {
            Some((current, volume)) if *current == id => Some(volume.clone()),
            _ => None,
        }
    }
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

    let pages = volume.pages.iter().map(|p| p.name.clone()).collect();
    let id = volumes.insert(volume);
    Ok(VolumeInfo { id, pages })
}

#[cfg(test)]
mod tests {
    use std::io::{Seek, Write};

    use zip::write::{SimpleFileOptions, ZipWriter};

    use super::{Volume, Volumes};

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
            // Each entry holds its own name, so a test can tell which one was read
            writer.write_all(name.as_bytes()).unwrap();
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
    fn reads_pages_in_reading_order() {
        let volume = Volume::open(zip_file(&["b/10.png", "ComicInfo.xml", "b/2.jpg"])).unwrap();
        assert_eq!(
            volume.read_page(0).unwrap(),
            (b"b/2.jpg".to_vec(), "image/jpeg")
        );
        assert_eq!(
            volume.read_page(1).unwrap(),
            (b"b/10.png".to_vec(), "image/png")
        );
    }

    #[test]
    fn rejects_pages_out_of_range() {
        let volume = Volume::open(zip_file(&["1.jpg"])).unwrap();
        assert_eq!(volume.read_page(1).err().unwrap(), "Page 2 does not exist.");
    }

    #[test]
    fn forgets_a_volume_when_another_opens() {
        let volumes = Volumes::default();
        let first = volumes.insert(Volume::open(zip_file(&["1.jpg"])).unwrap());
        assert!(volumes.get(first).is_some());
        let second = volumes.insert(Volume::open(zip_file(&["1.jpg"])).unwrap());
        assert_ne!(first, second);
        assert!(volumes.get(first).is_none());
        assert!(volumes.get(second).is_some());
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
