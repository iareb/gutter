# Spike `image-formats` — Which formats each webview decodes

**Question:** which image formats does each webview decode?

**Answer:** JPEG, PNG, WebP, GIF and BMP decode everywhere with correct colors. **AVIF fails on WebKitGTK** and **JPEG XL fails on WebView2**. The design's Rust fallback for AVIF is needed.

Date: 2026-11-01 · Code: branch `spike/resize-quality` (not merged) · Done together with the [`resize-quality`](resize-quality.md) spike, same setup

## What the spike does

`gutter-formats.cbz` contains the same 1200 × 1800 picture in 12 variants. The picture has four flat quadrants of known color (red, green, blue, grey). For each variant the UI fetches the bytes through `page://`, decodes them with `createImageBitmap` and samples the center of each quadrant. A variant passes only if all four samples are within 12 levels of the expected color, so a decoder that runs but gets colors wrong (e.g. an inverted CMYK JPEG) still fails. When `createImageBitmap` fails, the UI also tries an `<img>` element to tell an API limit from a missing decoder.

## Results

| Variant | Windows (WebView2) | Android (WebView) | Linux (WebKitGTK) |
| --- | --- | --- | --- |
| JPEG baseline | 5 ms | 13 ms | 6 ms |
| JPEG progressive | 9 ms | 23 ms | 9 ms |
| JPEG CMYK | 10 ms | 34 ms | 9 ms |
| PNG RGB | 5 ms | 21 ms | 9 ms |
| PNG 16 bit greyscale | 5 ms | 13 ms | 9 ms |
| PNG palette | 5 ms | 15 ms | 5 ms |
| WebP lossy | 4 ms | 13 ms | 12 ms |
| WebP lossless | 5 ms | 11 ms | 11 ms |
| AVIF | 7 ms | 27 ms | **not decoded** |
| JPEG XL | **not decoded** | 50 ms | 41 ms |
| GIF | 4 ms | 8 ms | 11 ms |
| BMP | 10 ms | 21 ms | 34 ms |

Times are full-size decodes. Every decoded variant had correct colors. Where a format failed, `<img>` failed too: the decoder is missing, not just the API.

## Findings

- **The common formats are safe.** JPEG (including progressive and CMYK, both common in scans), PNG (including 16 bit and palette), WebP, GIF and BMP decode correctly in all three webviews.
- **AVIF is missing on WebKitGTK**, most likely because Ubuntu's build is compiled without it. It does work on WebView2, which ships its own decoder: the design's note that it depends on the Windows AV1 extension is wrong.
- **JPEG XL is the reverse:** it works on Android and WebKitGTK but not on WebView2, although WebView2 runs the same Chromium version as Android. It is not one of the formats the design supports.

## Caveats

- One build per platform. Support depends on how each webview is compiled: other Linux distributions may ship WebKitGTK with AVIF, and WebView2 may enable JPEG XL later. The app must not trust a format list per platform.
- macOS and iOS were not tested.
- Single small test images. Very large or unusual files (e.g. AVIF with 10 bit color) are left to the M0 test corpus.

## Decision

Formats are detected at runtime, not assumed per platform: if the webview fails to decode a page, Rust decodes it and serves it in a format the webview supports, as the design already plans for AVIF. The design's Windows note on AVIF is corrected. JPEG XL stays out of the supported list for now; the same fallback could cover it later.
