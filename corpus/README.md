# Test corpus

Comics to develop and test gutter with. Copyrighted comics never go in the repo, so this folder holds only this file: everything else is generated or local, and ignored by git.

| Folder | Content |
| --- | --- |
| `generated/` | Synthetic volumes made by `pnpm corpus` (source: [scripts/make-corpus.ts](../scripts/make-corpus.ts)) |
| `local/` | Your own files: personal comics and public-domain comics. Never committed |

## Generated volumes

Run `pnpm corpus` from the repo root. The output is the same on every machine and every run, since pages are drawn without fonts and noise is seeded.

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

## Real comics

Synthetic pages show defects clearly but don't look like comics. For real pages, put files in `local/`:

- **Public domain:** many Golden Age comics (US, 1930s–1950s) entered the public domain because their copyright was never renewed. They are free to download from archives like [Digital Comic Museum](https://digitalcomicmuseum.com) or [Comic Book Plus](https://comicbookplus.com). One or two volumes are enough.
- **Personal:** your own CBZ and CBR files, to test real scans. They stay on your machine.
