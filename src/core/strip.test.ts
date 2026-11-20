import { describe, expect, it } from 'vitest'
import { Strip } from './strip'
import type { Size } from './fit'

const page = { width: 1000, height: 1500 }
const all = (s: Size) => () => s
const none = () => undefined

describe('Strip', () => {
  it('stacks the pages fitted to the width, with no gap', () => {
    const s = new Strip(3)
    s.layout(400, 300, all(page))
    expect([s.offset(0), s.offset(1), s.offset(2)]).toEqual([0, 600, 1200])
    expect(s.total).toBe(1800)
  })

  it('estimates pages not known yet from the ones that are', () => {
    const s = new Strip(3)
    s.layout(400, 300, (n) => (n === 0 ? { width: 1000, height: 2000 } : undefined))
    expect(s.height(1)).toBe(800)
    const unknown = new Strip(2)
    unknown.layout(400, 300, none)
    expect(unknown.height(0)).toBe(600)
  })

  it('scrolls within the strip, and follows the page at the top', () => {
    const s = new Strip(3)
    s.layout(400, 300, all(page))
    expect(s.scrollBy(-50)).toBe(false)
    s.scrollBy(650)
    expect(s.top).toBe(650)
    expect(s.page).toBe(1)
    s.scrollBy(10_000)
    expect(s.top).toBe(1500)
    expect(s.page).toBe(2)
  })

  it('jumps to the top of a page, as far as the end allows', () => {
    const s = new Strip(3)
    s.layout(400, 300, all(page))
    s.jump(1)
    expect(s.top).toBe(600)
    s.jump(2)
    expect(s.top).toBe(1200)
    const short = new Strip(3)
    short.layout(400, 1000, all(page))
    short.jump(2)
    expect(short.top).toBe(800)
  })

  it('keeps the place being read when a real height replaces an estimate', () => {
    const s = new Strip(4)
    s.layout(400, 300, (n) => (n === 2 ? page : undefined))
    s.jump(2)
    s.scrollBy(100)
    const into = s.top - s.offset(s.page)
    // Page 0 turns out taller: everything below moves down, the picture does not
    s.layout(400, 300, (n) =>
      n === 0 ? { width: 1000, height: 3000 } : n === 2 ? page : undefined,
    )
    expect(s.page).toBe(2)
    expect(s.top - s.offset(2)).toBe(into)
  })

  it('keeps the place when the width changes', () => {
    const s = new Strip(3)
    s.layout(400, 300, all(page))
    s.jump(1)
    s.scrollBy(300)
    s.layout(800, 600, all(page))
    expect(s.page).toBe(1)
    // Halfway into page 2 before, halfway into it after
    expect(s.top).toBe(1200 + 600)
  })

  it('lists the pages near the screen', () => {
    const s = new Strip(5)
    s.layout(400, 300, all(page))
    s.setTop(500)
    expect(s.pagesAround(0, 0)).toEqual([0, 1])
    expect(s.pagesAround(0, 600)).toEqual([0, 1, 2])
    expect(s.pagesAround(600, 0)).toEqual([0, 1])
    expect(new Strip(0).pagesAround(0, 0)).toEqual([])
  })
})
