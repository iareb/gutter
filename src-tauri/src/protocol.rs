//! The `page` protocol: the webview loads page `n` (counted from 0) of volume
//! `id` from `page://localhost/<id>/<n>`, or `http://page.localhost/<id>/<n>` on
//! Windows and Android. Page bytes never travel through IPC messages.

use tauri::http::{Response, StatusCode, header};

use crate::volume::Volumes;

/// Parses `/<id>/<n>` from the request path.
pub fn parse(path: &str) -> Option<(u32, usize)> {
    let (id, n) = path.strip_prefix('/')?.split_once('/')?;
    Some((id.parse().ok()?, n.parse().ok()?))
}

/// Answers a request for a page. Blocking: call it off the webview's thread.
pub fn respond(volumes: &Volumes, path: &str) -> Response<Vec<u8>> {
    let Some((id, n)) = parse(path) else {
        return error(
            StatusCode::BAD_REQUEST,
            format!("Not a page address: {path}"),
        );
    };
    let Some(volume) = volumes.get(id) else {
        return error(
            StatusCode::NOT_FOUND,
            "This volume is no longer open.".into(),
        );
    };
    match volume.read_page(n) {
        Ok((bytes, mime)) => {
            let mut builder = response(StatusCode::OK, mime);
            // The UI needs the size to pick the decode size before decoding.
            // Unknown formats get no headers and are measured by decoding.
            if let Ok(size) = imagesize::blob_size(&bytes) {
                builder = builder
                    .header(WIDTH, size.width)
                    .header(HEIGHT, size.height);
            }
            builder.body(bytes).unwrap()
        }
        Err(message) => error(StatusCode::NOT_FOUND, message),
    }
}

/// Page size in pixels, read from the image header.
pub const WIDTH: &str = "x-page-width";
pub const HEIGHT: &str = "x-page-height";

fn response(status: StatusCode, mime: &str) -> tauri::http::response::Builder {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        // The app's own cache decides what stays in memory (design: memory budget)
        .header(header::CACHE_CONTROL, "no-store")
        // The page origin differs from the app's: without this, fetch() fails and
        // a canvas that drew the page could not be read back
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        // Cross-origin, custom headers stay hidden from fetch() unless listed
        .header(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            format!("{WIDTH}, {HEIGHT}"),
        )
}

fn error(status: StatusCode, message: String) -> Response<Vec<u8>> {
    response(status, "text/plain; charset=utf-8")
        .body(message.into_bytes())
        .unwrap()
}

#[cfg(test)]
mod tests {
    use std::io::{Seek, Write};

    use tauri::http::{StatusCode, header};
    use zip::write::{SimpleFileOptions, ZipWriter};

    use super::{HEIGHT, WIDTH, parse, respond};
    use crate::volume::{Volume, Volumes};

    /// A volume whose entries hold their own name as content.
    fn volume(names: &[&str]) -> Volume {
        let entries: Vec<_> = names.iter().map(|n| (*n, n.as_bytes())).collect();
        volume_with(&entries)
    }

    fn volume_with(entries: &[(&str, &[u8])]) -> Volume {
        let mut writer = ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for (name, content) in entries {
            writer
                .start_file(*name, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(content).unwrap();
        }
        let mut file = tempfile::tempfile().unwrap();
        file.write_all(&writer.finish().unwrap().into_inner())
            .unwrap();
        file.rewind().unwrap();
        Volume::open(file).unwrap()
    }

    #[test]
    fn parses_page_addresses() {
        assert_eq!(parse("/0/0"), Some((0, 0)));
        assert_eq!(parse("/12/345"), Some((12, 345)));
        for bad in [
            "", "/", "/1", "/1/", "/x/1", "/1/x", "/1/2/3", "/-1/0", "1/2",
        ] {
            assert_eq!(parse(bad), None, "{bad}");
        }
    }

    #[test]
    fn serves_a_page_with_its_type() {
        let volumes = Volumes::default();
        let id = volumes.insert(volume(&["2.png", "1.jpg"]));
        let response = respond(&volumes, &format!("/{id}/1"));
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");
        assert_eq!(response.body(), b"2.png");
        // Not a real image: no size
        assert!(response.headers().get(WIDTH).is_none());
    }

    #[test]
    fn tells_the_page_size_from_its_header() {
        // Just the start of a PNG: signature and IHDR chunk with 3 x 5 pixels
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
        png.extend_from_slice(&[0, 0, 0, 3, 0, 0, 0, 5, 8, 6, 0, 0, 0]);
        let volumes = Volumes::default();
        let id = volumes.insert(volume_with(&[("1.png", &png)]));
        let response = respond(&volumes, &format!("/{id}/0"));
        assert_eq!(response.headers()[WIDTH], "3");
        assert_eq!(response.headers()[HEIGHT], "5");
    }

    #[test]
    fn explains_what_went_wrong() {
        let volumes = Volumes::default();
        let old = volumes.insert(volume(&["1.jpg"]));
        let id = volumes.insert(volume(&["1.jpg"]));

        let cases = [
            (
                "/nonsense".to_string(),
                StatusCode::BAD_REQUEST,
                "Not a page address: /nonsense",
            ),
            (
                format!("/{old}/0"),
                StatusCode::NOT_FOUND,
                "This volume is no longer open.",
            ),
            (
                format!("/{id}/5"),
                StatusCode::NOT_FOUND,
                "Page 6 does not exist.",
            ),
        ];
        for (path, status, message) in cases {
            let response = respond(&volumes, &path);
            assert_eq!(response.status(), status, "{path}");
            assert_eq!(response.body(), message.as_bytes(), "{path}");
        }
    }
}
