//! The library: the volumes the reader added and where each one was left, in SQLite.
//!
//! The functions take a connection, so that tests run them on a database in memory;
//! the commands at the end open files and lock the connection the app keeps.

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};

use crate::volume::Volume;

/// The steps from one schema version to the next: the database is at version `n`
/// once the first `n` have run. A step is never changed once released, only added.
const MIGRATIONS: &[&str] = &[
    // 1: volumes and where each one was left
    "CREATE TABLE volumes (
        id INTEGER PRIMARY KEY,
        -- A path on a computer, a content:// address on Android
        address TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        size INTEGER NOT NULL,
        -- The size and a hash of the first and last 64 KB: finds a volume moved or renamed
        fingerprint TEXT NOT NULL,
        -- Null until the archive was read
        pages INTEGER,
        -- Milliseconds since 1970
        added INTEGER NOT NULL,
        opened INTEGER
    );
    CREATE INDEX volumes_fingerprint ON volumes (fingerprint);
    CREATE TABLE reading (
        volume INTEGER PRIMARY KEY REFERENCES volumes (id) ON DELETE CASCADE,
        -- Counted from 0
        page INTEGER NOT NULL DEFAULT 0,
        finished INTEGER NOT NULL DEFAULT 0,
        -- Chosen while reading this volume; null: the View menu's choice
        direction TEXT,
        mode TEXT,
        cover INTEGER
    );",
];

/// Brings a database to the latest schema version, all steps in one transaction.
/// Refuses a database made by a newer Gutter rather than guess at it.
pub fn migrate(conn: &mut Connection) -> Result<(), String> {
    let version: i64 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|e| e.to_string())?;
    let version = usize::try_from(version).map_err(|e| e.to_string())?;
    if version > MIGRATIONS.len() {
        return Err(format!(
            "The library was saved by a newer version of Gutter (schema {version}, this one knows {})",
            MIGRATIONS.len()
        ));
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for step in &MIGRATIONS[version..] {
        tx.execute_batch(step).map_err(|e| e.to_string())?;
    }
    tx.pragma_update(None, "user_version", MIGRATIONS.len() as i64)
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

/// Opens (or makes) the library at this path, ready to use.
pub fn open(path: &Path) -> Result<Connection, String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut conn = Connection::open(path).map_err(|e| e.to_string())?;
    prepare(&mut conn)?;
    // Page changes are saved often: the write-ahead log makes each one cheap
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| e.to_string())?;
    Ok(conn)
}

fn prepare(conn: &mut Connection) -> Result<(), String> {
    conn.pragma_update(None, "foreign_keys", true)
        .map_err(|e| e.to_string())?;
    migrate(conn)
}

const EDGE: u64 = 64 * 1024;

/// Size and fingerprint of a file: its size and a hash of its first and last 64 KB.
/// Cheap whatever the size of the file, and the same after a move or a rename.
pub fn fingerprint(file: &mut (impl Read + Seek)) -> io::Result<(u64, String)> {
    let size = file.seek(SeekFrom::End(0))?;
    let mut hash = Fnv::new();
    let mut buf = vec![0; EDGE as usize];
    file.seek(SeekFrom::Start(0))?;
    let head = size.min(EDGE) as usize;
    file.read_exact(&mut buf[..head])?;
    hash.write(&buf[..head]);
    // The last 64 KB, not counting bytes already in the first
    let tail_start = size.saturating_sub(EDGE).max(EDGE);
    if tail_start < size {
        let tail = (size - tail_start) as usize;
        file.seek(SeekFrom::Start(tail_start))?;
        file.read_exact(&mut buf[..tail])?;
        hash.write(&buf[..tail]);
    }
    Ok((size, format!("{size}-{:016x}", hash.0)))
}

/// 64-bit FNV-1a: tiny, and the same in every version of Gutter, which a
/// fingerprint saved in the database needs (Rust's own hasher may change).
struct Fnv(u64);

impl Fnv {
    fn new() -> Self {
        Fnv(0xcbf2_9ce4_8422_2325)
    }
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.0 = (self.0 ^ b as u64).wrapping_mul(0x0100_0000_01b3);
        }
    }
}

/// A volume of the library and where it was left.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: i64,
    pub address: String,
    pub name: String,
    pub size: u64,
    pub fingerprint: String,
    pub pages: Option<u32>,
    pub added: i64,
    pub opened: Option<i64>,
    #[serde(flatten)]
    pub reading: Reading,
}

/// Where a volume was left, and the choices made while reading it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reading {
    pub page: u32,
    pub finished: bool,
    pub direction: Option<String>,
    pub mode: Option<String>,
    pub cover: Option<bool>,
}

/// What adding a file did.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Added {
    /// It was not in the library.
    New,
    /// It was, at this address.
    Known,
    /// It was, at another address that no longer opens: it moved, or was renamed,
    /// and keeps its place.
    Moved,
    /// It is a copy of a volume whose file is still there: that volume is kept as it
    /// was, and nothing is added.
    Duplicate,
}

/// A file about to be added: what was read of it.
pub struct Candidate<'a> {
    pub address: &'a str,
    pub name: &'a str,
    pub size: u64,
    pub fingerprint: &'a str,
    pub pages: Option<u32>,
}

const SELECT: &str =
    "SELECT v.id, v.address, v.name, v.size, v.fingerprint, v.pages, v.added, v.opened,
    r.page, r.finished, r.direction, r.mode, r.cover
    FROM volumes v JOIN reading r ON r.volume = v.id";

fn entry(row: &Row) -> rusqlite::Result<Entry> {
    Ok(Entry {
        id: row.get(0)?,
        address: row.get(1)?,
        name: row.get(2)?,
        size: row.get::<_, i64>(3)? as u64,
        fingerprint: row.get(4)?,
        pages: row.get(5)?,
        added: row.get(6)?,
        opened: row.get(7)?,
        reading: Reading {
            page: row.get(8)?,
            finished: row.get(9)?,
            direction: row.get(10)?,
            mode: row.get(11)?,
            cover: row.get(12)?,
        },
    })
}

fn by_id(conn: &Connection, id: i64) -> rusqlite::Result<Option<Entry>> {
    conn.query_row(&format!("{SELECT} WHERE v.id = ?1"), [id], entry)
        .optional()
}

/// Adds a file, or finds it: at the same address (a file changed in place keeps its
/// place), or by its fingerprint at another address. Then `opens` tells which: if
/// the old address no longer opens, the file moved or was renamed and the volume
/// takes the new address; if it still opens, the new file is a copy, and the library
/// keeps one volume for both (a folder holding two copies would otherwise move the
/// volume back and forth each time it is listed).
pub fn add(
    conn: &mut Connection,
    file: &Candidate,
    now: i64,
    opens: impl Fn(&str) -> bool,
) -> rusqlite::Result<(Entry, Added)> {
    let tx = conn.transaction()?;
    let at_address: Option<i64> = tx
        .query_row(
            "SELECT id FROM volumes WHERE address = ?1",
            [file.address],
            |r| r.get(0),
        )
        .optional()?;
    let (id, how) = if let Some(id) = at_address {
        tx.execute(
            "UPDATE volumes SET name = ?2, size = ?3, fingerprint = ?4, pages = coalesce(?5, pages)
             WHERE id = ?1",
            params![
                id,
                file.name,
                file.size as i64,
                file.fingerprint,
                file.pages
            ],
        )?;
        (id, Added::Known)
    } else if let Some((id, old)) = tx
        .query_row(
            "SELECT id, address FROM volumes WHERE fingerprint = ?1
             ORDER BY coalesce(opened, added) DESC",
            [file.fingerprint],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()?
    {
        if opens(&old) {
            (id, Added::Duplicate)
        } else {
            tx.execute(
                "UPDATE volumes SET address = ?2, name = ?3, pages = coalesce(?4, pages)
                 WHERE id = ?1",
                params![id, file.address, file.name, file.pages],
            )?;
            (id, Added::Moved)
        }
    } else {
        tx.execute(
            "INSERT INTO volumes (address, name, size, fingerprint, pages, added)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                file.address,
                file.name,
                file.size as i64,
                file.fingerprint,
                file.pages,
                now
            ],
        )?;
        let id = tx.last_insert_rowid();
        tx.execute("INSERT INTO reading (volume) VALUES (?1)", [id])?;
        (id, Added::New)
    };
    let found = by_id(&tx, id)?.expect("the volume was just written");
    tx.commit()?;
    Ok((found, how))
}

/// Every volume, the last opened first, then the ones never opened, newest first.
pub fn list(conn: &Connection) -> rusqlite::Result<Vec<Entry>> {
    let mut query = conn.prepare(&format!(
        "{SELECT} ORDER BY v.opened IS NULL, v.opened DESC, v.added DESC, v.id DESC"
    ))?;
    query.query_map([], entry)?.collect()
}

/// A volume was opened for reading now, and has this many pages.
pub fn opened(conn: &Connection, id: i64, pages: u32, now: i64) -> rusqlite::Result<bool> {
    conn.execute(
        "UPDATE volumes SET opened = ?2, pages = ?3 WHERE id = ?1",
        params![id, now, pages],
    )
    .map(|n| n == 1)
}

/// Saves where a volume was left and the choices made for it.
pub fn save(conn: &Connection, id: i64, reading: &Reading) -> rusqlite::Result<bool> {
    conn.execute(
        "UPDATE reading SET page = ?2, finished = ?3, direction = ?4, mode = ?5, cover = ?6
         WHERE volume = ?1",
        params![
            id,
            reading.page,
            reading.finished,
            reading.direction,
            reading.mode,
            reading.cover
        ],
    )
    .map(|n| n == 1)
}

/// Removes a volume from the library. The file is never touched.
pub fn remove(conn: &Connection, id: i64) -> rusqlite::Result<bool> {
    conn.execute("DELETE FROM volumes WHERE id = ?1", [id])
        .map(|n| n == 1)
}

/// A name to show when none was given: the last part of a path or an address.
/// On Android the system's name for the file comes from the documents plugin.
pub fn name_from(address: &str) -> String {
    let decoded = percent_decode(address);
    let last = decoded
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(&decoded)
        .rsplit(':')
        .next()
        .unwrap_or_default();
    if last.is_empty() {
        decoded
    } else {
        last.to_string()
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2]))
        {
            out.push((h * 16 + l) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

/// The library the app keeps open, or why it could not be opened.
pub struct Library(Mutex<Result<Connection, String>>);

impl Library {
    pub fn new(opened: Result<Connection, String>) -> Self {
        Library(Mutex::new(opened))
    }

    fn with<T>(&self, f: impl FnOnce(&mut Connection) -> rusqlite::Result<T>) -> Result<T, String> {
        match &mut *self.0.lock().unwrap() {
            Ok(conn) => f(conn).map_err(|e| format!("The library could not be updated ({e}).")),
            Err(e) => Err(format!("The library could not be opened ({e}).")),
        }
    }
}

fn open_file(app: &AppHandle, address: FilePath) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    app.fs()
        .open(address, options)
        .map_err(|e| format!("The file could not be opened ({e})."))
}

/// Adds a file to the library, or finds it there (see [`add`]). Without `pages`,
/// the archive is read to count them, and a file that is not a readable comic is
/// refused; with them (the caller has just opened it), only its edges are read.
#[tauri::command]
pub async fn library_add(
    app: AppHandle,
    library: State<'_, Library>,
    address: FilePath,
    name: Option<String>,
    pages: Option<u32>,
) -> Result<(Entry, Added), String> {
    let text = address.to_string();
    let mut file = open_file(&app, address)?;
    let (size, fingerprint) =
        fingerprint(&mut file).map_err(|e| format!("The file could not be read ({e})."))?;
    let pages = match pages {
        Some(n) => n,
        None => Volume::open(file)?.page_names().len() as u32,
    };
    let name = name.unwrap_or_else(|| name_from(&text));
    let candidate = Candidate {
        address: &text,
        name: &name,
        size,
        fingerprint: &fingerprint,
        pages: Some(pages),
    };
    // The old address of a file with the same fingerprint: is the file still there?
    let opens = |old: &str| {
        old.parse::<FilePath>()
            .is_ok_and(|path| open_file(&app, path).is_ok())
    };
    library.with(|conn| add(conn, &candidate, now(), opens))
}

#[tauri::command]
pub fn library_list(library: State<Library>) -> Result<Vec<Entry>, String> {
    library.with(|conn| list(conn))
}

#[tauri::command]
pub fn library_opened(library: State<Library>, id: i64, pages: u32) -> Result<bool, String> {
    library.with(|conn| opened(conn, id, pages, now()))
}

#[tauri::command]
pub fn library_save(library: State<Library>, id: i64, reading: Reading) -> Result<bool, String> {
    library.with(|conn| save(conn, id, &reading))
}

#[tauri::command]
pub fn library_remove(library: State<Library>, id: i64) -> Result<bool, String> {
    library.with(|conn| remove(conn, id))
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use rusqlite::Connection;

    use super::*;

    fn db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        prepare(&mut conn).unwrap();
        conn
    }

    /// Adds a file whose copies elsewhere are all gone: a fingerprint found means it moved.
    fn add_gone(
        conn: &mut Connection,
        file: &Candidate,
        now: i64,
    ) -> rusqlite::Result<(Entry, Added)> {
        add(conn, file, now, |_| false)
    }

    fn file<'a>(address: &'a str, fingerprint: &'a str) -> Candidate<'a> {
        Candidate {
            address,
            name: "Volume",
            size: 100,
            fingerprint,
            pages: Some(20),
        }
    }

    #[test]
    fn a_new_database_gets_the_latest_schema() {
        let conn = db();
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(version, MIGRATIONS.len() as i64);
        assert!(list(&conn).unwrap().is_empty());
    }

    #[test]
    fn migrating_twice_changes_nothing() {
        let mut conn = db();
        add_gone(&mut conn, &file("a.cbz", "f1"), 1).unwrap();
        migrate(&mut conn).unwrap();
        assert_eq!(list(&conn).unwrap().len(), 1);
    }

    #[test]
    fn refuses_a_database_from_a_newer_gutter() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "user_version", MIGRATIONS.len() as i64 + 1)
            .unwrap();
        let error = migrate(&mut conn).unwrap_err();
        assert!(error.contains("newer version of Gutter"), "{error}");
    }

    #[test]
    fn a_database_file_is_made_and_opened_again() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("library.sqlite3");
        let mut conn = open(&path).unwrap();
        add_gone(&mut conn, &file("a.cbz", "f1"), 1).unwrap();
        drop(conn);
        let conn = open(&path).unwrap();
        assert_eq!(list(&conn).unwrap()[0].address, "a.cbz");
    }

    #[test]
    fn adds_a_volume_at_the_first_page() {
        let mut conn = db();
        let (entry, how) = add_gone(&mut conn, &file("a.cbz", "f1"), 1000).unwrap();
        assert_eq!(how, Added::New);
        assert_eq!(entry.address, "a.cbz");
        assert_eq!(entry.pages, Some(20));
        assert_eq!(entry.added, 1000);
        assert_eq!(entry.opened, None);
        assert_eq!(entry.reading, Reading::default());
    }

    #[test]
    fn the_same_address_twice_is_one_volume() {
        let mut conn = db();
        let (first, _) = add_gone(&mut conn, &file("a.cbz", "f1"), 1).unwrap();
        save(
            &conn,
            first.id,
            &Reading {
                page: 7,
                ..Default::default()
            },
        )
        .unwrap();
        let (again, how) = add_gone(&mut conn, &file("a.cbz", "f1"), 2).unwrap();
        assert_eq!(how, Added::Known);
        assert_eq!(again.id, first.id);
        assert_eq!(again.reading.page, 7);
        assert_eq!(list(&conn).unwrap().len(), 1);
    }

    #[test]
    fn a_file_changed_in_place_keeps_its_place() {
        let mut conn = db();
        let (first, _) = add_gone(&mut conn, &file("a.cbz", "f1"), 1).unwrap();
        save(
            &conn,
            first.id,
            &Reading {
                page: 3,
                ..Default::default()
            },
        )
        .unwrap();
        let (again, how) = add_gone(&mut conn, &file("a.cbz", "f2"), 2).unwrap();
        assert_eq!(how, Added::Known);
        assert_eq!(again.fingerprint, "f2");
        assert_eq!(again.reading.page, 3);
    }

    #[test]
    fn a_moved_file_is_found_by_its_fingerprint() {
        let mut conn = db();
        let (first, _) = add_gone(&mut conn, &file("old/a.cbz", "f1"), 1).unwrap();
        save(
            &conn,
            first.id,
            &Reading {
                page: 12,
                direction: Some("rtl".into()),
                ..Default::default()
            },
        )
        .unwrap();
        let moved = Candidate {
            name: "Renamed",
            ..file("new/b.cbz", "f1")
        };
        let (again, how) = add_gone(&mut conn, &moved, 2).unwrap();
        assert_eq!(how, Added::Moved);
        assert_eq!(again.id, first.id);
        assert_eq!(again.address, "new/b.cbz");
        assert_eq!(again.name, "Renamed");
        assert_eq!(again.reading.page, 12);
        assert_eq!(again.reading.direction.as_deref(), Some("rtl"));
        assert_eq!(list(&conn).unwrap().len(), 1);
    }

    #[test]
    fn a_copy_of_a_volume_still_there_adds_nothing() {
        let mut conn = db();
        let (first, _) = add_gone(&mut conn, &file("a.cbz", "f1"), 1).unwrap();
        save(
            &conn,
            first.id,
            &Reading {
                page: 5,
                ..Default::default()
            },
        )
        .unwrap();
        let asked = std::cell::RefCell::new(Vec::new());
        let (again, how) = add(&mut conn, &file("copy/a.cbz", "f1"), 2, |old| {
            asked.borrow_mut().push(old.to_string());
            true
        })
        .unwrap();
        assert_eq!(asked.into_inner(), ["a.cbz"]);
        assert_eq!(how, Added::Duplicate);
        assert_eq!(
            (again.id, again.address.as_str(), again.reading.page),
            (first.id, "a.cbz", 5)
        );
        assert_eq!(list(&conn).unwrap().len(), 1);
    }

    #[test]
    fn adding_without_pages_keeps_the_count_known() {
        let mut conn = db();
        add_gone(&mut conn, &file("a.cbz", "f1"), 1).unwrap();
        let unknown = Candidate {
            pages: None,
            ..file("a.cbz", "f1")
        };
        let (again, _) = add_gone(&mut conn, &unknown, 2).unwrap();
        assert_eq!(again.pages, Some(20));
    }

    #[test]
    fn lists_the_last_opened_first_then_the_newest() {
        let mut conn = db();
        let (a, _) = add_gone(&mut conn, &file("a.cbz", "f1"), 1).unwrap();
        let (b, _) = add_gone(&mut conn, &file("b.cbz", "f2"), 2).unwrap();
        let (c, _) = add_gone(&mut conn, &file("c.cbz", "f3"), 3).unwrap();
        let (d, _) = add_gone(&mut conn, &file("d.cbz", "f4"), 4).unwrap();
        opened(&conn, a.id, 20, 10).unwrap();
        opened(&conn, b.id, 20, 20).unwrap();
        let order: Vec<i64> = list(&conn).unwrap().iter().map(|e| e.id).collect();
        assert_eq!(order, [b.id, a.id, d.id, c.id]);
    }

    #[test]
    fn opening_records_the_time_and_the_pages() {
        let mut conn = db();
        let (a, _) = add_gone(
            &mut conn,
            &Candidate {
                pages: None,
                ..file("a.cbz", "f1")
            },
            1,
        )
        .unwrap();
        assert_eq!(a.pages, None);
        assert!(opened(&conn, a.id, 40, 99).unwrap());
        let a = &list(&conn).unwrap()[0];
        assert_eq!((a.pages, a.opened), (Some(40), Some(99)));
        assert!(!opened(&conn, 12345, 1, 1).unwrap());
    }

    #[test]
    fn saves_and_reads_back_where_a_volume_was_left() {
        let mut conn = db();
        let (a, _) = add_gone(&mut conn, &file("a.cbz", "f1"), 1).unwrap();
        let reading = Reading {
            page: 22,
            finished: true,
            direction: Some("rtl".into()),
            mode: Some("double".into()),
            cover: Some(false),
        };
        assert!(save(&conn, a.id, &reading).unwrap());
        assert_eq!(list(&conn).unwrap()[0].reading, reading);
        assert!(!save(&conn, 12345, &reading).unwrap());
    }

    #[test]
    fn removing_a_volume_removes_its_place() {
        let mut conn = db();
        let (a, _) = add_gone(&mut conn, &file("a.cbz", "f1"), 1).unwrap();
        assert!(remove(&conn, a.id).unwrap());
        assert!(list(&conn).unwrap().is_empty());
        let left: i64 = conn
            .query_row("SELECT count(*) FROM reading", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0);
        assert!(!remove(&conn, a.id).unwrap());
        // Added again, it starts from the beginning
        let (again, how) = add_gone(&mut conn, &file("a.cbz", "f1"), 2).unwrap();
        assert_eq!((how, again.reading.page), (Added::New, 0));
    }

    #[test]
    fn the_fingerprint_reads_only_the_edges() {
        let mut bytes = vec![0u8; 1_000_000];
        let (size, base) = fingerprint(&mut Cursor::new(&bytes)).unwrap();
        assert_eq!(size, 1_000_000);
        assert!(base.starts_with("1000000-"));
        // A change in the middle goes unseen; at either end it does not
        bytes[500_000] = 1;
        assert_eq!(fingerprint(&mut Cursor::new(&bytes)).unwrap().1, base);
        bytes[10] = 1;
        let head = fingerprint(&mut Cursor::new(&bytes)).unwrap().1;
        assert_ne!(head, base);
        bytes[999_990] = 1;
        assert_ne!(fingerprint(&mut Cursor::new(&bytes)).unwrap().1, head);
    }

    #[test]
    fn the_fingerprint_of_small_and_empty_files() {
        let (size, empty) = fingerprint(&mut Cursor::new(Vec::<u8>::new())).unwrap();
        assert_eq!((size, empty.as_str()), (0, "0-cbf29ce484222325"));
        let small = fingerprint(&mut Cursor::new(b"abc".to_vec())).unwrap().1;
        let other = fingerprint(&mut Cursor::new(b"abd".to_vec())).unwrap().1;
        assert_ne!(small, other);
        // Just over one edge: the tail is the bytes after the first 64 KB
        let mut bytes = vec![0u8; EDGE as usize + 10];
        let before = fingerprint(&mut Cursor::new(&bytes)).unwrap().1;
        *bytes.last_mut().unwrap() = 1;
        assert_ne!(fingerprint(&mut Cursor::new(&bytes)).unwrap().1, before);
    }

    #[test]
    fn the_fingerprint_does_not_change_between_versions() {
        // Saved in the database: the same bytes must always give the same text.
        // The value was computed apart, with a few lines of JavaScript.
        let bytes: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
        assert_eq!(
            fingerprint(&mut Cursor::new(&bytes)).unwrap().1,
            "200000-6d0a691d7ea44080"
        );
    }

    #[test]
    fn names_from_paths_and_addresses() {
        assert_eq!(name_from(r"C:\Comics\Saga 01.cbz"), "Saga 01.cbz");
        assert_eq!(name_from("/home/me/comics/Saga 01.cbr"), "Saga 01.cbr");
        assert_eq!(
            name_from(
                "content://com.android.providers.downloads.documents/document/raw%3A%2Fstorage%2Femulated%2F0%2FDownload%2Fspike-a.cbz"
            ),
            "spike-a.cbz"
        );
        assert_eq!(
            name_from(
                "content://com.android.externalstorage.documents/tree/primary%3ADownload%2Fx/document/primary%3ADownload%2Fx%2Fp%C3%A0gina.cbz"
            ),
            "pàgina.cbz"
        );
        assert_eq!(name_from("content://media/document/msf%3A1234"), "1234");
    }
}
