# Benchmark `canvas-vs-img` — How the page reaches the screen

**Question:** should the decoded page be drawn on a `<canvas>` or shown in an `<img>`?

**Answer: `<canvas>` with a 2D context, as the app already does.** It is the fastest way that keeps our moire-free downscale: an `<img>` either lets the browser downscale (fast on Chromium but full of moire) or needs our page re-encoded as PNG (same pixels, up to 25 times slower). The zero-copy `bitmaprenderer` canvas is not faster overall.

Date: 2026-11-07 · Roadmap step 1.6 · Code: scratch scripts injected into the running app over the DevTools protocol, not committed

## Setup

| | Windows | Linux | Android |
| --- | --- | --- | --- |
| Device | Desktop PC, i7-12700 | Same PC, WSL Ubuntu 26.04 | Motorola Edge 60, 1220 × 2712 screen |
| Webview | WebView2, Chromium 156 | WebKitGTK 2.52 | Android System WebView, Chromium 156 |
| Build | `pnpm tauri dev`, debug | `pnpm tauri dev`, debug | `pnpm tauri android dev`, debug |

On Windows two window sizes were measured: 1000 × 800 at density 1, and the phone's CSS size (434 × 964 at density 2.8125) emulated.

## What was compared

Each method gets the same page bytes and the same placement (whole physical pixels, as in `PageView`):

| Method | How the pixels reach the element |
| --- | --- |
| `<canvas>` 2D | Our decode and stepped downscale, then `drawImage` at 1:1. What the app does |
| `<canvas>` bitmaprenderer | Our decode and downscale, then `transferFromImageBitmap`: the bitmap is handed over without a copy |
| `<img>`, browser scaling | The original image, scaled to the target size by the browser. Skips our downscale |
| `<img>`, our PNG | Our decode and downscale, re-encoded as PNG and shown in an `<img>` |

**Time:** page change from the bytes in memory to the frame presented (two animation frames after the element is ready), on the 40 pages of `large.cbz` (1988 × 3056 JPEG, about 3 MB each), 2 rounds, median of 39 changes. **Quality:** `resize.cbz` (1 px stripes), comparing a real screenshot with the page our pipeline produces, and the moire (standard deviation of brightness) in the stripe areas.

## Results

Page change time, median (90th percentile):

| Method | Windows 1000 × 800 | Windows, phone size | Linux | Android |
| --- | --- | --- | --- | --- |
| `<canvas>` 2D | 99 ms (117) | 75 ms (83) | 65 ms (67) | **183 ms (202)** |
| `<canvas>` bitmaprenderer | 85 ms (99) | 74 ms (83) | 64 ms (67) | 201 ms (218) |
| `<img>`, browser scaling | 50 ms (59) | 50 ms (60) | 81 ms (85) | 184 ms (201) |
| `<img>`, our PNG | 158 ms (192) | 342 ms (393) | 178 ms (194) | 4567 ms (4600) |

Quality on Windows (screenshot vs our pipeline):

| Method | Ratio 4.5 | Ratio 2.12 | Ratio 1.97 (phone) | Ratio 2.95 | Ratio 3.6, density 1.25 |
| --- | --- | --- | --- | --- | --- |
| `<canvas>` 2D | 0% differ, moire 0 | 0%, 0 | 0.2%, 1.8 | 0%, 0 | 0%, 0 |
| `<canvas>` bitmaprenderer | same as 2D | same | same | same | same |
| `<img>`, browser scaling | 0.25%, 0 | **87%, 28.5** | **88%, 36.4** | 0.16%, 0 | 0.5%, 0 |
| `<img>`, our PNG | same as 2D | same | same | same | 0.3%, 0 |

On Android, moire on screen at ratio 1.97: `<img>` with browser scaling **73.6**, `<img>` with our PNG 1.3; `<canvas>` 1.6, measured on the canvas content (see caveats).

## Findings

- **The browser's own scaling is out.** It is the fastest on Chromium only because it skips our downscale, and that is exactly what leaves moire at the ratios real screens use (2.12, 1.97). On WebKitGTK it is not even faster.
- **Re-encoding as PNG keeps the quality but is far too slow**, worst on the phone (4.6 s per page).
- **`bitmaprenderer` is not a clear win:** 15% faster on desktop Windows, equal on the phone size and on Linux, 10% slower on the real phone. The 2D canvas stays: simpler, and the app's tests read its pixels back.
- **A page change on the phone takes about 180 ms** for a 3 MB, 1988 × 3056 page, in a debug build. Far from the 16 ms target for a preloaded page: M3 must prepare the pages around the current one in advance, as the design already plans.

## Caveats

- **The DevTools screenshot on Android leaves out large GPU canvases.** Canvases of 1219 × 1829 came out as background, including the app's own, while a 643 × 965 one was captured correctly and you can see the page on the phone. On Android the canvas quality is therefore the canvas content, not the screen; on Windows both were measured and match.
- **Memory is not compared.** The total private memory of the WebView2 processes (800–1050 MB while cycling `large.cbz`) includes the GPU process, caches and the 116 MB of pages the benchmark keeps in memory, and does not separate the methods. The memory budget is measured properly in M3, and this high number is a warning for it.
- Debug builds everywhere; WebKit rounds times to 1 ms.

## Decision

Pages are drawn on a `<canvas>` with a 2D context, at 1:1, as `PageView` does since step 1.3. The open question in the design doc is closed.
