# AGENTS.md

Instructions for coding agents working on gutter. Read this first, then [docs/design.md](docs/design.md) for the full rationale.

## Project

gutter is an open-source comic book reader for Windows, Linux, macOS, Android and iOS, built from a single codebase. Its reason to exist is doing the basics right: pages at full quality, predictable gestures, an interface that stays out of the way.

Not in scope for 0.1: online store or downloads, cloud sync, editing files, DRM.

## Stack

| Layer | Technology |
| --- | --- |
| App shell | Tauri 2 |
| UI | Svelte 5 + TypeScript, built with Vite |
| Native side | Rust (Tauri commands): filesystem, archives, thumbnails, database |
| Archives | `zip` crate for CBZ; `unrar` or libarchive for CBR (undecided) |
| Page delivery | Tauri custom protocol, e.g. `page://<volume>/<n>` |
| Image decoding | `createImageBitmap` in the webview; Rust `image` crate as fallback |
| Persistence | SQLite via Tauri plugin |
| Tests | Vitest (unit), Playwright (end-to-end) |

## Architecture

Three layers, each depending only on the one below:

1. **UI (Svelte):** Library and Reader screens. No business logic.
2. **Core (TypeScript):** decoding, cache, renderer, gesture engine, viewer state. Must not import from the UI, so it can be tested on its own.
3. **Native (Rust):** filesystem, archive reader, thumbnails, SQLite.

A page flows: Rust reads only the requested entry from the archive → served to the webview via the custom protocol → decoded to an `ImageBitmap` → cached → drawn by the renderer. Gestures go through the gesture engine, which updates the viewer state, which tells the renderer what to draw.

## Hard rules

These come from the project's goals. Do not break them without updating the design doc in the same change.

- **Never recompress or downscale pages for reading.** No JPEG re-encoding, no reduced-quality cache. Thumbnails exist only in the library.
- **Render at physical resolution:** CSS size × `devicePixelRatio` × zoom. After a zoom gesture ends, decode again from the original bytes; never upscale an already-reduced bitmap.
- **Never load a whole archive into JavaScript.** Rust reads the archive index and hands over one page at a time.
- **One gesture, one action.** A gesture either moves the view or changes the page, never both. All input goes through the gesture engine; per-platform differences live in small input adapters, not in the state machine.
- **Memory budget is in bytes, not pages** (width × height × 4 per bitmap). When short on memory, shrink the preload window, never the quality of the current page. Free bitmaps with `ImageBitmap.close()`.
- **Keep the main thread free:** extraction in Rust on worker threads, decoding asynchronous.

## Commands

Package manager is pnpm. Run everything from the repo root.

| Task | Command |
| --- | --- |
| Install dependencies | `pnpm install` |
| Run the app in development | `pnpm tauri dev` |
| Type check (TypeScript + Svelte) | `pnpm check` |
| Build desktop app and installers | `pnpm tauri build` |

Lint, tests and Android build are added in later M0 steps (see [docs/roadmap.md](docs/roadmap.md)).

## Layout

| Path | Content |
| --- | --- |
| `src/` | Frontend: Svelte UI and, later, the TypeScript core |
| `src-tauri/` | Native side: Rust crate, Tauri config, icons, capabilities |
| `docs/` | Design document, roadmap, spike reports |

The frontend is plain Svelte + Vite, not SvelteKit: the app has two screens and needs no router or server rendering.

## Workflow

Single maintainer, no pull requests: work lands directly on `main`. The plan, step by step, is in [docs/roadmap.md](docs/roadmap.md).

- **Never commit or push.** Make the change, then hand the maintainer a commit message, **what changes for the user** and **how to try it in under 5 minutes**. They commit and push.
- Small steps, one feature each.
- CI runs on every push to `main`: lint, type check, tests, build. A red CI is fixed before anything else.
- The maintainer validates behavior, not code. Prefer evidence they can check without reading code: test results, benchmark numbers against the targets in the design doc, before/after screenshots.
- A reported gesture bug becomes a recorded event sequence and a regression test.
- When a decision in the design doc turns out wrong, update `docs/design.md` in the same change and explain why in plain language.
- Update this file in the same change that alters architecture, commands or rules.

## Conventions

- English for code, comments, commits and docs.
- LF line endings (enforced by `.gitattributes`), formatting per `.editorconfig`.
