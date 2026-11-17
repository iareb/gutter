/**
 * A cache with a budget in bytes, for the pages of one volume: the encoded bytes
 * of many pages and the decoded bitmaps of a few. Each entry belongs to a page.
 * When the budget is exceeded the entries farthest from the page being read go
 * first; the entries of that page itself are never dropped, so the page on
 * screen never loses quality because of the budget (the cache may then hold
 * more than its budget, and says so through `over`).
 */
export class Cache<T> {
  private entries = new Map<string, Entry<T>>()
  private current = 0
  private total = 0

  /**
   * @param budget Bytes the cache may hold.
   * @param dispose Called once for every value that leaves the cache.
   */
  constructor(
    private budget: number,
    private dispose: (value: T) => void,
  ) {}

  /** Bytes held now. */
  get used(): number {
    return this.total
  }

  get limit(): number {
    return this.budget
  }

  /** The cache holds more than its budget: only the current page's entries are left to drop. */
  get over(): boolean {
    return this.total > this.budget
  }

  get size(): number {
    return this.entries.size
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  get(key: string): T | undefined {
    return this.entries.get(key)?.value
  }

  /** Every key, with the page it belongs to. */
  all(): [string, number][] {
    return [...this.entries].map(([key, e]) => [key, e.page])
  }

  /** Keys of every entry of a page. */
  keysOf(page: number): string[] {
    return [...this.entries].filter(([, e]) => e.page === page).map(([key]) => key)
  }

  /** Bytes held for each page, for the development overlay. */
  pages(): Map<number, number> {
    const pages = new Map<number, number>()
    for (const e of this.entries.values()) pages.set(e.page, (pages.get(e.page) ?? 0) + e.bytes)
    return pages
  }

  /**
   * Whether an entry of `bytes` for `page` would stay: there is room for it after
   * dropping only entries farther from the current page than it is.
   */
  canHold(page: number, bytes: number): boolean {
    if (page === this.current) return true
    const mine = this.rank(page)
    let free = this.budget - this.total
    for (const e of this.entries.values()) {
      if (free >= bytes) break
      if (e.page !== this.current && this.rank(e.page) > mine) free += e.bytes
    }
    return free >= bytes
  }

  /** Adds or replaces an entry, then drops what exceeds the budget. */
  set(key: string, page: number, bytes: number, value: T): void {
    this.delete(key)
    this.entries.set(key, { page, bytes, value })
    this.total += bytes
    this.trim()
  }

  delete(key: string): void {
    const e = this.entries.get(key)
    if (!e) return
    this.entries.delete(key)
    this.total -= e.bytes
    this.dispose(e.value)
  }

  /** The page being read changed: what is far from it is the first to go. */
  setCurrent(page: number): void {
    this.current = page
    this.trim()
  }

  /** Changes the budget, dropping what no longer fits. */
  setBudget(budget: number): void {
    this.budget = budget
    this.trim()
  }

  clear(): void {
    for (const key of [...this.entries.keys()]) this.delete(key)
  }

  /** Larger is farther. A page behind the reader counts as farther: reading goes forward. */
  private rank(page: number): number {
    const d = page - this.current
    return d >= 0 ? d : -d * 1.5
  }

  private trim(): void {
    if (this.total <= this.budget) return
    const victims = [...this.entries]
      .filter(([, e]) => e.page !== this.current)
      // Farthest first; on the same page, the biggest first
      .sort(([, a], [, b]) => this.rank(b.page) - this.rank(a.page) || b.bytes - a.bytes)
    for (const [key] of victims) {
      if (this.total <= this.budget) return
      this.delete(key)
    }
  }
}

type Entry<T> = { page: number; bytes: number; value: T }
