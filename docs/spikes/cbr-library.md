# Spike `cbr-library` — Which library reads CBR files

**Question:** which RAR library should gutter use for CBR: the pure Rust `rars` crate, or bindings to UnRAR (`unrar-ng`)? It has to read a page without unpacking the whole archive, build on Windows, Linux and Android, and have a license compatible with an MIT project.

**Answer: `rars`.** Both libraries return exactly the same bytes for every page of every archive tried, so correctness is not what separates them. `rars` wins on the things that cannot be fixed later: it is pure Rust (builds for Android from a Windows machine with no setup, where the UnRAR bindings fail to build), it is Apache-2.0 (UnRAR's license is not open source) and it has limits for hostile files. It loses on speed in solid RAR5 archives (about 4 times slower) and it refuses to open a truncated archive at all, where UnRAR still reads the pages before the cut. Both costs are manageable, see the decision.

Date: 2026-11-13 · Code: a throwaway program outside the repository, steps to repeat it below

## Setup

| | Windows | Linux | Android |
| --- | --- | --- | --- |
| Device | Windows 11 PC | WSL, Ubuntu 26.04 | Motorola edge 60, MediaTek MT6878 (8 cores) |
| Build | `cargo build --release` | the same, in WSL | `--target aarch64-linux-android`, NDK 29, built on the Windows PC |
| Libraries | `rars` 0.12.4 and `unrar-ng` 0.7.7 | the same | `rars` only (see results) |

Test archives, made with the installed WinRAR 6.24 (`Rar.exe`) from the pages of the corpus files `basic.cbz` (20 pages of 225 KB, 4.4 MB) and `large.cbz` (40 noisy pages of 3 MB, 117 MB): RAR5 solid, RAR5 not solid, RAR5 stored, RAR4 solid, RAR4 not solid, all with `-m3`. Plus archives broken on purpose (truncated, bytes flipped, empty, garbage after a valid signature, a ZIP with a `.rar` name, header encryption, data-only encryption), and one real 91 MB CBR (RAR4, not solid, 55 pages) from the maintainer's downloads, read without modifying it.

## What the spike does

One operation per process, so time and memory are clean: open the archive and list it, or read the page at a given index and print its size and a hash. `rars`: `ArchiveReader::read_path`, then `read_member_at(index)`. `unrar-ng`: `open_for_processing`, `read_header`, `skip` over the entries before the one wanted, then `read`. The hashes of the pages from the two libraries, on the three platforms, are compared with each other.

To repeat it: extract a CBZ, then `Rar.exe a -r -ma5 -s -m3 out.rar .` (`-ma4` for RAR4, `-m0` for stored, no `-s` for not solid, `-hp<password>` or `-p<password>` for encryption).

## Results

**Correctness.** Every page, in every one of the 10 valid archives and the real CBR, gives the same hash with both libraries, on Windows and Linux; the phone gives the same hashes as Windows for `rars`.

**Time to read one page** (milliseconds, the page is 3 MB in `large`; the first page is the whole cost of opening):

| Archive | Page | `rars`, Windows | `unrar-ng`, Windows | `rars`, phone |
| --- | --- | --- | --- | --- |
| RAR5, not solid | any | 4.5 | 5 | 8 |
| RAR5, stored | any | 4.6 | 5 | — |
| RAR5, solid | 1st | 23 | 12 | 41 |
| RAR5, solid | 20th | 394 | 105 | 749 |
| RAR5, solid | 40th | 751 | 175 | 1483 |
| RAR4, solid | 1st | 25 | 22 | 54 |
| RAR4, solid | 20th | 424 | 376 | 919 |
| RAR4, solid | 40th | 796 | 714 | 1817 |

With `basic` (small pages) a not solid page takes 1 to 2 ms and the 20th page of a solid archive 9 ms, with both libraries. The real CBR (not solid): 12 to 15 ms per page, 1.6 MB each, with both.

**Peak memory** (Linux, one page of the 40th of `large`; the phone gives the same figures for `rars`):

| Archive | `rars` | `unrar-ng` |
| --- | --- | --- |
| RAR5, solid | 63 MB | 45 MB |
| RAR4, solid | 18 MB | 12 MB |
| not solid | 8 MB | 12 MB |

**Building.**

| | `rars` | `unrar-ng` |
| --- | --- | --- |
| Windows | builds | builds (compiles UnRAR's C++ with MSVC) |
| Linux (WSL) | builds | builds |
| Android arm64, from a Windows PC | **builds** in 37 s, runs on the phone | **fails** |

**Damaged and protected archives.** Neither library crashed: every failure was an error returned to the caller.

| Archive | `rars` | `unrar-ng` |
| --- | --- | --- |
| Truncated at 50 % | **cannot open it** (`TooShort`) | opens it, 10 pages of 21 can be read |
| Truncated at 60 % (RAR4 solid) | cannot open it | opens it, 11 of 21 readable |
| 40 bytes flipped in the middle (not solid) | only the damaged page fails (checksum), the other 20 are fine | the same |
| Empty file, or a ZIP with a `.rar` name | `UnsupportedSignature` | `Not a RAR archive` |
| Garbage after a valid signature | error when opening | opens with 0 files, error on reading |
| Password on the data only | lists fine, reading a page gives `NeedPassword` | the same (`MissingPassword`) |
| Password on the headers | cannot open: `NeedPassword` | opens with 0 files, error on reading |

## Findings

- **The cost of a solid archive is linear in the pages before the one wanted.** In RAR a solid archive is one compressed stream: page 40 can only be read after decoding the 39 before it. At 3 MB per page that is about 20 ms per page for `rars` on the PC and 40 ms on the phone; UnRAR is about 4 times faster on RAR5 and the same on RAR4. Real pages are smaller than these noisy ones, but JPEG does not compress, so the time is mostly proportional to bytes. A not solid archive costs the same as a CBZ page (a few milliseconds), so only solid files are a problem, and only for jumps and for the first page after a jump.
- **Both libraries return exactly the same bytes.** WinRAR, the reference compressor, wrote the archives; the two readers agree on all of them.
- **The UnRAR bindings cannot be built for Android from Windows.** Their `build.rs` picks the sources with `cfg!(windows)`, which describes the machine building, not the target, so it tries to compile `isnt.cpp`, a Windows-only file, for Android, and fails. The maintainer's setup is a Windows PC building for the phone. A Linux machine building for Android would pick the Unix sources and probably work (not tried). Working around it means patching or forking the crate.
- **`rars` is pure Rust,** so it builds with the same `cargo` command for every target, with no C++ compiler or NDK clang to set up, and it will do the same for iOS and macOS later.
- **Licenses.** `rars` is Apache-2.0. The UnRAR source that `unrar-ng` bundles is under the UnRAR license, which forbids using it to make a RAR-compatible compressor and is not an open source license; F-Droid treats apps bundling it as non-free (from the design doc, not checked here). It can be shipped, but it needs a notice and it rules out F-Droid and Linux distributions that accept only free software.
- **`rars` has limits for hostile files:** a ceiling on the dictionary size of a RAR5 archive (a RAR5 archive can ask for a 1 GB dictionary and the decoder has to allocate it), on the size of a member, on the headers and a way to cancel. They turn "the app runs out of memory" into "this archive is not supported". `unrar-ng` has no equivalent; it can only report that a dictionary is too large for the build.
- **`rars` is young and says so.** The crate was published in May 2026 (154 000 downloads, 100 000 of them in the last 90 days, last release 2026-11-05) by one author, started as an experiment in development with coding agents, and its README says it is slower than WinRAR, uses more memory and needs more testing at volume. It has no truncated-archive tolerance.
- **It does not read the whole file into memory:** `read_path` and `read_reader` (any `Read + Seek`, which fits a file handle from the Android picker) read the headers and then the payloads on demand. A 122 MB archive peaked at 8 MB.
- **Memory is set by the dictionary.** RAR5 archives written with WinRAR's default settings peak at about 60 MB, RAR4 (a 4 MB dictionary) at about 18 MB.

## Caveats

- **The pages are noisy JPEGs.** They are the worst case for time: real scans compress a little better and are smaller, so the solid figures are an upper bound. A real solid CBR was not available; the real one tested is not solid.
- **Only WinRAR 6.24 wrote the test archives.** Archives from other tools (older RAR versions, 7-Zip-compatible writers, `rars` itself) were not tried, nor multi-volume sets (`.part1.rar`), recovery records, or a solid archive with a damaged page (the damage will run on to the pages after it).
- **Windows and Linux numbers come from different machines** and from an unoptimized storage layer in WSL; compare the libraries within a column, not across columns.
- **`unrar-ng` on Android was not measured:** it does not build from this machine, so the phone only has `rars` numbers.
- **The sizes of the app** were not compared.

## Decision

Use **`rars`** for CBR. Reasons: it builds for every target with the plain `cargo` command, its license has no strings, it has the resource limits an app that opens files from the internet needs, and the two weaknesses can be handled:

- **Solid archives:** read them with one forward pass that keeps a bounded cache of the pages already decoded, instead of reading each page alone (which repeats all the work before it). Jumping far ahead costs the pages in between. This is also what M3's preloading needs to know: for a CBR a page has a cost that depends on where it is, so the preloader must treat solid archives as a sequence.
- **Truncated archives:** `rars` gives an error and no pages, where the principle "damaged file: clear message, the rest stays readable" would want the readable pages. Accepted for 0.1, with a clear message. If it turns out to matter in practice, `unrar-ng` can come back as an optional feature behind a common interface, for builds that are not meant for F-Droid.

The RAR5 dictionary limit is set from the memory budget (a first guess: 128 MB on the desktop, 64 MB on mobile), and password-protected archives show a message saying they are not supported yet. The format is recognized from the first bytes of the file, not from the extension: a file that says `.cbr` and contains a ZIP opens as a ZIP.
