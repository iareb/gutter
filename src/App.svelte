<script lang="ts">
  import { open } from '@tauri-apps/plugin-dialog'
  import { keyMove, movePage, type Move } from './core/navigation'
  import { fileName, openVolume, type Volume } from './core/volume'
  import PageView from './PageView.svelte'

  let volume = $state<Volume>()
  let title = $state<string>()
  let error = $state<string>()
  let busy = $state(false)
  /** Current page, counted from 0. */
  let page = $state(0)

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
      // Otherwise Space and Enter would press the button again instead of turning pages
      ;(document.activeElement as HTMLElement | null)?.blur()
    }
  }

  function go(move: Move) {
    if (volume) page = movePage(move, page, volume.pages.length)
  }

  function onkeydown(event: KeyboardEvent) {
    if (!volume || event.ctrlKey || event.altKey || event.metaKey) return
    const move = keyMove(event.key, event.shiftKey)
    if (!move) return
    event.preventDefault()
    go(move)
  }
</script>

<svelte:window {onkeydown} />

<main>
  <header>
    <button onclick={pick} disabled={busy}>Open comic…</button>
    {#if volume}
      <span>{title ?? 'Comic'} · {page + 1} / {volume.pages.length}</span>
    {/if}
  </header>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {:else if volume}
    <PageView {volume} {page} onmove={go} />
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
