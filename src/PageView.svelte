<script lang="ts">
  // Shows one page at the screen's physical resolution, fitted or zoomed. The
  // page bytes are fetched once; the page is decoded at the size it is shown
  // (never above the original) and only the visible part is drawn, one canvas
  // pixel per screen pixel. Panning redraws from the same decoded page; zooming,
  // resizing the window or moving it to a screen with another pixel density
  // decodes again. A page that cannot be shown gets a message in its place, and
  // the other pages stay readable.
  import { untrack } from 'svelte'
  import { decode } from './core/decode'
  import { fitPage, type Size } from './core/fit'
  import { fromPointer, fromWheel, type InputEvent } from './core/input'
  import {
    clampView,
    FIT_VIEW,
    panView,
    sameView,
    shownSize,
    visibleRect,
    zoomView,
    type View,
  } from './core/view'
  import { loadConvertedPage, loadPage, type PageData, type Volume } from './core/volume'

  type Props = {
    volume: Volume
    /** Counted from 0. */
    page: number
    /** Every pointer and wheel event on the page, normalized. */
    oninput: (event: InputEvent) => void
  }
  let { volume, page, oninput }: Props = $props()

  let box: HTMLDivElement
  let canvas: HTMLCanvasElement
  /** Available space, in CSS pixels. */
  let viewport = $state<Size>()
  let dpr = $state(devicePixelRatio)
  // Raw: a converted page replaces the bytes in place, without rendering again
  let data = $state.raw<PageData>()
  /** Size of the original image. */
  let original = $state.raw<Size>()
  let view = $state.raw<View>(FIT_VIEW)
  const zoom = $derived(view.zoom)
  /** The page decoded for the current zoom, kept while panning. */
  let decoded = $state.raw<ImageBitmap>()
  /** Why the current page cannot be shown. */
  let failure = $state<string>()

  /** The space for the page in whole physical pixels: it must never need rescaling to fit. */
  const room = $derived(
    viewport && {
      width: Math.floor(viewport.width * dpr),
      height: Math.floor(viewport.height * dpr),
    },
  )
  /** The page fitted to the screen (zoom 1), in physical pixels. */
  const fit = $derived(
    original && room && room.width > 0 && room.height > 0
      ? fitPage(original, { width: room.width / dpr, height: room.height / dpr }, dpr)
      : undefined,
  )

  const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

  function fail(e: unknown) {
    failure = message(e)
    // The previous page must not stay on screen under the new page number
    canvas.width = 0
  }

  function setDecoded(bitmap: ImageBitmap | undefined) {
    decoded?.close()
    decoded = bitmap
  }

  /**
   * Moves a zoomed page by a fraction of the screen. Returns false when there is
   * nothing to move (fitted page, or already at the edge in that direction).
   */
  export function pan(fx: number, fy: number): boolean {
    if (!fit || !room || view.zoom === 1) return false
    const shown = shownSize(fit, view.zoom)
    const next = panView(view, fx * room.width, fy * room.height, shown, room)
    if (sameView(next, view)) return false
    view = next
    return true
  }

  export const zoomed = () => view.zoom > 1
  /** The page area, in CSS pixels. */
  export const area = () => {
    const r = box.getBoundingClientRect()
    return { width: r.width, height: r.height }
  }

  function pointer(event: PointerEvent) {
    // A mouse moving without a button pressed is not part of a gesture
    if (event.type === 'pointermove' && event.pointerType === 'mouse' && !event.buttons) return
    const e = fromPointer(event, box.getBoundingClientRect(), 0)
    if (e) oninput(e)
  }

  export function zoomBy(how: 'in' | 'out' | 'fit') {
    if (!fit || !room) return
    const next = how === 'fit' ? FIT_VIEW : zoomView(view, how === 'in' ? 1.5 : 1 / 1.5)
    view = clampView(next, shownSize(fit, next.zoom), room)
  }

  // A new page: fetch its bytes, start fitted
  $effect(() => {
    let cancelled = false
    data = undefined
    original = undefined
    failure = undefined
    view = FIT_VIEW
    // Untracked: this effect must run on a page change, not when a decode arrives
    untrack(() => setDecoded(undefined))
    loadPage(volume, page).then(
      (loaded) => !cancelled && (data = loaded),
      (e) => !cancelled && fail(e),
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

  // The original size: from Rust's header, or by decoding once
  $effect(() => {
    if (!data) return
    let cancelled = false
    measure(data).then(
      (size) => !cancelled && (original = size),
      (e) => !cancelled && fail(e),
    )
    return () => (cancelled = true)
  })

  // Decode for the current fit and zoom
  $effect(() => {
    if (!data || !original || !fit) return
    const shown = shownSize(fit, zoom)
    // Past the original's own pixels there is nothing more to decode: drawing scales it up
    const target = {
      width: Math.max(Math.min(shown.width, original.width), 1),
      height: Math.max(Math.min(shown.height, original.height), 1),
    }
    let cancelled = false
    decodePage(data, target).then(
      (bitmap) => (cancelled ? bitmap.close() : setDecoded(bitmap)),
      (e) => !cancelled && fail(e),
    )
    return () => (cancelled = true)
  })

  // Keep the view inside the page when the window changes
  $effect(() => {
    if (!fit || !room) return
    const clamped = clampView(view, shownSize(fit, view.zoom), room)
    if (!sameView(clamped, view)) view = clamped
  })

  // Draw the visible part: on every pan, and whenever a new decode arrives
  $effect(() => {
    if (decoded && fit && room) draw(decoded, fit, view, room, dpr)
  })

  async function convert(data: PageData) {
    const converted = await loadConvertedPage(volume, page)
    data.bytes = converted.bytes
    data.size = converted.size
  }

  async function measure(data: PageData): Promise<Size> {
    if (data.size) return data.size
    // No size from Rust: measure by decoding once
    const probe = await createImageBitmap(data.bytes).catch(() => undefined)
    if (probe) {
      const size = { width: probe.width, height: probe.height }
      probe.close()
      return size
    }
    await convert(data)
    return data.size!
  }

  function decodePage(data: PageData, target: Size) {
    return decode(data.bytes, target).catch(async () => {
      // The webview cannot decode this page: ask Rust, and keep its PNG for next time
      await convert(data)
      return decode(data.bytes, target)
    })
  }

  function draw(bitmap: ImageBitmap, fit: Size, view: View, room: Size, dpr: number) {
    const shown = shownSize(fit, view.zoom)
    const r = visibleRect(view, shown, room)
    // One canvas pixel per screen pixel: the browser must not rescale the page
    if (canvas.width !== r.width || canvas.height !== r.height) {
      canvas.width = r.width
      canvas.height = r.height
    }
    // CSS lengths are rounded to 1/64 px: round up, so no pixel row or column is lost
    const cssLength = (pixels: number) => `${Math.ceil((pixels / dpr) * 64) / 64}px`
    canvas.style.width = cssLength(r.width)
    canvas.style.height = cssLength(r.height)
    // Centered, but on a whole physical pixel: at a fractional position, which is
    // common with fractional densities, the browser would resample the page
    const rect = box.getBoundingClientRect()
    const snap = (start: number, length: number, size: number) =>
      Math.round(start * dpr + (length * dpr - size) / 2) / dpr - start
    canvas.style.left = `${snap(rect.left, rect.width, r.width)}px`
    canvas.style.top = `${snap(rect.top, rect.height, r.height)}px`
    // The size can still be a hair off: nearest-neighbor keeps that from blurring the page
    canvas.style.imageRendering = 'pixelated'

    // The decoded page is the shown size, or smaller while a new decode is on its
    // way or when zoomed past the original: then the visible part is scaled here
    const sx = bitmap.width / shown.width
    const sy = bitmap.height / shown.height
    const ctx = canvas.getContext('2d')!
    ctx.imageSmoothingQuality = 'high'
    ctx.clearRect(0, 0, r.width, r.height)
    ctx.drawImage(bitmap, r.x * sx, r.y * sy, r.width * sx, r.height * sy, 0, 0, r.width, r.height)
  }
</script>

<!-- Keyboard users turn pages with the keys handled in App.svelte -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="box"
  bind:this={box}
  onpointerdown={pointer}
  onpointermove={pointer}
  onpointerup={pointer}
  onpointercancel={pointer}
  onwheel={(event) => oninput(fromWheel(event, box.getBoundingClientRect(), 0))}
>
  <canvas bind:this={canvas} width="0" height="0" aria-label="Page {page + 1}"></canvas>
  {#if failure}
    <p class="failure" role="alert">{failure}</p>
  {/if}
</div>

<style>
  .box {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .failure {
    display: grid;
    place-items: center;
    height: 100%;
    margin: 0;
    padding: 16px;
    box-sizing: border-box;
    color: #e08a8a;
    text-align: center;
  }

  canvas {
    position: absolute;
    /* Only while a resize is settling: then the page is decoded at the new size */
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
</style>
