// Vertical scroll: every page of the volume, one under the other, fitted to the
// width of the screen, with no gap. Lengths are in physical pixels, whole, so
// that pages meet exactly and are drawn one image pixel per screen pixel.
//
// The height of a page whose size is not known yet is estimated from the pages
// that are known. The place being read is kept as an anchor: a page and how far
// into it the top of the screen is. When a real height replaces an estimate the
// anchor stays, so the picture on screen does not jump.
import type { Size } from './fit'

/** Shape of a page when no page of the volume is known yet: a usual comic page. */
const DEFAULT_RATIO = 1.5

export class Strip {
  private heights: number[]
  private offsets: number[] = []
  private width = 0
  private viewport = 0
  /** The page at the top of the screen, and how far into it the top is, in pixels. */
  private anchor = { page: 0, into: 0 }

  constructor(readonly count: number) {
    this.heights = new Array(count).fill(0)
  }

  /**
   * The width of the strip and the height of the screen, and the sizes of the
   * pages known so far. Keeps the place being read.
   */
  layout(width: number, viewport: number, size: (n: number) => Size | undefined) {
    const ratio = this.averageRatio(size)
    const before = this.heights[this.anchor.page] ?? 0
    this.width = width
    this.viewport = viewport
    for (let n = 0; n < this.count; n++) {
      const s = size(n)
      this.heights[n] = Math.max(1, Math.round(width * (s ? s.height / s.width : ratio)))
    }
    let at = 0
    this.offsets = this.heights.map((h) => {
      const top = at
      at += h
      return top
    })
    // The same place in the page at its new height: the same part of the picture stays at the top
    const after = this.heights[this.anchor.page] ?? 0
    if (before > 0 && after !== before)
      this.anchor.into = Math.round((this.anchor.into * after) / before)
    this.anchor.into = Math.min(this.anchor.into, Math.max(after - 1, 0))
    this.setTop(this.top)
  }

  private averageRatio(size: (n: number) => Size | undefined) {
    let sum = 0
    let known = 0
    for (let n = 0; n < this.count; n++) {
      const s = size(n)
      if (s) {
        sum += s.height / s.width
        known++
      }
    }
    return known ? sum / known : DEFAULT_RATIO
  }

  /** Total height of the strip. */
  get total(): number {
    return this.count ? this.offsets[this.count - 1] + this.heights[this.count - 1] : 0
  }

  /** How far down the strip the top of the screen is. */
  get top(): number {
    return (this.offsets[this.anchor.page] ?? 0) + this.anchor.into
  }

  private get maxTop() {
    return Math.max(0, this.total - this.viewport)
  }

  /** The page at the top of the screen: the one the counter shows. */
  get page(): number {
    return this.anchor.page
  }

  offset(n: number): number {
    return this.offsets[n]
  }

  height(n: number): number {
    return this.heights[n]
  }

  /** Moves to a place on the strip, kept inside it. Returns whether it moved. */
  setTop(top: number): boolean {
    const before = this.top
    const t = Math.round(Math.min(Math.max(top, 0), this.maxTop))
    const page = this.pageAt(t)
    this.anchor = { page, into: t - this.offsets[page] }
    return this.top !== before
  }

  scrollBy(dy: number): boolean {
    return this.setTop(this.top + dy)
  }

  /** The top of a page at the top of the screen, as far as the end of the strip allows. */
  jump(page: number) {
    const n = Math.min(Math.max(page, 0), this.count - 1)
    this.anchor = { page: n, into: 0 }
    this.setTop(this.offsets[n])
  }

  /** The page under a point of the strip. */
  pageAt(y: number): number {
    let lo = 0
    let hi = this.count - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.offsets[mid] <= y) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  /** Pages that cross the part of the strip from `top - before` to `top + viewport + after`. */
  pagesAround(before: number, after: number): number[] {
    if (!this.count) return []
    const first = this.pageAt(Math.max(0, this.top - before))
    const last = this.pageAt(Math.min(this.total - 1, this.top + this.viewport + after))
    const pages = []
    for (let n = first; n <= last; n++) pages.push(n)
    return pages
  }

  get stripWidth() {
    return this.width
  }
}
