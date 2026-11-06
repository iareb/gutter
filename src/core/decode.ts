import type { Size } from './fit'
import { downscaleSteps } from './quality'

const canvas = (size: Size) => {
  const c = document.createElement('canvas')
  c.width = size.width
  c.height = size.height
  return c
}

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
    const ctx = step.getContext('2d')!
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
