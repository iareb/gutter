import { describe, expect, it } from 'vitest'
import { Cache } from './cache'

function make(budget: number) {
  const gone: string[] = []
  const cache = new Cache<string>(budget, (value) => gone.push(value))
  return { cache, gone }
}

describe('Cache', () => {
  it('holds entries within the budget', () => {
    const { cache, gone } = make(100)
    cache.set('a', 0, 40, 'a')
    cache.set('b', 1, 40, 'b')
    expect(cache.used).toBe(80)
    expect(cache.over).toBe(false)
    expect(gone).toEqual([])
  })

  it('drops the farthest page first', () => {
    const { cache, gone } = make(100)
    cache.setCurrent(5)
    cache.set('p5', 5, 40, 'p5')
    cache.set('p6', 6, 40, 'p6')
    cache.set('p9', 9, 40, 'p9')
    expect(gone).toEqual(['p9'])
    expect(cache.has('p9')).toBe(false)
    expect(cache.used).toBe(80)
  })

  it('counts a page behind as farther than one ahead at the same distance', () => {
    const { cache, gone } = make(100)
    cache.setCurrent(5)
    cache.set('p5', 5, 40, 'p5')
    cache.set('p4', 4, 40, 'p4')
    cache.set('p6', 6, 40, 'p6')
    expect(gone).toEqual(['p4'])
  })

  it('never drops the current page, even over the budget', () => {
    const { cache, gone } = make(100)
    cache.setCurrent(2)
    cache.set('big', 2, 300, 'big')
    cache.set('next', 3, 10, 'next')
    expect(cache.has('big')).toBe(true)
    expect(cache.over).toBe(true)
    expect(gone).toEqual(['next'])
  })

  it('drops the biggest entry of a page first', () => {
    const { cache, gone } = make(100)
    cache.setCurrent(0)
    cache.set('small', 3, 10, 'small')
    cache.set('bitmap', 3, 80, 'bitmap')
    cache.set('here', 0, 30, 'here')
    expect(gone).toEqual(['bitmap'])
  })

  it('frees pages that are far when the current page changes', () => {
    const { cache, gone } = make(100)
    cache.setCurrent(0)
    cache.set('p0', 0, 40, 'p0')
    cache.set('p1', 1, 40, 'p1')
    cache.setCurrent(10)
    cache.set('p10', 10, 40, 'p10')
    expect(gone).toEqual(['p0'])
    expect(cache.has('p1')).toBe(true)
    cache.setCurrent(10)
  })

  it('disposes a replaced entry and a deleted one', () => {
    const { cache, gone } = make(100)
    cache.set('a', 0, 10, 'one')
    cache.set('a', 0, 20, 'two')
    expect(gone).toEqual(['one'])
    expect(cache.used).toBe(20)
    cache.delete('a')
    expect(gone).toEqual(['one', 'two'])
    expect(cache.used).toBe(0)
    cache.delete('missing')
  })

  it('says whether an entry would stay', () => {
    const { cache } = make(100)
    cache.setCurrent(0)
    cache.set('p0', 0, 60, 'p0')
    cache.set('p1', 1, 30, 'p1')
    // 10 free: a page farther than p1 has no room, a nearer one takes p1's place
    expect(cache.canHold(2, 20)).toBe(false)
    expect(cache.canHold(1, 40)).toBe(false)
    expect(cache.canHold(1, 10)).toBe(true)
    expect(cache.canHold(0, 500)).toBe(true)
    cache.set('p5', 5, 5, 'p5')
    // 5 free, and p5 is farther than page 2: it would make room for 10, not for 35
    expect(cache.canHold(2, 10)).toBe(true)
    expect(cache.canHold(2, 35)).toBe(false)
  })

  it('lists the keys and bytes of each page', () => {
    const { cache } = make(1000)
    cache.set('a', 1, 10, 'a')
    cache.set('b', 1, 20, 'b')
    cache.set('c', 2, 5, 'c')
    expect(cache.keysOf(1).sort()).toEqual(['a', 'b'])
    expect([...cache.pages()]).toEqual([
      [1, 30],
      [2, 5],
    ])
  })

  it('shrinks with its budget and empties', () => {
    const { cache, gone } = make(100)
    cache.setCurrent(0)
    cache.set('p0', 0, 50, 'p0')
    cache.set('p1', 1, 50, 'p1')
    cache.setBudget(60)
    expect(gone).toEqual(['p1'])
    cache.clear()
    expect(gone).toEqual(['p1', 'p0'])
    expect(cache.size).toBe(0)
  })
})
