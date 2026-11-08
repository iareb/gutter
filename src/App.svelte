<script lang="ts">
  import { invoke } from '@tauri-apps/api/core'
  import { open } from '@tauri-apps/plugin-dialog'
  import { fromKey, type InputEvent, type Recording } from './core/input'
  import { GestureEngine, type Action } from './core/gestures'
  import { movePage, type Move } from './core/navigation'
  import { fileName, openVolume, type Volume } from './core/volume'
  import PageView from './PageView.svelte'

  let volume = $state<Volume>()
  let title = $state<string>()
  let error = $state<string>()
  let busy = $state(false)
  /** Current page, counted from 0. */
  let page = $state(0)
  let viewer = $state<PageView>()

  // All input goes through the gesture engine as normalized events
  const engine = new GestureEngine({
    width: () => viewer?.area().width ?? 0,
    zoomed: () => viewer?.zoomed() ?? false,
  })

  async function pick() {
    const path = await open({ multiple: false, directory: false })
    if (!path) return
    busy = true
    error = undefined
    try {
      volume = await openVolume(path)
      title = fileName(path)
      page = 0
    } catch (e) {
      volume = undefined
      error = String(e)
    } finally {
      busy = false
      blur()
    }
  }

  // Otherwise Space and Enter would press the button again instead of turning pages
  const blur = () => (document.activeElement as HTMLElement | null)?.blur()

  function go(move: Move) {
    if (volume) page = movePage(move, page, volume.pages.length)
  }

  function apply(action: Action) {
    switch (action.kind) {
      case 'move':
        return go(action.move)
      case 'pan':
        // A zoomed page moves first; at its edge the same key turns the page
        if (!viewer?.pan(action.fx, action.fy) && action.orMove) go(action.orMove)
        return
      case 'zoom':
        return viewer?.zoomBy(action.how)
      case 'drag':
        return viewer?.drag(action.dx, action.dy)
      case 'zoomAt':
        return viewer?.zoomAt(action.factor, action.x, action.y)
    }
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
  <header>
    <button onclick={pick} disabled={busy}>Open comic…</button>
    {#if volume}
      <span>{title ?? 'Comic'} · {page + 1} / {volume.pages.length}</span>
    {/if}
    {#if DEV}
      <button class="record" onclick={toggleRecording}>{recorded ? '■ Stop' : '● Rec'}</button>
      {#if recordStatus}<small>{recordStatus}</small>{/if}
    {/if}
  </header>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {:else if volume}
    <PageView bind:this={viewer} {volume} {page} oninput={input} />
  {:else}
    <p class="empty">gutter</p>
  {/if}
</main>

<style>
  main {
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
    gap: 16px;
    align-items: center;
    padding: 12px 16px;
  }

  button {
    padding: 6px 14px;
    font: inherit;
    color: #e4e4ea;
    background: #26262c;
    border: 1px solid #34343c;
    border-radius: 6px;
  }

  .record {
    margin-left: auto;
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
