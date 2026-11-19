// How pages are grouped on screen. In single mode every page is shown alone; in
// double mode pages go in pairs (1-2, 3-4...), with three exceptions: the first
// page alone as a cover if asked, a wide page (a spread: wider than tall)
// always alone, and the page before a wide page alone, so that the pairs after
// it stay right. A group of pages shown together is a unit.
//
// Pairing needs the shape of the pages, which is known only once their sizes
// are. The layout is built from the first page on and stops at the first page
// whose shape it needs and does not know: the units past it are not known yet,
// and the viewer waits for them rather than guess.
import type { Size } from './fit'
import type { Move } from './navigation'

/** Pages shown together, counted from 0, in reading order. */
export type Unit = readonly number[]

export type LayoutOptions = {
  count: number
  double: boolean
  /** In double mode: the first page alone. */
  cover: boolean
  /** Whether a page is wide; undefined while its size is not known. */
  wide: (n: number) => boolean | undefined
}

/** A spread: a page wider than tall, shown alone. */
export const isWide = (size: Size) => size.width > size.height

export class Layout {
  private units: number[][] = []
  /** Unit of each page known so far. */
  private index = new Map<number, number>()
  /** Every page of the volume is in a known unit. */
  readonly done: boolean

  constructor(private options: LayoutOptions) {
    const { count, double, cover, wide } = options
    const add = (unit: number[]) => {
      for (const n of unit) this.index.set(n, this.units.length)
      this.units.push(unit)
    }
    let i = 0
    if (!double) {
      for (; i < count; i++) add([i])
    } else {
      if (cover && count > 0) add([i++])
      while (i < count) {
        const w = wide(i)
        if (w === undefined) break
        if (w || i + 1 === count) {
          add([i++])
          continue
        }
        const next = wide(i + 1)
        if (next === undefined) break
        if (next) add([i++])
        else {
          add([i, i + 1])
          i += 2
        }
      }
    }
    this.done = i >= count
  }

  get count() {
    return this.options.count
  }

  get double() {
    return this.options.double
  }

  /** The unit a page is in, or undefined while it is not known. */
  unitOf(page: number): Unit | undefined {
    const i = this.index.get(page)
    return i === undefined ? undefined : this.units[i]
  }

  /** The unit after this one: undefined at the end, or while it is not known. */
  after(unit: Unit): Unit | undefined {
    return this.unitOf(unit[unit.length - 1] + 1)
  }

  /** The unit before this one: undefined at the start. */
  before(unit: Unit): Unit | undefined {
    return unit[0] === 0 ? undefined : this.unitOf(unit[0] - 1)
  }

  /**
   * The page a move goes to, counted from 0. It may be in a unit not known yet:
   * the viewer then waits for it. At the first or last unit it is `page` itself.
   */
  target(page: number, move: Move): number {
    const count = this.options.count
    const unit = this.unitOf(page)
    switch (move) {
      case 'next': {
        const last = unit ? unit[unit.length - 1] : page
        return last + 1 < count ? last + 1 : page
      }
      case 'previous': {
        const first = unit ? unit[0] : page
        if (first === 0) return page
        return this.unitOf(first - 1)?.[0] ?? first - 1
      }
      case 'first':
        return 0
      case 'last':
        return this.done ? this.units[this.units.length - 1][0] : count - 1
    }
  }
}

/** What the options bar shows for a unit: "7" or "7–8". */
export const unitLabel = (unit: Unit) =>
  unit.length > 1 ? `${unit[0] + 1}–${unit[unit.length - 1] + 1}` : `${unit[0] + 1}`

/**
 * The size of a unit as one virtual page: its pages side by side, each scaled
 * to the height of the tallest, in the order given (the order on screen).
 */
export function unitSize(sizes: readonly Size[]): Size {
  const height = Math.max(...sizes.map((s) => s.height))
  const width = sizes.reduce((sum, s) => sum + (s.width * height) / s.height, 0)
  return { width, height }
}

/**
 * Where each page of a unit sits across its shown width, in whole pixels: the
 * pages touch, and the last one ends at the edge.
 */
export function partRects(sizes: readonly Size[], shownWidth: number) {
  const virtual = unitSize(sizes)
  let edge = 0
  let from = 0
  return sizes.map((s) => {
    edge += (s.width * virtual.height) / s.height
    const to = Math.round((shownWidth * edge) / virtual.width)
    const rect = { x: from, width: to - from }
    from = to
    return rect
  })
}

/**
 * The size to decode each page of a unit at, for the unit shown at `shown`
 * pixels: its share of the width, never above the page's own pixels, and at
 * least one pixel.
 */
export function partTargets(sizes: readonly Size[], shown: Size): Size[] {
  return partRects(sizes, shown.width).map((rect, i) => {
    const original = sizes[i]
    const k = Math.min(
      1,
      original.width / Math.max(rect.width, 1),
      original.height / Math.max(shown.height, 1),
    )
    return {
      width: Math.max(Math.round(rect.width * k), 1),
      height: Math.max(Math.round(shown.height * k), 1),
    }
  })
}
