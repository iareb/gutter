<script lang="ts">
  // Vertical scroll: the pages one under the other, fitted to the width, with no
  // gap (core/strip.ts). One canvas the size of the screen shows the part of the
  // strip under it, drawn one image pixel per screen pixel; only the pages near
  // the screen are decoded, and the screen after the visible one is made ready
  // while the reader looks. A page not decoded yet is a dark placeholder of the
  // right height (or of an estimated one, corrected without moving the picture).
  //
  // The wheel scrolls: a mouse notch about an eighth of the screen, a trackpad
  // as it moves. A finger drags the strip. Keys come through scroll() and key().
  import { untrack } from 'svelte'
  import { SvelteMap, SvelteSet } from 'svelte/reactivity'
  import { fitPage, type Size } from './core/fit'
  import type { PageStore } from './core/pages'
  import { Strip } from './core/strip'

  type Props = {
    store: PageStore
    count: number
    /** The page to start at, counted from 0. */
    start: number
    /** Bumped when page sizes are learned elsewhere: the strip is laid out again. */
    sizesSeen: number
    /** The page at the top of the screen changed. */
    onpage: (page: number) => void
    onloading?: (loading: boolean) => void
  }
  let { store, count, start, sizesSeen, onpage, onloading }: Props = $props()

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

  /** Physical pixels of the screen. */
  const room = () =>
    viewport && {
      width: Math.floor(viewport.width * dpr),
      height: Math.floor(viewport.height * dpr),
    }

  function relayout() {
    const r = room()
    if (!r) return
    strip.layout(r.width, r.height, (n) => store.peekSize(n))
    if (!started) {
      strip.jump(untrack(() => start))
      started = true
    }
    if (!animating) goal = strip.top
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
    ctx.fillStyle = '#111113'
    ctx.fillRect(0, 0, r.width, r.height)
    const visible = strip.pagesAround(0, 0)
    let missing = false
    for (const n of visible) {
      const y = strip.offset(n) - strip.top
      const h = strip.height(n)
      const target = targetOf(n)
      const bitmap = target && store.cached(n, target)
      if (bitmap) {
        // One pixel per pixel, or scaled up for a page narrower than the screen
        ctx.drawImage(bitmap, 0, y, r.width, h)
        continue
      }
      missing = true
      ctx.fillStyle = '#1a1a1f'
      ctx.fillRect(0, y, r.width, h)
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
    if (!r) return
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

  /** Moves the strip by physical pixels; smoothly unless `now`. */
  function move(dy: number, now = false) {
    store.busy()
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

  /** Scrolls by a fraction of the screen. */
  export function scroll(screens: number) {
    move(screens * (room()?.height ?? 0))
  }

  /** The top of a page at the top of the screen. */
  export function jumpTo(page: number) {
    animating = false
    strip.jump(page)
    goal = strip.top
    schedule()
  }

  /** The page at the top of the screen. */
  export const page = () => strip.page

  /**
   * The keys of vertical scroll. Returns whether the key did something.
   * Down, up, PageDown, PageUp and Space scroll; Home and End go to the ends;
   * the left and right arrows go to the previous and next page.
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
        animating = false
        strip.setTop(strip.total)
        goal = strip.top
        schedule()
        return true
      case 'ArrowRight':
        return (jumpTo(strip.page + 1), true)
      case 'ArrowLeft': {
        // Back to the top of this page, or to the previous one when already there
        const atTop = strip.top === strip.offset(strip.page)
        return (jumpTo(atTop ? strip.page - 1 : strip.page), true)
      }
    }
    return false
  }

  // The wheel: a notch (100 CSS pixels) moves an eighth of the screen, a trackpad
  // moves the strip as far as the fingers go
  $effect(() => {
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      if (event.ctrlKey) return
      const r = room()
      if (!r) return
      const lines = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? r.height / dpr : 1
      const css = event.deltaY * lines
      move(css * dpr * (r.height / dpr / 8 / 100))
    }
    box.addEventListener('wheel', wheel, { passive: false })
    return () => box.removeEventListener('wheel', wheel)
  })

  // A finger drags the strip (inertia and zoom come with step 3.8)
  let dragging: { id: number; y: number } | undefined
  function pointer(event: PointerEvent) {
    if (event.pointerType === 'mouse') return
    if (event.type === 'pointerdown' && !dragging) {
      dragging = { id: event.pointerId, y: event.clientY }
      animating = false
      goal = strip.top
    } else if (dragging?.id === event.pointerId) {
      if (event.type === 'pointermove') {
        move((dragging.y - event.clientY) * dpr, true)
        dragging.y = event.clientY
      } else dragging = undefined
    }
  }

  $effect(() => () => {
    cancelAnimationFrame(frame)
    clearTimeout(preloadTimer)
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
