import { Cache } from './cache'
import type { Size } from './fit'
import type { PageData } from './volume'

/** What the store needs from the outside: fetching and decoding (replaced by fakes in tests). */
export type Loaders = {
  /** The encoded page, as Rust serves it. */
  load(n: number): Promise<PageData>
  /** The page decoded by Rust and converted to PNG, for when the webview cannot decode it. */
  convert(n: number): Promise<PageData>
  /** Decodes at exactly `target` pixels. */
  decode(blob: Blob, target: Size): Promise<ImageBitmap>
  /** The size of an image the webview can decode, or undefined when it cannot. */
  probe(blob: Blob): Promise<Size | undefined>
}

type Item = { kind: 'data'; data: PageData } | { kind: 'bitmap'; bitmap: ImageBitmap }

/** How a bitmap is counted against the budget: 4 bytes a pixel. */
export const bitmapBytes = (size: Size) => size.width * size.height * 4

const dataKey = (n: number) => `d${n}`
const bitmapKey = (n: number, t: Size) => `b${n}:${t.width}x${t.height}`

/** The pages around the current one that are kept ready: how many ahead and how many behind. */
export const PRELOAD = { ahead: 2, behind: 1 }

/** Decoded pages farther than this from the current one are dropped; their encoded bytes stay while the budget allows. */
export const KEEP_DECODED = { ahead: 3, behind: 2 }

/** How long a gesture keeps the preloading waiting, after its last event. */
const BUSY_MS = 250
/** A bitmap that left the cache is closed a moment later: the viewer may still be drawing it. */
const CLOSE_DELAY_MS = 300

/** What the development overlay shows. */
export type Snapshot = {
  budget: number
  used: number
  entries: number
  bitmaps: number
  /** Bitmaps made and closed since the volume was opened: the difference is what is alive. */
  made: number
  closed: number
  hits: number
  misses: number
  /** The last page change: milliseconds until the page was drawn, and whether it was ready. */
  turn?: { page: number; ms: number; ready: boolean }
  /** Milliseconds the last fetch and decode of each kind took. */
  fetchMs?: number
  decodeMs?: number
  /** Bytes held for each page. */
  pages: [number, number][]
}

/**
 * Everything the viewer knows about the pages of one volume: encoded bytes,
 * sizes and decoded bitmaps, within a budget, and the preloading of the pages
 * around the one being read. The cache owns the bitmaps: the viewer never closes
 * one.
 */
export class PageStore {
  private cache: Cache<Item>
  private sizes = new Map<number, Size>()
  private fetching = new Map<number, Promise<PageData>>()
  private decoding = new Map<string, Promise<ImageBitmap>>()
  private measuring = new Map<number, Promise<Size>>()
  private generation = 0
  private busyUntil = 0
  private current = 0
  private bitmapCount = 0
  private made = 0
  private closed = 0
  private hits = 0
  private misses = 0
  private lastFetchMs?: number
  private lastDecodeMs?: number
  turn?: Snapshot['turn']

  constructor(
    private loaders: Loaders,
    budget: number,
  ) {
    this.cache = new Cache<Item>(budget, (item) => this.release(item))
  }

  private release(item: Item) {
    if (item.kind !== 'bitmap') return
    this.bitmapCount--
    setTimeout(() => {
      item.bitmap.close()
      this.closed++
    }, CLOSE_DELAY_MS)
  }

  /** Drops everything: the volume was closed. A running preload stops. */
  dispose() {
    this.generation++
    this.cache.clear()
  }

  setBudget(bytes: number) {
    this.cache.setBudget(bytes)
  }

  /** The reader is busy with a gesture: preloading waits. */
  busy() {
    this.busyUntil = performance.now() + BUSY_MS
  }

  setCurrent(n: number) {
    this.current = n
    this.cache.setCurrent(n)
    this.pruneBitmaps()
  }

  private pruneBitmaps() {
    for (const [key, page] of this.cache.all()) {
      const d = page - this.current
      if (key.startsWith('b') && (d > KEEP_DECODED.ahead || -d > KEEP_DECODED.behind))
        this.cache.delete(key)
    }
  }

  peekSize(n: number): Size | undefined {
    return this.sizes.get(n)
  }

  /** The decoded page if it is ready right now. */
  peek(n: number, target: Size): ImageBitmap | undefined {
    const item = this.cache.get(bitmapKey(n, target))
    if (item?.kind === 'bitmap') {
      this.hits++
      return item.bitmap
    }
    this.misses++
    return undefined
  }

  /** The encoded page: from the cache, or fetched (once, however many ask). */
  data(n: number): Promise<PageData> {
    const item = this.cache.get(dataKey(n))
    if (item?.kind === 'data') return Promise.resolve(item.data)
    let pending = this.fetching.get(n)
    if (!pending) {
      const t0 = performance.now()
      pending = this.loaders.load(n).then((data) => {
        this.lastFetchMs = performance.now() - t0
        this.store(n, data)
        return data
      })
      const forget = () => this.fetching.delete(n)
      pending.then(forget, forget)
      this.fetching.set(n, pending)
    }
    return pending
  }

  private store(n: number, data: PageData) {
    this.cache.set(dataKey(n), n, data.bytes.size, { kind: 'data', data })
  }

  /** The size of the original page. */
  size(n: number): Promise<Size> {
    const known = this.sizes.get(n)
    if (known) return Promise.resolve(known)
    let pending = this.measuring.get(n)
    if (!pending) {
      pending = this.measure(n)
      const forget = () => this.measuring.delete(n)
      pending.then(forget, forget)
      this.measuring.set(n, pending)
    }
    return pending
  }

  private async measure(n: number): Promise<Size> {
    const data = await this.data(n)
    let size = data.size ?? (await this.loaders.probe(data.bytes))
    if (!size) size = (await this.convert(n)).size!
    this.sizes.set(n, size)
    return size
  }

  /** Replaces the bytes of a page by the PNG Rust makes of it. */
  private async convert(n: number): Promise<PageData> {
    const data = await this.loaders.convert(n)
    this.store(n, data)
    return data
  }

  /**
   * The page decoded at `target`. Once a bitmap is made for the page being read,
   * the other sizes of that page are dropped: the zoom moved on.
   */
  bitmap(n: number, target: Size): Promise<ImageBitmap> {
    const key = bitmapKey(n, target)
    const item = this.cache.get(key)
    if (item?.kind === 'bitmap') return Promise.resolve(item.bitmap)
    let pending = this.decoding.get(key)
    if (!pending) {
      pending = this.makeBitmap(n, target, key)
      const forget = () => this.decoding.delete(key)
      pending.then(forget, forget)
      this.decoding.set(key, pending)
    }
    return pending
  }

  private async makeBitmap(n: number, target: Size, key: string): Promise<ImageBitmap> {
    const data = await this.data(n)
    const t0 = performance.now()
    let bitmap: ImageBitmap
    try {
      bitmap = await this.loaders.decode(data.bytes, target)
    } catch {
      // The webview cannot decode this page: Rust's PNG, kept for next time
      bitmap = await this.loaders.decode((await this.convert(n)).bytes, target)
    }
    this.lastDecodeMs = performance.now() - t0
    this.made++
    this.bitmapCount++
    this.cache.set(key, n, bitmapBytes(target), { kind: 'bitmap', bitmap })
    if (n === this.current) this.dropOtherSizes(n, key)
    this.pruneBitmaps()
    return bitmap
  }

  private dropOtherSizes(n: number, keep: string) {
    for (const key of this.cache.keysOf(n)) {
      if (key !== keep && key.startsWith('b')) this.cache.delete(key)
    }
  }

  /**
   * Gets the pages around `current` ready, one at a time, nearest first: two
   * ahead and one behind, or the other way round after going back. `fitOf` gives
   * the size a page is shown at, which is the size to decode it at. Starting
   * again (the page changed) stops the previous run; nothing runs while a
   * gesture is going on, and a page that does not fit in the budget is skipped.
   */
  async preload(
    current: number,
    count: number,
    backwards: boolean,
    fitOf: (original: Size) => Size,
  ) {
    const run = ++this.generation
    const stale = () => run !== this.generation
    const { ahead, behind } = backwards ? { ahead: PRELOAD.behind, behind: PRELOAD.ahead } : PRELOAD
    const order: number[] = []
    for (let i = 1; i <= Math.max(ahead, behind); i++) {
      if (i <= ahead) order.push(current + i)
      if (i <= behind) order.push(current - i)
    }
    // Backwards the pages behind come first
    if (backwards) order.sort((a, b) => Math.abs(a - current) - Math.abs(b - current) || a - b)
    for (const n of order) {
      if (n < 0 || n >= count) continue
      try {
        await this.idle(stale)
        if (stale()) return
        const original = await this.size(n)
        if (stale()) return
        const raw = fitOf(original)
        const target = { width: Math.max(raw.width, 1), height: Math.max(raw.height, 1) }
        // Sizes this page was prepared at before the window changed are of no use
        for (const key of this.cache.keysOf(n)) {
          if (key.startsWith('b') && key !== bitmapKey(n, target)) this.cache.delete(key)
        }
        if (this.cache.has(bitmapKey(n, target))) continue
        if (!this.cache.canHold(n, bitmapBytes(target))) continue
        await this.idle(stale)
        if (stale()) return
        await this.bitmap(n, target)
      } catch {
        // A page that cannot be prepared now is reported when it is opened
      }
    }
  }

  /** Waits until no gesture is going on. */
  private async idle(stale: () => boolean) {
    while (!stale() && performance.now() < this.busyUntil) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  snapshot(): Snapshot {
    return {
      budget: this.cache.limit,
      used: this.cache.used,
      entries: this.cache.size,
      bitmaps: this.bitmapCount,
      made: this.made,
      closed: this.closed,
      hits: this.hits,
      misses: this.misses,
      turn: this.turn,
      fetchMs: this.lastFetchMs,
      decodeMs: this.lastDecodeMs,
      pages: [...this.cache.pages()].sort((a, b) => a[0] - b[0]),
    }
  }
}
