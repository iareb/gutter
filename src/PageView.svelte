<script lang="ts">
  // Shows one page at the screen's physical resolution, fitted or zoomed. The
  // page store (core/pages.ts) fetches and decodes it, and has usually done so
  // already for the pages around the current one: a page that is ready is drawn
  // at once. The page is decoded at the size it is shown (never above the
  // original) and only the visible part is drawn, one canvas pixel per screen
  // pixel. Panning redraws from the same decoded page; zooming, resizing the
  // window or moving it to a screen with another pixel density decodes again.
  // A page that cannot be shown gets a message in its place, and the other pages
  // stay readable.
  import { untrack } from 'svelte'
  import type { Edges } from './core/gestures'
  import { fitPage, type Size } from './core/fit'
  import { listen } from '@tauri-apps/api/event'
  import {
    fromPinch,
    fromPointer,
    fromWheel,
    type InputEvent,
    type NativePinch,
  } from './core/input'
  import {
    clampView,
    FIT_VIEW,
    panView,
    sameView,
    shownSize,
    visibleRect,
    zoomAround,
    zoomView,
    type View,
  } from './core/view'
  import { pageBeside, type Direction } from './core/navigation'
  import type { PageStore } from './core/pages'
  import type { Volume } from './core/volume'

  type Props = {
    volume: Volume
    /** Fetches, decodes and keeps the pages of the volume. */
    store: PageStore
    /** Counted from 0. */
    page: number
    /** Reading direction: which page sits on which side of this one. */
    reading: Direction
    /** Every pointer and wheel event on the page, normalized. */
    oninput: (event: InputEvent) => void
    /** Tells when the bytes of the page are being fetched: a page in a solid archive can take a while. */
    onloading?: (loading: boolean) => void
  }
  let { volume, store, page, reading, oninput, onloading }: Props = $props()

  let box: HTMLDivElement
  let canvas: HTMLCanvasElement
  /** Available space, in CSS pixels. */
  let viewport = $state<Size>()
  let dpr = $state(devicePixelRatio)
  /** Size of the original image. */
  let original = $state.raw<Size>()
  let view = $state.raw<View>(FIT_VIEW)
  const zoom = $derived(view.zoom)
  /** The page decoded for the current zoom, kept while panning. Owned by the store: never closed here. */
  let decoded = $state.raw<ImageBitmap>()
  /** Why the current page cannot be shown. */
  let failure = $state<string>()

  // Turning a page slides it out and the next one in beside it, when the next
  // one is ready (made in advance); otherwise the page changes in place, and the
  // old page stays on screen until the new one can be drawn: never a blank page.
  // Both pages sit on a strip that moves sideways: under the finger during a
  // swipe, by itself for SLIDE_MS when the page turns. The strip is moved here,
  // not through Svelte, so that a slide cut short by the next one starts from
  // where the strip really is.

  /** How long the pages take to slide. */
  const SLIDE_MS = 200
  /** Space between the page and the one beside it while they slide, in CSS pixels. */
  const GAP = 16
  let strip: HTMLDivElement
  /** The page beside this one, shown while sliding. */
  let beside: HTMLCanvasElement
  /** Which side it is drawn on: 1 the right, -1 the left, 0 none. */
  let besideSide: -1 | 0 | 1 = 0
  /** The old page is sliding out: the new one is drawn once it is gone. */
  let leaving = $state(false)
  let leaveTimer: ReturnType<typeof setTimeout> | undefined
  /** For the page-turn time shown by the development overlay. */
  let turnStart = 0
  let leaveEnd = 0
  let turnReady: boolean | undefined
  let turnPending = false
  let previous = 0
  /** Whether the reader is going back: the pages behind are then prepared first. */
  let backwards = false

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

  const loading = $derived(!original && !failure)
  $effect(() => onloading?.(loading))

  const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

  function fail(e: unknown) {
    failure = message(e)
    // The previous page must not stay on screen under the new page number
    canvas.width = 0
  }

  /**
   * Moves a zoomed page by a fraction of the screen. Returns false when there is
   * nothing to move (fitted page, or already at the edge in that direction).
   */
  export function pan(fx: number, fy: number): boolean {
    store.busy()
    if (!fit || !room || view.zoom === 1) return false
    const shown = shownSize(fit, view.zoom)
    const next = panView(view, fx * room.width, fy * room.height, shown, room)
    if (sameView(next, view)) return false
    view = next
    return true
  }

  /** Drags a zoomed page by CSS pixels: the page follows the pointer. */
  export function drag(dx: number, dy: number) {
    store.busy()
    if (!fit || !room || view.zoom === 1) return
    view = panView(view, -dx * dpr, -dy * dpr, shownSize(fit, view.zoom), room)
  }

  /** Zooms keeping the page point at (x, y), CSS pixels in the page area, still. */
  export function zoomAt(factor: number, x: number, y: number) {
    store.busy()
    if (!fit || !room) return
    view = zoomAround(view, factor, { x: x * dpr, y: y * dpr }, fit, room)
  }

  function place(x: number, animate: boolean) {
    strip.style.transition = animate ? `transform ${SLIDE_MS}ms ease-out` : ''
    strip.style.transform = x ? `translateX(${x}px)` : ''
  }

  /** How far the page beside sits from this one, in CSS pixels. */
  const besideShift = () => box.getBoundingClientRect().width + GAP

  /** Draws the page on the given side of this one, if it is ready. Returns whether it is. */
  function showBeside(side: -1 | 1): boolean {
    if (besideSide === side) return true
    const n = pageBeside(page, side, reading)
    const size = n >= 0 && n < volume.pages.length ? store.peekSize(n) : undefined
    const bitmap = size && room && targetOf(n, size)
    if (!bitmap || !room) {
      hideBeside()
      return false
    }
    draw(beside, bitmap.bitmap, bitmap.fit, FIT_VIEW, room, dpr, side * besideShift())
    besideSide = side
    return true
  }

  /** A page at zoom 1, as the preloading made it. */
  function targetOf(n: number, size: Size) {
    const space = { width: room!.width / dpr, height: room!.height / dpr }
    const f = fitPage(size, space, dpr)
    const fit = { width: Math.max(f.width, 1), height: Math.max(f.height, 1) }
    const bitmap = store.cached(n, fit)
    return bitmap && { bitmap, fit }
  }

  function hideBeside() {
    besideSide = 0
    if (beside) beside.width = 0
  }

  /** Shows the page shifted sideways by `dx` CSS pixels, with the page beside it: it follows the finger. */
  export function follow(dx: number) {
    store.busy()
    if (leaving) return
    // On a whole physical pixel, like the page itself
    const x = Math.round(dx * dpr) / dpr
    // Pulling to the left uncovers the page on the right
    if (x !== 0) showBeside(x < 0 ? 1 : -1)
    place(x, false)
  }

  /** Slides the page back in place after a swipe that did not turn it. */
  export function settle() {
    if (leaving) return
    place(0, true)
  }

  /**
   * Slides the page out of the screen, to the left (-1) or the right (1), and the
   * page beside it in, before the page changes. Returns false when that page is
   * not ready: then nothing slides, and the page changes in place.
   */
  export function leave(side: -1 | 1): boolean {
    // A slide still going on ends at once: the next one starts from there
    finish()
    if (!showBeside(-side as -1 | 1)) {
      place(0, false)
      return false
    }
    leaving = true
    place(side * besideShift(), true)
    leaveTimer = setTimeout(finish, SLIDE_MS)
    return true
  }

  /** The end of a slide: the strip back in place, with the new page on it. */
  function finish() {
    if (!leaving) return
    clearTimeout(leaveTimer)
    leaveEnd = performance.now()
    leaving = false
    place(0, false)
    // Applied now, so that a slide starting right after starts from here
    strip.getBoundingClientRect()
    hideBeside()
    // Drawn in this same frame, not after it: the old page must not show again
    if (decoded && fit && room) draw(canvas, decoded, fit, view, room, dpr)
    else canvas.width = 0
  }

  /** Which sides of the page are on screen: past them it cannot be dragged. */
  export function edges(): Edges {
    if (!fit || !room) return { left: true, right: true }
    const shown = shownSize(fit, view.zoom)
    const r = visibleRect(view, shown, room)
    return {
      left: r.x === 0,
      right: r.x + r.width === shown.width,
    }
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
    store.busy()
    const e = fromPointer(event, box.getBoundingClientRect(), 0)
    if (e) oninput(e)
  }

  export function zoomBy(how: 'in' | 'out' | 'fit') {
    if (!fit || !room) return
    const next = how === 'fit' ? FIT_VIEW : zoomView(view, how === 'in' ? 1.5 : 1 / 1.5)
    view = clampView(next, shownSize(fit, next.zoom), room)
  }

  // A new page: use what the store has of it, start fitted
  $effect(() => {
    let cancelled = false
    const n = page
    backwards = n < previous
    previous = n
    failure = undefined
    view = FIT_VIEW
    turnStart = performance.now()
    turnReady = undefined
    turnPending = true
    // Untracked: this effect must run on a page change, not when a decode arrives
    untrack(() => {
      decoded = undefined
      // A page turned by a slide keeps sliding; any other change shows the page in place
      if (!leaving) {
        place(0, false)
        hideBeside()
      }
    })
    store.setCurrent(n)
    // Known: the page is drawn in this same turn if its bitmap is ready too
    // (A local: reading `original` back here would make this effect depend on what it writes)
    const known = store.peekSize(n)
    original = known
    if (!known) {
      store.size(n).then(
        (size) => !cancelled && (original = size),
        (e) => !cancelled && fail(e),
      )
    }
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
      hideBeside()
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

  // Decode for the current fit and zoom
  $effect(() => {
    if (!original || !fit) return
    const shown = shownSize(fit, zoom)
    // Past the original's own pixels there is nothing more to decode: drawing scales it up
    const target = {
      width: Math.max(Math.min(shown.width, original.width), 1),
      height: Math.max(Math.min(shown.height, original.height), 1),
    }
    const n = page
    const ready = store.peek(n, target)
    turnReady ??= !!ready
    if (ready) {
      decoded = ready
      return
    }
    let cancelled = false
    // The first decode of a page starts at once. A new zoom waits until it stops
    // changing: during a pinch the page is scaled from the decode it already has
    const delay = untrack(() => decoded) ? 150 : 0
    const timer = setTimeout(() => {
      store.bitmap(n, target).then(
        (bitmap) => !cancelled && (decoded = bitmap),
        (e) => !cancelled && fail(e),
      )
    }, delay)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  })

  // Keep the view inside the page when the window changes
  $effect(() => {
    if (!fit || !room) return
    const clamped = clampView(view, shownSize(fit, view.zoom), room)
    if (!sameView(clamped, view)) view = clamped
  })

  // Draw the visible part: on every pan, and whenever a new decode arrives.
  // While the old page slides out, the new one waits
  $effect(() => {
    if (!leaving && decoded && fit && room) {
      draw(canvas, decoded, fit, view, room, dpr)
      if (turnPending) {
        turnPending = false
        store.turn = {
          page,
          ms: performance.now() - Math.max(turnStart, leaveEnd),
          ready: turnReady ?? false,
        }
      }
    }
  })

  // Once the current page is on screen, get the ones around it ready
  $effect(() => {
    if (!decoded || !room) return
    const space = { width: room.width / dpr, height: room.height / dpr }
    const n = untrack(() => page)
    const back = untrack(() => backwards)
    store.preload(n, volume.pages.length, back, (o) => fitPage(o, space, dpr))
  })

  $effect(() => () => clearTimeout(leaveTimer))

  // Another reading direction puts other pages on each side
  $effect(() => {
    void reading
    untrack(hideBeside)
  })

  // Touchpad pinch on Linux: WebKitGTK hides it from the page, Rust sends it
  $effect(() => {
    let stop: (() => void) | undefined
    let gone = false
    listen<NativePinch>('pinch', (event) =>
      oninput(fromPinch(event.payload, box.getBoundingClientRect(), performance.now())),
    ).then((unlisten) => (gone ? unlisten() : (stop = unlisten)))
    return () => {
      gone = true
      stop?.()
    }
  })

  // The wheel belongs to the gesture engine: not passive, so the webview neither
  // scrolls nor zooms itself (Ctrl+wheel, and a trackpad pinch on Chromium)
  $effect(() => {
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      oninput(fromWheel(event, box.getBoundingClientRect(), 0))
    }
    box.addEventListener('wheel', wheel, { passive: false })
    return () => box.removeEventListener('wheel', wheel)
  })

  /** Draws the visible part of a page on a canvas; `dx` shifts it sideways, in CSS pixels. */
  function draw(
    canvas: HTMLCanvasElement,
    bitmap: ImageBitmap,
    fit: Size,
    view: View,
    room: Size,
    dpr: number,
    dx = 0,
  ) {
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
    canvas.style.left = `${snap(rect.left, rect.width, r.width) + Math.round(dx * dpr) / dpr}px`
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
>
  <div class="strip" bind:this={strip}>
    <canvas bind:this={canvas} width="0" height="0" aria-label="Page {page + 1}"></canvas>
    <canvas bind:this={beside} width="0" height="0" aria-hidden="true"></canvas>
  </div>
  {#if failure}
    <p class="failure" role="alert">{failure}</p>
  {/if}
</div>

<style>
  .box {
    position: relative;
    /* Every touch on the page goes to the gesture engine: no browser panning or zooming */
    touch-action: none;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .strip {
    position: absolute;
    inset: 0;
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
