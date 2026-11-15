# Test fixtures

Small archives that the Rust tests read (`cargo test`). They are committed because the large test files in `corpus/generated/` are made by a script, and the script cannot make RAR archives without WinRAR's `rar`, which is not free software. These were made once with it.

Everything is synthetic: each page is a solid-color PNG of 8 × 12 pixels, so the archives are about 600 bytes.

| File | What it is |
| --- | --- |
| `pages/page 1.png`, `page 2.png`, `page 10.png` | The three pages, red, green and blue. The tests compare what is read from an archive with these files byte for byte. The names are chosen so that reading order (2 before 10) differs from alphabetical order |
| `pages-rar5.cbr` | RAR 5, not solid, compressed. Holds the three pages, a `ComicInfo.xml`, and a `__MACOSX/._page 1.png`; only the pages must show up |
| `pages-rar4.cbr` | The same in RAR 4 (the entry names use `\`, as WinRAR writes them on Windows) |
| `pages-rar5-store.cbr` | The same in RAR 5, stored without compression |
| `pages-12/1.png` to `12.png` | Twelve pages of different widths, so of different sizes. Their names sort differently as text (`1, 10, 11, 12, 2`) than as numbers |
| `solid-rar5.cbr`, `solid-rar4.cbr` | The twelve pages and a `ComicInfo.xml` in a solid archive, in RAR 5 and RAR 4. WinRAR stores them in text order, so the order a pass decodes them in is not the reading order |

## How they were made

With WinRAR 6.24, from a folder holding the files listed above (with `__MACOSX/` as a subfolder):

```bash
Rar.exe a -r -ma5 -m3 pages-rar5.cbr .
Rar.exe a -r -ma4 -m3 pages-rar4.cbr .
Rar.exe a -r -ma5 -m0 pages-rar5-store.cbr .
Rar.exe a -r -s -ma5 -m3 solid-rar5.cbr .   # from the folder with the twelve pages
Rar.exe a -r -s -ma4 -m3 solid-rar4.cbr .
```

`-ma5` and `-ma4` choose the RAR version, `-m3` the normal compression, `-m0` storing and `-s` a solid archive. Encrypted ones (`-p<password>`, or `-hp<password>` to encrypt the headers too) and damaged ones come with the later steps of M2.5.
