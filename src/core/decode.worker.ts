// Decodes and downscales a page away from the main thread: the same method as
// decode.ts (decode at full size, then downscale on canvases in main memory, in
// steps), which on a large page takes long enough to stall scrolling.
import type { Size } from './fit'
import { downscaleSteps } from './quality'

type Request = { id: number; blob: Blob; target: Size }

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<Request>) => void) | null
  postMessage(message: unknown, transfer?: Transferable[]): void
}

scope.onmessage = async (event) => {
  const { id, blob, target } = event.data
  let full: ImageBitmap
  try {
    full = await createImageBitmap(blob)
  } catch (e) {
    // The format: the page is converted by Rust and tried again
    scope.postMessage({ id, error: String(e), kind: 'decode' })
    return
  }
  try {
    const steps = downscaleSteps(full, target)
    if (steps.length === 0) {
      scope.postMessage({ id, bitmap: full }, [full])
      return
    }
    let source: ImageBitmap | OffscreenCanvas = full
    for (const size of steps) {
      const step = new OffscreenCanvas(size.width, size.height)
      const ctx = step.getContext('2d', { willReadFrequently: true })
      if (!ctx) throw new Error('No 2D canvas in a worker')
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(source, 0, 0, size.width, size.height)
      if (source instanceof OffscreenCanvas) {
        source.width = 0
        source.height = 0
      }
      source = step
    }
    full.close()
    const bitmap = (source as OffscreenCanvas).transferToImageBitmap()
    scope.postMessage({ id, bitmap }, [bitmap])
  } catch (e) {
    full.close()
    // This webview cannot do it in a worker: the main thread will
    scope.postMessage({ id, error: String(e), kind: 'canvas' })
  }
}
