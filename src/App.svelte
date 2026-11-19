<script lang="ts">
  import { invoke } from '@tauri-apps/api/core'
  import { SvelteSet } from 'svelte/reactivity'
  import { open } from '@tauri-apps/plugin-dialog'
  import { fromKey, type InputEvent, type Recording } from './core/input'
  import { GestureEngine, type Action } from './core/gestures'
  import { leaveSide, type Direction, type Move } from './core/navigation'
  import { loadSettings, saveSettings, type Mode, type Settings } from './core/settings'
  import { defaultBudget } from './core/budget'
  import { KEEP_DECODED, PageStore } from './core/pages'
  import { isWide, Layout, unitLabel, type Unit } from './core/spreads'
  import type { Size } from './core/fit'
  import { fileName, openVolume, pageLoaders, pageSizes, type Volume } from './core/volume'
  import PageView from './PageView.svelte'
  import Stats from './Stats.svelte'

  let volume = $state<Volume>()
  /** The reader's choices for every volume, saved as soon as they change. */
  let settings = $state.raw<Settings>(loadSettings())
  $effect(() => saveSettings(settings))
  /** The View menu is open. */
  let menu = $state(false)
  let viewBox = $state<HTMLDivElement>()
  /** Fetches, decodes and keeps the pages of the open volume. */
  let store = $state.raw<PageStore>()
  /** The development overlay: always in development builds, in release when localStorage asks. */
  const stats = (() => {
    try {
      return import.meta.env.DEV || localStorage.getItem('gutter.stats') === '1'
    } catch {
      return false
    }
  })()
  let title = $state<string>()
  let error = $state<string>()
  let busy = $state(false)
  /** Current page, counted from 0. */
  let page = $state(0)
  let viewer = $state<PageView>()

  // Units: the pages shown together (two side by side in double page mode).
  // In double page mode the sizes of the pages are read from their headers,
  // from the first page on, and the layout grows as they arrive
  /** Pages whose size could not be told: they count as narrow. */
  const unreadable = new SvelteSet<number>()
  /** Bumped when sizes are learned, so that the layout is built again. */
  let sizesSeen = $state(0)
  const layout = $derived.by(() => {
    void sizesSeen
    if (!volume || !store) return undefined
    const s = store
    return new Layout({
      count: volume.pages.length,
      double: settings.mode === 'double',
      cover: settings.cover,
      wide: (n) => {
        const size = s.peekSize(n)
        return size ? isWide(size) : unreadable.has(n) ? false : undefined
      },
    })
  })
  /** The unit of the current page, or undefined while its layout is not known. */
  const unit = $derived(layout?.unitOf(page))
  /** What is on screen: the last unit known, kept while the next one is being laid out. */
  let shownUnit = $state.raw<Unit>()
  $effect(() => {
    if (unit) shownUnit = unit
  })
  // The current page is the first of its unit
  $effect(() => {
    if (unit && unit[0] !== page) page = unit[0]
  })

  $effect(() => {
    if (!volume || !store || settings.mode !== 'double') return
    const v = volume
    const s = store
    let cancelled = false
    void (async () => {
      const RUN = 8
      for (let from = 0; from < v.pages.length; from += RUN) {
        const to = Math.min(from + RUN, v.pages.length)
        const missing = []
        for (let n = from; n < to; n++) if (!s.peekSize(n) && !unreadable.has(n)) missing.push(n)
        if (missing.length === 0) continue
        let sizes: (Size | null)[]
        try {
          sizes = await pageSizes(v, from, to)
        } catch {
          return
        }
        if (cancelled) return
        s.learnSizes(from, sizes)
        // No size in the header (a format Rust cannot measure): measured by decoding
        for (const n of missing) {
          if (s.peekSize(n)) continue
          await s.size(n).catch(() => unreadable.add(n))
          if (cancelled) return
        }
        sizesSeen++
      }
    })()
    return () => (cancelled = true)
  })

  // Pairs need more decoded pages kept around the current one
  $effect(() => {
    store?.setKeep(settings.mode === 'double' ? { ahead: 6, behind: 4 } : KEEP_DECODED)
  })
  /** The page is still being fetched, and has been for a moment: say so. */
  let loading = $state(false)
  let slow = $state(false)
  $effect(() => {
    if (!loading) {
      slow = false
      return
    }
    const timer = setTimeout(() => (slow = true), 400)
    return () => clearTimeout(timer)
  })

  /**
   * The page the slider shows while it is being dragged, counted from 1. The page itself changes
   * when the slider stops for a moment or is let go: in a solid archive every far jump is a pass
   * over the archive, and loading the pages the slider goes through would be a waste.
   */
  let target = $state<number>()
  let commitTimer: ReturnType<typeof setTimeout> | undefined
  const SLIDER_PAUSE_MS = 250

  function slide(value: number) {
    target = value
    clearTimeout(commitTimer)
    commitTimer = setTimeout(() => commit(value), SLIDER_PAUSE_MS)
  }

  function commit(value: number) {
    clearTimeout(commitTimer)
    target = undefined
    // Any page of a unit: the unit is shown, and the page becomes its first
    if (volume) page = Math.min(Math.max(value, 1), volume.pages.length) - 1
  }

  // All input goes through the gesture engine as normalized events
  const engine = new GestureEngine({
    width: () => viewer?.area().width ?? 0,
    zoomed: () => viewer?.zoomed() ?? false,
    edges: () => viewer?.edges() ?? { left: true, right: true },
    direction: () => settings.direction,
  })

  function choose(direction: Direction) {
    settings = { ...settings, direction }
    menu = false
    blur()
  }

  function setMode(mode: Mode) {
    settings = { ...settings, mode }
    menu = false
    blur()
  }

  function setCover(cover: boolean) {
    settings = { ...settings, cover }
    menu = false
    blur()
  }

  // The menu closes on a click or tap outside it, and on Escape
  $effect(() => {
    if (!menu) return
    const outside = (event: PointerEvent) => {
      if (!viewBox?.contains(event.target as Node)) menu = false
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        menu = false
        blur()
      }
    }
    window.addEventListener('pointerdown', outside, true)
    window.addEventListener('keydown', escape, true)
    return () => {
      window.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('keydown', escape, true)
    }
  })

  async function pick() {
    const path = await open({ multiple: false, directory: false })
    if (!path) return
    busy = true
    error = undefined
    try {
      const opened = await openVolume(path)
      store?.dispose()
      store = new PageStore(pageLoaders(opened), defaultBudget())
      unreadable.clear()
      shownUnit = undefined
      volume = opened
      title = fileName(path)
      page = 0
    } catch (e) {
      store?.dispose()
      store = undefined
      volume = undefined
      error = String(e)
    } finally {
      busy = false
      blur()
    }
  }

  // Otherwise Space and Enter would press the button again instead of turning pages
  const blur = () => (document.activeElement as HTMLElement | null)?.blur()

  /**
   * A tap, a key or a wheel notch changes the page. To the page beside, the pages
   * slide when the new one is ready; to the first or the last, the page changes in place.
   */
  function go(move: Move) {
    if (!layout) return
    const next = layout.target(page, move)
    if (next === page) return
    if (move === 'next' || move === 'previous') viewer?.leave(leaveSide(move, settings.direction))
    page = next
  }

  function apply(action: Action) {
    switch (action.kind) {
      case 'move':
        return go(action.move)
      case 'pan':
        // A zoomed page moves up to its edge, and stays on the same page
        viewer?.pan(action.fx, action.fy)
        return
      case 'zoom':
        return viewer?.zoomBy(action.how)
      case 'drag':
        return viewer?.drag(action.dx, action.dy)
      case 'zoomAt':
        return viewer?.zoomAt(action.factor, action.x, action.y)
      case 'follow':
        return viewer?.follow(action.dx)
      case 'settle':
        return viewer?.settle()
      case 'turn':
        return turn(action.move)
    }
  }

  /** A swipe turned the page: the old one slides out. On the first or last page it slides back. */
  function turn(move: 'next' | 'previous') {
    if (!layout) return
    const next = layout.target(page, move)
    if (next === page) return viewer?.settle()
    // The next page comes from the right in left-to-right reading, from the left in right to left
    viewer?.leave(leaveSide(move, settings.direction))
    page = next
  }

  /** Feeds one event to the gesture engine. Returns whether it did something. */
  function input(event: InputEvent) {
    recorded?.push(event)
    const actions = engine.feed(event)
    actions.forEach(apply)
    return actions.length > 0
  }

  function onkeydown(event: KeyboardEvent) {
    if (!volume || event.ctrlKey || event.altKey || event.metaKey) return
    // The arrows of a slider that has the focus move the slider, not the page
    if ((event.target as HTMLElement | null)?.tagName === 'INPUT') return
    if (input(fromKey(event, 0))) event.preventDefault()
  }

  // Development builds only: record gestures to a file, to replay them in tests
  // (tests/recordings). Release builds have no button and no command behind it.
  const DEV = import.meta.env.DEV
  let recorded = $state.raw<InputEvent[] | null>(null)
  let recordStatus = $state<string>()

  async function toggleRecording() {
    blur()
    if (!recorded) {
      recorded = []
      recordStatus = 'Recording…'
      return
    }
    const events = recorded
    recorded = null
    const t0 = events[0]?.t ?? 0
    const area = viewer?.area() ?? { width: innerWidth, height: innerHeight }
    const recording: Recording = {
      version: 1,
      device: navigator.userAgent,
      area: { width: area.width, height: area.height, dpr: devicePixelRatio },
      events: events.map((e) => ({ ...e, t: e.t - t0 })),
    }
    try {
      const path = await invoke<string>('save_recording', { json: JSON.stringify(recording) })
      recordStatus = `${events.length} events saved to ${path}`
      console.info(`[gutter] recording saved: ${path}`)
    } catch (e) {
      recordStatus = `Not saved: ${e}`
    }
  }
</script>

<svelte:window {onkeydown} />

<main>
  <!-- The options bar: always there, and the place where more options will go -->
  <header>
    <button onclick={pick} disabled={busy}>Open comic…</button>
    <div class="view" bind:this={viewBox}>
      <button aria-haspopup="menu" aria-expanded={menu} onclick={() => (menu = !menu)}>View</button>
      {#if menu}
        <div class="menu" role="menu">
          <fieldset>
            <legend>Reading direction</legend>
            <label>
              <input
                type="radio"
                name="direction"
                checked={settings.direction === 'ltr'}
                onchange={() => choose('ltr')}
              />
              Left to right
            </label>
            <label>
              <input
                type="radio"
                name="direction"
                checked={settings.direction === 'rtl'}
                onchange={() => choose('rtl')}
              />
              Right to left (manga)
            </label>
          </fieldset>
          <fieldset>
            <legend>Pages</legend>
            <label>
              <input
                type="radio"
                name="mode"
                checked={settings.mode === 'single'}
                onchange={() => setMode('single')}
              />
              One at a time
            </label>
            <label>
              <input
                type="radio"
                name="mode"
                checked={settings.mode === 'double'}
                onchange={() => setMode('double')}
              />
              Two side by side
            </label>
            <label class:off={settings.mode !== 'double'}>
              <input
                type="checkbox"
                checked={settings.cover}
                disabled={settings.mode !== 'double'}
                onchange={(event) => setCover(event.currentTarget.checked)}
              />
              First page alone (cover)
            </label>
          </fieldset>
        </div>
      {/if}
    </div>
    {#if volume}
      <span class="title"
        >{title ?? 'Comic'} · {target ?? (unit ? unitLabel(unit) : page + 1)} / {volume.pages
          .length}</span
      >
      {#if volume.pages.length > 1}
        <input
          class="slider"
          type="range"
          min="1"
          max={volume.pages.length}
          value={target ?? page + 1}
          aria-label="Go to page"
          style:direction={settings.direction}
          oninput={(event) => slide(event.currentTarget.valueAsNumber)}
          onchange={(event) => {
            commit(event.currentTarget.valueAsNumber)
            // Otherwise the arrows and Space would move the slider instead of turning pages
            event.currentTarget.blur()
          }}
        />
      {/if}
    {/if}
    <div class="options">
      {#if slow || (volume && !unit)}<small>Loading page {page + 1}…</small>{/if}
      {#if DEV}
        {#if recordStatus}<small>{recordStatus}</small>{/if}
        <button onclick={toggleRecording}>{recorded ? '■ Stop' : '● Rec'}</button>
      {/if}
    </div>
  </header>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {:else if volume && store && layout && shownUnit}
    <PageView
      bind:this={viewer}
      {store}
      unit={shownUnit}
      {layout}
      reading={settings.direction}
      oninput={input}
      onloading={(value) => (loading = value)}
    />
    {#if stats}<Stats {store} />{/if}
  {:else}
    <p class="empty">gutter</p>
  {/if}
</main>

<style>
  main {
    position: relative;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    height: 100%;
    /* On Android the app draws under the status and navigation bars: keep out of them.
       Zero on desktop. */
    padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom)
      env(safe-area-inset-left);
  }

  header {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    gap: 8px 16px;
    align-items: center;
    padding: 10px 16px;
    background: #18181c;
    border-bottom: 1px solid #26262c;
  }

  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Takes what the bar has left; on a narrow screen it drops to a row of its own */
  .slider {
    flex: 1 1 160px;
    min-width: 120px;
    height: 32px;
    margin: 0;
    accent-color: #8a9bff;
  }

  .view {
    position: relative;
  }

  .menu {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 3;
    display: grid;
    gap: 10px;
    min-width: 220px;
    padding: 12px 14px;
    background: #1f1f24;
    border: 1px solid #34343c;
    border-radius: 8px;
    box-shadow: 0 8px 24px #0008;
  }

  fieldset {
    display: grid;
    gap: 6px;
    margin: 0;
    padding: 0;
    border: 0;
  }

  legend {
    margin-bottom: 4px;
    font-size: 0.8rem;
    opacity: 0.7;
  }

  label {
    display: flex;
    gap: 8px;
    align-items: center;
    /* Big enough for a finger */
    min-height: 32px;
  }

  label.off {
    opacity: 0.5;
  }

  input[type='radio'],
  input[type='checkbox'] {
    margin: 0;
    accent-color: #8a9bff;
  }

  /* Whatever options the bar gets stay on the right */
  .options {
    display: flex;
    gap: 12px;
    align-items: center;
    min-width: 0;
    margin-left: auto;
  }

  button {
    padding: 6px 14px;
    font: inherit;
    color: #e4e4ea;
    background: #26262c;
    border: 1px solid #34343c;
    border-radius: 6px;
  }

  small {
    overflow: hidden;
    opacity: 0.7;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .empty,
  .error {
    display: grid;
    flex: 1;
    place-items: center;
    margin: 0;
    padding: 16px;
  }

  .empty {
    font-size: 1.25rem;
    letter-spacing: 0.05em;
  }

  .error {
    color: #e08a8a;
    text-align: center;
  }
</style>
