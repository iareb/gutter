//! CBR files: RAR archives of pages (RAR 4 and RAR 5), read with the pure Rust
//! `rars` crate. See docs/spikes/cbr-library.md for why.
//!
//! When the archive is not solid a page is read by itself from its position,
//! which costs the same as a CBZ page. A solid archive is one compressed stream:
//! a page can only be decoded after all the ones before it. Doing that for every
//! page would make page 100 cost a hundred pages; so when a page is not at hand,
//! one pass over the archive decodes the history and keeps a window of pages
//! around the one asked for, as many as fit in a memory budget. Turning pages in
//! either direction then finds them ready, and a new pass is needed only to leave
//! the window: once every few pages for big pages, about once for the pages of a
//! typical comic. A jump costs the pages up to it, once.

use std::collections::HashMap;
use std::fs::File;
use std::io::Write;
use std::sync::{Arc, Mutex};

use rars::{Archive, ArchiveReadOptions, ArchiveReader, ExtractionDecision};

use crate::archive::{PageSource, is_page, natural_cmp};

/// How many bytes of decoded pages a solid archive keeps in memory.
const SOLID_WINDOW_BYTES: u64 = 48 * 1024 * 1024;

/// The size comes from the archive and may be wrong: cap what is reserved upfront.
const MAX_RESERVE: u64 = 64 * 1024 * 1024;

/// An open CBR. Only the headers are in memory; pages are read from the file on demand.
pub struct Rar {
    archive: Archive,
    /// Page names in reading order.
    names: Vec<String>,
    /// Position in the archive of each page, in reading order.
    indices: Vec<usize>,
    /// Set when the archive is solid.
    solid: Option<Solid>,
}

/// The decoded pages kept for a solid archive.
struct Solid {
    /// The pages in the order the archive holds them: position in the archive and
    /// size once unpacked. This is the order a pass decodes them in, which for
    /// names like `1, 10, 2` differs from reading order.
    pages: Vec<(usize, u64)>,
    /// How many bytes of pages to keep.
    budget: u64,
    /// The pages kept by the last pass, by position in the archive.
    window: HashMap<usize, Vec<u8>>,
    /// How many passes over the archive there have been.
    passes: usize,
}

/// The name of an entry as a path with `/` for folders: RAR 4 archives made on
/// Windows store `\`.
fn entry_name(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).replace('\\', "/")
}

impl Rar {
    /// Reads the archive headers. Fails on anything that is not a readable RAR.
    pub fn open(file: File) -> Result<Rar, String> {
        Rar::open_with_budget(file, SOLID_WINDOW_BYTES)
    }

    fn open_with_budget(file: File, budget: u64) -> Result<Rar, String> {
        let archive = ArchiveReader::read_reader(file)
            .map_err(|e| format!("This file is not a CBR archive, or it is damaged ({e})."))?;
        let mut pages: Vec<(String, usize)> = archive
            .member_refs()
            .enumerate()
            .filter(|(_, member)| !member.is_directory() && !member.is_redirection())
            .filter_map(|(index, member)| {
                let name = entry_name(&member.decoded_name(None).ok()?);
                is_page(&name).then_some((name, index))
            })
            .collect();
        // The order the archive holds them in, before sorting for reading
        let sizes: HashMap<usize, u64> = archive
            .members()
            .enumerate()
            .map(|(index, member)| (index, member.meta.unpacked_size))
            .collect();
        let in_archive_order: Vec<(usize, u64)> = pages
            .iter()
            .map(|(_, index)| (*index, sizes.get(index).copied().unwrap_or(0)))
            .collect();
        pages.sort_by(|a, b| natural_cmp(&a.0, &b.0));
        let (names, indices) = pages.into_iter().unzip();

        let is_solid = archive.is_solid() || archive.member_refs().any(|m| m.is_solid());
        let solid = is_solid.then(|| {
            let mut pages = in_archive_order;
            pages.sort_by_key(|(index, _)| *index);
            Solid {
                pages,
                budget,
                window: HashMap::new(),
                passes: 0,
            }
        });
        Ok(Rar {
            archive,
            names,
            indices,
            solid,
        })
    }

    /// How many passes over a solid archive reading has taken so far.
    #[cfg(test)]
    fn passes(&self) -> usize {
        self.solid.as_ref().map_or(0, |s| s.passes)
    }
}

/// Which pages of a solid archive to keep when a pass is needed for the one at
/// `target` (all positions in archive order): the first and last of a run that
/// contains it and fits in `budget` bytes. People read forwards more than back,
/// so it fills three quarters of the budget ahead, then behind, then ahead again.
/// The page asked for is always kept, whatever its size.
fn window_range(sizes: &[u64], target: usize, budget: u64) -> (usize, usize) {
    let (mut lo, mut hi) = (target, target);
    let mut used = sizes[target];
    for (limit, ahead) in [(budget / 4 * 3, true), (budget, false), (budget, true)] {
        loop {
            if ahead && hi + 1 < sizes.len() && used + sizes[hi + 1] <= limit {
                hi += 1;
                used += sizes[hi];
            } else if !ahead && lo > 0 && used + sizes[lo - 1] <= limit {
                lo -= 1;
                used += sizes[lo];
            } else {
                break;
            }
        }
    }
    (lo, hi)
}

/// A place for the bytes of a page to go, which the pass owns while it runs.
struct Collector(Arc<Mutex<Vec<u8>>>);

impl Write for Collector {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Solid {
    /// Decodes the archive from the start up to the page at `position` in archive
    /// order and the pages after it that fit, and keeps the window of pages
    /// around it. The pages before the window are decoded and thrown away: they
    /// are the history the next ones need.
    fn decode_window(&mut self, archive: &Archive, position: usize) -> rars::Result<()> {
        let sizes: Vec<u64> = self.pages.iter().map(|(_, size)| *size).collect();
        let (lo, hi) = window_range(&sizes, position, self.budget);
        let kept: HashMap<usize, Arc<Mutex<Vec<u8>>>> = self.pages[lo..=hi]
            .iter()
            .map(|(index, size)| {
                let capacity = (*size).min(MAX_RESERVE) as usize;
                (*index, Arc::new(Mutex::new(Vec::with_capacity(capacity))))
            })
            .collect();
        let last = self.pages[hi].0;

        let mut current = 0;
        self.passes += 1;
        archive.extract_with_control(ArchiveReadOptions::new(), |member| {
            let this = current;
            current += 1;
            if this > last {
                return Ok(ExtractionDecision::Stop);
            }
            if let Some(buffer) = kept.get(&this) {
                return Ok(ExtractionDecision::Extract(Box::new(Collector(
                    buffer.clone(),
                ))));
            }
            if member.meta.is_directory || member.meta.is_redirection {
                return Ok(ExtractionDecision::Skip);
            }
            // In a solid archive a member cannot be skipped: its output is the
            // history of the next one
            Ok(ExtractionDecision::Extract(Box::new(std::io::sink())))
        })?;

        self.window = kept
            .into_iter()
            .map(|(index, buffer)| (index, std::mem::take(&mut *buffer.lock().unwrap())))
            .collect();
        Ok(())
    }
}

impl PageSource for Rar {
    fn pages(&self) -> &[String] {
        &self.names
    }

    fn read(&mut self, n: usize) -> Result<Vec<u8>, String> {
        let unreadable =
            |e: &dyn std::fmt::Display| format!("Page {} could not be read ({e}).", n + 1);
        let index = *self
            .indices
            .get(n)
            .ok_or_else(|| format!("Page {} does not exist.", n + 1))?;

        let Some(solid) = &mut self.solid else {
            return self
                .archive
                .read_member_at(index, None)
                .map_err(|e| unreadable(&e))?
                .ok_or_else(|| unreadable(&"it has no data"));
        };
        if !solid.window.contains_key(&index) {
            let position = solid
                .pages
                .iter()
                .position(|(i, _)| *i == index)
                .ok_or_else(|| unreadable(&"it is not in the archive"))?;
            solid
                .decode_window(&self.archive, position)
                .map_err(|e| unreadable(&e))?;
        }
        solid
            .window
            .get(&index)
            .cloned()
            .ok_or_else(|| unreadable(&"it has no data"))
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use crate::archive::PageSource;
    use crate::fixtures;

    use super::{Rar, entry_name, window_range};

    const FIXTURES: [&str; 3] = ["pages-rar5.cbr", "pages-rar4.cbr", "pages-rar5-store.cbr"];
    const SOLID: [&str; 2] = ["solid-rar5.cbr", "solid-rar4.cbr"];

    #[test]
    fn lists_the_pages_in_reading_order_without_the_rest() {
        for name in FIXTURES {
            let rar = Rar::open(fixtures::open(name)).unwrap();
            // ComicInfo.xml and the macOS junk are left out; 2 comes before 10
            assert_eq!(
                rar.pages(),
                ["page 1.png", "page 2.png", "page 10.png"],
                "{name}"
            );
        }
    }

    #[test]
    fn reads_each_page_byte_for_byte() {
        for name in FIXTURES {
            let mut rar = Rar::open(fixtures::open(name)).unwrap();
            for (n, page) in ["page 1.png", "page 2.png", "page 10.png"]
                .iter()
                .enumerate()
            {
                assert_eq!(rar.read(n).unwrap(), fixtures::page(page), "{name}, {page}");
            }
            // Not solid: every page is read by itself
            assert_eq!(rar.passes(), 0, "{name}");
        }
    }

    #[test]
    fn rejects_pages_out_of_range() {
        let mut rar = Rar::open(fixtures::open("pages-rar5.cbr")).unwrap();
        assert_eq!(rar.read(3).err().unwrap(), "Page 4 does not exist.");
    }

    #[test]
    fn reads_folders_written_with_backslashes() {
        assert_eq!(entry_name(b"Chapter 1\\001.jpg"), "Chapter 1/001.jpg");
        assert_eq!(entry_name("pàgina è.jpg".as_bytes()), "pàgina è.jpg");
        // So the macOS junk of a RAR 4 archive made on Windows is still recognized
        assert!(!crate::archive::is_page(&entry_name(
            b"__MACOSX\\._page 1.png"
        )));
    }

    #[test]
    fn refuses_a_truncated_archive() {
        let mut bytes = std::fs::read(fixtures::path("pages-rar5.cbr")).unwrap();
        bytes.truncate(bytes.len() / 2);
        let mut file = tempfile::tempfile().unwrap();
        file.write_all(&bytes).unwrap();
        let error = Rar::open(file).err().unwrap();
        assert!(
            error.starts_with("This file is not a CBR archive"),
            "{error}"
        );
    }

    // The window of a solid archive

    #[test]
    fn the_window_fills_ahead_first_then_behind() {
        let sizes = [10; 10];
        // Three quarters of 40 is 30 bytes: the page and two after it; then behind, up to 40
        assert_eq!(window_range(&sizes, 4, 40), (3, 6));
        // At the start there is nothing behind: the rest goes ahead
        assert_eq!(window_range(&sizes, 0, 40), (0, 3));
        // At the end the same the other way
        assert_eq!(window_range(&sizes, 9, 40), (6, 9));
    }

    #[test]
    fn the_window_always_holds_the_page_asked_for() {
        assert_eq!(window_range(&[10, 500, 10], 1, 40), (1, 1));
        assert_eq!(window_range(&[10, 10, 10], 1, 0), (1, 1));
        // Everything fits
        assert_eq!(window_range(&[10, 10, 10], 1, u64::MAX), (0, 2));
    }

    #[test]
    fn the_window_counts_bytes_not_pages() {
        // The big page behind would take it past the budget, so the window stays after it
        assert_eq!(window_range(&[5, 5, 30, 5, 5, 5], 3, 40), (3, 5));
        // With room for it, it goes in, and so does the page before it: 15 + 30 + 5 = 50
        assert_eq!(window_range(&[5, 5, 30, 5, 5, 5], 3, 50), (1, 5));
    }

    fn solid(name: &str, budget: u64) -> Rar {
        Rar::open_with_budget(fixtures::open(name), budget).unwrap()
    }

    fn reading_order() -> Vec<String> {
        (1..=12).map(|i| format!("{i}.png")).collect()
    }

    #[test]
    fn lists_a_solid_archive_in_reading_order() {
        for name in SOLID {
            let rar = solid(name, u64::MAX);
            assert_eq!(rar.pages(), reading_order(), "{name}");
        }
    }

    #[test]
    fn reads_every_page_of_a_solid_archive_in_one_pass_when_they_fit() {
        for name in SOLID {
            let mut rar = solid(name, u64::MAX);
            for (n, page) in reading_order().iter().enumerate() {
                assert_eq!(
                    rar.read(n).unwrap(),
                    fixtures::page_in("pages-12", page),
                    "{name}, {page}"
                );
            }
            // The first page brought them all: the rest were at hand
            assert_eq!(rar.passes(), 1, "{name}");
        }
    }

    #[test]
    fn keeps_to_the_budget_and_still_reads_everything() {
        for name in SOLID {
            // Room for about three pages of a dozen
            let mut rar = solid(name, 240);
            for (n, page) in reading_order().iter().enumerate() {
                assert_eq!(
                    rar.read(n).unwrap(),
                    fixtures::page_in("pages-12", page),
                    "{name}, {page}"
                );
            }
            // More than one pass, far fewer than one per page
            let passes = rar.passes();
            assert!((2..=8).contains(&passes), "{name}: {passes} passes");
            // The window never holds more than the budget allows (three pages of ~77 bytes)
            assert!(rar.solid.as_ref().unwrap().window.len() <= 3, "{name}");
        }
    }

    #[test]
    fn reading_a_page_again_costs_no_pass() {
        let mut rar = solid("solid-rar5.cbr", 240);
        rar.read(5).unwrap();
        let passes = rar.passes();
        assert_eq!(rar.read(5).unwrap(), fixtures::page_in("pages-12", "6.png"));
        assert_eq!(rar.passes(), passes);
    }

    #[test]
    fn reads_backwards_and_jumps_in_any_order() {
        for name in SOLID {
            let mut rar = solid(name, 240);
            for n in [11, 10, 9, 0, 6, 1, 7, 2, 11, 3, 8, 4, 5] {
                let page = format!("{}.png", n + 1);
                assert_eq!(
                    rar.read(n).unwrap(),
                    fixtures::page_in("pages-12", &page),
                    "{name}, {page}"
                );
            }
        }
    }

    #[test]
    fn a_page_bigger_than_the_budget_is_still_read() {
        let mut rar = solid("solid-rar4.cbr", 1);
        for n in [3, 0, 11, 5] {
            let page = format!("{}.png", n + 1);
            assert_eq!(rar.read(n).unwrap(), fixtures::page_in("pages-12", &page));
        }
        assert!(rar.solid.as_ref().unwrap().window.len() == 1);
    }

    #[test]
    fn a_solid_archive_cut_short_does_not_open() {
        let mut bytes = std::fs::read(fixtures::path("solid-rar5.cbr")).unwrap();
        bytes.truncate(bytes.len() / 2);
        let mut file = tempfile::tempfile().unwrap();
        file.write_all(&bytes).unwrap();
        assert!(Rar::open(file).is_err());
    }
}
