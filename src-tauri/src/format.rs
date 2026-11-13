//! Telling what kind of archive a file is from its first bytes. File names lie:
//! plenty of `.cbr` files are ZIP archives inside, and the other way round.

use std::io::{self, Read, Seek, SeekFrom};

/// The kinds of archive a comic can come in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Zip,
    /// RAR 4 and RAR 5.
    Rar,
    SevenZip,
    /// Anything else. A ZIP can have data in front of it (a self-extracting
    /// stub), so the caller still tries it as one.
    Unknown,
}

/// How many bytes the signatures need.
const SIGNATURE_LEN: usize = 8;

/// The format a file starting with these bytes has.
pub fn format_of(start: &[u8]) -> Format {
    // Normal, empty and spanned ZIP archives
    if matches!(
        start.get(..4),
        Some(b"PK\x03\x04" | b"PK\x05\x06" | b"PK\x07\x08")
    ) {
        Format::Zip
    // RAR 1.5 to 4: `Rar!\x1a\x07\x00`; RAR 5 and later: `Rar!\x1a\x07\x01\x00`
    } else if start.starts_with(b"Rar!\x1a\x07\x00") || start.starts_with(b"Rar!\x1a\x07\x01\x00") {
        Format::Rar
    } else if start.starts_with(b"7z\xbc\xaf\x27\x1c") {
        Format::SevenZip
    } else {
        Format::Unknown
    }
}

/// Reads the start of the file and puts the position back where it was.
pub fn detect<R: Read + Seek>(file: &mut R) -> io::Result<Format> {
    let position = file.stream_position()?;
    file.seek(SeekFrom::Start(0))?;
    let mut start = Vec::with_capacity(SIGNATURE_LEN);
    file.by_ref()
        .take(SIGNATURE_LEN as u64)
        .read_to_end(&mut start)?;
    file.seek(SeekFrom::Start(position))?;
    Ok(format_of(&start))
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::{Format, detect, format_of};

    #[test]
    fn recognizes_zip() {
        assert_eq!(format_of(b"PK\x03\x04rest"), Format::Zip);
        // An archive with no files starts with the end record
        assert_eq!(format_of(b"PK\x05\x06\0\0\0\0"), Format::Zip);
    }

    #[test]
    fn recognizes_both_rar_versions() {
        assert_eq!(format_of(b"Rar!\x1a\x07\x00\xcf\x90s"), Format::Rar);
        assert_eq!(format_of(b"Rar!\x1a\x07\x01\x00\x33\x92"), Format::Rar);
    }

    #[test]
    fn recognizes_seven_zip() {
        assert_eq!(format_of(b"7z\xbc\xaf\x27\x1c\x00\x04"), Format::SevenZip);
    }

    #[test]
    fn leaves_the_rest_unknown() {
        assert_eq!(format_of(b""), Format::Unknown);
        assert_eq!(format_of(b"PK"), Format::Unknown);
        assert_eq!(format_of(b"plain text"), Format::Unknown);
        // A RAR signature cut short, or one from an unknown future version
        assert_eq!(format_of(b"Rar!\x1a\x07"), Format::Unknown);
        assert_eq!(format_of(b"Rar!\x1a\x07\x02\x00"), Format::Unknown);
    }

    #[test]
    fn looks_at_the_start_and_keeps_the_position() {
        let mut file = Cursor::new(b"Rar!\x1a\x07\x01\x00 and a lot more".to_vec());
        file.set_position(12);
        assert_eq!(detect(&mut file).unwrap(), Format::Rar);
        assert_eq!(file.position(), 12);
    }

    #[test]
    fn handles_files_shorter_than_a_signature() {
        assert_eq!(
            detect(&mut Cursor::new(b"PK".to_vec())).unwrap(),
            Format::Unknown
        );
        assert_eq!(
            detect(&mut Cursor::new(Vec::new())).unwrap(),
            Format::Unknown
        );
    }
}
