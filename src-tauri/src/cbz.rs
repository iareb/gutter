//! CBZ files: ZIP archives of pages.

use std::fs::File;
use std::io::{Read, Seek};

use zip::ZipArchive;

use crate::archive::{PageSource, is_page, natural_cmp};

/// An open CBZ. Only the ZIP index is in memory.
pub struct Cbz {
    archive: ZipArchive<File>,
    /// Page names in reading order.
    names: Vec<String>,
    /// Position in the ZIP of each page, in reading order.
    indices: Vec<usize>,
}

/// A page of a ZIP: its entry name and its position in the archive.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Page {
    name: String,
    index: usize,
}

/// Lists the pages of a ZIP in reading order. Reads only the index.
fn pages<R: Read + Seek>(archive: &ZipArchive<R>) -> Vec<Page> {
    let mut pages: Vec<Page> = (0..archive.len())
        .filter_map(|index| {
            let name = archive.name_for_index(index)?.ok()?;
            is_page(&name).then(|| Page {
                name: name.into_owned(),
                index,
            })
        })
        .collect();
    pages.sort_by(|a, b| natural_cmp(&a.name, &b.name));
    pages
}

impl Cbz {
    /// Reads the archive index. Fails on anything that is not a readable ZIP.
    pub fn open(file: File) -> Result<Cbz, String> {
        let archive = ZipArchive::new(file)
            .map_err(|e| format!("This file is not a CBZ archive, or it is damaged ({e})."))?;
        let pages = pages(&archive);
        Ok(Cbz {
            archive,
            names: pages.iter().map(|p| p.name.clone()).collect(),
            indices: pages.iter().map(|p| p.index).collect(),
        })
    }
}

/// The size comes from the archive and may be wrong: cap what is reserved upfront.
const MAX_RESERVE: u64 = 64 * 1024 * 1024;

impl PageSource for Cbz {
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
        let mut entry = self.archive.by_index(index).map_err(|e| unreadable(&e))?;
        let mut bytes = Vec::with_capacity(entry.size().min(MAX_RESERVE) as usize);
        entry.read_to_end(&mut bytes).map_err(|e| unreadable(&e))?;
        Ok(bytes)
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Cursor, Write};

    use zip::ZipArchive;
    use zip::write::{SimpleFileOptions, ZipWriter};

    use super::pages;

    fn zip_with(names: &[&str]) -> ZipArchive<Cursor<Vec<u8>>> {
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        for name in names {
            writer
                .start_file(*name, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(b"x").unwrap();
        }
        ZipArchive::new(writer.finish().unwrap()).unwrap()
    }

    #[test]
    fn lists_pages_in_reading_order() {
        let archive = zip_with(&[
            "page 10.JPG",
            "ComicInfo.xml",
            "page 2.jpg",
            "__MACOSX/._page 1.jpg",
            "page 1.jpg",
            "zz extra/pàgina è 13.jpg",
        ]);
        let names: Vec<_> = pages(&archive)
            .into_iter()
            .map(|p| (p.name, p.index))
            .collect();
        assert_eq!(
            names,
            [
                ("page 1.jpg".into(), 4),
                ("page 2.jpg".into(), 2),
                ("page 10.JPG".into(), 0),
                ("zz extra/pàgina è 13.jpg".into(), 5),
            ]
        );
    }
}
