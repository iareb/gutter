# Spike: what a page costs (M3 step 3.1)

Question: where does the memory of the viewer go, what can the viewer do about it, and what should the page cache hold? Measured on the Windows release build (WebView2), on the phone (Motorola edge 60, Android System WebView, debug APK) and, for behavior, on Linux in WSL (WebKitGTK). Volumes: `large.cbz` (40 pages of 1988 × 3056, 3 MB each, 116 MB), `huge-page.cbz`, `basic.cbz`. The numbers come from the development overlay (`localStorage.gutter.stats = 1`, or any development build), `dumpsys meminfo` on the phone and the private memory of the `msedgewebview2` processes on Windows.

## What was found

**1. The decoded page is not the cost; the way it is made is.** A page decoded at screen size is 4 bytes a pixel (4 to 12 MB). But making it drew the page at full size (24 MB here) on an accelerated canvas, which uploads it to the graphics memory as a texture; that memory is kept for a long time and the next decode adds another.

| Phone, 30 decodes of one page | Total PSS before → at the peak | Time per page |
| --- | --- | --- |
| Accelerated canvas (what M2 did) | 366 → 539 MB (+173) | 124 ms |
| Canvas in main memory (`willReadFrequently`) | 363 → 363 MB (+0) | 136 ms in this test, 700 ms with `imageSmoothingQuality = 'high'` as the viewer sets it |
| `createImageBitmap` with `resizeWidth`/`resizeHeight`, quality low | 362 → 362 MB (+0) | 126 ms |
| The same, quality high | 374 → 374 MB (+0) | 225 ms |

On Windows the same shows in the graphics process: 16 pages made on an accelerated canvas took it from 167 to 664 MB, and it went on to 767 MB after they were closed; on a canvas in main memory the 16 bitmaps took 100 MB of the renderer and were released when closed.

The last two rows are not an option: `createImageBitmap` with resize options is what the resize-quality spike rejected (WebKitGTK ignores the quality, Chromium leaves moiré at common ratios). The choice is between the first two rows, and it is a trade between memory and time: the canvas in main memory is about 6 times slower on the phone (0.7 s against 0.1 s with the high-quality filter), and on Windows it is not slower. Its output is not identical to the accelerated one: on a noisy test page the two differ by 0.85 / 255 on average and 18 at most, and the main-memory one has about 8 % more edge energy, so it is not blurrier.

**Decision:** every page is made on a canvas in main memory. A first version kept the accelerated canvas for the page the reader is waiting for and used main memory only for the pages made in advance; it held while reading at an even pace, but not over a longer session. A session on the phone of 6 slider jumps and 30 taps 0.15 s apart over `large.cbz` and `basic-rar5.cbr`, each way in a freshly started app (idle 174 to 179 MB):

| Phone, the same session | Peak | At the end | 10 s later | A page not ready takes |
| --- | --- | --- | --- | --- |
| Accelerated canvas for every page | 856 MB | 455 MB | 444 MB | 0.04 to 0.16 s |
| Accelerated for the page waited for, main memory in advance | 774 MB | 386 MB | 378 MB | 0.04 to 0.16 s, some 0.65 s |
| Main memory for every page (chosen) | 334 MB | 248 MB | 222 MB | about 0.7 s |

The price is on the phone: a page that is not ready yet (the first one after opening, a jump, flipping faster than the preloading) takes about 0.7 s instead of 0.1 s; "Loading page…" shows after 0.4 s. On Windows there is no price: the first page of `large.cbz` takes 75 to 96 ms. A page made in advance and one made on demand are now the same pixels. Making the downscale itself faster (in Rust, or with a cheaper filter checked against the resize-quality spike) is what would remove the price; it is not part of M3.

**2. `close()` matters.** 16 full-size bitmaps dropped without `close()` were still held 3 s later (403 MB in the renderer); closed, they were gone (31 MB). The page store closes every bitmap it drops, 0.3 s after, because the viewer may be drawing it at that moment.

**3. A Worker with an OffscreenCanvas does not help.** It is available on the two Chromium webviews tried (WebView2 and Android System WebView); WebKitGTK was not tried. Decoding 10 pages: main thread 70 ms each with a longest frame of 12 to 16 ms on Windows; Worker 72 to 82 ms each with a longest frame of 9 to 92 ms. On the phone, 8 pages: main thread 133 to 142 ms and a longest frame of 46 ms; Worker 120 to 131 ms and 59 to 127 ms. The work is the decode of the whole page, which the browser already does off the main thread; moving the downscale does not remove a stall. The main thread stays.

**4. A huge page costs the graphics memory, and tiles would not fix that here.** `huge-page.cbz` (7000 × 10000) on Windows, in a freshly started app with every page made in main memory: the webview takes 176 MB with a small volume open, 189 MB with the huge page fitted, 451 MB at the highest zoom and 887 MB after fitting again (graphics process 87 → 98 → 277 → 797 MB). Making the page is no longer the cost; showing it is: at the highest zoom the decoded page is 93 MB, and drawing it on the screen's canvas uploads it to the graphics memory, which keeps it. Cutting the page into tiles with `createImageBitmap(blob, x, y, w, h)` still decodes the whole image first, so the peak stays; a decode of one region would have to be done in Rust. The cache never drops the page on screen, so such a page can take the cache over its budget, but the viewer keeps working (checklist item 26 of M2 passes). **Step 3.9 is dropped from M3**; a region decode in Rust is noted after 0.1.

## What the viewer holds now

- Encoded pages (3 MB each here) are kept as long as the budget allows; they are cheap to keep and a page in a solid archive is expensive to ask for again.
- Decoded pages (4 bytes a pixel) are kept for the current page, two behind it and three ahead (`KEEP_DECODED`), and made in advance for two ahead and one behind (`PRELOAD`, the other way round after going back). Farther ones are closed.
- The budget (`defaultBudget`) is 192 MB on a computer and 96 MB on a phone. It counts the encoded bytes and 4 bytes a pixel for each bitmap. On the phone a window of six bitmaps is 64 MB. The farthest page goes first; the page on screen never goes.

## Results with that

| | Before (M2.6) | Now |
| --- | --- | --- |
| Page change, next page (phone) | 0.35 to 0.6 s | 0.5 to 0.9 ms when ready: 22 of 24 turns (taps 1 s and 0.25 s apart) |
| Page change, next page (Windows) | 0.15 s | 0.1 to 1 ms (ready 60 of 60 for the two CBZ volumes; 26 of 30 for the solid CBR, where flipping every 0.12 s outruns the pass over the archive) |
| First page after opening, a jump, a page not ready yet (phone) | 0.1 s | about 0.7 s |
| Phone, total PSS while reading `large.cbz` | 364 to 584 MB (idle app 172 MB) | 235 to 305 MB (graphics 74 to 101 MB) |
| Phone, a session of jumps and fast flipping over two volumes | not measured | 334 MB at the peak, 222 MB after (idle 179 MB) |
| Windows, webview while reading `large.cbz` | about 430 MB (after the M1 checklist) | 310 to 314 MB (idle app 150 MB) |

The design's targets (viewer below 300 MB on a computer and 150 MB on a phone) did not count the webview itself, which takes 148 MB (computer) and 172 MB (phone) with no page open. They are restated as memory above the idle app while reading a 116 MB volume: computer below 200 MB (now +164), phone below 150 MB (now +63 to +133 while reading, +155 at the peak of the fast session).

Not measured: the phone with `huge-page.cbz`, and a computer with a 4K screen (a bitmap there is 4 times bigger; the budget then holds fewer pages ahead and `canHold` skips what does not fit).
