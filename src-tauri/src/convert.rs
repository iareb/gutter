//! Decodes pages the webview cannot decode and converts them to PNG, which is
//! lossless and readable by every webview. Today that means AVIF on WebKitGTK.

/// Converts a page, given its bytes and MIME type, to PNG.
pub fn to_png(bytes: &[u8], mime: &str) -> Result<Vec<u8>, String> {
    if mime != "image/avif" {
        return Err("this format has no fallback decoder".into());
    }
    avif_to_png(bytes)
}

#[cfg(not(target_os = "linux"))]
fn avif_to_png(_bytes: &[u8]) -> Result<Vec<u8>, String> {
    Err("this build has no AVIF decoder".into())
}

#[cfg(target_os = "linux")]
fn avif_to_png(bytes: &[u8]) -> Result<Vec<u8>, String> {
    use avif_decode::{Decoder, Image};
    use png::BitDepth::{Eight, Sixteen};
    use png::ColorType::{Grayscale, Rgb, Rgba};

    let image = Decoder::from_avif(bytes)
        .and_then(Decoder::to_image)
        .map_err(|e| e.to_string())?;

    // PNG stores 16 bit samples big-endian
    let wide =
        |samples: &[u16]| -> Vec<u8> { samples.iter().flat_map(|s| s.to_be_bytes()).collect() };

    match image {
        Image::Rgb8(img) => {
            let (pixels, w, h) = img.into_contiguous_buf();
            let samples: Vec<u8> = pixels.iter().flat_map(|p| [p.r, p.g, p.b]).collect();
            encode(&samples, w, h, Rgb, Eight)
        }
        Image::Rgba8(img) => {
            let (pixels, w, h) = img.into_contiguous_buf();
            let samples: Vec<u8> = pixels.iter().flat_map(|p| [p.r, p.g, p.b, p.a]).collect();
            encode(&samples, w, h, Rgba, Eight)
        }
        Image::Gray8(img) => {
            let (pixels, w, h) = img.into_contiguous_buf();
            let samples: Vec<u8> = pixels.iter().map(|p| p.value()).collect();
            encode(&samples, w, h, Grayscale, Eight)
        }
        Image::Rgb16(img) => {
            let (pixels, w, h) = img.into_contiguous_buf();
            let samples: Vec<u16> = pixels.iter().flat_map(|p| [p.r, p.g, p.b]).collect();
            encode(&wide(&samples), w, h, Rgb, Sixteen)
        }
        Image::Rgba16(img) => {
            let (pixels, w, h) = img.into_contiguous_buf();
            let samples: Vec<u16> = pixels.iter().flat_map(|p| [p.r, p.g, p.b, p.a]).collect();
            encode(&wide(&samples), w, h, Rgba, Sixteen)
        }
        Image::Gray16(img) => {
            let (pixels, w, h) = img.into_contiguous_buf();
            let samples: Vec<u16> = pixels.iter().map(|p| p.value()).collect();
            encode(&wide(&samples), w, h, Grayscale, Sixteen)
        }
    }
}

#[cfg(target_os = "linux")]
fn encode(
    samples: &[u8],
    width: usize,
    height: usize,
    color: png::ColorType,
    depth: png::BitDepth,
) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, width as u32, height as u32);
    encoder.set_color(color);
    encoder.set_depth(depth);
    // The PNG lives only until the webview decodes it: speed matters, size does not
    encoder.set_compression(png::Compression::Fast);
    let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
    writer
        .write_image_data(samples)
        .map_err(|e| e.to_string())?;
    writer.finish().map_err(|e| e.to_string())?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::to_png;

    #[test]
    fn has_no_fallback_for_other_formats() {
        assert!(to_png(b"not an image", "image/jpeg").is_err());
    }

    #[test]
    fn rejects_damaged_avif() {
        assert!(to_png(b"not an image", "image/avif").is_err());
    }

    /// A 64 x 64 AVIF with four quadrants of known color.
    #[cfg(target_os = "linux")]
    #[test]
    fn converts_avif_keeping_its_colors() {
        let avif = include_bytes!("../tests/fixtures/quadrants.avif");
        let png = to_png(avif, "image/avif").unwrap();

        let mut reader = png::Decoder::new(std::io::Cursor::new(png))
            .read_info()
            .unwrap();
        let mut pixels = vec![0; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut pixels).unwrap();
        assert_eq!((info.width, info.height), (64, 64));

        let channels = info.color_type.samples();
        let at = |x: usize, y: usize| &pixels[(y * 64 + x) * channels..][..3];
        for ((x, y), expected) in [
            ((16, 16), [220, 30, 30]),
            ((48, 16), [30, 180, 60]),
            ((16, 48), [30, 60, 220]),
            ((48, 48), [128, 128, 128]),
        ] {
            let close = at(x, y)
                .iter()
                .zip(expected)
                .all(|(got, want)| got.abs_diff(want) < 8);
            assert!(close, "at {x},{y}: {:?}, expected {expected:?}", at(x, y));
        }
    }
}
