<script lang="ts">
  // Vertical scroll: the pages one under the other, all as wide as the strip, with no
  // gap (core/strip.ts). The strip starts as wide as the screen but never wider than
  // a page's own pixels, and zooms from a column of about two pages in the screen's
  // height to 8× (core/stripzoom.ts); a zoom the reader chooses is kept for every
  // volume. One canvas the size of the screen shows the part of the
  // strip under it, drawn one image pixel per screen pixel; only the pages near
  // the screen are decoded, and the screen after the visible one is made ready
  // while the reader looks. A page not decoded yet is a dark placeholder of the
  // right height (or of an estimated one, corrected without moving the picture).
  //
  // The wheel scrolls: a mouse notch about an eighth of the screen, a trackpad
  // as it moves. A finger (or the mouse) drags the strip, and a finger lets it
  // go with inertia (core/fling.ts). A tap on the left or right quarter scrolls
  // a screen back or forward (mirrored in right-to-left reading, as in the page
  // modes); a double tap in the middle zooms in 2× there, or back. Pinch,
  // Ctrl+wheel, + - 0 and the bar's buttons (zoomBy) zoom; wider than the screen,
  // it also moves sideways (Shift+wheel, a sideways wheel, or the drag). Keys come
  // through key().
  import { untrack } from 'svelte'
  import { SvelteMap, SvelteSet } from 'svelte/reactivity'
  import { listen } from '@tauri-apps/api/event'
  import { fitPage, needsScaling, type Size } from './core/fit'
  import { decay, FLING_START, FLING_STOP, Velocity } from './core/fling'
  import { fromPinch, type NativePinch } from './core/input'
  import type { Direction } from './core/navigation'
  import type { PageStore } from './core/pages'
  import { Strip } from './core/strip'
  import {
    loadStripZoom,
    minZoom,
    percent,
    saveStripZoom,
    startZoom,
    stripLeft,
  } from './core/stripzoom'
  import { MAX_ZOOM } from './core/view'

  type Props = {
    store: PageStore
    count: number
    /** The page to start at, counted from 0. */
    start: number
    /** Bumped when page sizes are learned elsewhere: the strip is laid out again. */
    sizesSeen: number
    /** Reading direction: which side of the screen a tap moves forward. */
    reading: Direction
    /** The page at the top of the screen changed. */
    onpage: (page: number) => void
    onloading?: (loading: boolean) => void
    /** The zoom changed: against the page's own pixels, 100 shows them one to one. */
    onzoom?: (percent: number) => void
  }
  let { store, count, start, sizesSeen, reading, onpage, onloading, onzoom }: Props = $props()

  let box: HTMLDivElement
  let canvas: HTMLCanvasElement
  let viewport = $state<Size>()
  let dpr = $state(devicePixelRatio)
  const strip = untrack(() => new Strip(count))
  let started = false
  /** Where a smooth scroll is going, in strip pixels. */
  let goal = 0
  let frame = 0
  let animating = false
  let reported = -1
  const failures = new SvelteMap<number, string>()
  /** Sizes and decodes on their way, so that a frame does not ask for them again. */
  const asked = new SvelteSet<string>()
  let preloadTimer: ReturnType<typeof setTimeout> | undefined
  /**
   * The strip's width against the screen's (1: as wide; less: a column in the middle;
   * more: wider, and moved sideways by panX). It starts as wide as the screen but no
   * wider than a page's own pixels, unless the reader chose a zoom: that one is kept
   * for every volume (core/stripzoom.ts).
   */
  let chosen = loadStripZoom()
  let zoom = chosen ?? 1
  /** The reader set the zoom (now, or before for every volume): laying out again keeps it. */
  let touched = chosen !== undefined
  let panX = 0
  /** The zoom last told to the bar. */
  let told = -1
  /** The zoom is changing: pages are shown from the decodes there are, made again once it rests. */
  let zooming = false
  let zoomTimer: ReturnType<typeof setTimeout> | undefined
  /** The fling going on, if any. */
  let fling = 0

  /** Physical pixels of the screen. */
  const room = () =>
    viewport && {
      width: Math.floor(viewport.width * dpr),
      height: Math.floor(viewport.height * dpr),
    }

  /** The strip's width at the current zoom. */
  const stripWidth = (r: Size) => Math.max(1, Math.round(r.width * zoom))

  /** A page's own size, to measure the zoom against: the one at the top of the screen. */
  const pageSize = () => store.peekSize(strip.page) ?? store.peekSize(untrack(() => start))

  /** The zoom the strip starts at, and comes back to with 0. */
  function startOf(r: Size): number {
    return startZoom(r.width, pageSize()?.width ?? 0)
  }

  /** The narrowest the strip can get. */
  function lowest(r: Size): number {
    const p = pageSize()
    // Before any page's size is known there is nothing to bound it by but the floor
    return p ? minZoom(r, p, startOf(r)) : 0.1
  }

  /** The strip is wider than the screen: it moves sideways. */
  const wide = () => strip.stripWidth > (room()?.width ?? 0)

  /** Keeps the sideways position inside the strip. */
  function clampPan() {
    const r = room()
    panX = r ? Math.min(Math.max(panX, 0), Math.max(0, strip.stripWidth - r.width)) : 0
  }

  function relayout() {
    const r = room()
    if (!r) return
    // The start depends on the window and on the pages, which may just have become known;
    // a zoom the reader set stays, inside the bounds of these pages
    if (!touched) zoom = startOf(r)
    else if (!zooming) zoom = Math.min(Math.max(zoom, lowest(r)), MAX_ZOOM)
    strip.layout(stripWidth(r), r.height, (n) => store.peekSize(n))
    if (!started) {
      strip.jump(untrack(() => start))
      started = true
    }
    if (!animating) goal = strip.top
    clampPan()
    schedule()
  }

  // A new size of the window or of the pages: lay the strip out again, keeping the place
  $effect(() => {
    void viewport
    void dpr
    void sizesSeen
    untrack(relayout)
  })

  $effect(() => {
    const observer = new ResizeObserver(([entry]) => {
      viewport = { width: entry.contentRect.width, height: entry.contentRect.height }
    })
    observer.observe(box)
    return () => observer.disconnect()
  })

  $effect(() => {
    const query = matchMedia(`(resolution: ${dpr}dppx)`)
    const update = () => (dpr = devicePixelRatio)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  })

  function schedule() {
    if (!frame) frame = requestAnimationFrame(draw)
  }

  /**
   * Where the strip was last drawn. Drawn somewhere else, it is moving: a decode that
   * has to be scaled (zoomed past a page's own pixels, or while a new decode is on its
   * way) is then scaled with no filter, which costs about what a copy does on this
   * canvas in main memory. The high-quality filter took 150 ms a frame on a phone
   * while a zoomed strip moved. Once the strip has been still for a moment it is
   * drawn again with it.
   */
  let drawnAt = ''
  let sharpTimer: ReturnType<typeof setTimeout> | undefined
  const SHARP_AFTER_MS = 150

  /** The size a page is decoded at: the strip's width, never above the page's own pixels. */
  function targetOf(n: number): Size | undefined {
    const size = store.peekSize(n)
    if (!size || !viewport) return undefined
    const t = fitPage(size, { width: strip.stripWidth / dpr, height: Infinity }, dpr)
    return { width: Math.max(t.width, 1), height: Math.max(t.height, 1) }
  }

  /** Gets a page near the screen decoded, once: its size first if it is not known. */
  function want(n: number) {
    const target = targetOf(n)
    if (!target) {
      if (asked.has(`s${n}`)) return
      asked.add(`s${n}`)
      store.size(n).then(
        () => {
          asked.delete(`s${n}`)
          relayout()
        },
        (e) => {
          failures.set(n, e instanceof Error ? e.message : String(e))
          schedule()
        },
      )
      return
    }
    // While the zoom changes, nothing new is made: it would be the wrong size by the time it is ready
    if (zooming) return
    // Already made: asking again would answer at once and draw again, every frame
    if (store.cached(n, target)) return
    const key = `b${n}:${target.width}`
    if (asked.has(key)) return
    asked.add(key)
    // Once made, the page may still leave the cache later: then it is asked for again
    store.bitmap(n, target).then(
      () => {
        asked.delete(key)
        schedule()
      },
      (e) => {
        failures.set(n, e instanceof Error ? e.message : String(e))
        schedule()
      },
    )
  }

  function draw() {
    frame = 0
    const r = room()
    if (!r || !strip.stripWidth) return
    if (canvas.width !== r.width || canvas.height !== r.height) {
      canvas.width = r.width
      canvas.height = r.height
    }
    // Whole CSS pixels of the box, rounded up so no physical row is lost
    canvas.style.width = `${Math.ceil((r.width / dpr) * 64) / 64}px`
    canvas.style.height = `${Math.ceil((r.height / dpr) * 64) / 64}px`
    // On a whole physical pixel: at a fractional position the browser would resample the pages
    const at = box.getBoundingClientRect()
    canvas.style.left = `${Math.round(at.left * dpr) / dpr - at.left}px`
    canvas.style.top = `${Math.round(at.top * dpr) / dpr - at.top}px`
    // In main memory: on an accelerated canvas every page drawn would be uploaded to
    // the graphics memory and kept there (618 MB of webview at the end of a volume
    // on Windows, against 372 MB); here only a screen of pixels goes to the screen
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    ctx.imageSmoothingQuality = 'high'
    const at_ = `${strip.top},${panX},${strip.stripWidth}`
    const moving = drawnAt !== '' && at_ !== drawnAt
    drawnAt = at_
    clearTimeout(sharpTimer)
    if (moving) sharpTimer = setTimeout(schedule, SHARP_AFTER_MS)
    ctx.fillStyle = '#111113'
    ctx.fillRect(0, 0, r.width, r.height)
    const visible = strip.pagesAround(0, 0)
    const width = strip.stripWidth
    // A strip narrower than the screen is a column in the middle; a wider one shows
    // the part of its width that panX has moved to
    const left = stripLeft(r.width, width)
    const from = panX
    const shown = Math.min(r.width - left, width - panX)
    const p = pageSize()
    const pct = p ? percent(width, p.width) : -1
    if (pct !== told && pct > 0) {
      told = pct
      onzoom?.(pct)
    }
    let missing = false
    for (const n of visible) {
      const y = strip.offset(n) - strip.top
      const h = strip.height(n)
      const target = targetOf(n)
      // The right decode, or while it is being made (after a zoom) the best there is, scaled
      const bitmap = (target && store.cached(n, target)) || store.anyBitmap(n)
      if (bitmap) {
        const sx = bitmap.width / width
        ctx.imageSmoothingEnabled = !moving && needsScaling(sx, bitmap.height / h)
        ctx.drawImage(bitmap, from * sx, 0, shown * sx, bitmap.height, left, y, shown, h)
        if (target && bitmap.width !== target.width) want(n)
        continue
      }
      missing = true
      ctx.fillStyle = '#1a1a1f'
      ctx.fillRect(left, y, shown, h)
      ctx.fillStyle = failures.has(n) ? '#e08a8a' : '#55555c'
      ctx.font = `${Math.round(14 * dpr)}px system-ui, sans-serif`
      ctx.textAlign = 'center'
      ctx.fillText(
        failures.get(n) ?? `Page ${n + 1}`,
        r.width / 2,
        y + Math.min(h / 2, r.height / 2),
      )
      if (!failures.has(n)) want(n)
    }
    // Half a screen beyond the visible part, decoded too: it is the next to show
    for (const n of strip.pagesAround(r.height / 2, r.height / 2)) if (!visible.includes(n)) want(n)
    onloading?.(missing)
    if (strip.page !== reported) {
      reported = strip.page
      onpage(strip.page)
    }
    store.setCurrent(strip.page, visible)
    clearTimeout(preloadTimer)
    preloadTimer = setTimeout(preload, 150)
  }

  /** Once the scroll rests: the next screen made ready, and a little behind. */
  function preload() {
    const r = room()
    if (!r || zooming) return
    const near = new Set(strip.pagesAround(r.height / 2, r.height / 2))
    const ahead = strip.pagesAround(0, r.height * 2).filter((n) => !near.has(n))
    const behind = strip
      .pagesAround(r.height, 0)
      .filter((n) => !near.has(n))
      .reverse()
    store.prepare(
      [...ahead, ...behind].map((n) => ({
        n,
        target: async () => {
          await store.size(n)
          return targetOf(n)
        },
      })),
    )
  }

  /** Stops a smooth scroll or a fling where it is. */
  function stop() {
    cancelAnimationFrame(fling)
    fling = 0
    animating = false
    goal = strip.top
  }

  /** Moves the strip by physical pixels; smoothly unless `now`. */
  function move(dy: number, now = false) {
    store.busy()
    cancelAnimationFrame(fling)
    fling = 0
    goal = Math.min(Math.max(goal + dy, 0), Math.max(0, strip.total - (room()?.height ?? 0)))
    if (now) {
      strip.setTop(goal)
      schedule()
      return
    }
    if (!animating) {
      animating = true
      requestAnimationFrame(step)
    }
  }

  function step() {
    if (!animating) return
    const d = goal - strip.top
    if (Math.abs(d) < 1) {
      strip.setTop(goal)
      animating = false
      draw()
      return
    }
    strip.setTop(strip.top + (Math.abs(d) < 4 ? d : d * 0.35))
    draw()
    requestAnimationFrame(step)
  }

  /** Lets the strip go at `v` physical pixels per millisecond, slowing down. */
  function startFling(v: number) {
    stop()
    let last = performance.now()
    let speed = v
    const tick = (now: number) => {
      const s = decay(speed, now - last)
      last = now
      speed = s.v
      const moved = strip.scrollBy(s.distance)
      goal = strip.top
      store.busy()
      draw()
      fling = moved && Math.abs(speed) > FLING_STOP ? requestAnimationFrame(tick) : 0
    }
    fling = requestAnimationFrame(tick)
  }

  /** Moves the strip sideways, when it is wider than the screen, by physical pixels. */
  function pan(dx: number) {
    if (!wide()) return
    panX += dx
    clampPan()
    schedule()
  }

  /**
   * Zooms the strip by `factor` (or `to` a zoom), keeping the point (x, y) of the
   * screen, in CSS pixels, over the same place of the page. `keep`: the reader chose
   * this zoom, and it is kept for every volume once it rests; a double tap's is a look
   * at a detail, and is not.
   */
  function zoomAt(factor: number, x: number, y: number, keep = true, to?: number) {
    const r = room()
    if (!r) return
    const wanted = to ?? zoom * factor
    if (!Number.isFinite(wanted) || wanted <= 0) return
    const next = Math.min(Math.max(wanted, lowest(r)), MAX_ZOOM)
    if (next === zoom) return
    stop()
    store.busy()
    const px = x * dpr
    const py = y * dpr
    // Where the point is on the strip, as a fraction of its width and its height
    const fx = (px - stripLeft(r.width, strip.stripWidth) + panX) / strip.stripWidth
    const fy = (strip.top + py) / Math.max(strip.total, 1)
    zoom = next
    touched = true
    if (keep) chosen = next
    strip.layout(stripWidth(r), r.height, (n) => store.peekSize(n))
    strip.setTop(fy * strip.total - py)
    goal = strip.top
    panX = fx * strip.stripWidth - px + stripLeft(r.width, strip.stripWidth)
    clampPan()
    zooming = true
    clearTimeout(zoomTimer)
    zoomTimer = setTimeout(() => {
      zooming = false
      saveStripZoom(chosen)
      schedule()
    }, 200)
    schedule()
  }

  const middle = (r: Size) => [r.width / dpr / 2, r.height / dpr / 2] as const

  /**
   * Back to where the strip starts (as wide as the screen, no wider than the page's
   * own pixels), keeping still the point (x, y) of the screen, by default its middle:
   * the point the keys zoom on, so + then 0 comes back. The kept zoom is forgotten.
   */
  function toStart(x?: number, y?: number) {
    const r = room()
    if (!r) return
    chosen = undefined
    saveStripZoom(undefined)
    const [mx, my] = middle(r)
    zoomAt(1, x ?? mx, y ?? my, false, startOf(r))
    touched = false
  }

  /** Zoom in, zoom out, or back to the start: the bar's buttons. */
  export function zoomBy(how: 'in' | 'out' | 'fit') {
    const r = room()
    if (!r) return
    const [mx, my] = middle(r)
    if (how === 'fit') toStart()
    else zoomAt(how === 'in' ? 1.25 : 1 / 1.25, mx, my)
  }

  /** Scrolls by a fraction of the screen. */
  export function scroll(screens: number) {
    move(screens * (room()?.height ?? 0))
  }

  /** The top of a page at the top of the screen. */
  export function jumpTo(page: number) {
    stop()
    strip.jump(page)
    goal = strip.top
    schedule()
  }

  /** The page at the top of the screen. */
  export const page = () => strip.page

  /**
   * The keys of vertical scroll. Returns whether the key did something.
   * Down, up, PageDown, PageUp and Space scroll; Home and End go to the ends;
   * the left and right arrows go to the previous and next page, or move a
   * zoomed strip sideways; + - 0 zoom.
   */
  export function key(name: string, shift = false): boolean {
    const r = room()
    if (!r) return false
    switch (name) {
      case 'ArrowDown':
        return (move(r.height / 8), true)
      case 'ArrowUp':
        return (move(-r.height / 8), true)
      case 'PageDown':
        return (move(r.height * 0.9), true)
      case 'PageUp':
        return (move(-r.height * 0.9), true)
      case ' ':
        return (move(shift ? -r.height * 0.9 : r.height * 0.9), true)
      case 'Home':
        return (jumpTo(0), true)
      case 'End':
        stop()
        strip.setTop(strip.total)
        goal = strip.top
        schedule()
        return true
      case 'ArrowRight':
        if (wide()) return (pan(r.width * 0.3), true)
        return (jumpTo(strip.page + 1), true)
      case 'ArrowLeft': {
        if (wide()) return (pan(-r.width * 0.3), true)
        // Back to the top of this page, or to the previous one when already there
        const atTop = strip.top === strip.offset(strip.page)
        return (jumpTo(atTop ? strip.page - 1 : strip.page), true)
      }
      case '+':
      case '=':
        return (zoomBy('in'), true)
      case '-':
        return (zoomBy('out'), true)
      case '0':
        return (zoomBy('fit'), true)
    }
    return false
  }

  // The wheel: a notch (100 CSS pixels) moves an eighth of the screen, a trackpad
  // moves the strip as far as the fingers go. Ctrl+wheel zooms on the cursor (a
  // trackpad pinch arrives that way on Chromium); Shift or a sideways wheel moves
  // a zoomed strip sideways
  $effect(() => {
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      const r = room()
      if (!r) return
      const lines = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? r.height / dpr : 1
      const b = box.getBoundingClientRect()
      if (event.ctrlKey) {
        const dy = event.deltaY * lines
        const factor = Math.abs(dy) < 50 ? Math.exp(-dy * 0.01) : 1.25 ** (-dy / 100)
        zoomAt(factor, event.clientX - b.left, event.clientY - b.top)
        return
      }
      const sideways = event.shiftKey && event.deltaX === 0 ? event.deltaY : event.deltaX
      if (sideways && wide()) pan(sideways * lines * dpr)
      if (event.shiftKey) return
      const css = event.deltaY * lines
      if (css) move(css * dpr * (r.height / dpr / 8 / 100))
    }
    box.addEventListener('wheel', wheel, { passive: false })
    return () => box.removeEventListener('wheel', wheel)
  })

  // Touchpad pinch on Linux: WebKitGTK hides it from the page, Rust sends it
  $effect(() => {
    let stopListening: (() => void) | undefined
    let gone = false
    let scale = 1
    listen<NativePinch>('pinch', (event) => {
      const b = box.getBoundingClientRect()
      const e = fromPinch(event.payload, b, performance.now())
      if (e.phase !== 'update') {
        scale = 1
        return
      }
      zoomAt(e.scale / scale, e.x, e.y)
      scale = e.scale
    }).then((unlisten) => (gone ? unlisten() : (stopListening = unlisten)))
    return () => {
      gone = true
      stopListening?.()
    }
  })

  // Pointers: a drag moves the strip (a finger lets it go with inertia), a tap on
  // a side scrolls a screen, a double tap in the middle zooms, two fingers pinch
  const TAP_SLOP = 10
  const TAP_MS = 500
  const DOUBLE_TAP_MS = 300
  type Point = { x: number; y: number }
  const fingers = new SvelteMap<number, Point>()
  let press:
    | { id: number; kind: string; start: Point; last: Point; t0: number; dragging: boolean }
    | undefined
  let pinch: { distance: number } | undefined
  let lastTap: { t: number; p: Point } | undefined
  const velocity = new Velocity()

  const local = (event: PointerEvent): Point => {
    const b = box.getBoundingClientRect()
    return { x: event.clientX - b.left, y: event.clientY - b.top }
  }
  const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)

  function pointer(event: PointerEvent) {
    const p = local(event)
    const now = performance.now()
    switch (event.type) {
      case 'pointerdown': {
        if (event.pointerType === 'mouse' && event.button !== 0) return
        fingers.set(event.pointerId, p)
        stop()
        if (fingers.size === 2) {
          // A second finger: whatever the first was doing, this is a pinch
          const [a, b] = [...fingers.values()]
          pinch = { distance: distance(a, b) }
          press = undefined
          lastTap = undefined
          return
        }
        if (fingers.size === 1) {
          press = {
            id: event.pointerId,
            kind: event.pointerType,
            start: p,
            last: p,
            t0: now,
            dragging: false,
          }
          velocity.clear()
          velocity.add(now, p.y)
        }
        return
      }
      case 'pointermove': {
        if (!fingers.has(event.pointerId)) return
        fingers.set(event.pointerId, p)
        if (pinch && fingers.size === 2) {
          const [a, b] = [...fingers.values()]
          const d = distance(a, b)
          if (pinch.distance > 0 && d > 0) {
            zoomAt(d / pinch.distance, (a.x + b.x) / 2, (a.y + b.y) / 2)
          }
          pinch.distance = d
          return
        }
        if (!press || press.id !== event.pointerId) return
        if (!press.dragging && distance(p, press.start) <= TAP_SLOP) return
        press.dragging = true
        lastTap = undefined
        move((press.last.y - p.y) * dpr, true)
        pan((press.last.x - p.x) * dpr)
        press.last = p
        velocity.add(now, p.y)
        return
      }
      case 'pointerup':
      case 'pointercancel': {
        fingers.delete(event.pointerId)
        if (fingers.size === 0) pinch = undefined
        if (!press || press.id !== event.pointerId) return
        const done = press
        press = undefined
        if (event.type === 'pointercancel') return
        if (done.dragging) {
          // A finger lets the strip go with the speed it had; a mouse just stops
          const v = -velocity.get(now) * dpr
          if (done.kind !== 'mouse' && Math.abs(v) / dpr > FLING_START) startFling(v)
          return
        }
        if (now - done.t0 <= TAP_MS) tap(p, now)
      }
    }
  }

  /** A tap or click that did not move: a side scrolls a screen, the middle can zoom. */
  function tap(p: Point, now: number) {
    const r = room()
    if (!r) return
    const width = r.width / dpr
    const side = p.x < width * 0.25 ? -1 : p.x >= width * 0.75 ? 1 : 0
    if (side) {
      lastTap = undefined
      // The right side goes forward, or the left one in right-to-left reading
      const forward = (side === 1) === (reading === 'ltr')
      move((forward ? 0.9 : -0.9) * r.height)
      return
    }
    const double = lastTap && now - lastTap.t <= DOUBLE_TAP_MS && distance(p, lastTap.p) <= 30
    if (double) {
      lastTap = undefined
      // Out on the same point a double tap went in on
      // Back to the zoom the reader reads at, or in on a detail, not kept
      const base = chosen ?? startOf(r)
      if (zoom > base * 1.01) {
        zoomAt(1, p.x, p.y, false, base)
        if (chosen === undefined) touched = false
      } else zoomAt(2, p.x, p.y, false)
      return
    }
    lastTap = { t: now, p }
  }

  $effect(() => () => {
    cancelAnimationFrame(frame)
    cancelAnimationFrame(fling)
    clearTimeout(preloadTimer)
    clearTimeout(zoomTimer)
  })
</script>

<div
  class="box"
  bind:this={box}
  role="document"
  aria-label="Pages, scrolled vertically"
  onpointerdown={pointer}
  onpointermove={pointer}
  onpointerup={pointer}
  onpointercancel={pointer}
>
  <canvas bind:this={canvas} width="0" height="0"></canvas>
</div>

<style>
  .box {
    position: relative;
    /* Every touch goes to the strip: no browser panning or zooming */
    touch-action: none;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  canvas {
    position: absolute;
    top: 0;
    left: 0;
    image-rendering: pixelated;
  }
</style>
