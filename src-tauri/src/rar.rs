//! CBR files: RAR archives of pages (RAR 4 and RAR 5), read with the pure Rust
//! `rars` crate. See docs/spikes/cbr-library.md for why.
//!
//! A page is read by itself from its position in the archive, which costs the
//! same as a CBZ page when the archive is not solid. In a solid archive each page
//! needs all the ones before it decoded first: that works, but slowly, and the
//! forward pass that makes it fast is step 2.5.3.

use std::fs::File;

use rars::{Archive, ArchiveReader};

use crate::archive::{PageSource, is_page, natural_cmp};

/// An open CBR. Only the headers are in memory; pages are read from the file on demand.
pub struct Rar {
    archive: Archive,
    /// Page names in reading order.
    names: Vec<String>,
    /// Position in the archive of each page, in reading order.
    indices: Vec<usize>,
}

/// The name of an entry as a path with `/` for folders: RAR 4 archives made on
/// Windows store `\`.
fn entry_name(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).replace('\\', "/")
}

impl Rar {
    /// Reads the archive headers. Fails on anything that is not a readable RAR.
    pub fn open(file: File) -> Result<Rar, String> {
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
        pages.sort_by(|a, b| natural_cmp(&a.0, &b.0));
        let (names, indices) = pages.into_iter().unzip();
        Ok(Rar {
            archive,
            names,
            indices,
        })
    }
}

impl PageSource for Rar {
    fn pages(&self) -> &[String] {
        &self.names
    }

    fn read(&mut self, n: usize) -> Result<Vec<u8>, String> {
        let index = *self
            .indices
            .get(n)
            .ok_or_else(|| format!("Page {} does not exist.", n + 1))?;
        self.archive
            .read_member_at(index, None)
            .map_err(|e| format!("Page {} could not be read ({e}).", n + 1))?
            .ok_or_else(|| format!("Page {} could not be read (it has no data).", n + 1))
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use crate::archive::PageSource;
    use crate::fixtures;

    use super::{Rar, entry_name};

    const FIXTURES: [&str; 3] = ["pages-rar5.cbr", "pages-rar4.cbr", "pages-rar5-store.cbr"];

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
}
