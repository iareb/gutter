import { afterEach, describe, expect, it, vi } from 'vitest'
import { PageStore, type Loaders } from './pages'
import type { Size } from './fit'

type Fake = ImageBitmap & { closedAt?: number }

function setup(
  options: { budget?: number; headerSize?: boolean; probe?: boolean; badDecode?: boolean } = {},
) {
  const calls = { load: [] as number[], convert: [] as number[], decode: [] as string[] }
  const original: Size = { width: 1000, height: 1500 }
  const loaders: Loaders = {
    load: async (n) => {
      calls.load.push(n)
      const bytes = new Blob(['x'.repeat(100)])
      return options.headerSize === false ? { bytes } : { bytes, size: original }
    },
    convert: async (n) => {
      calls.convert.push(n)
      return { bytes: new Blob(['p'.repeat(300)]), size: original }
    },
    decode: async (blob, target) => {
      calls.decode.push(`${target.width}x${target.height}`)
      if (options.badDecode && blob.size < 300) throw new Error('cannot decode')
      return { width: target.width, height: target.height, close: vi.fn() } as unknown as Fake
    },
    probe: async () => (options.probe === false ? undefined : original),
  }
  const store = new PageStore(loaders, options.budget ?? 10_000_000)
  return { store, calls, original }
}

const fit = (o: Size): Size => ({
  width: Math.round(o.width / 5),
  height: Math.round(o.height / 5),
})
const T: Size = { width: 200, height: 300 }

afterEach(() => vi.useRealTimers())

describe('PageStore', () => {
  it('fetches a page once however many ask', async () => {
    const { store, calls } = setup()
    await Promise.all([store.data(3), store.data(3), store.size(3)])
    await store.data(3)
    expect(calls.load).toEqual([3])
  })

  it('takes the size from the header, then from the webview, then from Rust', async () => {
    expect(await setup().store.size(0)).toEqual({ width: 1000, height: 1500 })
    const probed = setup({ headerSize: false })
    expect(await probed.store.size(0)).toEqual({ width: 1000, height: 1500 })
    expect(probed.calls.convert).toEqual([])
    const converted = setup({ headerSize: false, probe: false })
    expect(await converted.store.size(0)).toEqual({ width: 1000, height: 1500 })
    expect(converted.calls.convert).toEqual([0])
  })

  it('keeps a decoded page and hands it out again', async () => {
    const { store, calls } = setup()
    expect(store.peek(1, T)).toBeUndefined()
    const bitmap = await store.bitmap(1, T)
    expect(store.peek(1, T)).toBe(bitmap)
    expect(await store.bitmap(1, T)).toBe(bitmap)
    expect(calls.decode).toEqual(['200x300'])
  })

  it('asks Rust for a PNG when the webview cannot decode the page', async () => {
    const { store, calls } = setup({ badDecode: true })
    await store.bitmap(0, T)
    expect(calls.convert).toEqual([0])
    expect(calls.decode).toHaveLength(2)
  })

  it('keeps only the latest size of the page being read', async () => {
    vi.useFakeTimers()
    const { store } = setup()
    store.setCurrent(0)
    const small = await store.bitmap(0, T)
    const big = await store.bitmap(0, { width: 400, height: 600 })
    expect(store.peek(0, T)).toBeUndefined()
    expect(store.peek(0, { width: 400, height: 600 })).toBe(big)
    // Closed a moment later, not at once: the viewer may still be drawing it
    expect(small.close).not.toHaveBeenCalled()
    vi.advanceTimersByTime(500)
    expect(small.close).toHaveBeenCalledOnce()
    expect(store.snapshot().bitmaps).toBe(1)
  })

  it('preloads two pages ahead and one behind, nearest first', async () => {
    const { store, calls } = setup()
    store.setCurrent(5)
    await store.preload(5, 20, false, fit)
    expect(calls.load).toEqual([6, 4, 7])
    expect(calls.decode).toHaveLength(3)
    expect(store.peek(6, fit({ width: 1000, height: 1500 }))).toBeDefined()
  })

  it('preloads the other way round after going back', async () => {
    const { store, calls } = setup()
    store.setCurrent(5)
    await store.preload(5, 20, true, fit)
    expect(calls.load).toEqual([4, 6, 3])
  })

  it('does not go past the first or the last page', async () => {
    const { store, calls } = setup()
    await store.preload(0, 2, false, fit)
    expect(calls.load).toEqual([1])
  })

  it('does not prepare a page twice', async () => {
    const { store, calls } = setup()
    store.setCurrent(5)
    await store.preload(5, 20, false, fit)
    await store.preload(5, 20, false, fit)
    expect(calls.decode).toHaveLength(3)
  })

  it('stops when the page changes', async () => {
    const { store, calls } = setup()
    store.setCurrent(5)
    const first = store.preload(5, 20, false, fit)
    store.setCurrent(10)
    const second = store.preload(10, 20, false, fit)
    await Promise.all([first, second])
    expect(calls.load).not.toContain(7)
    expect(calls.load).toContain(11)
  })

  it('waits while a gesture is going on', async () => {
    vi.useFakeTimers()
    const { store, calls } = setup()
    store.setCurrent(5)
    store.busy()
    const run = store.preload(5, 20, false, fit)
    await vi.advanceTimersByTimeAsync(200)
    expect(calls.load).toEqual([])
    await vi.advanceTimersByTimeAsync(400)
    await run
    expect(calls.load).toEqual([6, 4, 7])
  })

  it('skips a page that would not fit in the budget', async () => {
    // A 200 x 300 bitmap is 240 000 bytes; the budget holds the encoded pages and one bitmap
    const { store, calls } = setup({ budget: 300_000 })
    store.setCurrent(5)
    await store.bitmap(5, T)
    await store.preload(5, 20, false, fit)
    expect(calls.decode).toHaveLength(1)
    expect(store.snapshot().used).toBeLessThanOrEqual(300_000 + 240_000)
  })

  it('never holds more than the budget around the current page', async () => {
    const { store } = setup({ budget: 1_000_000 })
    for (let page = 0; page < 30; page++) {
      store.setCurrent(page)
      await store.bitmap(page, T)
      await store.preload(page, 30, false, fit)
      expect(store.snapshot().used).toBeLessThanOrEqual(1_000_000)
    }
  })

  it('drops the decoded pages that are far from the current one, not their bytes', async () => {
    vi.useFakeTimers()
    const { store } = setup()
    store.setCurrent(5)
    const near = await store.bitmap(7, T)
    const far = await store.bitmap(9, T)
    expect(store.peek(9, T)).toBeUndefined()
    expect(store.peek(7, T)).toBe(near)
    vi.advanceTimersByTime(500)
    expect(far.close).toHaveBeenCalled()
    expect(near.close).not.toHaveBeenCalled()
    store.setCurrent(1)
    expect(store.peek(7, T)).toBeUndefined()
    // The encoded page is still there: no second fetch
    const again = await store.data(7)
    expect(again).toBeDefined()
  })

  it('prepares the pages it is given, at the sizes they ask for', async () => {
    const { store, calls } = setup()
    store.setCurrent(4)
    await store.prepare([
      { n: 5, target: async () => ({ width: 100, height: 150 }) },
      { n: 6, target: async () => undefined },
      { n: 7, target: async () => ({ width: 90, height: 150 }) },
    ])
    expect(calls.decode).toEqual(['100x150', '90x150'])
    expect(store.cached(5, { width: 100, height: 150 })).toBeDefined()
  })

  it('keeps more decoded pages when asked to', async () => {
    const { store } = setup()
    store.setCurrent(0)
    await store.bitmap(5, T)
    expect(store.cached(5, T)).toBeUndefined()
    store.setKeep({ ahead: 6, behind: 4 })
    await store.bitmap(5, T)
    expect(store.cached(5, T)).toBeDefined()
    store.setKeep({ ahead: 3, behind: 2 })
    expect(store.cached(5, T)).toBeUndefined()
  })

  it('learns sizes read elsewhere', async () => {
    const { store, calls } = setup()
    store.learnSizes(3, [{ width: 10, height: 20 }, null])
    expect(store.peekSize(3)).toEqual({ width: 10, height: 20 })
    expect(store.peekSize(4)).toBeUndefined()
    expect(await store.size(3)).toEqual({ width: 10, height: 20 })
    expect(calls.load).toEqual([])
  })

  it('drops everything on dispose', async () => {
    vi.useFakeTimers()
    const { store } = setup()
    const bitmap = await store.bitmap(0, T)
    store.dispose()
    expect(store.snapshot().used).toBe(0)
    vi.advanceTimersByTime(500)
    expect(bitmap.close).toHaveBeenCalled()
  })
})
