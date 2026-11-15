//! Files from `tests/fixtures`, for the tests of every module that reads archives.

use std::fs::File;
use std::path::PathBuf;

/// The path of a fixture file.
pub fn path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../tests/fixtures")
        .join(name)
}

/// A fixture archive, open for reading.
pub fn open(name: &str) -> File {
    File::open(path(name)).unwrap_or_else(|e| panic!("fixture {name}: {e}"))
}

/// The bytes of one of the pages the fixture archives were made from.
pub fn page(name: &str) -> Vec<u8> {
    std::fs::read(path(&format!("pages/{name}"))).unwrap_or_else(|e| panic!("fixture {name}: {e}"))
}
