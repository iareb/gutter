//! Open volumes: an archive whose index is in memory, pages read on demand.

use std::fs::File;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};

use crate::archive::{self, PageSource};
use crate::cbz::Cbz;
use crate::format::{self, Format};

/// An open archive of any format. Only its index is in memory.
pub struct Volume {
    source: Mutex<Box<dyn PageSource>>,
    /// The page names in reading order, kept here to answer without locking.
    names: Vec<String>,
}

impl Volume {
    /// Recognizes the format from the first bytes of the file, reads the index
    /// and lists the pages. Fails on anything that is not a readable archive
    /// with at least one page.
    pub fn open(mut file: File) -> Result<Volume, String> {
        let format =
            format::detect(&mut file).map_err(|e| format!("The file could not be read ({e})."))?;
        let source: Box<dyn PageSource> = match format {
            // Anything unrecognized still gets tried as a ZIP: it may have a stub in front
            Format::Zip | Format::Unknown => Box::new(Cbz::open(file)?),
            Format::Rar => return Err("CBR files (RAR archives) are not supported yet.".into()),
            Format::SevenZip => {
                return Err("CB7 files (7z archives) are not supported yet.".into());
            }
        };
        let names = source.pages().to_vec();
        if names.is_empty() {
            return Err("This archive contains no pages.".into());
        }
        Ok(Volume {
            source: Mutex::new(source),
            names,
        })
    }

    /// The page names in reading order.
    pub fn page_names(&self) -> &[String] {
        &self.names
    }

    /// Reads one page (counted from 0). Returns its bytes and MIME type.
    pub fn read_page(&self, n: usize) -> Result<(Vec<u8>, &'static str), String> {
        let name = self
            .names
            .get(n)
            .ok_or_else(|| format!("Page {} does not exist.", n + 1))?;
        let bytes = self.source.lock().unwrap().read(n)?;
        Ok((bytes, archive::mime_type(name)))
    }
}

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

    let pages = volume.page_names().to_vec();
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
        assert_eq!(volume.page_names(), ["1.jpg", "2.jpg"]);
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
    fn opens_a_zip_whatever_it_is_called() {
        // The format comes from the bytes: this is what a ZIP named `.cbr` looks like to us
        let volume = Volume::open(zip_file(&["1.jpg"])).unwrap();
        assert_eq!(volume.page_names().len(), 1);
    }

    #[test]
    fn says_which_formats_are_not_supported_yet() {
        let not_yet = |bytes: &[u8]| Volume::open(temp_file(bytes)).err().unwrap();
        let rar = "CBR files (RAR archives) are not supported yet.";
        assert_eq!(not_yet(b"Rar!\x1a\x07\x00\xcf\x90s\0\0"), rar);
        assert_eq!(not_yet(b"Rar!\x1a\x07\x01\x00\x33\x92"), rar);
        assert_eq!(
            not_yet(b"7z\xbc\xaf\x27\x1c\x00\x04"),
            "CB7 files (7z archives) are not supported yet."
        );
    }

    #[test]
    fn rejects_empty_files() {
        let error = Volume::open(temp_file(b"")).err().unwrap();
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
