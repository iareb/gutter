import { describe, expect, it } from 'vitest'
import { decay, FLING_TIME_MS, Velocity } from './fling'

describe('Velocity', () => {
  it('measures the last moments of a drag', () => {
    const v = new Velocity()
    // Slow at first, then fast: only the last 100 ms count (70 px in 100 ms)
    v.add(0, 0)
    v.add(200, 20)
    v.add(250, 40)
    v.add(300, 90)
    expect(v.get(300)).toBeCloseTo(0.7, 5)
  })

  it('is zero when the finger stopped before letting go, or never moved', () => {
    const v = new Velocity()
    v.add(0, 0)
    v.add(50, 50)
    expect(v.get(200)).toBe(0)
    const still = new Velocity()
    still.add(0, 10)
    expect(still.get(0)).toBe(0)
  })
})

describe('decay', () => {
  it('slows down by the same amount whatever the frame rate', () => {
    let a = { distance: 0, v: 2 }
    let total60 = 0
    for (let i = 0; i < 60; i++) {
      a = decay(a.v, 1000 / 60)
      total60 += a.distance
    }
    let b = { distance: 0, v: 2 }
    let total120 = 0
    for (let i = 0; i < 120; i++) {
      b = decay(b.v, 1000 / 120)
      total120 += b.distance
    }
    expect(total60).toBeCloseTo(total120, 6)
    expect(a.v).toBeCloseTo(b.v, 6)
  })

  it('goes as far as speed times the time constant, in the end', () => {
    const { distance, v } = decay(2, 100_000)
    expect(distance).toBeCloseTo(2 * FLING_TIME_MS, 3)
    expect(v).toBeCloseTo(0, 6)
  })
})
