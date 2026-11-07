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
| M2 — Gesture engine | Next: steps below |

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
| 2.1 Zoomed rendering | Viewer state: page, zoom, offset. A zoomed page is decoded again at the zoom's physical resolution (never above the original) and only the visible part is drawn, still 1:1; the offset is clamped so the page never leaves the screen. Driven by temporary keys (+, −, arrows) until the gestures exist | `basic.cbz` at 200% and 400%: the tiny digits get sharper, never blurrier; panning stops at the edges |
| 2.2 Events, recording, replay | Normalized input events (pointer, wheel, key, pinch) with timestamps; adapters from the webview's events; a development-only recorder that saves a gesture to a file; Vitest replays recordings into the engine | A recorded swipe replayed in `pnpm test` gives the same result every time |
| 2.3 State machine | States idle, pan, pinch, page change in progress; during a page change other input is ignored; each gesture yields exactly one action. Pure TypeScript, tested with synthetic and recorded sequences | `pnpm test`: a swipe that turns a page cannot also pan, and vice versa |
| 2.4 Touch | Pinch centered between the fingers; pan when zoomed; swipe turns the page only past a distance **and** a velocity threshold, otherwise snaps back, with the page following the finger and a 150–250 ms slide; double tap: 2× on the tapped area, then back to fit; at the edge of a zoomed page a new swipe turns the page. Tuned on the phone | On Android: 50 swipes on `basic.cbz` without a double page turn; zoom stays under the fingers |
| 2.5 Mouse and keyboard | Wheel: one notch, one page, or vertical pan when zoomed; Ctrl+wheel: zoom on the cursor; double click like double tap; arrows and Page Up/Down pan a zoomed page, then turn at the edge | On Windows and Linux: read `basic.cbz` with the wheel, zoom on a detail with Ctrl+wheel |
| 2.6 Trackpad | Two-finger scroll accumulates and turns the page past a threshold, then input is locked until the inertia dies out, telling inertia apart by the trend of the deltas; pinch as Ctrl+wheel on Chromium, from Rust through the GTK handler on Linux (from the `trackpad-pinch` spike) | On the Linux laptop: 50 flicks on `basic.cbz`, each turning exactly one page; pinch zooms without the whole window zooming |
| 2.7 Controls on demand | Tap or click in the center shows and hides the header, so the page can use the whole screen | The page fills the screen; one tap brings the controls back |
| 2.8 Milestone checklist | Concrete gesture actions on Windows, Linux and Android, including the requirement "no double skip in 50 consecutive swipes"; each failure becomes a recorded sequence and a regression test | Every cell of `checklists/m2.md` is ok |

## M3 onwards

Detailed steps are written at the end of the previous milestone.

- **M3 — Reading modes:** double page, vertical scroll, manga direction, preloading and memory budget.
- **M4 — Library:** cover grid, thumbnails, reading position in SQLite.
- **M5 — Formats and release:** CBR, image folders, release 0.1.
