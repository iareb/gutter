import type { Size } from './fit'

/**
 * The zoom of vertical scroll is the strip's width as a fraction of the screen's:
 * 1 is as wide as the screen, less is a column in the middle, more is wider than
 * the screen and moves sideways. These are its bounds and its start.
 */

/**
 * Where the strip starts: as wide as the screen, but never wider than a page's own
 * pixels (100%), which would only enlarge the page. On a phone that is the screen's
 * width; on a computer a page narrower than the window keeps its own size.
 */
export function startZoom(screenWidth: number, pageWidth: number): number {
  if (screenWidth <= 0 || pageWidth <= 0) return 1
  return Math.min(1, pageWidth / screenWidth)
}

/**
 * How narrow the strip can get: half of a whole page in the screen's height (about two
 * pages one above the other), or half the start if that is narrower (a webtoon's long
 * pages), and never below a tenth of the screen. Zooming out works whatever the fit.
 */
export function minZoom(screen: Size, page: Size, start: number): number {
  if (screen.width <= 0 || page.width <= 0 || page.height <= 0) return Math.max(0.1, start / 2)
  const wholePage = (screen.height * page.width) / page.height / screen.width
  return Math.max(0.1, Math.min(start, wholePage, 1) / 2)
}

/** The zoom as a reader knows it: the page's own pixels shown one to one are 100%. */
export function percent(stripWidth: number, pageWidth: number): number {
  return pageWidth > 0 ? Math.round((stripWidth / pageWidth) * 100) : 100
}

/** Where a strip narrower than the screen starts, on a whole pixel: centered. */
export function stripLeft(screenWidth: number, stripWidth: number): number {
  return Math.max(0, Math.round((screenWidth - stripWidth) / 2))
}

const KEY = 'gutter.stripZoom'

/**
 * The zoom of vertical scroll the reader chose, once for every volume (a column on a
 * computer is chosen once). Undefined: the start, worked out for each page and window.
 */
export function loadStripZoom(
  storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage,
): number | undefined {
  try {
    const z = Number(storage?.getItem(KEY))
    return Number.isFinite(z) && z > 0 ? z : undefined
  } catch {
    return undefined
  }
}

export function saveStripZoom(
  zoom: number | undefined,
  storage: Pick<Storage, 'setItem' | 'removeItem'> | undefined = globalThis.localStorage,
): void {
  try {
    if (zoom === undefined) storage?.removeItem(KEY)
    else storage?.setItem(KEY, String(zoom))
  } catch {
    // Not kept: the zoom still holds until the app is closed
  }
}
