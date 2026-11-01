# Roadmap

How we get from an empty repo to release 0.1. Milestones and their rationale are in the [design document](design.md#roadmap-and-open-questions); this file breaks them into concrete steps.

## Workflow

gutter has a single maintainer, so there are no pull requests: work lands directly on `main`.

1. The agent makes the change in the working tree and runs it locally.
2. The agent hands over a commit message and a short manual checklist (how to try it in under 5 minutes).
3. The maintainer runs the checklist, commits and pushes.
4. CI runs on every push to `main`. A red CI is fixed before anything else.

Spikes (M0.5) live on throwaway branches named `spike/<name>` that are never merged; only their write-up in `docs/spikes/` lands on `main`.

## M0 — Skeleton

| Step | Content | How to try it |
| --- | --- | --- |
| 0.1 Scaffold | Tauri 2 + Svelte 5 + TypeScript + Vite with pnpm; an empty dark window | `pnpm tauri dev` opens the window |
| 0.2 Tooling | ESLint, Prettier, `svelte-check`, Vitest, clippy, rustfmt; one sample test per side; commands documented in `AGENTS.md` | `pnpm check` and `pnpm test` pass |
| 0.3 CI | GitHub Actions on every push: lint, type check, tests, build on Windows and Ubuntu | Green check next to the commit on GitHub |
| 0.4 Test corpus | Script that generates synthetic test CBZs (see below), plus one or two public-domain comics; an ignored `corpus/local/` folder for personal files | The script produces the files and they open in any reader |
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
| `resize-quality` | Does `createImageBitmap` with high-quality resize work on WebView2, WebKitGTK and Android? | **Done: no on WebKitGTK**, which ignores `resizeQuality`. Canvas in steps works everywhere; a startup self-test picks the method. See [spikes/resize-quality.md](spikes/resize-quality.md) |
| `image-formats` | Which image formats does each webview decode? | **Done**: common formats everywhere; AVIF fails on WebKitGTK, JPEG XL on WebView2. Rust fallback needed. See [spikes/image-formats.md](spikes/image-formats.md) |
| `trackpad-pinch` | Does trackpad pinch arrive as a usable event on Windows and Linux? | Prepares M2. Waiting for a Linux laptop with a trackpad: under WSL the trackpad arrives as a mouse |

## M1 onwards

Detailed steps are written at the end of M0.5, since spike results may change them.

- **M1 — Basic viewer:** open a CBZ, single page at full quality, keyboard and tap navigation, `<canvas>` vs `<img>` benchmark.
- **M2 — Gesture engine:** state machine, event recording and replay, tuning on Android.
- **M3 — Reading modes:** double page, vertical scroll, manga direction, preloading and memory budget.
- **M4 — Library:** cover grid, thumbnails, reading position in SQLite.
- **M5 — Formats and release:** CBR, image folders, release 0.1.
