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
 * fitPage), in a worker where the webview allows it (decode.worker.ts). The
 * same method on every platform: decode at full size, then
 * downscale on a canvas in steps (see downscaleSteps). `createImageBitmap`
 * with `resizeQuality: 'high'` is not used: WebKitGTK ignores the quality and
 * Chromium leaves moiré at common ratios (step 1.3, resize-quality spike).
 */
export async function decode(blob: Blob, target: Size): Promise<ImageBitmap> {
  const pool = workers()
  if (pool.length) {
    try {
      return await inWorker(pool, blob, target)
    } catch (e) {
      // A page the webview cannot decode is reported as such; anything else is the
      // worker that cannot do it: the main thread does, from now on
      if ((e as { kind?: string }).kind === 'decode') throw e
      workerPool = []
    }
  }
  return decodeHere(blob, target)
}

/**
 * Two workers decode pages, so that the page the reader waits for is not stuck
 * behind one made in advance. Where a webview has no workers with canvases,
 * there are none and the main thread decodes.
 */
let workerPool: Worker[] | undefined
let nextWorker = 0
let nextId = 0
const pending = new Map<
  number,
  { resolve: (b: ImageBitmap) => void; reject: (e: unknown) => void }
>()

function workers(): Worker[] {
  if (workerPool) return workerPool
  workerPool = []
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return workerPool
  try {
    for (let i = 0; i < 2; i++) {
      const w = new Worker(new URL('./decode.worker.ts', import.meta.url), { type: 'module' })
      w.onmessage = (
        event: MessageEvent<{ id: number; bitmap?: ImageBitmap; error?: string; kind?: string }>,
      ) => {
        const { id, bitmap, error, kind } = event.data
        const p = pending.get(id)
        pending.delete(id)
        if (bitmap) p?.resolve(bitmap)
        else p?.reject(Object.assign(new Error(error), { kind }))
      }
      // A worker that fails without answering: its pages are made on the main thread
      w.onerror = () => {
        workerPool = []
        for (const [id, p] of pending) {
          pending.delete(id)
          p.reject(Object.assign(new Error('The decoding worker stopped'), { kind: 'canvas' }))
        }
      }
      workerPool.push(w)
    }
  } catch {
    workerPool = []
  }
  return workerPool
}

function inWorker(pool: Worker[], blob: Blob, target: Size): Promise<ImageBitmap> {
  const id = nextId++
  const worker = pool[nextWorker++ % pool.length]
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    worker.postMessage({ id, blob, target })
  })
}

/** The same work on the main thread. */
async function decodeHere(blob: Blob, target: Size): Promise<ImageBitmap> {
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
