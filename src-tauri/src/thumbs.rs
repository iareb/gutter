//! Covers for the library: the first page of a volume, made small once and kept.
//!
//! A cover is a JPEG [`WIDTH`] pixels wide, made in Rust from the first page in
//! reading order and saved in the app's cache folder under the volume's
//! fingerprint, so a file changed in place gets a new one and a file moved or
//! renamed keeps its own. A first page Rust cannot decode leaves a marker
//! instead, so it is not tried again: the library shows a plain placeholder.
//! Covers are made when the library asks for them, at most [`AT_ONCE`] at a
//! time; a cover asked for twice while it is being made is made once.

use std::collections::HashMap;
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};

use image::codecs::jpeg::JpegEncoder;

use crate::convert;
use crate::volume::Volume;

/// Wide enough for a cover in a grid of two columns on a phone, at its pixel
/// density (about 190 CSS pixels at 2.6 physical pixels each is 500): 400 is a
/// little soft there and sharp everywhere else, at 30 to 60 KB a cover.
pub const WIDTH: u32 = 400;
const QUALITY: u8 = 85;
/// Covers made at the same time: each one decodes a whole page, up to a few
/// hundred MB for a huge scan, and the reader may be turning pages meanwhile.
pub const AT_ONCE: usize = 2;

/// The cover of a volume: its JPEG bytes, or none when its first page cannot be
/// decoded. An error is a volume that could not be read at all (a file gone, a
/// permission lost): nothing is kept, so it is tried again next time.
pub type Cover = Result<Option<Vec<u8>>, String>;

/// Makes a cover from a volume's first page.
pub fn make(volume: &Volume) -> Cover {
    let (bytes, mime) = volume.read_page(0)?;
    Ok(shrink(&bytes, mime))
}

/// A page made into a cover, or none if it cannot be decoded.
pub fn shrink(bytes: &[u8], mime: &str) -> Option<Vec<u8>> {
    let page = image::load_from_memory(bytes)
        .ok()
        // AVIF on Linux: the same decoder the reader falls back on
        .or_else(|| {
            let png = convert::to_png(bytes, mime).ok()?;
            image::load_from_memory(&png).ok()
        })?;
    let (width, height) = (page.width(), page.height());
    if width == 0 || height == 0 {
        return None;
    }
    // Never made larger than the page. An average over each area of the page: as
    // clean as a filter for a shrink this large, and about three times faster, which
    // matters on a phone, where Android runs this work on its slower cores
    let small = if width > WIDTH {
        let h = ((height as u64 * WIDTH as u64 + width as u64 / 2) / width as u64).max(1) as u32;
        page.thumbnail_exact(WIDTH, h)
    } else {
        page
    };
    let mut out = Cursor::new(Vec::new());
    JpegEncoder::new_with_quality(&mut out, QUALITY)
        .encode_image(&small.to_rgb8())
        .ok()?;
    Some(out.into_inner())
}

/// The covers kept in a folder, and the ones being made.
pub struct Thumbs {
    dir: PathBuf,
    /// One lock per fingerprint being made, so that two requests make it once.
    making: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// Covers being made now, at most [`AT_ONCE`].
    slots: (Mutex<usize>, Condvar),
    /// Covers made since the app started, for the tests and the measurements.
    made: AtomicUsize,
}

impl Thumbs {
    pub fn new(dir: PathBuf) -> Self {
        Thumbs {
            dir,
            making: Mutex::default(),
            slots: (Mutex::new(0), Condvar::new()),
            made: AtomicUsize::new(0),
        }
    }

    pub fn made(&self) -> usize {
        self.made.load(Ordering::Relaxed)
    }

    fn file(&self, fingerprint: &str, extension: &str) -> PathBuf {
        // A fingerprint is digits, a dash and hex digits: safe as a file name
        self.dir.join(format!("{fingerprint}.{extension}"))
    }

    /// What is kept for a fingerprint, if anything.
    fn kept(&self, fingerprint: &str) -> Option<Option<Vec<u8>>> {
        if let Ok(bytes) = fs::read(self.file(fingerprint, "jpg")) {
            return Some(Some(bytes));
        }
        self.file(fingerprint, "none").exists().then_some(None)
    }

    /// The cover for a fingerprint: the one kept, or one made now from the
    /// volume `open` opens. Blocking: call it off the webview's thread.
    pub fn get(&self, fingerprint: &str, open: impl FnOnce() -> Result<Volume, String>) -> Cover {
        if let Some(kept) = self.kept(fingerprint) {
            return Ok(kept);
        }
        let lock = self
            .making
            .lock()
            .unwrap()
            .entry(fingerprint.to_string())
            .or_default()
            .clone();
        let cover = {
            let _one = lock.lock().unwrap();
            // Made by the request that held the lock before this one
            match self.kept(fingerprint) {
                Some(kept) => Ok(kept),
                None => {
                    let _slot = self.slot();
                    self.make_and_keep(fingerprint, open)
                }
            }
        };
        self.making.lock().unwrap().remove(fingerprint);
        cover
    }

    fn make_and_keep(
        &self,
        fingerprint: &str,
        open: impl FnOnce() -> Result<Volume, String>,
    ) -> Cover {
        let cover = make(&open()?)?;
        self.made.fetch_add(1, Ordering::Relaxed);
        let kept = match &cover {
            Some(jpeg) => write(&self.file(fingerprint, "jpg"), jpeg),
            None => write(&self.file(fingerprint, "none"), b""),
        };
        // Not kept (a full disk): shown now, made again next time
        if let Err(e) = kept {
            eprintln!("A cover could not be kept: {e}");
        }
        Ok(cover)
    }

    /// Waits for one of the [`AT_ONCE`] places, and gives it back when dropped.
    fn slot(&self) -> Slot<'_> {
        let (count, freed) = &self.slots;
        let mut n = count.lock().unwrap();
        while *n >= AT_ONCE {
            n = freed.wait(n).unwrap();
        }
        *n += 1;
        Slot(&self.slots)
    }
}

struct Slot<'a>(&'a (Mutex<usize>, Condvar));

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        *self.0.0.lock().unwrap() -= 1;
        self.0.1.notify_one();
    }
}

/// Writes a whole file or nothing: written aside, then renamed into place, so a
/// cover cut short by the app closing is never read back.
fn write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let aside = path.with_extension("part");
    fs::write(&aside, bytes)?;
    fs::rename(&aside, path)
}

#[cfg(test)]
mod tests {
    use std::io::{Seek, Write};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use image::{ImageBuffer, ImageFormat, Rgb, RgbImage};
    use zip::write::{SimpleFileOptions, ZipWriter};

    use super::*;
    use crate::fixtures;

    fn png(width: u32, height: u32) -> Vec<u8> {
        let img: RgbImage = ImageBuffer::from_fn(width, height, |x, y| {
            Rgb([(x % 256) as u8, (y % 256) as u8, 128])
        });
        let mut out = Cursor::new(Vec::new());
        img.write_to(&mut out, ImageFormat::Png).unwrap();
        out.into_inner()
    }

    fn volume(pages: &[(&str, Vec<u8>)]) -> Volume {
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes) in pages {
            writer
                .start_file(*name, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(bytes).unwrap();
        }
        let mut file = tempfile::tempfile().unwrap();
        file.write_all(&writer.finish().unwrap().into_inner())
            .unwrap();
        file.rewind().unwrap();
        Volume::open(file).unwrap()
    }

    fn size(jpeg: &[u8]) -> (u32, u32) {
        let img = image::load_from_memory_with_format(jpeg, ImageFormat::Jpeg).unwrap();
        (img.width(), img.height())
    }

    #[test]
    fn a_cover_is_the_first_page_in_reading_order_made_small() {
        // "2.png" sorts before "10.png": the cover is page 2's shape, not page 10's
        let v = volume(&[("10.png", png(1200, 600)), ("2.png", png(1600, 2400))]);
        let jpeg = make(&v).unwrap().unwrap();
        assert_eq!(size(&jpeg), (WIDTH, 600));
        assert!(jpeg.len() < 100_000, "{} bytes", jpeg.len());
    }

    #[test]
    fn a_small_page_is_not_made_larger() {
        let v = volume(&[("1.png", png(300, 450))]);
        assert_eq!(size(&make(&v).unwrap().unwrap()), (300, 450));
    }

    #[test]
    fn covers_of_the_fixture_pages_and_archives() {
        for name in ["page 1.png", "page 2.png", "page 10.png"] {
            assert!(
                shrink(&fixtures::page(name), "image/png").is_some(),
                "{name}"
            );
        }
        for name in ["pages-rar5.cbr", "solid-rar5.cbr", "pages-rar4.cbr"] {
            let v = Volume::open(fixtures::open(name)).unwrap();
            assert!(make(&v).unwrap().is_some(), "{name}");
        }
    }

    #[test]
    fn a_page_that_cannot_be_decoded_has_no_cover() {
        let v = volume(&[("1.jpg", b"not a picture".to_vec())]);
        assert_eq!(make(&v).unwrap(), None);
    }

    #[test]
    fn a_cover_is_made_once_and_kept() {
        let dir = tempfile::tempdir().unwrap();
        let thumbs = Thumbs::new(dir.path().join("thumbs"));
        let opened = AtomicUsize::new(0);
        let open = || {
            opened.fetch_add(1, Ordering::Relaxed);
            Ok(volume(&[("1.png", png(800, 1200))]))
        };
        let first = thumbs.get("100-ab", open).unwrap().unwrap();
        let again = thumbs.get("100-ab", open).unwrap().unwrap();
        assert_eq!(first, again);
        assert_eq!((thumbs.made(), opened.load(Ordering::Relaxed)), (1, 1));
        assert!(dir.path().join("thumbs/100-ab.jpg").exists());
        // Kept across a restart of the app
        let later = Thumbs::new(dir.path().join("thumbs"));
        assert_eq!(
            later.get("100-ab", || unreachable!()).unwrap().unwrap(),
            first
        );
    }

    #[test]
    fn a_page_without_a_cover_is_not_tried_again() {
        let dir = tempfile::tempdir().unwrap();
        let thumbs = Thumbs::new(dir.path().to_path_buf());
        let open = || Ok(volume(&[("1.jpg", b"broken".to_vec())]));
        assert_eq!(thumbs.get("7-ff", open).unwrap(), None);
        assert_eq!(thumbs.get("7-ff", || unreachable!()).unwrap(), None);
        assert_eq!(thumbs.made(), 1);
    }

    #[test]
    fn a_volume_that_cannot_be_read_is_tried_again() {
        let dir = tempfile::tempdir().unwrap();
        let thumbs = Thumbs::new(dir.path().to_path_buf());
        let error = thumbs.get("9-00", || Err("gone".into())).unwrap_err();
        assert_eq!(error, "gone");
        assert!(
            thumbs
                .get("9-00", || Ok(volume(&[("1.png", png(10, 10))])))
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn the_same_cover_asked_at_once_is_made_once() {
        let dir = tempfile::tempdir().unwrap();
        let thumbs = Arc::new(Thumbs::new(dir.path().to_path_buf()));
        let opened = Arc::new(AtomicUsize::new(0));
        let handles: Vec<_> = (0..6)
            .map(|_| {
                let (thumbs, opened) = (thumbs.clone(), opened.clone());
                std::thread::spawn(move || {
                    thumbs
                        .get("5-aa", || {
                            opened.fetch_add(1, Ordering::Relaxed);
                            std::thread::sleep(std::time::Duration::from_millis(50));
                            Ok(volume(&[("1.png", png(900, 900))]))
                        })
                        .unwrap()
                        .unwrap()
                })
            })
            .collect();
        let covers: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert!(covers.windows(2).all(|w| w[0] == w[1]));
        assert_eq!(opened.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn no_more_than_a_few_covers_are_made_at_once() {
        let dir = tempfile::tempdir().unwrap();
        let thumbs = Arc::new(Thumbs::new(dir.path().to_path_buf()));
        let now = Arc::new(AtomicUsize::new(0));
        let most = Arc::new(AtomicUsize::new(0));
        let handles: Vec<_> = (0..6)
            .map(|i| {
                let (thumbs, now, most) = (thumbs.clone(), now.clone(), most.clone());
                std::thread::spawn(move || {
                    thumbs
                        .get(&format!("{i}-cc"), || {
                            let n = now.fetch_add(1, Ordering::SeqCst) + 1;
                            most.fetch_max(n, Ordering::SeqCst);
                            std::thread::sleep(std::time::Duration::from_millis(40));
                            now.fetch_sub(1, Ordering::SeqCst);
                            Ok(volume(&[("1.png", png(20, 20))]))
                        })
                        .unwrap()
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(most.load(Ordering::SeqCst), AT_ONCE);
        assert_eq!(thumbs.made(), 6);
    }
}
