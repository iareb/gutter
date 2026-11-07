import type { Size } from './fit'

/**
 * What part of the page is on screen. `zoom` is relative to the page fitted to
 * the screen (1 = fit); `cx`, `cy` are the center of the view as a fraction of
 * the page, 0 to 1.
 */
export type View = { zoom: number; cx: number; cy: number }

export const FIT_VIEW: View = { zoom: 1, cx: 0.5, cy: 0.5 }
export const MAX_ZOOM = 8

/** A rectangle in physical pixels of the zoomed page. */
export type Rect = { x: number; y: number; width: number; height: number }

/** Size of the whole page at this zoom, in physical pixels. Can exceed the original. */
export function shownSize(fit: Size, zoom: number): Size {
  return { width: Math.round(fit.width * zoom), height: Math.round(fit.height * zoom) }
}

/** Keeps the page on screen: an axis that fits is centered, one that does not stops at the edges. */
export function clampView(view: View, shown: Size, viewport: Size): View {
  const axis = (center: number, page: number, room: number) => {
    const half = room / page / 2
    return half >= 0.5 ? 0.5 : Math.min(Math.max(center, half), 1 - half)
  }
  return {
    zoom: view.zoom,
    cx: axis(view.cx, shown.width, viewport.width),
    cy: axis(view.cy, shown.height, viewport.height),
  }
}

/** The part of the zoomed page that is visible, in whole physical pixels. */
export function visibleRect(view: View, shown: Size, viewport: Size): Rect {
  const axis = (center: number, page: number, room: number) => {
    const length = Math.min(page, room)
    const start = Math.round(center * page - length / 2)
    return [Math.min(Math.max(start, 0), page - length), length]
  }
  const [x, width] = axis(view.cx, shown.width, viewport.width)
  const [y, height] = axis(view.cy, shown.height, viewport.height)
  return { x, y, width, height }
}

/** Moves the view by `dx`, `dy` physical pixels, stopping at the edges. */
export function panView(view: View, dx: number, dy: number, shown: Size, viewport: Size): View {
  return clampView(
    { zoom: view.zoom, cx: view.cx + dx / shown.width, cy: view.cy + dy / shown.height },
    shown,
    viewport,
  )
}

/** Zooms by `factor` around the center of the view, between fit and MAX_ZOOM. */
export function zoomView(view: View, factor: number): View {
  const zoom = Math.min(Math.max(view.zoom * factor, 1), MAX_ZOOM)
  // Back at fit the whole page is visible: no position to keep
  return zoom === 1 ? FIT_VIEW : { ...view, zoom }
}

export const sameView = (a: View, b: View) =>
  a.zoom === b.zoom && Math.abs(a.cx - b.cx) < 1e-9 && Math.abs(a.cy - b.cy) < 1e-9
