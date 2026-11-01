import { describe, expect, it } from 'vitest'
import { fitPage } from './fit'

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
