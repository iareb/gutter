import { describe, expect, it } from 'vitest'
import { fitPage, needsScaling } from './fit'

const page = { width: 2000, height: 3000 }

describe('fitPage', () => {
  it('fits the side that runs out first', () => {
    expect(fitPage(page, { width: 1000, height: 1000 }, 1)).toEqual({ width: 667, height: 1000 })
    expect(fitPage(page, { width: 400, height: 1000 }, 1)).toEqual({ width: 400, height: 600 })
  })

  it('works in physical pixels', () => {
    expect(fitPage(page, { width: 400, height: 1000 }, 2.5)).toEqual({ width: 1000, height: 1500 })
  })

  it('applies zoom', () => {
    expect(fitPage(page, { width: 400, height: 1000 }, 1, 2)).toEqual({ width: 800, height: 1200 })
  })

  it('never upscales past the original', () => {
    expect(fitPage(page, { width: 1000, height: 1000 }, 3)).toEqual(page)
    expect(fitPage(page, { width: 400, height: 1000 }, 1, 10)).toEqual(page)
  })
})

describe('needsScaling', () => {
  it('copies a decode made at the size shown', () => {
    expect(needsScaling(1, 1)).toBe(false)
    // A page 3056 pixels high shown 3055 high: the height rounded to whole pixels
    expect(needsScaling(1, 3056 / 3055)).toBe(false)
  })

  it('scales a decode of another size', () => {
    expect(needsScaling(0.5, 0.5)).toBe(true)
    expect(needsScaling(1, 1.02)).toBe(true)
  })
})
