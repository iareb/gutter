import { describe, expect, it } from 'vitest'
import { downscaleSteps } from './quality'

describe('downscaleSteps', () => {
  it('halves, then ends with an exact halving from twice the target', () => {
    expect(downscaleSteps({ width: 2400, height: 3600 }, { width: 1080, height: 1620 })).toEqual([
      { width: 1200, height: 1800 },
      { width: 2160, height: 3240 },
      { width: 1080, height: 1620 },
    ])
  })

  it('halves many times for a small target', () => {
    const steps = downscaleSteps({ width: 8000, height: 8000 }, { width: 900, height: 900 })
    expect(steps.map((s) => s.width)).toEqual([4000, 2000, 1000, 1800, 900])
  })

  it('stops at a halving that hits the target exactly', () => {
    expect(downscaleSteps({ width: 400, height: 600 }, { width: 200, height: 300 })).toEqual([
      { width: 200, height: 300 },
    ])
  })

  it('goes through twice the target for a small reduction', () => {
    expect(downscaleSteps({ width: 1000, height: 1500 }, { width: 800, height: 1200 })).toEqual([
      { width: 1600, height: 2400 },
      { width: 800, height: 1200 },
    ])
  })

  it('does nothing at the original size', () => {
    expect(downscaleSteps({ width: 800, height: 1200 }, { width: 800, height: 1200 })).toEqual([])
  })

  it('always ends on the target', () => {
    for (const width of [101, 333, 727, 1080, 1999]) {
      const to = { width, height: Math.round(width * 1.5) }
      const steps = downscaleSteps({ width: 2400, height: 3600 }, to)
      expect(steps.at(-1)).toEqual(to)
    }
  })
})
