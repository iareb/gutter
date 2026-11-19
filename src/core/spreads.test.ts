import { describe, expect, it } from 'vitest'
import { Layout, partRects, partTargets, unitLabel, unitSize } from './spreads'

const units = (layout: Layout, count: number) => {
  const out: string[] = []
  for (let p = 0; p < count;) {
    const u = layout.unitOf(p)
    if (!u) break
    out.push(unitLabel(u))
    p = u[u.length - 1] + 1
  }
  return out.join(' ')
}
/** A volume where the pages listed in `wide` are spreads; `unknown` from that page on. */
const make = (
  count: number,
  opts: { double?: boolean; cover?: boolean; wide?: number[]; unknownFrom?: number } = {},
) =>
  new Layout({
    count,
    double: opts.double ?? true,
    cover: opts.cover ?? true,
    wide: (n) =>
      opts.unknownFrom !== undefined && n >= opts.unknownFrom
        ? undefined
        : (opts.wide ?? []).includes(n),
  })

describe('Layout', () => {
  it('shows every page alone in single mode', () => {
    expect(units(make(4, { double: false }), 4)).toBe('1 2 3 4')
  })

  it('pairs pages after a single cover', () => {
    expect(units(make(7), 7)).toBe('1 2–3 4–5 6–7')
    expect(units(make(6, { cover: false }), 6)).toBe('1–2 3–4 5–6')
  })

  it('keeps a wide page alone, and the page before it, so the pairs after stay right', () => {
    // Page 5 (counted from 1) is wide
    expect(units(make(9, { wide: [4] }), 9)).toBe('1 2–3 4 5 6–7 8–9')
    expect(units(make(8, { cover: false, wide: [4] }), 8)).toBe('1–2 3–4 5 6–7 8')
  })

  it('stops at the first page whose shape it needs and does not know', () => {
    const l = make(10, { unknownFrom: 4 })
    expect(units(l, 10)).toBe('1 2–3')
    expect(l.done).toBe(false)
    expect(l.unitOf(3)).toBeUndefined()
    expect(make(10).done).toBe(true)
  })

  it('moves by units, and to a unit not known yet', () => {
    const l = make(9, { wide: [4] })
    expect(l.target(0, 'next')).toBe(1)
    expect(l.target(1, 'next')).toBe(3)
    expect(l.target(2, 'next')).toBe(3)
    expect(l.target(3, 'previous')).toBe(1)
    expect(l.target(1, 'previous')).toBe(0)
    expect(l.target(0, 'previous')).toBe(0)
    expect(l.target(7, 'next')).toBe(7)
    expect(l.target(5, 'last')).toBe(7)
    expect(l.target(5, 'first')).toBe(0)
    const partial = make(10, { unknownFrom: 4 })
    expect(partial.target(1, 'next')).toBe(3)
    expect(partial.target(1, 'last')).toBe(9)
  })

  it('knows the units beside one', () => {
    const l = make(7)
    expect(l.after([1, 2])).toEqual([3, 4])
    expect(l.before([1, 2])).toEqual([0])
    expect(l.before([0])).toBeUndefined()
    expect(l.after([5, 6])).toBeUndefined()
  })
})

describe('unit geometry', () => {
  const a = { width: 1000, height: 1500 }
  const b = { width: 500, height: 750 }

  it('scales the pages to the tallest and puts them side by side', () => {
    expect(unitSize([a])).toEqual(a)
    expect(unitSize([a, b])).toEqual({ width: 2000, height: 1500 })
  })

  it('places the pages in whole pixels, touching, filling the width', () => {
    expect(partRects([a, b], 801)).toEqual([
      { x: 0, width: 401 },
      { x: 401, width: 400 },
    ])
    expect(partRects([a], 333)).toEqual([{ x: 0, width: 333 }])
  })

  it('decodes each page at its share, never above its own pixels', () => {
    expect(partTargets([a, b], { width: 800, height: 600 })).toEqual([
      { width: 400, height: 600 },
      { width: 400, height: 600 },
    ])
    // Shown larger than the small page itself: it stays at its own size
    expect(partTargets([a, b], { width: 1600, height: 1200 })).toEqual([
      { width: 800, height: 1200 },
      { width: 500, height: 750 },
    ])
    expect(partTargets([a], { width: 0, height: 0 })).toEqual([{ width: 1, height: 1 }])
  })
})
