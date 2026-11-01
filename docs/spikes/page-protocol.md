# Spike `page-protocol` — Serving pages through a custom protocol

**Question:** does Rust extract a page from a 100 MB CBZ and the webview show it in under 500 ms via the custom protocol?

**Answer: yes.** From choosing the file to the first page decoded: **52 ms on Windows, 211 ms on Android** (debug build). The custom protocol is at least as fast as IPC, so the design's choice stands.

Date: 2026-10-31 · Code: branch `spike/page-protocol` (not merged, built on `spike/android-files`)

## Setup

| | Windows | Android |
| --- | --- | --- |
| Device | Desktop PC, WebView2 | Motorola Edge 60, Android 16, WebView 156 |
| Build | `pnpm tauri dev`, debug | `pnpm tauri android dev`, debug |
| File access | Normal path | `content://` URI via the system picker |

Test file: synthetic CBZ, 99.7 MB, 40 JPEG pages of 1988 × 3056 (about 2.6 MB each), stored without compression.

## What the spike does

- `open_volume` opens the file, reads the ZIP index and keeps the archive open in Rust state under a numeric id. Only the index stays in memory.
- A custom protocol `page` is registered with `register_asynchronous_uri_scheme_protocol`. A request for `<volume>/<page>` reads that single entry on a separate thread and answers with the right `Content-Type`. The URL is built with `convertFileSrc(id, 'page')`: `http://page.localhost/<id>/<n>` on Windows and Android, `page://localhost/<id>/<n>` on Linux and macOS.
- The viewer loads each page with `new Image()` + `img.decode()` on that URL and swaps it in once decoded.
- A comparison button loads the same page 3 times through IPC (`ipc::Response`, raw bytes) and 3 times through `fetch` on the protocol URL, timing transfer and decode separately.
- Responses carry `Cache-Control: no-store` so every measurement goes through Rust.

## Results

| Step | Windows | Android |
| --- | --- | --- |
| Rust: open the file | 0.1 ms | 62.9 ms |
| Rust: read the ZIP index (41 entries) | 0.3 ms | 5.1 ms |
| First page via `page://` (transfer + decode) | 49.9 ms | 110.0 ms |
| **Total from choice to first page** | **52.4 ms** | **211.4 ms** |
| Next page, not preloaded (3 runs) | 49–50 ms | 67–71 ms |
| Back to the page just shown | 1.0 ms | 1.0 ms |

IPC vs custom protocol, same page, average of 3 runs:

| | Windows transfer | Windows decode | Android transfer | Android decode |
| --- | --- | --- | --- | --- |
| IPC | 24.0 ms | 28.5 ms | 71.9 ms | 66.4 ms |
| `page://` | 22.4 ms | 29.1 ms | 63.7 ms | 90.9 ms |

## Findings

- **The custom protocol is not slower than IPC**, slightly faster in transfer on both platforms. Decode works on identical bytes, so the Android decode gap (66 vs 91 ms) is measurement noise. Keep `page://`: it lets the webview load pages like any image and keeps page bytes out of the IPC channel.
- **Archive size does not matter.** Reading the index of a 100 MB file takes 0.3 ms on Windows and 5 ms on Android. Opening a `content://` file costs more on Android (63 ms here, 14 ms in the `android-files` spike for a 50 MB file): a one-off cost per volume, still well within budget.
- **On Android, page cost is split between transfer and decode** (~35 ms each). A page change that isn't preloaded takes ~70 ms, so the 16 ms target for page changes depends on preloading, as the design already assumes.
- **An already decoded page swaps in within 1 ms.** Going back to the page just shown hit the webview's in-memory image cache despite `no-store`. This confirms that preloaded, decoded pages can be shown within one frame. It also means the webview keeps decoded images on its own: the memory budget in M3 has to account for it.

## Caveats

- Debug builds on both platforms: release Rust will lower transfer times.
- Decoding used `img.decode()` at full size, not `createImageBitmap` with resize. That is the `resize-quality` spike's job.
- The archive sits behind a single `Mutex`, so pages are read one at a time. Fine for a viewer, but M3 preloading may want one file handle per worker.

## Decision

No change to the design. The custom protocol `page://<volume>/<n>` is confirmed as the way pages reach the webview. Its code (`open_volume`, volume state, protocol handler) is a good starting point for M1.
