import type { Size } from './fit'

/**
 * Sizes to draw at when downscaling on a canvas. Halve while the result is
 * still at least the target; if the target is not reached exactly, scale to
 * twice the target and halve once more. Every path ends in an exact 2:1
 * step, which averages 2 × 2 pixels: the browsers' own single-step filters
 * leave moiré at ratios below about 2.8 (measured in Chromium, step 1.3).
 */
export function downscaleSteps(from: Size, to: Size): Size[] {
  const steps: Size[] = []
  let { width, height } = from
  while (width / 2 >= to.width && height / 2 >= to.height) {
    width = Math.round(width / 2)
    height = Math.round(height / 2)
    steps.push({ width, height })
  }
  if (width !== to.width || height !== to.height) {
    steps.push({ width: to.width * 2, height: to.height * 2 }, to)
  }
  return steps
}
