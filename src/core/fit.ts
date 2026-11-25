export type Size = { width: number; height: number }

/**
 * Size in physical pixels at which to decode a page so it fits the viewport:
 * CSS size × devicePixelRatio × zoom. Never larger than the original, since
 * upscaling adds no detail, only blur.
 */
export function fitPage(page: Size, viewport: Size, devicePixelRatio: number, zoom = 1): Size {
  const fit = Math.min(viewport.width / page.width, viewport.height / page.height)
  const scale = Math.min(fit * devicePixelRatio * zoom, 1)
  return { width: Math.round(page.width * scale), height: Math.round(page.height * scale) }
}

/**
 * Whether drawing a decode at a size needs it scaled: it does not when the decode
 * was made at the size shown (give or take the rounding of a page's height to
 * whole pixels). Then the canvas copies pixels and needs no filter, and the
 * high-quality filter still costs time if it is left on: on a phone, turning it off
 * for these copies took the longest frame of a fast vertical scroll from 44 to 28 ms.
 */
export function needsScaling(sx: number, sy: number): boolean {
  return Math.abs(sx - 1) > 0.005 || Math.abs(sy - 1) > 0.005
}
