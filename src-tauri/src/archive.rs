//! What every kind of comic archive has in common: which entries are pages, in
//! what order, and the interface an open archive offers.

use std::cmp::Ordering;

/// An open archive that lists its pages and reads one on demand. One
/// implementation per format; `volume.rs` picks it from the file's first bytes.
pub trait PageSource: Send {
    /// The names of the pages in reading order.
    fn pages(&self) -> &[String];

    /// The bytes of one page (counted from 0), as stored.
    fn read(&mut self, n: usize) -> Result<Vec<u8>, String>;
}

/// Extensions of the image formats gutter reads as pages.
const PAGE_EXTENSIONS: [&str; 5] = ["jpg", "jpeg", "png", "webp", "avif"];

/// Whether an archive entry is a page: an image file, not a folder and not
/// the metadata macOS adds to archives (`__MACOSX/`, `._name`).
pub fn is_page(entry: &str) -> bool {
    let file_name = entry.rsplit('/').next().unwrap_or(entry);
    if entry.starts_with("__MACOSX/") || file_name.starts_with("._") {
        return false;
    }
    file_name
        .rsplit_once('.')
        .is_some_and(|(_, ext)| PAGE_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
}

/// MIME type of a page, from its extension.
pub fn mime_type(entry: &str) -> &'static str {
    let ext = entry
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase());
    match ext.as_deref() {
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("avif") => "image/avif",
        _ => "application/octet-stream",
    }
}

/// Compares entry names the way people number pages: runs of digits by value
/// (`2` before `10`), the rest ignoring case. Exact byte order breaks ties.
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut x, mut y) = (a, b);
    loop {
        let (Some(cx), Some(cy)) = (x.chars().next(), y.chars().next()) else {
            break x.len().cmp(&y.len()).then_with(|| a.cmp(b));
        };
        let order = if cx.is_ascii_digit() && cy.is_ascii_digit() {
            let (nx, rx) = split_digits(x);
            let (ny, ry) = split_digits(y);
            (x, y) = (rx, ry);
            compare_numbers(nx, ny)
        } else {
            (x, y) = (&x[cx.len_utf8()..], &y[cy.len_utf8()..]);
            cx.to_lowercase().cmp(cy.to_lowercase())
        };
        if order != Ordering::Equal {
            break order;
        }
    }
}

/// Splits a string into its leading run of ASCII digits and the rest.
fn split_digits(s: &str) -> (&str, &str) {
    s.split_at(s.find(|c: char| !c.is_ascii_digit()).unwrap_or(s.len()))
}

/// Compares two runs of digits by value, without parsing: any length works.
fn compare_numbers(a: &str, b: &str) -> Ordering {
    let (a, b) = (a.trim_start_matches('0'), b.trim_start_matches('0'));
    a.len().cmp(&b.len()).then_with(|| a.cmp(b))
}

#[cfg(test)]
mod tests {
    use super::{is_page, mime_type, natural_cmp};

    #[test]
    fn accepts_images_in_any_case_and_folder() {
        assert!(is_page("001.jpg"));
        assert!(is_page("Chapter 1/002.PNG"));
        assert!(is_page("cover.Webp"));
        assert!(is_page("p.avif"));
    }

    #[test]
    fn rejects_other_entries() {
        assert!(!is_page("ComicInfo.xml"));
        assert!(!is_page("Chapter 1/"));
        assert!(!is_page("jpg"));
        assert!(!is_page("__MACOSX/Chapter 1/001.jpg"));
        assert!(!is_page("Chapter 1/._001.jpg"));
    }

    #[test]
    fn gives_mime_types_by_extension() {
        assert_eq!(mime_type("001.JPG"), "image/jpeg");
        assert_eq!(mime_type("a/b.jpeg"), "image/jpeg");
        assert_eq!(mime_type("p.png"), "image/png");
        assert_eq!(mime_type("p.webp"), "image/webp");
        assert_eq!(mime_type("p.avif"), "image/avif");
        assert_eq!(mime_type("ComicInfo.xml"), "application/octet-stream");
    }

    fn sorted(names: &[&str]) -> Vec<String> {
        let mut names: Vec<String> = names.iter().map(|s| s.to_string()).collect();
        names.sort_by(|a, b| natural_cmp(a, b));
        names
    }

    #[test]
    fn sorts_numbers_by_value() {
        assert_eq!(
            sorted(&["page 10.jpg", "page 2.jpg", "page 1.jpg"]),
            ["page 1.jpg", "page 2.jpg", "page 10.jpg"]
        );
        assert_eq!(
            sorted(&["10.jpg", "009.jpg", "1.jpg"]),
            ["1.jpg", "009.jpg", "10.jpg"]
        );
        assert_eq!(
            sorted(&["v2/c10/1.jpg", "v2/c9/1.jpg", "v10/c1/1.jpg"]),
            ["v2/c9/1.jpg", "v2/c10/1.jpg", "v10/c1/1.jpg"]
        );
    }

    #[test]
    fn ignores_case_and_handles_odd_names() {
        assert_eq!(
            sorted(&["B.jpg", "a.jpg", "C.jpg"]),
            ["a.jpg", "B.jpg", "C.jpg"]
        );
        assert_eq!(
            sorted(&["pàgina è 2.jpg", "pàgina è 1.jpg"]),
            ["pàgina è 1.jpg", "pàgina è 2.jpg"]
        );
        assert_eq!(
            sorted(&["99999999999999999999999.jpg", "1.jpg"])[0],
            "1.jpg"
        );
        assert_eq!(sorted(&["01.jpg", "1.jpg"]), ["01.jpg", "1.jpg"]);
    }
}
