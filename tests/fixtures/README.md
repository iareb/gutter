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
| `password-rar5.cbr`, `password-headers-rar5.cbr` | The three pages of `pages-rar5.cbr` protected with the password `secret`: the first only encrypts the data, the second the names too |
| `damaged-page-rar5.cbr` | `pages-rar5-store.cbr` with a byte of `page 2.png` flipped. Only that page fails; the others read fine |
| `damaged-solid-rar5.cbr` | `solid-rar5.cbr` with one byte of the compressed data flipped, inside `12.png`: the pages before it in the archive (1, 10, 11) read, 12 is damaged and 2 to 9, decoded after it, are lost |

## How they were made

With WinRAR 6.24, from a folder holding the files listed above (with `__MACOSX/` as a subfolder):

```bash
Rar.exe a -r -ma5 -m3 pages-rar5.cbr .
Rar.exe a -r -ma4 -m3 pages-rar4.cbr .
Rar.exe a -r -ma5 -m0 pages-rar5-store.cbr .
Rar.exe a -r -s -ma5 -m3 solid-rar5.cbr .   # from the folder with the twelve pages
Rar.exe a -r -s -ma4 -m3 solid-rar4.cbr .
Rar.exe a -r -ma5 -m3 -psecret password-rar5.cbr .         # from the folder of the three pages
Rar.exe a -r -ma5 -m3 -hpsecret password-headers-rar5.cbr .
```

`-ma5` and `-ma4` choose the RAR version, `-m3` the normal compression, `-m0` storing and `-s` a solid archive. `-p<password>` encrypts the data and `-hp<password>` the names too. The damaged ones are copies of the others with one byte flipped by a small script, at an offset found by trying: inside the stored data of the page for the first, inside the compressed data for the second (byte 521 of `solid-rar5.cbr`).
