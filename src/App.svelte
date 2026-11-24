<script lang="ts">
  import { invoke } from '@tauri-apps/api/core'
  import { SvelteSet } from 'svelte/reactivity'
  import { getCurrentWindow } from '@tauri-apps/api/window'
  import { getCurrentWebview } from '@tauri-apps/api/webview'
  import {
    addMany,
    pickFiles,
    pickFolder,
    rescanFolders,
    scanPaths,
    type Progress,
    type Report,
    type ToAdd,
  } from './core/adding'
  import { fromKey, type InputEvent, type Recording } from './core/input'
  import { GestureEngine, type Action } from './core/gestures'
  import { leaveSide, type Direction, type Move } from './core/navigation'
  import { loadSettings, saveSettings, type Mode, type Settings } from './core/settings'
  import { defaultBudget } from './core/budget'
  import { KEEP_DECODED, PageStore } from './core/pages'
  import { isWide, Layout, unitLabel, type Unit } from './core/spreads'
  import type { Size } from './core/fit'
  import {
    openVolume,
    pageLoaders,
    pageSizes,
    pickComic,
    type Picked,
    type Volume,
  } from './core/volume'
  import {
    addToLibrary,
    choicesFor,
    listLibrary,
    markOpened,
    PlaceSaver,
    removeFromLibrary,
    saveReading,
    startPage,
    type Entry,
  } from './core/library'
  import Library from './Library.svelte'
  import PageView from './PageView.svelte'
  import ScrollView from './ScrollView.svelte'
  import Stats from './Stats.svelte'

  /** The app opens on the library; a volume opens in the reader. */
  let screen = $state<'library' | 'reader'>('library')
  /** The volumes of the library, read again each time the library is shown. */
  let entries = $state.raw<Entry[]>([])
  /** A volume that could not be opened from the library, or a library that could not be read. */
  let libraryError = $state<string>()
  /** Comics being added: how far it has got. */
  let adding = $state<Progress>()
  /** What the last adding did, shown until closed. */
  let report = $state.raw<Report>()
  /** The Add menu is open. */
  let addMenu = $state(false)
  let addBox = $state<HTMLDivElement>()
  /** Files are being dragged over the window. */
  let dragging = $state(false)
  let volume = $state<Volume>()
  /** The reader's choices for every volume, saved as soon as they change. */
  const saved = loadSettings()
  let settings = $state.raw<Settings>(saved)
  $effect(() => saveSettings(settings))
  /**
   * The choices the open volume is read with: its own, kept in the library, or the
   * menu's for a volume never read. A choice made in the menu holds for this volume
   * and becomes the default for the volumes never read.
   */
  let view = $state.raw<Settings>(saved)
  /** The open volume in the library, where its place is kept. Missing if the library cannot be reached. */
  let entry = $state.raw<Entry>()
  /** Saves the place of the open volume, at most once a second. */
  let saver: PlaceSaver | undefined
  /** The open volume has been read to its last page, now or before. */
  let finished = false
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
  let scroller = $state<ScrollView>()

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
      double: view.mode === 'double',
      cover: view.cover,
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
    // Double page needs the shapes to pair pages, vertical scroll the heights to stack them
    if (!volume || !store || view.mode === 'single') return
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
    store?.setKeep(
      view.mode === 'double'
        ? { ahead: 6, behind: 4 }
        : view.mode === 'vertical'
          ? { ahead: 5, behind: 3 }
          : KEEP_DECODED,
    )
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
    // In vertical scroll: that page at the top of the screen
    scroller?.jumpTo(page)
  }

  // All input goes through the gesture engine as normalized events
  const engine = new GestureEngine({
    width: () => viewer?.area().width ?? 0,
    zoomed: () => viewer?.zoomed() ?? false,
    edges: () => viewer?.edges() ?? { left: true, right: true },
    direction: () => view.direction,
  })

  function choose(direction: Direction) {
    view = { ...view, direction }
    settings = { ...settings, direction }
    menu = false
    blur()
  }

  function setMode(mode: Mode) {
    view = { ...view, mode }
    settings = { ...settings, mode }
    menu = false
    blur()
  }

  function setCover(cover: boolean) {
    view = { ...view, cover }
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

  // Every change of page or of choice saves the place, at most once a second
  $effect(() => {
    if (!volume || !entry) return
    const last = volume.pages.length - 1
    if (unit ? unit[unit.length - 1] === last : page === last) finished = true
    saver?.set({ page, finished, direction: view.direction, mode: view.mode, cover: view.cover })
  })

  // ... and what is waiting is saved at once when the app goes to the background or closes
  $effect(() => {
    const flush = () => void saver?.flush()
    const hidden = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    document.addEventListener('visibilitychange', hidden)
    window.addEventListener('pagehide', flush)
    let unlisten: (() => void) | undefined
    let gone = false
    void getCurrentWindow()
      .onCloseRequested(async () => {
        await saver?.flush()
      })
      .then((u) => (gone ? u() : (unlisten = u)))
      .catch(() => {})
    return () => {
      gone = true
      unlisten?.()
      document.removeEventListener('visibilitychange', hidden)
      window.removeEventListener('pagehide', flush)
    }
  })

  /** Reads the library again: the volumes, their places, their order. */
  async function refresh() {
    try {
      entries = await listLibrary()
    } catch (e) {
      libraryError = String(e)
    }
  }
  $effect(() => {
    void refresh().then(async () => {
      // On Android the folders picked before are listed again: what is new in them is added
      const found = await rescanFolders().catch(() => undefined)
      if (found && (found.added || found.moved)) {
        report = found
        await refresh()
      }
    })
  })

  /** Adds the comics a source gives: picked files, a folder, files dropped on the window. */
  async function add(source: () => Promise<ToAdd[] | undefined>) {
    addMenu = false
    libraryError = undefined
    let files
    try {
      files = await source()
    } catch (e) {
      libraryError = String(e)
      return
    }
    if (!files) return
    report = undefined
    adding = { done: 0, total: files.length }
    try {
      report = await addMany(files, (p) => (adding = p))
    } catch (e) {
      libraryError = String(e)
    } finally {
      adding = undefined
    }
    await refresh()
  }

  // Files and folders dropped on the window are added, on the library screen
  $effect(() => {
    let unlisten: (() => void) | undefined
    let gone = false
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const drag = event.payload
        if (drag.type === 'enter' || drag.type === 'over') dragging = screen === 'library'
        else if (drag.type === 'leave') dragging = false
        else if (drag.type === 'drop') {
          dragging = false
          if (screen === 'library' && !adding) void add(() => scanPaths(drag.paths))
        }
      })
      .then((u) => (gone ? u() : (unlisten = u)))
      .catch(() => {})
    return () => {
      gone = true
      unlisten?.()
    }
  })

  // The Add menu closes on a click or tap outside it, and on Escape
  $effect(() => {
    if (!addMenu) return
    const outside = (event: PointerEvent) => {
      if (!addBox?.contains(event.target as Node)) addMenu = false
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') addMenu = false
    }
    window.addEventListener('pointerdown', outside, true)
    window.addEventListener('keydown', escape, true)
    return () => {
      window.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('keydown', escape, true)
    }
  })

  async function pick() {
    let picked
    try {
      picked = await pickComic()
    } catch (e) {
      libraryError = String(e)
      return
    }
    if (picked) await open(picked)
  }

  /** Opens a volume in the reader, where it was left: one just picked, or one of the library. */
  async function open(picked: Picked) {
    busy = true
    error = undefined
    libraryError = undefined
    try {
      await saver?.flush()
      const opened = await openVolume(picked.address)
      // The library finds the volume, also moved or renamed; reading works without it
      const found: Entry | undefined = await addToLibrary(
        picked.address,
        picked.name,
        opened.pages.length,
      ).then(
        ([e]) => e,
        (e) => {
          console.warn('[gutter] not in the library:', e)
          return undefined
        },
      )
      store?.dispose()
      store = new PageStore(pageLoaders(opened), defaultBudget())
      unreadable.clear()
      shownUnit = undefined
      entry = found
      view = choicesFor(found, settings)
      finished = found?.finished ?? false
      saver = found ? new PlaceSaver((r) => saveReading(found.id, r)) : undefined
      if (found) void markOpened(found.id, opened.pages.length).catch(() => {})
      volume = opened
      title = found?.name ?? picked.name
      page = startPage(found, opened.pages.length)
      if (screen === 'library') {
        screen = 'reader'
        // An entry in the history: Android's back gesture comes back to the library
        history.pushState({ gutter: 'reader' }, '')
      }
    } catch (e) {
      store?.dispose()
      store = undefined
      volume = undefined
      entry = undefined
      saver = undefined
      // Said where the reader is: on the library a volume that cannot be opened stays listed
      if (screen === 'library') libraryError = String(e)
      else error = String(e)
    } finally {
      busy = false
      blur()
    }
  }

  /** Back to the library: the place is saved, the pages are let go, the library read again. */
  async function leave() {
    await saver?.flush()
    store?.dispose()
    store = undefined
    volume = undefined
    entry = undefined
    saver = undefined
    error = undefined
    menu = false
    screen = 'library'
    await refresh()
  }

  /** The Library button: through the history, so that it and the back gesture are one way back. */
  function toLibrary() {
    if (history.state?.gutter === 'reader') history.back()
    else void leave()
  }

  $effect(() => {
    const popped = () => {
      if (screen === 'reader') void leave()
    }
    window.addEventListener('popstate', popped)
    return () => window.removeEventListener('popstate', popped)
  })

  async function remove(gone: Entry) {
    try {
      await removeFromLibrary(gone)
    } catch (e) {
      libraryError = String(e)
    }
    await refresh()
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
    if (move === 'next' || move === 'previous') viewer?.leave(leaveSide(move, view.direction))
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
    viewer?.leave(leaveSide(move, view.direction))
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
    if (view.mode === 'vertical') {
      if (scroller?.key(event.key, event.shiftKey)) event.preventDefault()
      return
    }
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
    {#if screen === 'library'}
      <button onclick={pick} disabled={busy}>Open comic…</button>
      <div class="view" bind:this={addBox}>
        <button
          aria-haspopup="menu"
          aria-expanded={addMenu}
          disabled={!!adding}
          onclick={() => (addMenu = !addMenu)}>Add</button
        >
        {#if addMenu}
          <div class="menu" role="menu">
            <button role="menuitem" class="item" onclick={() => add(pickFiles)}>Comics…</button>
            <button role="menuitem" class="item" onclick={() => add(pickFolder)}>A folder…</button>
          </div>
        {/if}
      </div>
      <span class="title">Library</span>
    {:else}
      <button onclick={toLibrary}>‹ Library</button>
    {/if}
    {#if screen === 'reader'}
      <div class="view" bind:this={viewBox}>
        <button aria-haspopup="menu" aria-expanded={menu} onclick={() => (menu = !menu)}
          >View</button
        >
        {#if menu}
          <div class="menu" role="menu">
            <fieldset>
              <legend>Reading direction</legend>
              <label>
                <input
                  type="radio"
                  name="direction"
                  checked={view.direction === 'ltr'}
                  onchange={() => choose('ltr')}
                />
                Left to right
              </label>
              <label>
                <input
                  type="radio"
                  name="direction"
                  checked={view.direction === 'rtl'}
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
                  checked={view.mode === 'single'}
                  onchange={() => setMode('single')}
                />
                One at a time
              </label>
              <label>
                <input
                  type="radio"
                  name="mode"
                  checked={view.mode === 'double'}
                  onchange={() => setMode('double')}
                />
                Two side by side
              </label>
              <label>
                <input
                  type="radio"
                  name="mode"
                  checked={view.mode === 'vertical'}
                  onchange={() => setMode('vertical')}
                />
                Vertical scroll
              </label>
              <label class:off={view.mode !== 'double'}>
                <input
                  type="checkbox"
                  checked={view.cover}
                  disabled={view.mode !== 'double'}
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
            style:direction={view.direction}
            oninput={(event) => slide(event.currentTarget.valueAsNumber)}
            onchange={(event) => {
              commit(event.currentTarget.valueAsNumber)
              // Otherwise the arrows and Space would move the slider instead of turning pages
              event.currentTarget.blur()
            }}
          />
        {/if}
      {/if}
    {/if}
    <div class="options">
      {#if busy}<small>Opening…</small>{/if}
      {#if adding}<small>Adding {adding.done} of {adding.total}…</small>{/if}
      {#if slow || (volume && !unit)}<small>Loading page {page + 1}…</small>{/if}
      {#if DEV}
        {#if recordStatus}<small>{recordStatus}</small>{/if}
        <button onclick={toggleRecording}>{recorded ? '■ Stop' : '● Rec'}</button>
      {/if}
    </div>
  </header>

  {#if screen === 'library'}
    <Library
      {entries}
      error={libraryError}
      onopen={(e) => open({ address: e.address, name: e.name })}
      onremove={remove}
      {report}
      onclosereport={() => (report = undefined)}
      onaddfiles={() => add(pickFiles)}
      onaddfolder={() => add(pickFolder)}
    />
    {#if dragging}<div class="drop">Drop comics or folders to add them to the library</div>{/if}
  {:else if error}
    <p class="error" role="alert">{error}</p>
  {:else if volume && store && view.mode === 'vertical'}
    {#key store}
      <ScrollView
        bind:this={scroller}
        {store}
        count={volume.pages.length}
        start={page}
        {sizesSeen}
        reading={view.direction}
        onpage={(n) => (page = n)}
        onloading={(value) => (loading = value)}
      />
    {/key}
    {#if stats}<Stats {store} />{/if}
  {:else if volume && store && layout && shownUnit}
    <PageView
      bind:this={viewer}
      {store}
      unit={shownUnit}
      {layout}
      reading={view.direction}
      oninput={input}
      onloading={(value) => (loading = value)}
    />
    {#if stats}<Stats {store} />{/if}
  {:else}
    <p class="empty">Gutter</p>
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

  .menu .item {
    padding: 8px 12px;
    text-align: left;
    background: none;
    border: 0;
  }

  .menu .item:hover {
    background: #26262c;
  }

  /* Over the library while files are dragged over the window */
  .drop {
    position: absolute;
    inset: 12px;
    z-index: 6;
    display: grid;
    place-items: center;
    font-size: 1.1rem;
    pointer-events: none;
    background: #18181ccc;
    border: 2px dashed #8a9bff;
    border-radius: 12px;
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
