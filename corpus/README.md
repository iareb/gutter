# Test corpus

Comics to develop and test gutter with. Copyrighted comics never go in the repo, so this folder holds only this file: everything else is generated or local, and ignored by git.

| Folder | Content |
| --- | --- |
| `generated/` | Synthetic volumes made by `pnpm corpus` (source: [scripts/make-corpus.ts](../scripts/make-corpus.ts)) |
| `local/` | Your own files: personal comics and public-domain comics. Never committed |

## Generated volumes

Run `pnpm corpus` from the repo root. The output is the same on every run, since pages are drawn without fonts and noise is seeded, and the same on Windows and Linux except for `formats.cbz`, whose encoders (AVIF, WebP) come out differently in each platform's build of `sharp`. The CBR volumes that are made with `rar` are the same bytes on every run of the same `rar`, except the two with a password, which carry a random salt.

| File | What it contains | What it tests |
| --- | --- | --- |
| `basic.cbz` | 20 comic-sized pages (1988 × 3056 JPEG) and a `ComicInfo.xml` | Everyday reading. Each page shows its number large and in the top corner (with the total), 1 px stripes and tiny digits at 1 and 2 px per font pixel |
| `large.cbz` | 40 pages like `basic`, with noise so each JPEG weighs like a real scan; about 120 MB | Opening and page-change times, memory |
| `formats.cbz` | One 1200 × 1800 picture per encoding: JPEG baseline, progressive, CMYK; PNG RGB, 16 bit grey, palette; WebP lossy and lossless; AVIF; GIF | What each webview decodes. Four flat quadrants (red, green, blue, grey) let a test check decoded colors, not only failures. Two pages do not keep those colors, because of how `sharp` writes them: CMYK goes through a color profile that the file does not carry, and 16 bit grey uses linear luminance. Compare them across webviews, not with the other pages |
| `resize.cbz` | 2400 × 3600 of 1 px stripes, as PNG and JPEG | Downscaling quality: a good downscale turns stripes into flat grey, a poor one leaves moire |
| `huge-page.cbz` | A 7000 × 10000 page with a numbered 500 px grid, then a normal page | Pages larger than the memory budget (280 MB decoded): tiled rendering, zoom position |
| `spread.cbz` | Pages 1–4, a double-width image holding pages 5 and 6, pages 7–8 | Double-page spreads in single and double page modes |
| `odd-names.cbz` | 13 pages named `page 1.jpg` … `page 10.JPG`, `page 11.jpeg`, `page 12.png`, `zz extra/pàgina è 13.jpg`, stored in reverse order, plus `Thumbs.db`, `ComicInfo.xml` and macOS junk (`__MACOSX/`, `._*`) | Reading order: the pages must show 1 to 13 in order. Natural sort, mixed-case extensions, spaces, accents, subfolders, non-page entries |
| `broken-page.cbz` | 3 pages, the second is text named `002.jpg` | A clear error on one page, the others still readable |
| `truncated.cbz` | A 5-page volume cut at 60% | Damaged archive: clear error, no crash |
| `not-a-zip.cbz` | Plain text with a `.cbz` name | Wrong file type: clear error |
| `no-pages.cbz` | A valid ZIP with only text files | Empty volume: clear message |

## CBR volumes

CBR files are RAR archives, and RAR can only be written with the `rar` command line, which is not free software and is not in this repo. `pnpm corpus` looks for it in the `RAR` environment variable, on the PATH, and in WinRAR's folder on Windows. Without it, the volumes below that need it are skipped, with a message that lists them, and everything else is made as usual. Install it with WinRAR, or with the `rar` package of the distribution. `not-a-rar.cbr`, `not-yet.cb7` and `zip-as-cbr.cbr` need no archiver.

Tiny CBR files for the Rust tests are committed instead, in [tests/fixtures](../tests/fixtures/README.md), so `cargo test` needs no `rar`.

| File | What it contains | What it tests |
| --- | --- | --- |
| `basic-rar5.cbr`, `basic-rar4.cbr` | The pages of `basic.cbz` (20 pages and a `ComicInfo.xml`) in RAR 5 and in RAR 4, not solid | Reading CBR: the same 20 pages, in order, as the CBZ |
| `basic-solid.cbr` | The same, RAR 5 and solid | A solid archive: in one pass, each page decoded after the ones before it |
| `large-rar5.cbr` | The 40 heavy pages of `large.cbz`, about 120 MB | Opening and page-change times of a big CBR, memory |
| `large-solid.cbr` | The same, RAR 5 and solid | The window of decoded pages: turning forward, back, and jumping to the last page (about a second, with "Loading page…" shown) |
| `truncated.cbr` | A 5-page RAR 5 cut at 60% | "This archive is incomplete…", no crash |
| `password.cbr` | 3 pages encrypted with the password `secret` | "This archive is password-protected, and gutter cannot open those yet." |
| `password-names.cbr` | The same, with the names encrypted too | The same message: a different failure inside |
| `damaged-page.cbr` | 3 pages stored without compression, with a byte of the second flipped | Page 2 says it is damaged; pages 1 and 3 read |
| `not-a-rar.cbr` | A RAR signature followed by nothing that makes sense | "This file is not a CBR archive, or it is damaged…" |
| `not-yet.cb7` | A 7z signature and zeros | "CB7 files (7z archives) are not supported yet.": CB7 comes after 0.1 |
| `zip-as-cbr.cbr` | `basic.cbz` with a `.cbr` name | The format comes from the contents: it opens as a CBZ |

## Real comics

Synthetic pages show defects clearly but don't look like comics. For real pages, put files in `local/`:

- **Public domain:** many Golden Age comics (US, 1930s–1950s) entered the public domain because their copyright was never renewed. They are free to download from archives like [Digital Comic Museum](https://digitalcomicmuseum.com) or [Comic Book Plus](https://comicbookplus.com). One or two volumes are enough.
- **Personal:** your own CBZ and CBR files, to test real scans. They stay on your machine.
