import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { choicesFor, PlaceSaver, startPage, type Reading } from './library'
import { DEFAULT_SETTINGS } from './settings'

const at = (page: number, more: Partial<Reading> = {}): Reading => ({
  page,
  finished: false,
  direction: 'ltr',
  mode: 'single',
  cover: true,
  ...more,
})

describe('choices for a volume', () => {
  it('are the menu’s for a volume never read', () => {
    const menu = { direction: 'rtl', mode: 'double', cover: false } as const
    expect(choicesFor(undefined, menu)).toEqual(menu)
    expect(choicesFor(at(0, { direction: null, mode: null, cover: null }), menu)).toEqual(menu)
  })

  it('are the volume’s own where it has them', () => {
    const own = at(3, { direction: 'rtl', mode: 'vertical', cover: null })
    expect(choicesFor(own, DEFAULT_SETTINGS)).toEqual({
      direction: 'rtl',
      mode: 'vertical',
      cover: true,
    })
  })
})

describe('the page to start at', () => {
  it('is where the volume was left', () => {
    expect(startPage(at(22), 40)).toBe(22)
  })

  it('is the first page for a volume never read', () => {
    expect(startPage(undefined, 40)).toBe(0)
  })

  it('stays inside a volume that got shorter', () => {
    expect(startPage(at(39), 20)).toBe(19)
    expect(startPage(at(-3), 20)).toBe(0)
    expect(startPage(at(5), 0)).toBe(0)
  })
})

describe('saving the place', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function saver() {
    const saved: number[] = []
    const s = new PlaceSaver(
      async (r) => void saved.push(r.page),
      1000,
      () => Date.now(),
    )
    return { s, saved }
  }

  it('saves the first change at once', () => {
    const { s, saved } = saver()
    s.set(at(1))
    expect(saved).toEqual([1])
  })

  it('saves a burst of changes once a second, the last of them', () => {
    const { s, saved } = saver()
    s.set(at(1))
    s.set(at(2))
    s.set(at(3))
    vi.advanceTimersByTime(999)
    expect(saved).toEqual([1])
    vi.advanceTimersByTime(1)
    expect(saved).toEqual([1, 3])
    // After a quiet second, a change is saved at once again
    vi.advanceTimersByTime(1500)
    s.set(at(9))
    expect(saved).toEqual([1, 3, 9])
  })

  it('does not save the same place twice', () => {
    const { s, saved } = saver()
    s.set(at(4))
    vi.advanceTimersByTime(2000)
    s.set(at(4))
    vi.advanceTimersByTime(2000)
    expect(saved).toEqual([4])
    s.set(at(4, { direction: 'rtl' }))
    expect(saved).toEqual([4, 4])
  })

  it('saves nothing for a page turned and turned back within the second', () => {
    const { s, saved } = saver()
    s.set(at(4))
    s.set(at(5))
    s.set(at(4))
    vi.advanceTimersByTime(2000)
    expect(saved).toEqual([4])
  })

  it('saves what is waiting when flushed, and only once', async () => {
    const { s, saved } = saver()
    s.set(at(1))
    s.set(at(7))
    await s.flush()
    expect(saved).toEqual([1, 7])
    vi.advanceTimersByTime(2000)
    await s.flush()
    expect(saved).toEqual([1, 7])
  })

  it('keeps going when a save fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let calls = 0
    const s = new PlaceSaver(async () => {
      calls++
      throw new Error('no library')
    })
    await s.flush()
    s.set(at(1))
    await vi.runAllTimersAsync()
    expect(calls).toBe(1)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
