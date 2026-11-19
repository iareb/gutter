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
use crate::rar::Rar;

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
            Format::Rar => Box::new(Rar::open(file)?),
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

impl Volume {
    /// The size of a page, in pixels, from its image header, reading no more of
    /// the page than that needs where the format allows. None when it cannot be told.
    pub fn page_size(&self, n: usize) -> Option<(u32, u32)> {
        // Most headers are in the first few kilobytes; a JPEG with a large
        // thumbnail or metadata in front can push its size further
        for max in [64 * 1024, 1024 * 1024, usize::MAX] {
            let bytes = self.source.lock().unwrap().head(n, max).ok()?;
            if let Ok(size) = imagesize::blob_size(&bytes) {
                return Some((size.width as u32, size.height as u32));
            }
            if bytes.len() < max {
                // The whole page was read and it has no size we can read
                return None;
            }
        }
        None
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

/// Sizes of pages `from..to` (counted from 0), from their image headers, to
/// lay out double pages. A size that cannot be told is null. Asked in small
/// runs, so that the pages being read are never kept waiting for long: the
/// volume is locked page by page.
#[tauri::command]
pub async fn page_sizes(
    volumes: State<'_, Volumes>,
    id: u32,
    from: usize,
    to: usize,
) -> Result<Vec<Option<(u32, u32)>>, String> {
    let volume = volumes
        .get(id)
        .ok_or_else(|| "This volume is no longer open.".to_string())?;
    let to = to.min(volume.page_names().len());
    Ok((from.min(to)..to).map(|n| volume.page_size(n)).collect())
}

#[cfg(test)]
mod tests {
    use std::io::{Seek, Write};

    use zip::write::{SimpleFileOptions, ZipWriter};

    use crate::fixtures;

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

    /// The start of a PNG: enough for its size, nothing to decode.
    fn png_header(width: u32, height: u32) -> Vec<u8> {
        let mut b = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
        b.extend_from_slice(&width.to_be_bytes());
        b.extend_from_slice(&height.to_be_bytes());
        b.extend_from_slice(&[8, 6, 0, 0, 0]);
        b
    }

    /// A JPEG header with two large metadata segments before the size.
    fn jpeg_after_metadata(width: u16, height: u16) -> Vec<u8> {
        let mut b = vec![0xFF, 0xD8];
        for _ in 0..2 {
            b.extend_from_slice(&[0xFF, 0xE1]);
            b.extend_from_slice(&60_002u16.to_be_bytes());
            b.extend(std::iter::repeat_n(0, 60_000));
        }
        b.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x11, 0x08]);
        b.extend_from_slice(&height.to_be_bytes());
        b.extend_from_slice(&width.to_be_bytes());
        b.extend_from_slice(&[3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xFF, 0xD9]);
        b
    }

    #[test]
    fn tells_page_sizes_from_their_headers() {
        let mut writer = ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let pages: [(&str, Vec<u8>); 3] = [
            ("1.png", png_header(300, 200)),
            ("2.png", b"not an image".to_vec()),
            // A JPEG whose size comes after 120 KB of metadata: found by reading more of it
            ("3.jpg", jpeg_after_metadata(40, 60)),
        ];
        for (name, bytes) in &pages {
            writer
                .start_file(*name, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(bytes).unwrap();
        }
        let volume = Volume::open(temp_file(&writer.finish().unwrap().into_inner())).unwrap();
        assert_eq!(volume.page_size(0), Some((300, 200)));
        assert_eq!(volume.page_size(1), None);
        assert_eq!(volume.page_size(2), Some((40, 60)));
        assert_eq!(volume.page_size(3), None);
    }

    #[test]
    fn tells_page_sizes_in_a_cbr() {
        let volume = Volume::open(fixtures::open("pages-rar5.cbr")).unwrap();
        let (bytes, _) = volume.read_page(0).unwrap();
        let expected = imagesize::blob_size(&bytes).unwrap();
        assert_eq!(
            volume.page_size(0),
            Some((expected.width as u32, expected.height as u32))
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
        let error = Volume::open(temp_file(b"7z\xbc\xaf\x27\x1c\x00\x04"))
            .err()
            .unwrap();
        assert_eq!(error, "CB7 files (7z archives) are not supported yet.");
    }

    #[test]
    fn opens_a_cbr_and_reads_its_pages() {
        for name in ["pages-rar5.cbr", "pages-rar4.cbr", "pages-rar5-store.cbr"] {
            let volume = Volume::open(fixtures::open(name)).unwrap();
            assert_eq!(
                volume.page_names(),
                ["page 1.png", "page 2.png", "page 10.png"],
                "{name}"
            );
            let (bytes, mime) = volume.read_page(2).unwrap();
            assert_eq!((bytes, mime), (fixtures::page("page 10.png"), "image/png"));
        }
    }

    #[test]
    fn a_cbr_cut_short_says_it_is_incomplete() {
        let mut bytes = std::fs::read(fixtures::path("pages-rar4.cbr")).unwrap();
        bytes.truncate(bytes.len() / 2);
        let error = Volume::open(temp_file(&bytes)).err().unwrap();
        assert!(error.starts_with("This archive is incomplete"), "{error}");
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
