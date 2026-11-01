# gutter

A fast, open-source comic book reader for desktop and mobile that never degrades your pages.

> **Status:** early development. There is nothing to install yet.

## Why

Free comic readers tend to blur pages, fight you on zoom and scroll, skip pages on a trackpad flick, and look dated. gutter aims to fix exactly that:

- **The page comes first.** While reading, only the comic is on screen; controls appear when you ask for them.
- **No quality loss.** Pages are always rendered at the screen's physical resolution, and re-rendered sharp after zooming.
- **Predictable gestures.** One gesture does one thing. No accidental page turns.
- **Lightweight.** Fast startup, low memory, small installer.
- **One codebase** for Windows, Linux, macOS, Android and iOS.

## Planned features

- CBZ, CBR and image folders (JPEG, PNG, WebP, AVIF)
- Single page, double page and vertical scroll (webtoon) modes
- Left-to-right and right-to-left (manga) reading
- Library with covers and saved reading position

Built with [Tauri 2](https://tauri.app), [Svelte 5](https://svelte.dev), TypeScript and Rust. See the [design document](docs/design.md) for the full plan.

## Development

See [docs/setup.md](docs/setup.md) to set up Windows, Linux or Android and run the app.

## License

[MIT](LICENSE)
