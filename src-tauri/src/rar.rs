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
//!
//! Files come from anywhere, so reading is bounded: a RAR 5 archive can ask for a
//! dictionary of up to a gigabyte and a page can unpack to far more than it
//! should; both are refused with a message, not a crash. Whatever goes wrong
//! gets a message that says what it means to the reader: a password, a file cut
//! short, a damaged page.

use std::collections::HashMap;
use std::fs::File;
use std::io::Write;
use std::sync::{Arc, Mutex};

use rars::{
    Archive, ArchiveMemberRef, ArchiveReadOptions, ArchiveReader, Error, ExtractionDecision,
};

use crate::archive::{PageSource, is_page, natural_cmp};

/// How many bytes of decoded pages a solid archive keeps in memory.
const SOLID_WINDOW_BYTES: u64 = 48 * 1024 * 1024;

/// The size comes from the archive and may be wrong: cap what is reserved upfront.
const MAX_RESERVE: u64 = 64 * 1024 * 1024;

/// The biggest dictionary a RAR 5 archive may ask for. The decoder allocates all
/// of it; the usual one is 32 MB and WinRAR's biggest preset is 1 GB.
const MAX_DICTIONARY: u64 = if cfg!(any(target_os = "android", target_os = "ios")) {
    64 * 1024 * 1024
} else {
    128 * 1024 * 1024
};

/// The biggest a page can be once unpacked.
const MAX_PAGE_BYTES: u64 = 256 * 1024 * 1024;

const PASSWORD_MESSAGE: &str =
    "This archive is password-protected, and gutter cannot open those yet.";

/// What reading is bounded by.
#[derive(Clone, Copy)]
struct Limits {
    dictionary: u64,
    page: u64,
}

/// The knobs of an open archive; the tests turn them down to make small files hit them.
#[derive(Clone, Copy)]
struct Settings {
    /// How many bytes of decoded pages a solid archive keeps.
    window: u64,
    limits: Limits,
}

impl Default for Settings {
    fn default() -> Settings {
        Settings {
            window: SOLID_WINDOW_BYTES,
            limits: Limits {
                dictionary: MAX_DICTIONARY,
                page: MAX_PAGE_BYTES,
            },
        }
    }
}

impl Limits {
    fn options(&self) -> ArchiveReadOptions<'static> {
        ArchiveReadOptions::new()
            .with_rar50_dictionary_size_limit(self.dictionary)
            .with_max_member_output_bytes(self.page)
    }
}

/// An open CBR. Only the headers are in memory; pages are read from the file on demand.
pub struct Rar {
    archive: Archive,
    /// Page names in reading order.
    names: Vec<String>,
    /// Position in the archive of each page, in reading order.
    indices: Vec<usize>,
    limits: Limits,
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
        Rar::open_with(file, Settings::default())
    }

    fn open_with(file: File, settings: Settings) -> Result<Rar, String> {
        let Settings { window, limits } = settings;
        let archive = ArchiveReader::read_reader(file).map_err(|e| open_message(&e))?;
        let members: Vec<_> = archive.members().collect();

        let mut pages: Vec<(String, usize)> = Vec::new();
        let mut encrypted = false;
        let mut dictionary = 0;
        for (index, member) in archive.member_refs().enumerate() {
            if member.is_directory() || member.is_redirection() {
                continue;
            }
            let Some(name) = member.decoded_name(None).ok().map(|n| entry_name(&n)) else {
                continue;
            };
            if !is_page(&name) {
                continue;
            }
            encrypted |= members[index].meta.is_encrypted;
            // A stored page needs no dictionary
            if let ArchiveMemberRef::Rar50Plus(header) = member
                && !header.is_stored()
                && let Ok(info) = header.decoded_compression_info()
            {
                dictionary = dictionary.max(info.dictionary_size);
            }
            pages.push((name, index));
        }
        // Better to say so now than on the first page
        if encrypted {
            return Err(PASSWORD_MESSAGE.into());
        }
        if dictionary > limits.dictionary {
            return Err(dictionary_message(dictionary, limits.dictionary));
        }

        // The order the archive holds them in, before sorting for reading
        let in_archive_order: Vec<(usize, u64)> = pages
            .iter()
            .map(|(_, index)| (*index, members[*index].meta.unpacked_size))
            .collect();
        pages.sort_by(|a, b| natural_cmp(&a.0, &b.0));
        let (names, indices) = pages.into_iter().unzip();

        let is_solid = archive.is_solid() || archive.member_refs().any(|m| m.is_solid());
        let solid = is_solid.then(|| {
            let mut pages = in_archive_order;
            pages.sort_by_key(|(index, _)| *index);
            Solid {
                pages,
                budget: window,
                window: HashMap::new(),
                passes: 0,
            }
        });
        Ok(Rar {
            archive,
            names,
            indices,
            limits,
            solid,
        })
    }

    /// How many passes over a solid archive reading has taken so far.
    #[cfg(test)]
    fn passes(&self) -> usize {
        self.solid.as_ref().map_or(0, |s| s.passes)
    }
}

// What went wrong, said in terms of what the reader can do about it

/// The cause of an error: the innermost one, without the where and when around it.
fn root(error: &Error) -> &Error {
    match error {
        Error::AtArchiveOffset { source, .. }
        | Error::AtEntry { source, .. }
        | Error::InVolume { source, .. } => root(source),
        error => error,
    }
}

/// How many bytes, in the unit people use for it.
fn size_text(bytes: u64) -> String {
    const MB: u64 = 1024 * 1024;
    if bytes >= MB {
        format!("{} MB", bytes.div_ceil(MB))
    } else if bytes >= 1024 {
        format!("{} KB", bytes.div_ceil(1024))
    } else {
        format!("{bytes} bytes")
    }
}

fn dictionary_message(required: u64, limit: u64) -> String {
    format!(
        "This archive needs {} of memory to unpack, more than the {} gutter allows on this device.",
        size_text(required),
        size_text(limit)
    )
}

/// Whether the error is about a password, which gutter does not take yet.
fn is_password(error: &Error) -> bool {
    matches!(
        root(error),
        Error::NeedPassword
            | Error::WrongPasswordOrCorruptData
            | Error::UnsupportedEncryption { .. }
            | Error::FeatureDisabled {
                feature: "encryption"
            }
    )
}

/// Whether the data read does not match what the archive says it should be.
fn is_damage(error: &Error) -> bool {
    matches!(
        root(error),
        Error::CrcMismatch { .. }
            | Error::Crc32Mismatch { .. }
            | Error::HashMismatch { .. }
            | Error::InvalidHeader(_)
            | Error::Codec(_)
    )
}

/// The message for a failure to open the archive.
fn open_message(error: &Error) -> String {
    if is_password(error) {
        PASSWORD_MESSAGE.into()
    } else if matches!(root(error), Error::TooShort) {
        "This archive is incomplete: the file ends too soon. A download that stopped, or a copy \
         that did not finish, can do this."
            .into()
    } else {
        format!("This file is not a CBR archive, or it is damaged ({error}).")
    }
}

/// The message for a failure to read page `n` (counted from 0).
fn page_message(n: usize, error: &Error) -> String {
    let page = n + 1;
    if is_password(error) {
        return PASSWORD_MESSAGE.into();
    }
    match root(error) {
        Error::TooShort => format!("Page {page} could not be read: the archive ends too soon."),
        Error::Io(_) => format!(
            "Page {page} could not be read: the archive ends too soon, or the file cannot be read ({error})."
        ),
        Error::MemberOutputLimitExceeded { limit, .. } => format!(
            "Page {page} is bigger than the {} gutter reads.",
            size_text(*limit)
        ),
        Error::Rar50DictionaryLimitExceeded { limit, required } => format!(
            "Page {page} could not be read. {}",
            dictionary_message(*required, *limit)
        ),
        _ if is_damage(error) => {
            format!("Page {page} is damaged: what was read does not match what the archive says.")
        }
        _ => format!("Page {page} could not be read ({error})."),
    }
}

/// A pass over a solid archive that failed, and where.
struct PassError {
    source: Error,
    /// The position in the archive of the file it was decoding.
    at: usize,
}

impl Solid {
    /// Decodes the archive from the start up to the page at `position` in archive
    /// order and the pages after it that fit, and keeps the window of pages
    /// around it. The pages before the window are decoded and thrown away: they
    /// are the history the next ones need.
    ///
    /// If the archive is damaged part of the way, the pages decoded before that
    /// are kept all the same: a page ahead of the damage stays readable.
    fn decode_window(
        &mut self,
        archive: &Archive,
        position: usize,
        limits: &Limits,
    ) -> Result<(), PassError> {
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
        let mut started = Vec::new();
        self.passes += 1;
        let result = archive.extract_with_control(limits.options(), |member| {
            let this = current;
            current += 1;
            if this > last {
                return Ok(ExtractionDecision::Stop);
            }
            if let Some(buffer) = kept.get(&this) {
                started.push(this);
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
        });

        // The file being decoded when it failed is the last one started
        let failed_at = current.saturating_sub(1);
        self.window = kept
            .into_iter()
            .filter(|(index, _)| started.contains(index) && (result.is_ok() || *index != failed_at))
            .map(|(index, buffer)| (index, std::mem::take(&mut *buffer.lock().unwrap())))
            .collect();
        result.map(|_| ()).map_err(|source| PassError {
            source,
            at: failed_at,
        })
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

impl PageSource for Rar {
    fn pages(&self) -> &[String] {
        &self.names
    }

    fn read(&mut self, n: usize) -> Result<Vec<u8>, String> {
        let unreadable = |what: &str| format!("Page {} could not be read ({what}).", n + 1);
        let index = *self
            .indices
            .get(n)
            .ok_or_else(|| format!("Page {} does not exist.", n + 1))?;

        let Some(solid) = &mut self.solid else {
            return self
                .archive
                .read_member_at_with_options(index, self.limits.options())
                .map_err(|e| page_message(n, &e))?
                .ok_or_else(|| unreadable("it has no data"));
        };
        if !solid.window.contains_key(&index) {
            let position = solid
                .pages
                .iter()
                .position(|(i, _)| *i == index)
                .ok_or_else(|| unreadable("it is not in the archive"))?;
            if let Err(error) = solid.decode_window(&self.archive, position, &self.limits)
                && !solid.window.contains_key(&index)
            {
                return Err(solid_message(n, index, &self.indices, &error));
            }
        }
        solid
            .window
            .get(&index)
            .cloned()
            .ok_or_else(|| unreadable("it has no data"))
    }
}

/// The message for page `n` (at `index` in the archive) when the pass that was to
/// decode it failed at `error.at`.
fn solid_message(n: usize, index: usize, indices: &[usize], error: &PassError) -> String {
    let before = error.at != index && is_damage(&error.source);
    if !before {
        return page_message(n, &error.source);
    }
    // In a solid archive a page needs all the ones before it
    let culprit = match indices.iter().position(|i| *i == error.at) {
        Some(m) => format!("page {}", m + 1),
        None => "a file".to_string(),
    };
    format!(
        "Page {} could not be read: {culprit} before it in the archive is damaged, and in a solid \
         archive every page needs the ones before it.",
        n + 1
    )
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use rars::Error;

    use crate::archive::PageSource;
    use crate::fixtures;

    use super::{
        Limits, PASSWORD_MESSAGE, Rar, Settings, entry_name, open_message, page_message, size_text,
        window_range,
    };

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

    fn solid(name: &str, window: u64) -> Rar {
        let settings = Settings {
            window,
            ..Settings::default()
        };
        Rar::open_with(fixtures::open(name), settings).unwrap()
    }

    fn reading_order() -> Vec<String> {
        (1..=12).map(|i| format!("{i}.png")).collect()
    }

    fn twelve(page: &str) -> Vec<u8> {
        fixtures::page_in("pages-12", page)
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
                assert_eq!(rar.read(n).unwrap(), twelve(page), "{name}, {page}");
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
                assert_eq!(rar.read(n).unwrap(), twelve(page), "{name}, {page}");
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
        assert_eq!(rar.read(5).unwrap(), twelve("6.png"));
        assert_eq!(rar.passes(), passes);
    }

    #[test]
    fn reads_backwards_and_jumps_in_any_order() {
        for name in SOLID {
            let mut rar = solid(name, 240);
            for n in [11, 10, 9, 0, 6, 1, 7, 2, 11, 3, 8, 4, 5] {
                let page = format!("{}.png", n + 1);
                assert_eq!(rar.read(n).unwrap(), twelve(&page), "{name}, {page}");
            }
        }
    }

    #[test]
    fn a_page_bigger_than_the_budget_is_still_read() {
        let mut rar = solid("solid-rar4.cbr", 1);
        for n in [3, 0, 11, 5] {
            let page = format!("{}.png", n + 1);
            assert_eq!(rar.read(n).unwrap(), twelve(&page));
        }
        assert!(rar.solid.as_ref().unwrap().window.len() == 1);
    }

    // Files that cannot be read, and what they say

    fn open_error(name: &str) -> String {
        Rar::open(fixtures::open(name)).err().unwrap()
    }

    fn temp_file(bytes: &[u8]) -> std::fs::File {
        let mut file = tempfile::tempfile().unwrap();
        file.write_all(bytes).unwrap();
        file
    }

    #[test]
    fn a_password_protected_archive_says_so_when_it_opens() {
        // The pages are encrypted, the names are not; or the names are too
        assert_eq!(open_error("password-rar5.cbr"), PASSWORD_MESSAGE);
        assert_eq!(open_error("password-headers-rar5.cbr"), PASSWORD_MESSAGE);
    }

    #[test]
    fn a_file_cut_short_says_it_is_incomplete() {
        for name in ["pages-rar5.cbr", "solid-rar5.cbr", "pages-rar4.cbr"] {
            let mut bytes = std::fs::read(fixtures::path(name)).unwrap();
            bytes.truncate(bytes.len() / 2);
            let error = Rar::open(temp_file(&bytes)).err().unwrap();
            assert!(
                error.starts_with("This archive is incomplete"),
                "{name}: {error}"
            );
        }
    }

    #[test]
    fn a_file_that_is_not_a_rar_says_so() {
        let mut bytes = b"Rar!\x1a\x07\x01\x00".to_vec();
        bytes.extend([7; 5000]);
        let error = Rar::open(temp_file(&bytes)).err().unwrap();
        assert!(
            error.starts_with("This file is not a CBR archive, or it is damaged"),
            "{error}"
        );
    }

    #[test]
    fn an_archive_asking_for_too_big_a_dictionary_is_refused_when_it_opens() {
        // solid-rar5 declares a 1 MB dictionary
        let settings = Settings {
            limits: Limits {
                dictionary: 512 * 1024,
                ..Settings::default().limits
            },
            ..Settings::default()
        };
        let error = Rar::open_with(fixtures::open("solid-rar5.cbr"), settings)
            .err()
            .unwrap();
        assert_eq!(
            error,
            "This archive needs 1 MB of memory to unpack, more than the 512 KB gutter allows on this device."
        );
        // At the limit it opens
        let settings = Settings {
            limits: Limits {
                dictionary: 1024 * 1024,
                ..Settings::default().limits
            },
            ..Settings::default()
        };
        assert!(Rar::open_with(fixtures::open("solid-rar5.cbr"), settings).is_ok());
    }

    #[test]
    fn stored_pages_need_no_dictionary() {
        let settings = Settings {
            limits: Limits {
                dictionary: 0,
                ..Settings::default().limits
            },
            ..Settings::default()
        };
        assert!(Rar::open_with(fixtures::open("pages-rar5-store.cbr"), settings).is_ok());
    }

    #[test]
    fn a_page_bigger_than_the_limit_is_refused_without_stopping_the_rest() {
        // The pages of the fixtures are 75 bytes; one cannot unpack to 10
        let settings = Settings {
            limits: Limits {
                page: 10,
                ..Settings::default().limits
            },
            ..Settings::default()
        };
        let mut rar = Rar::open_with(fixtures::open("pages-rar5.cbr"), settings).unwrap();
        assert_eq!(
            rar.read(0).err().unwrap(),
            "Page 1 is bigger than the 10 bytes gutter reads."
        );
        // The limit is not a state: the page is refused again, not half-read
        assert!(rar.read(1).is_err());
    }

    #[test]
    fn a_damaged_page_leaves_the_others_readable() {
        let mut rar = Rar::open(fixtures::open("damaged-page-rar5.cbr")).unwrap();
        assert_eq!(rar.read(0).unwrap(), fixtures::page("page 1.png"));
        assert_eq!(
            rar.read(1).err().unwrap(),
            "Page 2 is damaged: what was read does not match what the archive says."
        );
        assert_eq!(rar.read(2).unwrap(), fixtures::page("page 10.png"));
        // And again, after the failure
        assert_eq!(rar.read(0).unwrap(), fixtures::page("page 1.png"));
    }

    #[test]
    fn in_a_solid_archive_the_pages_before_the_damage_stay_readable() {
        // The archive holds them as ComicInfo, 1, 10, 11, 12, 2, 3, 4, 5, 6, 7, 8, 9, and
        // a byte of the compressed data inside 12 is flipped: 1, 10 and 11 come before it
        // and are fine, 12 is damaged, and 2 to 9 cannot be decoded past it. However many
        // pages a pass keeps, the readable ones stay readable.
        for window in [u64::MAX, 240, 1] {
            let mut rar = solid_damaged(window);
            for page in [1, 10, 11] {
                assert_eq!(
                    rar.read(page - 1).unwrap(),
                    twelve(&format!("{page}.png")),
                    "page {page}, window {window}"
                );
            }
            assert_eq!(
                rar.read(11).err().unwrap(),
                "Page 12 is damaged: what was read does not match what the archive says.",
                "window {window}"
            );
            for page in 2..=9 {
                let error = rar.read(page - 1).err().unwrap();
                assert_eq!(
                    error,
                    format!(
                        "Page {page} could not be read: page 12 before it in the archive is damaged, and in a solid archive every page needs the ones before it."
                    ),
                    "window {window}"
                );
            }
            // And the readable ones still are, after all those failures
            assert_eq!(rar.read(0).unwrap(), twelve("1.png"), "window {window}");
        }
    }

    fn solid_damaged(window: u64) -> Rar {
        let settings = Settings {
            window,
            ..Settings::default()
        };
        Rar::open_with(fixtures::open("damaged-solid-rar5.cbr"), settings).unwrap()
    }

    #[test]
    fn tells_causes_apart() {
        let at = |source| Error::AtArchiveOffset {
            offset: 8,
            source: Box::new(source),
        };
        let entry = |source| Error::AtEntry {
            name: b"001.jpg".to_vec(),
            operation: "decoding",
            source: Box::new(source),
        };
        // Wrapped errors are told by what is inside them
        assert_eq!(open_message(&Error::NeedPassword), PASSWORD_MESSAGE);
        assert_eq!(
            page_message(
                0,
                &entry(Error::FeatureDisabled {
                    feature: "encryption"
                })
            ),
            PASSWORD_MESSAGE
        );
        assert!(open_message(&at(Error::TooShort)).starts_with("This archive is incomplete"));
        assert_eq!(
            page_message(
                4,
                &entry(Error::Crc32Mismatch {
                    expected: 1,
                    actual: 2
                })
            ),
            "Page 5 is damaged: what was read does not match what the archive says."
        );
        assert_eq!(
            page_message(
                0,
                &entry(Error::Rar50DictionaryLimitExceeded {
                    limit: 64 << 20,
                    required: 1 << 30
                })
            ),
            "Page 1 could not be read. This archive needs 1024 MB of memory to unpack, more than the 64 MB gutter allows on this device."
        );
        // What nobody planned for still says what it was
        assert_eq!(
            page_message(2, &Error::EntryNotFound),
            "Page 3 could not be read (no such archive entry)."
        );
    }

    #[test]
    fn writes_sizes_the_way_people_read_them() {
        assert_eq!(size_text(10), "10 bytes");
        assert_eq!(size_text(1500), "2 KB");
        assert_eq!(size_text(1 << 20), "1 MB");
        assert_eq!(size_text((128 << 20) + 1), "129 MB");
    }
}
