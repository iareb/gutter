import { describe, expect, it } from 'vitest'
import {
  clampView,
  FIT_VIEW,
  MAX_ZOOM,
  panView,
  sameView,
  shownSize,
  visibleRect,
  zoomView,
} from './view'

const fit = { width: 600, height: 900 }
const viewport = { width: 1000, height: 900 }

describe('shownSize', () => {
  it('scales the fitted page by the zoom', () => {
    expect(shownSize(fit, 1)).toEqual(fit)
    expect(shownSize(fit, 2.5)).toEqual({ width: 1500, height: 2250 })
  })
})

describe('clampView', () => {
  it('centers an axis that fits on screen', () => {
    expect(clampView({ zoom: 1, cx: 0.1, cy: 0.9 }, fit, viewport)).toEqual(FIT_VIEW)
  })

  it('stops at the edges of an axis that does not fit', () => {
    const shown = shownSize(fit, 3) // 1800 x 2700 in a 1000 x 900 viewport
    const view = clampView({ zoom: 3, cx: 0, cy: 1 }, shown, viewport)
    expect(view.cx).toBeCloseTo(500 / 1800)
    expect(view.cy).toBeCloseTo(1 - 450 / 2700)
  })
})

describe('visibleRect', () => {
  it('is the whole page at fit', () => {
    expect(visibleRect(FIT_VIEW, fit, viewport)).toEqual({ x: 0, y: 0, width: 600, height: 900 })
  })

  it('is a viewport-sized window into a zoomed page, in whole pixels', () => {
    const shown = shownSize(fit, 2) // 1200 x 1800
    expect(visibleRect({ zoom: 2, cx: 0.5, cy: 0.5 }, shown, viewport)).toEqual({
      x: 100,
      y: 450,
      width: 1000,
      height: 900,
    })
    expect(visibleRect({ zoom: 2, cx: 0.4999, cy: 0.25 }, shown, viewport)).toEqual({
      x: 100,
      y: 0,
      width: 1000,
      height: 900,
    })
  })

  it('never reaches outside the page', () => {
    const shown = shownSize(fit, 2)
    const r = visibleRect({ zoom: 2, cx: 1, cy: 1 }, shown, viewport)
    expect(r.x + r.width).toBe(1200)
    expect(r.y + r.height).toBe(1800)
  })
})

describe('panView', () => {
  const shown = shownSize(fit, 2)
  const start = clampView({ zoom: 2, cx: 0.5, cy: 0.5 }, shown, viewport)

  it('moves by physical pixels', () => {
    const moved = panView(start, 0, 300, shown, viewport)
    expect(visibleRect(moved, shown, viewport).y).toBe(750)
  })

  it('stops at the edge, so a further pan changes nothing', () => {
    const atEdge = panView(start, 0, 10000, shown, viewport)
    expect(visibleRect(atEdge, shown, viewport).y).toBe(900)
    expect(sameView(panView(atEdge, 0, 100, shown, viewport), atEdge)).toBe(true)
  })

  it('cannot move an axis that fits', () => {
    expect(sameView(panView(start, 300, 0, shown, viewport), start)).toBe(false)
    const wide = { width: 2000, height: 900 }
    const fitted = clampView({ zoom: 1, cx: 0.5, cy: 0.5 }, fit, wide)
    expect(sameView(panView(fitted, 300, 300, fit, wide), fitted)).toBe(true)
  })
})

describe('zoomView', () => {
  it('zooms around the center of the view', () => {
    expect(zoomView({ zoom: 2, cx: 0.3, cy: 0.7 }, 1.5)).toEqual({ zoom: 3, cx: 0.3, cy: 0.7 })
  })

  it('stays between fit and the maximum', () => {
    expect(zoomView({ zoom: 6, cx: 0.5, cy: 0.5 }, 2).zoom).toBe(MAX_ZOOM)
    expect(zoomView({ zoom: 1.2, cx: 0.3, cy: 0.7 }, 0.5)).toEqual(FIT_VIEW)
  })
})
