<script lang="ts">
  // Shows one page at the screen's physical resolution. The page bytes are
  // fetched once; resizing the window or moving it to a screen with another
  // pixel density decodes them again at the new size.
  import { decode } from './core/decode'
  import { fitPage, type Size } from './core/fit'
  import { loadConvertedPage, loadPage, type PageData, type Volume } from './core/volume'

  type Props = {
    volume: Volume
    /** Counted from 0. */
    page: number
    onerror: (message: string) => void
  }
  let { volume, page, onerror }: Props = $props()

  let box: HTMLDivElement
  let canvas: HTMLCanvasElement
  /** Available space, in CSS pixels. */
  let viewport = $state<Size>()
  let dpr = $state(devicePixelRatio)
  // Raw: a converted page replaces the bytes in place, without rendering again
  let data = $state.raw<PageData>()

  const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

  $effect(() => {
    let cancelled = false
    data = undefined
    loadPage(volume, page).then(
      (loaded) => !cancelled && (data = loaded),
      (e) => !cancelled && onerror(message(e)),
    )
    return () => (cancelled = true)
  })

  // While the window is being resized the current page is scaled by CSS;
  // it is decoded again once the size has been stable for a moment
  $effect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const observer = new ResizeObserver(([entry]) => {
      const size = { width: entry.contentRect.width, height: entry.contentRect.height }
      clearTimeout(timer)
      // Scaled by CSS until decoded again: smooth, not pixelated
      canvas.style.imageRendering = 'auto'
      if (viewport) timer = setTimeout(() => (viewport = size), 150)
      else viewport = size
    })
    observer.observe(box)
    return () => {
      observer.disconnect()
      clearTimeout(timer)
    }
  })

  // devicePixelRatio has no change event: watch a media query for the current value
  $effect(() => {
    const query = matchMedia(`(resolution: ${dpr}dppx)`)
    const update = () => (dpr = devicePixelRatio)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  })

  $effect(() => {
    if (!data || !viewport || viewport.width < 1 || viewport.height < 1) return
    let cancelled = false
    render(data, viewport, dpr, () => cancelled).catch((e) => !cancelled && onerror(message(e)))
    return () => (cancelled = true)
  })

  async function convert(data: PageData, { volume, page }: { volume: Volume; page: number }) {
    const converted = await loadConvertedPage(volume, page)
    data.bytes = converted.bytes
    data.size = converted.size
  }

  async function render(data: PageData, viewport: Size, dpr: number, cancelled: () => boolean) {
    const source = { volume, page }
    let size = data.size
    if (!size) {
      // No size from Rust: measure by decoding once
      const probe = await createImageBitmap(data.bytes).catch(() => undefined)
      if (probe) {
        size = { width: probe.width, height: probe.height }
        probe.close()
      } else {
        await convert(data, source)
        size = data.size!
      }
    }
    // Whole physical pixels only: the page must never need rescaling to fit
    const room = {
      width: Math.floor(viewport.width * dpr) / dpr,
      height: Math.floor(viewport.height * dpr) / dpr,
    }
    const fit = fitPage(size, room, dpr)
    const target = { width: Math.max(fit.width, 1), height: Math.max(fit.height, 1) }
    const bitmap = await decode(data.bytes, target).catch(async () => {
      // The webview cannot decode this page: ask Rust, and keep its PNG for next time
      await convert(data, source)
      return decode(data.bytes, target)
    })
    if (cancelled()) {
      bitmap.close()
      return
    }
    // One canvas pixel per screen pixel: the browser must not rescale the page
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    // CSS lengths are rounded to 1/64 px: round up, so no pixel row or column is lost
    const cssLength = (pixels: number) => `${Math.ceil((pixels / dpr) * 64) / 64}px`
    canvas.style.width = cssLength(bitmap.width)
    canvas.style.height = cssLength(bitmap.height)
    // Centered, but on a whole physical pixel: at a fractional position, which is
    // common with fractional densities, the browser would resample the page
    const rect = box.getBoundingClientRect()
    const snap = (start: number, length: number, size: number) =>
      Math.round(start * dpr + (length * dpr - size) / 2) / dpr - start
    canvas.style.left = `${snap(rect.left, rect.width, bitmap.width)}px`
    canvas.style.top = `${snap(rect.top, rect.height, bitmap.height)}px`
    // The size can still be a hair off: nearest-neighbor keeps that from blurring the page
    canvas.style.imageRendering = 'pixelated'
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
    bitmap.close()
  }
</script>

<div class="box" bind:this={box}>
  <canvas bind:this={canvas} width="0" height="0" aria-label="Page {page + 1}"></canvas>
</div>

<style>
  .box {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  canvas {
    position: absolute;
    /* Only while a resize is settling: then the page is decoded at the new size */
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
</style>
