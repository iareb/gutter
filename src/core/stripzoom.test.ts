import { describe, expect, it } from 'vitest'
import { loadStripZoom, minZoom, percent, saveStripZoom, startZoom, stripLeft } from './stripzoom'

describe('the zoom of vertical scroll', () => {
  it('starts as wide as the screen, on a phone', () => {
    // A page 1988 pixels wide on a phone 1220 pixels wide
    expect(startZoom(1220, 1988)).toBe(1)
  })

  it('starts at the page’s own pixels when the window is wider', () => {
    // A webtoon 800 pixels wide in a window 1920 wide: a column of 800
    expect(startZoom(1920, 800)).toBeCloseTo(800 / 1920)
    expect(startZoom(1920, 1920)).toBe(1)
  })

  it('goes down to two pages in the height of the screen', () => {
    // A page 1988 × 3056 in a window 1920 × 1000: a whole page fits 650 wide, two 325
    const screen = { width: 1920, height: 1000 }
    const page = { width: 1988, height: 3056 }
    expect(minZoom(screen, page, startZoom(1920, 1988))).toBeCloseTo(
      (1000 * 1988) / 3056 / 1920 / 2,
    )
  })

  it('zooms out on a phone too, where a whole page already fits the height', () => {
    // A page 1988 × 3056 on a phone 1220 × 2171: the start (the screen's width) shows it whole
    expect(minZoom({ width: 1220, height: 2171 }, { width: 1988, height: 3056 }, 1)).toBe(0.5)
  })

  it('never goes below half the start, nor below a tenth of the screen', () => {
    // A webtoon page far taller than wide
    expect(minZoom({ width: 1920, height: 1000 }, { width: 800, height: 20000 }, 0.4)).toBe(0.1)
    expect(minZoom({ width: 1920, height: 1000 }, { width: 800, height: 1200 }, 0.3)).toBeCloseTo(
      0.15,
    )
  })

  it('tells the zoom against the page’s own pixels', () => {
    expect(percent(1988, 1988)).toBe(100)
    expect(percent(994, 1988)).toBe(50)
    expect(percent(1220, 1988)).toBe(61)
  })

  it('puts a narrow strip in the middle, on a whole pixel', () => {
    expect(stripLeft(1920, 800)).toBe(560)
    expect(stripLeft(1921, 800)).toBe(561)
    expect(stripLeft(1220, 2440)).toBe(0)
  })
})

describe('the zoom chosen for vertical scroll', () => {
  const memory = () => {
    const m = new Map<string, string>()
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    }
  }

  it('is kept, and forgotten when back at the start', () => {
    const s = memory()
    expect(loadStripZoom(s)).toBeUndefined()
    saveStripZoom(0.45, s)
    expect(loadStripZoom(s)).toBe(0.45)
    saveStripZoom(undefined, s)
    expect(loadStripZoom(s)).toBeUndefined()
  })

  it('ignores what it cannot read', () => {
    const s = memory()
    s.setItem('gutter.stripZoom', 'wide')
    expect(loadStripZoom(s)).toBeUndefined()
    s.setItem('gutter.stripZoom', '-1')
    expect(loadStripZoom(s)).toBeUndefined()
  })
})
