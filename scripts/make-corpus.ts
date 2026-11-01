// Generates the synthetic test corpus in corpus/generated/. See corpus/README.md
// for what each volume is for. Run with `pnpm corpus`.
//
// Pages are drawn pixel by pixel, without fonts, so the output is identical on
// every machine: digits come from a built-in 5x7 bitmap font.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import sharp from 'sharp'

const OUT = join(import.meta.dirname, '..', 'corpus', 'generated')

// ---- Drawing ----------------------------------------------------------------

type Rgb = [number, number, number]

const BLACK: Rgb = [0, 0, 0]
const WHITE: Rgb = [255, 255, 255]

// 5x7 digits, one string per row
const DIGITS: Record<string, string[]> = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
}

/** An RGB image in memory, 3 bytes per pixel. */
class Canvas {
  readonly width: number
  readonly height: number
  readonly data: Uint8Array

  constructor(width: number, height: number, fill: Rgb = WHITE) {
    this.width = width
    this.height = height
    this.data = new Uint8Array(width * height * 3)
    this.rect(0, 0, width, height, fill)
  }

  rect(x: number, y: number, w: number, h: number, color: Rgb) {
    const [x0, y0] = [Math.max(x, 0), Math.max(y, 0)]
    const [x1, y1] = [Math.min(x + w, this.width), Math.min(y + h, this.height)]
    if (x1 <= x0 || y1 <= y0) return
    // Paint the first row, then copy it: much faster than pixel by pixel on big pages
    const start = (y0 * this.width + x0) * 3
    for (let col = 0; col < x1 - x0; col++) this.data.set(color, start + col * 3)
    const end = start + (x1 - x0) * 3
    for (let row = y0 + 1; row < y1; row++) {
      this.data.copyWithin((row * this.width + x0) * 3, start, end)
    }
  }

  /** Draws digits with each font pixel as a scale × scale square. Returns the width drawn. */
  text(digits: string, x: number, y: number, scale: number, color: Rgb) {
    for (const [i, digit] of [...digits].entries()) {
      DIGITS[digit].forEach((row, dy) => {
        for (let dx = 0; dx < 5; dx++) {
          if (row[dx] === '1')
            this.rect(x + (i * 6 + dx) * scale, y + dy * scale, scale, scale, color)
        }
      })
    }
    return (digits.length * 6 - 1) * scale
  }

  centeredText(digits: string, cx: number, cy: number, scale: number, color: Rgb) {
    const w = (digits.length * 6 - 1) * scale
    this.text(digits, Math.round(cx - w / 2), Math.round(cy - (7 * scale) / 2), scale, color)
  }

  /** 1 px black and white stripes: any blur or poor downscale turns them grey or moiré. */
  stripes(x: number, y: number, w: number, h: number, direction: 'vertical' | 'horizontal') {
    for (let row = y; row < y + h; row++) {
      for (let col = x; col < x + w; col++) {
        const dark = direction === 'vertical' ? col % 2 === 0 : row % 2 === 0
        this.data.set(dark ? BLACK : WHITE, (row * this.width + col) * 3)
      }
    }
  }

  /** Mixes deterministic noise into the image: makes JPEGs as heavy as real scans. */
  noise(amount: number, random: () => number) {
    for (let i = 0; i < this.data.length; i++) {
      const value = this.data[i] + (random() - 0.5) * amount
      this.data[i] = Math.max(0, Math.min(255, value))
    }
  }

  image() {
    return sharp(this.data, { raw: { width: this.width, height: this.height, channels: 3 } })
  }
}

/** Seeded random numbers (mulberry32), so every run produces the same files. */
function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---- Pages ------------------------------------------------------------------

const PAGE_W = 1988
const PAGE_H = 3056

const tint = (n: number): Rgb => [(n * 37) % 200, 200 - ((n * 37) % 200), (n * 91) % 200]

/** A comic-sized page: big page number, stripes and tiny digits that reveal quality loss. */
function comicPage(n: number, total: number, noise = 0) {
  const c = new Canvas(PAGE_W, PAGE_H, tint(n))
  c.rect(40, 40, PAGE_W - 80, PAGE_H - 80, WHITE)
  c.rect(40, 40, PAGE_W - 80, 12, BLACK)
  c.rect(40, PAGE_H - 52, PAGE_W - 80, 12, BLACK)
  c.rect(40, 40, 12, PAGE_H - 80, BLACK)
  c.rect(PAGE_W - 52, 40, 12, PAGE_H - 80, BLACK)

  // "n total" in the top corner, the big number in the middle
  const x = 100 + c.text(String(n), 100, 100, 8, BLACK) + 64
  c.text(String(total), x, 100, 8, [120, 120, 120])
  c.centeredText(String(n), PAGE_W / 2, PAGE_H / 2 - 400, 60, tint(n))

  c.stripes(120, PAGE_H - 1000, 800, 400, 'vertical')
  c.stripes(1068, PAGE_H - 1000, 800, 400, 'horizontal')

  // Tiny digits at 1 and 2 px per font pixel: unreadable as soon as quality drops
  for (let row = 0; row < 10; row++) {
    const line = String(n).padStart(3, '0') + '0123456789'.repeat(4)
    c.text(line, 120, PAGE_H - 540 + row * 10, 1, BLACK)
    c.text(line, 900, PAGE_H - 540 + row * 18, 2, BLACK)
  }

  if (noise) c.noise(noise, seeded(n))
  return c
}

const jpeg = (c: Canvas, quality = 90) => c.image().jpeg({ quality }).toBuffer()

// Quadrant colors of the format pages: a decoder that runs but gets colors
// wrong (e.g. an inverted CMYK JPEG) is caught by sampling these
const QUADRANTS: Rgb[] = [
  [220, 30, 30],
  [30, 180, 60],
  [30, 60, 220],
  [128, 128, 128],
]

function formatPage(n: number) {
  const w = 1200
  const h = 1800
  const c = new Canvas(w, h)
  QUADRANTS.forEach((color, i) =>
    c.rect((i % 2) * (w / 2), Math.floor(i / 2) * (h / 2), w / 2, h / 2, color),
  )
  c.rect(0, h / 2 - 110, w, 220, WHITE)
  c.centeredText(String(n), w / 2, h / 2, 20, BLACK)
  return c
}

/** 2400 × 3600 of 1 px stripes: a good downscale averages them into flat grey. */
function resizePage() {
  const c = new Canvas(2400, 3600)
  c.stripes(0, 0, 2400, 1680, 'vertical')
  c.stripes(0, 1920, 2400, 1680, 'horizontal')
  return c
}

// ---- Volumes ----------------------------------------------------------------

type Entries = Record<string, Uint8Array>

const COMIC_INFO = new TextEncoder().encode(
  '<?xml version="1.0"?>\n<ComicInfo><Title>gutter test volume</Title></ComicInfo>\n',
)

// Fixed timestamps, so the archives are byte-identical between runs
const zip = (entries: Entries) =>
  zipSync(entries, { level: 0, mtime: new Date('2026-01-01T00:00:00Z') })

async function comicPages(total: number, noise = 0) {
  const entries: Entries = {}
  for (let n = 1; n <= total; n++) {
    entries[`${String(n).padStart(3, '0')}.jpg`] = await jpeg(comicPage(n, total, noise))
  }
  return entries
}

const volumes: Record<string, () => Promise<Uint8Array>> = {
  // Everyday volume: 20 light pages and the files real CBZs carry along
  'basic.cbz': async () => zip({ 'ComicInfo.xml': COMIC_INFO, ...(await comicPages(20)) }),

  // ~100 MB, pages as heavy as real scans: for timing and memory
  'large.cbz': async () => zip(await comicPages(40, 120)),

  // One page per encoding, to check what each webview decodes
  'formats.cbz': async () => {
    const page = (n: number) => formatPage(n).image()
    return zip({
      '01-jpeg.jpg': await page(1).jpeg({ quality: 90 }).toBuffer(),
      '02-jpeg-progressive.jpg': await page(2).jpeg({ quality: 90, progressive: true }).toBuffer(),
      '03-jpeg-cmyk.jpg': await page(3).toColourspace('cmyk').jpeg({ quality: 90 }).toBuffer(),
      '04-png.png': await page(4).png().toBuffer(),
      '05-png-16bit-grey.png': await page(5).toColourspace('grey16').png().toBuffer(),
      '06-png-palette.png': await page(6).png({ palette: true, colours: 16 }).toBuffer(),
      '07-webp.webp': await page(7).webp({ quality: 90 }).toBuffer(),
      '08-webp-lossless.webp': await page(8).webp({ lossless: true }).toBuffer(),
      '09-avif.avif': await page(9).avif({ quality: 70 }).toBuffer(),
      '10-gif.gif': await page(10).gif().toBuffer(),
    })
  },

  // Downscaling quality, lossless and as a JPEG
  'resize.cbz': async () => {
    const page = resizePage()
    return zip({
      '01-stripes.png': await page.image().png().toBuffer(),
      '02-stripes.jpg': await jpeg(page, 95),
    })
  },

  // A 7000 × 10000 scan: 280 MB once decoded, more than the mobile budget
  'huge-page.cbz': async () => {
    const c = new Canvas(7000, 10000)
    for (let y = 0; y < 10000; y += 500) {
      for (let x = 0; x < 7000; x += 500) {
        c.rect(x, y, 500, 2, BLACK)
        c.rect(x, y, 2, 500, BLACK)
        c.text(`${y / 500}`, x + 20, y + 20, 6, [200, 0, 0])
        c.text(`${x / 500}`, x + 20, y + 80, 6, [0, 0, 200])
      }
    }
    c.stripes(3000, 4500, 1000, 1000, 'vertical')
    return zip({ '001.jpg': await jpeg(c), '002.jpg': await jpeg(comicPage(2, 2)) })
  },

  // A double-page spread between single pages: pages 5 and 6 are one image
  'spread.cbz': async () => {
    const entries: Entries = {}
    for (const n of [1, 2, 3, 4, 7, 8])
      entries[`${String(n).padStart(2, '0')}.jpg`] = await jpeg(comicPage(n, 8))
    const spread = new Canvas(PAGE_W * 2, PAGE_H)
    spread.rect(PAGE_W - 2, 0, 4, PAGE_H, BLACK)
    spread.centeredText('5', PAGE_W / 2, PAGE_H / 2, 60, tint(5))
    spread.centeredText('6', PAGE_W * 1.5, PAGE_H / 2, 60, tint(6))
    entries['05-06.jpg'] = await jpeg(spread)
    return zip(entries)
  },

  // Reading order must follow the numbers drawn on the pages (1 to 13), not
  // byte order: natural sort, mixed case extensions, spaces, accents, a
  // subfolder, and junk entries that are not pages
  'odd-names.cbz': async () => {
    const names = [
      ...Array.from({ length: 9 }, (_, i) => `page ${i + 1}.jpg`),
      'page 10.JPG',
      'page 11.jpeg',
      'page 12.png',
      'zz extra/pàgina è 13.jpg',
    ]
    const entries: Entries = {
      'ComicInfo.xml': COMIC_INFO,
      'Thumbs.db': new Uint8Array(64),
      '__MACOSX/._page 1.jpg': new Uint8Array(64),
      '._page 2.jpg': new Uint8Array(64),
    }
    // Stored in reverse, so archive order cannot pass for reading order
    for (const [i, name] of [...names.entries()].reverse()) {
      const page = comicPage(i + 1, names.length)
      entries[name] = name.endsWith('.png') ? await page.image().png().toBuffer() : await jpeg(page)
    }
    return zip(entries)
  },

  // Broken files: the reader must show a clear error, never crash
  'broken-page.cbz': async () => {
    const pages = await comicPages(3)
    pages['002.jpg'] = new TextEncoder().encode('this is not a JPEG')
    return zip(pages)
  },
  'truncated.cbz': async () => {
    const whole = zip(await comicPages(5))
    return whole.slice(0, Math.floor(whole.length * 0.6))
  },
  'not-a-zip.cbz': async () =>
    new TextEncoder().encode('This file has a .cbz name but is plain text.\n'),
  'no-pages.cbz': async () => zip({ 'ComicInfo.xml': COMIC_INFO, 'readme.txt': COMIC_INFO }),
}

// ---- Run --------------------------------------------------------------------

mkdirSync(OUT, { recursive: true })
for (const [name, make] of Object.entries(volumes)) {
  const t0 = performance.now()
  const bytes = await make()
  writeFileSync(join(OUT, name), bytes)
  const mb = (bytes.length / 1024 / 1024).toFixed(1).padStart(6)
  console.log(`${name.padEnd(18)} ${mb} MB  ${((performance.now() - t0) / 1000).toFixed(1)} s`)
}
console.log(`Written to ${OUT}`)
