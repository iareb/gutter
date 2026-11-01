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
