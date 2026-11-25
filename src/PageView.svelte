<script lang="ts">
  // Shows a unit (one page, or two side by side in double page mode) at the
  // screen's physical resolution, fitted or zoomed. Two pages are one virtual
  // page, each scaled to the height of the taller (core/spreads.ts), so zoom and
  // pan work as on a single page. The page store (core/pages.ts) fetches and
  // decodes the pages, and has usually done so already for the units around the
  // current one: a unit that is ready is drawn at once. Each page is decoded at
  // the size it is shown (never above its original) and only the visible part is
  // drawn, one canvas pixel per screen pixel. Panning redraws from the same
  // decoded pages; zooming, resizing the window or moving it to a screen with
  // another pixel density decodes again. A page that cannot be shown gets a
  // message in its place, and the other pages stay readable.
  import { untrack } from 'svelte'
  import type { Edges } from './core/gestures'
  import { fitPage, needsScaling, type Size } from './core/fit'
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
  import type { Direction } from './core/navigation'
  import type { PageStore } from './core/pages'
  import {
    partRects,
    partTargets,
    unitLabel,
    unitSize,
    type Layout,
    type Unit,
  } from './core/spreads'

  type Props = {
    /** Fetches, decodes and keeps the pages of the volume. */
    store: PageStore
    /** The pages shown, counted from 0, in reading order. */
    unit: Unit
    /** Which units come before and after this one. */
    layout: Layout
    /** Reading direction: which unit sits on which side of this one, and the order of a pair. */
    reading: Direction
    /** Every pointer and wheel event on the page, normalized. */
    oninput: (event: InputEvent) => void
    /** Tells when the bytes of the page are being fetched: a page in a solid archive can take a while. */
    onloading?: (loading: boolean) => void
    /** The zoom changed: against the pages' own pixels, 100 shows them one to one. */
    onzoom?: (percent: number) => void
  }
  let { store, unit, layout, reading, oninput, onloading, onzoom }: Props = $props()

  let box: HTMLDivElement
  let canvas: HTMLCanvasElement
  /** Available space, in CSS pixels. */
  let viewport = $state<Size>()
  let dpr = $state(devicePixelRatio)
  // A string: a new array with the same pages must not start the unit again
  const unitKey = $derived(unit.join(','))
  /** The pages of the unit in reading order. */
  const pages = $derived(unitKey.split(',').map(Number))
  /** Their original sizes, once all are known, in reading order. */
  let sizes = $state.raw<Size[]>()
  /** Left to right on screen: a pair is read from the right in right-to-left reading. */
  const onScreen = <T,>(list: readonly T[]) => (reading === 'rtl' ? [...list].reverse() : [...list])
  const screenPages = $derived(onScreen(pages))
  const screenSizes = $derived(sizes && onScreen(sizes))
  /** The unit as one virtual page. */
  const original = $derived(screenSizes && unitSize(screenSizes))
  let view = $state.raw<View>(FIT_VIEW)
  const zoom = $derived(view.zoom)
  /** The pages decoded for the current zoom, in screen order, kept while panning. Owned by the store. */
  let decoded = $state.raw<ImageBitmap[]>()
  /** Why the current unit cannot be shown. */
  let failure = $state<string>()

  // Turning a page slides it out and the next unit in beside it, when the next
  // one is ready (made in advance); otherwise the page changes in place, and the
  // old page stays on screen until the new one can be drawn: never a blank page.
  // Both sit on a strip that moves sideways: under the finger during a swipe, by
  // itself for SLIDE_MS when the page turns. The strip is moved here, not
  // through Svelte, so that a slide cut short by the next one starts from where
  // the strip really is.

  /** How long the pages take to slide. */
  const SLIDE_MS = 200
  /** Space between the page and the one beside it while they slide, in CSS pixels. */
  const GAP = 16
  let strip: HTMLDivElement
  /** The unit beside this one, shown while sliding. */
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
  const space = $derived(room && { width: room.width / dpr, height: room.height / dpr })
  /** The unit fitted to the screen (zoom 1), in physical pixels. */
  const fit = $derived(
    original && room && space && room.width > 0 && room.height > 0
      ? fitPage(original, space, dpr)
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

  /** How far the unit beside sits from this one, in CSS pixels. */
  const besideShift = () => box.getBoundingClientRect().width + GAP

  /** The unit on a side of this one: 1 the right, -1 the left. */
  function unitBeside(side: -1 | 1): Unit | undefined {
    const forward = (side === 1) === (reading === 'ltr')
    return forward ? layout.after(pages) : layout.before(pages)
  }

  /**
   * A unit at zoom 1, in screen order: its pages' sizes and the size each is
   * decoded at, the same the preloading uses. Undefined while a size is not known.
   */
  function fitted(u: Unit, known: (n: number) => Size | undefined) {
    if (!space) return undefined
    const all = u.map(known)
    if (!all.every(Boolean)) return undefined
    const screen = onScreen(all as Size[])
    const unitFit = fitPage(unitSize(screen), space, dpr)
    return {
      pages: onScreen(u),
      sizes: screen,
      fit: unitFit,
      targets: partTargets(screen, unitFit),
    }
  }

  /** Draws the unit on the given side of this one, if it is ready. Returns whether it is. */
  function showBeside(side: -1 | 1): boolean {
    if (besideSide === side) return true
    const u = unitBeside(side)
    const f = u && room && fitted(u, (n) => store.peekSize(n))
    const bitmaps = f && f.pages.map((n, i) => store.cached(n, f.targets[i]))
    if (!f || !bitmaps || !bitmaps.every(Boolean) || !room) {
      hideBeside()
      return false
    }
    draw(
      beside,
      bitmaps as ImageBitmap[],
      f.sizes,
      f.fit,
      FIT_VIEW,
      room,
      dpr,
      side * besideShift(),
    )
    besideSide = side
    return true
  }

  function hideBeside() {
    besideSide = 0
    if (beside) beside.width = 0
  }

  /** Shows the page shifted sideways by `dx` CSS pixels, with the unit beside it: it follows the finger. */
  export function follow(dx: number) {
    store.busy()
    if (leaving) return
    // On a whole physical pixel, like the page itself
    const x = Math.round(dx * dpr) / dpr
    // Pulling to the left uncovers the unit on the right
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
   * unit beside it in, before the page changes. Returns false when that unit is
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

  /** The end of a slide: the strip back in place, with the new unit on it. */
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
    if (decoded && screenSizes && fit && room)
      draw(canvas, decoded, screenSizes, fit, view, room, dpr)
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

  // A new unit: use what the store has of it, start fitted
  $effect(() => {
    let cancelled = false
    const ps = pages
    backwards = ps[0] < previous
    previous = ps[0]
    failure = undefined
    view = FIT_VIEW
    turnStart = performance.now()
    turnReady = undefined
    turnPending = true
    // Untracked: this effect must run on a new unit, not when a decode arrives
    untrack(() => {
      decoded = undefined
      // A page turned by a slide keeps sliding; any other change shows the page in place
      if (!leaving) {
        place(0, false)
        hideBeside()
      }
    })
    store.setCurrent(ps[0], ps.slice(1))
    // Known: the unit is drawn in this same turn if its pages are ready too
    // (A local: reading `sizes` back here would make this effect depend on what it writes)
    const known = ps.map((n) => store.peekSize(n))
    if (known.every(Boolean)) sizes = known as Size[]
    else {
      sizes = undefined
      Promise.all(ps.map((n) => store.size(n))).then(
        (all) => !cancelled && (sizes = all),
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
    if (!screenSizes || !fit) return
    // Past a page's own pixels there is nothing more to decode: drawing scales it up
    const targets = partTargets(screenSizes, shownSize(fit, zoom))
    const ns = screenPages
    const ready = ns.map((n, i) => store.peek(n, targets[i]))
    turnReady ??= ready.every(Boolean)
    if (ready.every(Boolean)) {
      decoded = ready as ImageBitmap[]
      return
    }
    let cancelled = false
    // The first decode of a unit starts at once. A new zoom waits until it stops
    // changing: during a pinch the page is scaled from the decode it already has
    const delay = untrack(() => decoded) ? 150 : 0
    const timer = setTimeout(() => {
      Promise.all(ns.map((n, i) => store.bitmap(n, targets[i]))).then(
        (bitmaps) => !cancelled && (decoded = bitmaps),
        (e) => !cancelled && fail(e),
      )
    }, delay)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  })

  // The zoom against the pages' own pixels, for the bar
  $effect(() => {
    if (fit && original)
      onzoom?.(Math.round((shownSize(fit, view.zoom).width / original.width) * 100))
  })

  // Keep the view inside the page when the window changes
  $effect(() => {
    if (!fit || !room) return
    const clamped = clampView(view, shownSize(fit, view.zoom), room)
    if (!sameView(clamped, view)) view = clamped
  })

  // Draw the visible part: on every pan, and whenever a new decode arrives.
  // While the old page slides out, the new one waits. Once a frame at most: a
  // finger sends several moves a frame, and only the last one is seen.
  // While a zoomed page moves, a decode that has to be scaled (zoomed past the
  // page's own pixels, or while a new decode is on its way) is scaled with the
  // quick filter: the high-quality one took 150 ms a frame on a phone. The page
  // is drawn again with the high-quality filter once it has been still for a moment
  let drawnView: View | undefined
  let drawnDecoded: ImageBitmap[] | undefined
  let sharpTimer: ReturnType<typeof setTimeout> | undefined
  const SHARP_AFTER_MS = 150
  $effect(() => {
    if (!leaving && decoded && screenSizes && fit && room) {
      const moved = drawnDecoded === decoded && drawnView !== undefined && drawnView !== view
      drawnView = view
      drawnDecoded = decoded
      const args = [canvas, decoded, screenSizes, fit, view, room, dpr] as const
      if (!moved) {
        // A new unit or a new decode: drawn now, a turn is timed up to here
        clearTimeout(sharpTimer)
        draw(...args)
        if (turnPending) {
          turnPending = false
          store.turn = {
            page: pages[0],
            ms: performance.now() - Math.max(turnStart, leaveEnd),
            ready: turnReady ?? false,
          }
        }
        return
      }
      const frame = requestAnimationFrame(() => {
        clearTimeout(sharpTimer)
        draw(...args, 0, 'low')
        sharpTimer = setTimeout(() => draw(...args), SHARP_AFTER_MS)
      })
      return () => cancelAnimationFrame(frame)
    }
  })
  $effect(() => () => clearTimeout(sharpTimer))

  // Once the current unit is on screen, get the ones around it ready: two ahead
  // and one behind, the other way round when going back
  $effect(() => {
    if (!decoded || !space) return
    const l = layout
    const u = untrack(() => pages)
    const back = untrack(() => backwards)
    const after = l.after(u)
    const before = l.before(u)
    const order = back
      ? [before, before && l.before(before), after]
      : [after, before, after && l.after(after)]
    const units = order.filter((x): x is Unit => !!x)
    const jobs = untrack(() =>
      units.flatMap((v) =>
        onScreen(v).map((n, i) => ({
          n,
          target: async () => {
            const all = await Promise.all(v.map((m) => store.size(m)))
            const f = fitted(v, (m) => all[v.indexOf(m)])
            return f?.targets[i]
          },
        })),
      ),
    )
    store.prepare(jobs)
  })

  $effect(() => () => clearTimeout(leaveTimer))

  // Another reading direction puts other units on each side
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

  /**
   * Draws the visible part of a unit on a canvas: `bitmaps` and `sizes` in
   * screen order, side by side. `dx` shifts it sideways, in CSS pixels.
   */
  function draw(
    canvas: HTMLCanvasElement,
    bitmaps: readonly ImageBitmap[],
    sizes: readonly Size[],
    fit: Size,
    view: View,
    room: Size,
    dpr: number,
    dx = 0,
    quality: CanvasRenderingContext2D['imageSmoothingQuality'] = 'high',
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

    // On the graphics memory, said outright: the screen's canvas, unlike those that make
    // the pages, is drawn every frame while a page moves, and scales fast there
    const ctx = canvas.getContext('2d', { willReadFrequently: false })!
    ctx.imageSmoothingQuality = quality
    ctx.clearRect(0, 0, r.width, r.height)
    // Each page covers its own strip of the unit. Its decode is the strip's size, or
    // smaller while a new decode is on its way or when zoomed past the original:
    // then the visible part is scaled here
    partRects(sizes, shown.width).forEach((part, i) => {
      const from = Math.max(r.x, part.x)
      const to = Math.min(r.x + r.width, part.x + part.width)
      if (to <= from) return
      const bitmap = bitmaps[i]
      const sx = bitmap.width / part.width
      const sy = bitmap.height / shown.height
      ctx.imageSmoothingEnabled = needsScaling(sx, sy)
      ctx.drawImage(
        bitmap,
        (from - part.x) * sx,
        r.y * sy,
        (to - from) * sx,
        r.height * sy,
        from - r.x,
        0,
        to - from,
        r.height,
      )
    })
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
    <canvas bind:this={canvas} width="0" height="0" aria-label="Page {unitLabel(pages)}"></canvas>
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
