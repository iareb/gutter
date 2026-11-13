# gutter

A fast, open-source comic book reader for desktop and mobile that never degrades your pages.

> **Status:** early development. The viewer, with zoom and gestures, works on Windows, Linux and Android, but there is no release to install yet: [build it from source](docs/setup.md). Progress is tracked in the [roadmap](docs/roadmap.md).

## Why

Free comic readers tend to blur pages, fight you on zoom and scroll, skip pages on a trackpad flick, and look dated. gutter aims to fix exactly that:

- **The page comes first.** While reading, the screen holds the comic and a slim options bar, nothing else.
- **No quality loss.** Pages are always rendered at the screen's physical resolution, and re-rendered sharp after zooming.
- **Predictable gestures.** One gesture does one thing. No accidental page turns.
- **Lightweight.** Fast startup, low memory, small installer.
- **One codebase** for Windows, Linux, macOS, Android and iOS.

## What works today

- Open a CBZ file with the system file picker, on desktop and Android
- One page at a time, at the screen's physical resolution: pages are downscaled in steps so fine patterns and screentones don't turn into moire, and drawn one image pixel per screen pixel
- Pages redrawn sharp when the window is resized or the phone rotated
- Turn pages with the arrow keys, Page Up/Down, Space, Home and End, or by tapping or clicking the left and right side of the page
- Zoom up to 8× and pan: pinch, double tap or double click, Ctrl+wheel, keys `+` `-` `0`; the page is redrawn sharp at every zoom
- Swipe to turn the page (it follows your finger), one page per mouse notch and one per trackpad flick, even with its inertia
- Pages in natural order (`page 2` before `page 10`), junk files skipped
- JPEG, PNG, WebP and AVIF pages; AVIF is decoded in Rust where the system webview can't (Linux)
- Clear messages for damaged files and pages, while the rest of the comic stays readable

## Planned features

- Zoom and pan with pinch, double tap and trackpad, with gestures that never turn a page by accident

- CBZ, CBR and image folders (JPEG, PNG, WebP, AVIF)
- Single page, double page and vertical scroll (webtoon) modes
- Left-to-right and right-to-left (manga) reading
- Preloading of the pages around the current one, within a memory limit
- Library with covers and saved reading position

Built with [Tauri 2](https://tauri.app), [Svelte 5](https://svelte.dev), TypeScript and Rust. See the [design document](docs/design.md) for the full plan.

## Development

See [docs/setup.md](docs/setup.md) to set up Windows, Linux or Android and run the app.

## License

[MIT](LICENSE)
