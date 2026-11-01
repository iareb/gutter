//! Reading comic archives.

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

#[cfg(test)]
mod tests {
    use super::is_page;

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
}
