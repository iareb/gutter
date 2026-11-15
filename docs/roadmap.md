# Roadmap

How we get from an empty repo to release 0.1. Milestones and their rationale are in the [design document](design.md#roadmap-and-open-questions); this file breaks them into concrete steps.

## Workflow

gutter has a single maintainer, so there are no pull requests: work lands directly on `main`.

1. The agent makes the change in the working tree and runs it locally.
2. The agent hands over a commit message and a short manual checklist (how to try it in under 5 minutes).
3. The maintainer runs the checklist, commits and pushes.
4. CI runs on every push to `main`. A red CI is fixed before anything else.

Spikes (M0.5) live on throwaway branches named `spike/<name>` that are never merged; only their write-up in `docs/spikes/` lands on `main`.

## Status

| Milestone | State |
| --- | --- |
| M0 — Skeleton | **Done** (Nov 1, 2026) |
| M0.5 — Risk check | **Done** (Nov 2), except trackpad pinch on Windows: no laptop with a trackpad yet |
| M1 — Basic viewer | **Done** (Nov 7): [checklist](checklists/m1.md) passed on Windows, Linux and Android |
| M2 — Gesture engine | Almost done: everything is written and the [checklist](checklists/m2.md) passes on Windows, Android and Linux in WSL; left: the Linux laptop with its trackpad (2.6, items 20 to 24 and a real mouse). Android items 26 and 27 were done by hand |
| M2.5 — CBR | Spike done (2026-11-13): the `rars` crate; 2.5.1 to 2.5.4 done, 2.5.5 next |
| M2.6 — Navigation by hand | Not started: asked for while M2.5 was under way, to go between M2.5 and M3 (see below) |

Estimates were revised at the end of M1, see the [design document](design.md#roadmap-and-open-questions).

## M0 — Skeleton

| Step | Content | How to try it |
| --- | --- | --- |
| 0.1 Scaffold | Tauri 2 + Svelte 5 + TypeScript + Vite with pnpm; an empty dark window | `pnpm tauri dev` opens the window |
| 0.2 Tooling | ESLint, Prettier, `svelte-check`, Vitest, clippy, rustfmt; one sample test per side; commands documented in `AGENTS.md` | `pnpm check` and `pnpm test` pass |
| 0.3 CI | GitHub Actions on every push: lint, type check, tests, build on Windows and Ubuntu | Green check next to the commit on GitHub |
| 0.4 Test corpus | `pnpm corpus` generates synthetic test CBZs (see below) in an ignored `corpus/generated/`; an ignored `corpus/local/` folder for personal files and public-domain comics, which are not committed | The script produces the files and they open in any reader |
| 0.5 Issue templates | Bug report template with steps to reproduce, for milestone checklist failures | Opening a new issue on GitHub shows the template |

The `android-files` spike runs right after step 0.1, because it is the biggest risk.

### Synthetic test corpus

Copyrighted comics cannot go in the repo, so a script generates pages designed for testing:

- fine stripe patterns and tiny text, which make any quality loss obvious;
- large page numbers, which make skipped pages visible;
- edge cases: 10,000 px pages, AVIF, odd file names, a corrupt archive, a double-page spread.

## M0.5 — Risk check

Each spike answers one yes/no question from the design doc. Results go to `docs/spikes/<name>.md` with numbers and screenshots; every "no" updates `design.md` before M1 starts.

| Spike | Question | Notes |
| --- | --- | --- |
| `android-files` | Does the app run on a real Android phone and open a file picked with the system picker? | **Done: yes**, 102 ms from choice to page. See [spikes/android-files.md](spikes/android-files.md) |
| `page-protocol` | Does Rust extract a page from a 100 MB CBZ and the webview show it in under 500 ms via the custom protocol? | **Done: yes**, 52 ms on Windows, 211 ms on Android. Code on `spike/page-protocol` is a starting point for M1. See [spikes/page-protocol.md](spikes/page-protocol.md) |
| `resize-quality` | Does `createImageBitmap` with high-quality resize work on WebView2, WebKitGTK and Android? | **Done: no on WebKitGTK**, which ignores `resizeQuality`. Later found in step 1.3: Chromium too leaves moire below a ratio of about 2.8. Pages are downscaled on a canvas in steps everywhere. See [spikes/resize-quality.md](spikes/resize-quality.md) |
| `image-formats` | Which image formats does each webview decode? | **Done**: common formats everywhere; AVIF fails on WebKitGTK, JPEG XL on WebView2. Rust fallback needed. See [spikes/image-formats.md](spikes/image-formats.md) |
| `cbr-library` | Which library reads CBR: `rars` (pure Rust) or the UnRAR bindings? | **Done: `rars`.** Same bytes from both; `rars` builds for Android from Windows (the UnRAR bindings do not), has a free license and limits for hostile files; it is about 4 times slower on solid RAR5 and cannot open truncated archives. See [spikes/cbr-library.md](spikes/cbr-library.md) |
| `trackpad-pinch` | Does trackpad pinch arrive as a usable event on Windows and Linux? | **Linux done: not in JavaScript**, WebKitGTK zooms the page itself; a GTK pinch handler in Rust works. Windows waiting for a laptop with a trackpad. See [spikes/trackpad-pinch.md](spikes/trackpad-pinch.md) |

## M1 — Basic viewer

Built from the spike results: the spike code is a starting point, rewritten with tests.

| Step | Content | How to try it |
| --- | --- | --- |
| 1.1 Open a CBZ | Pick a file with the system picker (desktop and Android); Rust reads only the ZIP index and lists the pages in natural order (2 before 10), skipping non-image entries; clear errors for broken files | Open `odd-names.cbz`: pages listed 1 to 13 in order; `not-a-zip.cbz` and `no-pages.cbz` show an error, no crash |
| 1.2 Page protocol | `page://` serves one page at a time on a separate thread, with Rust tests (from `page-protocol`) | Page 1 of `basic.cbz` shows up |
| 1.3 Full-quality page | Decode and fit to the screen at physical resolution; downscaled on a canvas in steps on every platform (from `resize-quality` and its update) | `resize.cbz` shows flat grey stripes, no moire, on every platform |
| 1.4 Format fallback | If the webview cannot decode a page (AVIF on WebKitGTK), the UI asks Rust for it as PNG (from `image-formats`); pages Rust cannot decode either show a clear error | Every page of `formats.cbz` shows on Linux |
| 1.5 Navigation | Keyboard, click and tap on the sides | Read `basic.cbz` front to back with keys and taps |
| 1.6 Benchmark | `<canvas>` vs `<img>`: quality and time on Windows, Linux and Android | **Done:** `<canvas>` 2D. See [spikes/canvas-vs-img.md](spikes/canvas-vs-img.md) |
| 1.7 Milestone checklist | 15 concrete actions on the built app, on Windows, Linux and Android; each failure becomes an issue | **Done:** every cell of [checklists/m1.md](checklists/m1.md) is ok |

## M2 — Gesture engine

Zoom, pan and page turns by touch, mouse, trackpad and keyboard, with the rule from the design doc: one gesture, one action. All input goes through one module, a state machine in the TypeScript core that sees normalized events from small per-platform adapters. Thresholds are constants in one place for now; a settings screen comes later. Windows trackpad pinch cannot be tested yet (no laptop with a trackpad): it follows the documented Chromium behavior and gets checked when a trackpad is available.

| Step | Content | How to try it |
| --- | --- | --- |
| 2.1 Zoomed rendering | Viewer state: page, zoom, offset. A zoomed page is decoded again at the zoom's physical resolution (never above the original) and only the visible part is drawn, still 1:1; the offset is clamped so the page never leaves the screen. Driven by temporary keys (+, −, arrows) until the gestures exist | **Done:** at every zoom level the visible part is identical to a reference decode, on WebView2 and WebKitGTK; + − 0 zoom, arrows and Page Up/Down pan and turn at the edge |
| 2.2 Events, recording, replay | Normalized input events (pointer, wheel, key, pinch) with timestamps; adapters from the webview's events; a development-only recorder that saves a gesture to a file; Vitest replays recordings into the engine | **Done:** recordings of mouse, touch, keys and wheel in `tests/recordings/`, replayed by `pnpm test`; the recorder is a "● Rec" button in development builds |
| 2.3 State machine | States idle, pan, pinch, page change in progress; during a page change other input is ignored; each gesture yields exactly one action. Pure TypeScript, tested with synthetic and recorded sequences | **Done:** `src/core/gestures.ts`, 20 tests; wired in with first-guess thresholds: swipe to turn, drag a zoomed page (finger or mouse), pinch to zoom around the fingers, one page per flick. Tuning, the page following the finger and double tap are step 2.4 |
| 2.4 Touch | Pinch centered between the fingers; pan when zoomed; swipe turns the page only past a distance **and** a velocity threshold, otherwise snaps back, with the page following the finger and a 150–250 ms slide; double tap: 2× on the tapped area, then back to fit; at the edge of a zoomed page a new swipe turns the page. Tuned on the phone | On Android: 50 swipes on `basic.cbz` without a double page turn; zoom stays under the fingers. **Done:** the page follows the finger and slides out (200 ms) or back; double tap in the middle of a fitted page zooms 2× on that point, anywhere on a zoomed page goes back to fit (taps on the sides of a fitted page still turn at once); pulling a zoomed page sideways past an edge already on screen turns it. Thresholds unchanged: they felt right on the phone. The new page appears once decoded; sliding it in needs preloading (M3). All seven touch trials passed on Android |
| 2.5 Mouse and keyboard | Wheel: one notch, one page, or vertical pan when zoomed; Ctrl+wheel: zoom on the cursor; double click like double tap; arrows and Page Up/Down pan a zoomed page, then turn at the edge | On Windows and Linux: read `basic.cbz` with the wheel, zoom on a detail with Ctrl+wheel. **Written, to try:** the wheel turns a page every 50 CSS px (a notch is about 100); on a zoomed page it scrolls, and turns the page only in a new burst of wheel events (after a 300 ms pause) that starts at the edge, like the swipe. Ctrl+wheel zooms 1.25× per notch on the cursor. Double click and the keys came with 2.4 and 2.1. **Done on Windows; WebKitGTK passes the same trial with simulated events** |
| 2.6 Trackpad | Two-finger scroll accumulates and turns the page past a threshold, then input is locked until the inertia dies out, telling inertia apart by the trend of the deltas; pinch as Ctrl+wheel on Chromium, from Rust through the GTK handler on Linux (from the `trackpad-pinch` spike) | On the Linux laptop: 50 flicks on `basic.cbz`, each turning exactly one page; pinch zooms without the whole window zooming. **Written, to try on the laptop:** a flick turns one page and its inertia is ignored until the steps grow again (a new flick), turn around, or stop for 300 ms; a stream that has had small steps is a trackpad, so a stall cannot make its big steps count as mouse notches (mouse notches still turn one page each). `src-tauri/src/pinch.rs` stops the GTK pinch before WebKitGTK zooms the page and sends begin / update / end with the scale and center to the page. On Windows, small Ctrl+wheel steps (under 50 px) zoom smoothly as a pinch would, per Chromium's documented behavior: not testable yet, no trackpad. Passing in WSL: Rust tests and clippy, and flicks plus pinch events sent through the page |
| 2.7 Options bar | **Changed after trying it on Windows.** First written as controls that float over the page and appear with a tap or click in the middle; the maintainer wants a bar that is always there, to hold the options to come, so that was removed. Now: the header is a bar of its own at the top, always visible (open a file, title and page number, room on the right for more options), and the page fills the rest. A tap in the middle does nothing again. What was first written: tap or click in the center shows and hides the header, so the page can use the whole screen | The page fills the screen; one tap brings the controls back. **Done in WSL, to try on Windows and the phone:** the header floats over the page (it hides after a file is opened) and a tap or click in the middle toggles it, after the 300 ms double tap time so a double tap never flashes it; on a zoomed page the middle toggles too and the sides do nothing; the page is never resized or decoded again by the toggle |
| 2.8 Milestone checklist | Concrete gesture actions on Windows, Linux and Android, including the requirement "no double skip in 50 consecutive swipes"; each failure becomes a recorded sequence and a regression test | **Written and run:** [checklists/m2.md](checklists/m2.md), 27 actions. Windows (real mouse, wheel and keys on the release build; touch emulated), Android (real taps and swipes with adb, 50 swipes with no double skip) and Linux in WSL (simulated events) pass; left: the laptop. The run found one bug, fixed: a fast mouse wheel spin turned only one page after 2.6 |

## M2.5 — CBR

Moved up from M5, before the reading modes: preloading and the memory budget in M3 depend on what a page costs in each format, and in a solid RAR archive a page can only be read after the ones before it. The [`cbr-library` spike](spikes/cbr-library.md) chose the `rars` crate (pure Rust, Apache-2.0). Same workflow as the other milestones: one step at a time, each with a way to try it.

| Step | Content | How to try it |
| --- | --- | --- |
| 2.5.1 Page source | The archive format is recognized from the file's first bytes, not from its extension (ZIP, RAR; anything else gets a clear message). The CBZ code moves behind a small interface in Rust ("an archive that lists its pages and reads one"), and `volume.rs` picks the implementation by format. No new format yet | **Done:** `format.rs` reads the first bytes (ZIP, RAR 4 and 5, 7z, anything else is tried as a ZIP, as a stub may come first); `archive.rs` has the `PageSource` interface, `cbz.rs` is the CBZ implementation and `volume.rs` picks by format; RAR and 7z files get a message saying they are not supported yet. 31 Rust tests; the M1 script on WebKitGTK still passes (one check of it is stale, it sends `click` events) |
| 2.5.2 CBR, not solid | `rars` behind that interface: RAR4 and RAR5, pages in natural order, non-images skipped, each page read on demand from a seekable file handle (a path on desktop, the file descriptor of the picker on Android). The picker offers `.cbr` files | **Done:** `rar.rs` reads RAR 4 and 5 through the `PageSource` interface (names with `` are normalized, so the macOS junk of a RAR 4 archive is still skipped); `rars` is added with only the reading features. The first three fixtures are in `tests/fixtures/` (RAR 5, RAR 4, RAR 5 stored, about 600 bytes each, made with WinRAR; see its README), 38 Rust tests, clippy clean, `cargo check` for Android arm64 from Windows passes. Solid archives already open but are slow (step 2.5.3). The picker has no file type filter, so it already offers `.cbr` |
| 2.5.3 Solid archives | A solid archive is read with one forward pass that keeps a bounded cache of decoded pages, instead of repeating all the work before each page. The first pages appear at once; a jump costs the pages in between, with a message while it works | **Done:** a solid archive keeps a window of decoded pages in memory (48 MB, the pages after the one asked for first, then those before); a page outside it costs one pass from the start of the archive that decodes the history and fills a new window around the page. The order the archive holds the pages in (`1, 10, 2`) is not the reading order, and the window is in the archive's. A "Loading page N…" message shows in the options bar when fetching a page takes more than 0.4 s. Fixtures: two solid archives of 12 tiny pages whose archive order differs from reading order; 48 Rust tests. On the Windows release app with a solid archive of 40 pages of 3 MB: 39 turns forward in 7.5 s in all (median 147 ms, 2 turns over 300 ms: the window refills, 1 s each), 15 turns back with none over 300 ms, a jump to the last page 1.2 s. Before, page N cost N pages: that run would have taken about 16 s of decoding alone. The pass runs on the thread that asked for the page, so for now a refill blocks the other requests; with M3's preloading it can move to a worker |
| 2.5.4 Limits and errors | Ceiling on the RAR5 dictionary (first guess 128 MB on desktop, 64 MB on mobile) and on member size; a password-protected file says it is not supported yet; truncated and damaged files give a clear message, and in a not solid archive a damaged page leaves the others readable | **Done:** reading is bounded: a RAR 5 dictionary above 128 MB (64 MB on Android and iOS) is refused when the file opens, and so is a page that unpacks to more than 256 MB. A password-protected archive says so when it opens, whether the names are encrypted or only the data; so does a file that ends too soon ("This archive is incomplete…"), and every error names its cause (password, checksum, limit, cut short) instead of showing the library's text. A damaged page in an archive that is not solid fails alone. In a solid archive the pages decoded before the damage stay readable, even when a pass was made for a page ahead of it, and the others say which page before them is damaged. Fixtures: two password-protected archives, a stored one with a damaged page, a compressed solid one with a damaged byte; 56 Rust tests. The check of the dictionary uses a lowered ceiling, because WinRAR shrinks the dictionary to the size of the data and no small file asks for a big one |
| 2.5.5 Corpus | Small CBR files made with WinRAR (RAR4 and RAR5, solid and not, stored, a damaged one, an encrypted one) are committed under `tests/fixtures/` for the Rust tests, a few KB each. `pnpm corpus` makes the large ones (`large` as CBR) when `rar` is on the PATH and skips them otherwise | `cargo test` reads every fixture; `pnpm corpus` still works without `rar` |
| 2.5.6 Milestone checklist | CBR actions on Windows, Linux and Android, including the maintainer's own CBR files; each failure becomes a corpus file and a test | Every cell of `checklists/m2-5.md` is ok |

## M2.6 — Navigation by hand

Two things asked for by the maintainer after trying the gesture engine on the desktop, small and independent of each other. They sit between M2.5 and M3 because the first one settles what the wheel and the arrows do on a zoomed page, which M3's vertical scroll mode builds on, and the slider is what makes jumping around a long book (and a big CBR) bearable before preloading arrives. Steps are written now in outline and detailed when the milestone starts; estimate: two or three days.

Moving a zoomed page by hand on the desktop, dragging it with the left mouse button, already works and needs no step: it is item 7 of the [M2 checklist](checklists/m2.md), together with Ctrl+wheel and the double click for zooming and the keys `+`, `-` and `0`.

| Step | Content | How to try it |
| --- | --- | --- |
| 2.6.1 A zoomed page stays put | While a page is zoomed, nothing but a deliberate jump changes it. The wheel only moves the page: up and down, and sideways with Shift or a horizontal wheel; however many notches, and however long a pause between them, it never turns the page, so the wheel cannot take you off a page you are looking at closely. The same for a trackpad's scroll. The four arrows move the page in the four directions, and also never turn it, at the edge or elsewhere; PageUp, PageDown and Space, which move it by almost a screen, the same. Today a new burst of wheel notches at the edge turns the page, and so do the arrows (M2's items 18 and 19 of the checklist say so, and are changed with this step); both rules go. Home and End still go to the first and last page: they are not movement keys. To change page from a zoomed one: leave the zoom (`0`, a double click), use the slider (2.6.2) or, on touch, swipe from the edge. At fit nothing changes | Zoom in on a page of `basic.cbz` and spin the wheel 40 notches down, then up, with pauses: the page scrolls to the bottom and to the top and stays the same page. Hold the four arrows down against every edge: the page moves, stops at the edge and does not turn |
| 2.6.2 Page slider | A slider to go to any page, in the options bar (or in a bar of its own at the bottom, as the design doc has it: decided when the step starts, together with how the bar looks on a phone), showing the page number and the total. Dragging shows the number it would go to and loads the page only when the pointer stops or is released, because in a solid archive every far jump costs a pass over the archive; the "Loading page…" message already covers the wait. It follows the page when other keys or gestures change it, works with a finger, and does not keep the keyboard focus, so Space and the arrows still do what they do. Previews of the pages come with the thumbnails of M4 | Drag the slider to page 15 of `basic.cbz`: page 15 shows; across the whole bar of `large-5-solid.rar`: only the last page is loaded, with the message while it works; the page counter and the slider always agree |

## M3 onwards

Detailed steps are written at the end of the previous milestone.

- **M2.5 — CBR:** moved here from M5, see its section above.
- **M2.6 — Navigation by hand:** a zoomed page that neither the wheel nor the arrows can turn, a page slider; see its section above.
- **M3 — Reading modes:** double page, vertical scroll, manga direction, preloading and memory budget.
- **M4 — Library:** cover grid, thumbnails, reading position in SQLite.
- **M5 — Formats and release:** image folders, release 0.1.
