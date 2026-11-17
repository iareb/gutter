import type { Size } from './fit'
import { downscaleSteps } from './quality'

const canvas = (size: Size) => {
  const c = document.createElement('canvas')
  c.width = size.width
  c.height = size.height
  return c
}

/**
 * The canvases of the downscale live in main memory (willReadFrequently). On an
 * accelerated canvas, drawing the full-size page uploads it to the graphics
 * memory as a texture, and that memory stays taken: on the phone a session of
 * jumps and fast flipping reached 774 MB with it and 327 MB without. The price
 * is time on the phone, about 0.7 s a page instead of 0.1 s, which preloading
 * hides while reading (docs/spikes/page-memory.md).
 */
const context = (c: HTMLCanvasElement) => c.getContext('2d', { willReadFrequently: true })!

/** Frees a canvas' pixels now instead of waiting for garbage collection. */
const release = (c: HTMLCanvasElement) => {
  c.width = 0
  c.height = 0
}

/**
 * Decodes a page at exactly `target` size, never larger than the page (see
 * fitPage). The same method on every platform: decode at full size, then
 * downscale on a canvas in steps (see downscaleSteps). `createImageBitmap`
 * with `resizeQuality: 'high'` is not used: WebKitGTK ignores the quality and
 * Chromium leaves moiré at common ratios (step 1.3, resize-quality spike).
 */
export async function decode(blob: Blob, target: Size): Promise<ImageBitmap> {
  const full = await createImageBitmap(blob)
  const steps = downscaleSteps(full, target)
  if (steps.length === 0) return full

  let source: CanvasImageSource = full
  let previous: HTMLCanvasElement | undefined
  for (const size of steps) {
    const step = canvas(size)
    const ctx = context(step)
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(source, 0, 0, size.width, size.height)
    if (previous) release(previous)
    previous = step
    source = step
  }
  full.close()
  const bitmap = await createImageBitmap(source)
  release(previous!)
  return bitmap
}
