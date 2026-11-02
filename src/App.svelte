<script lang="ts">
  import { open } from '@tauri-apps/plugin-dialog'
  import { fileName, openVolume, type Volume } from './core/volume'

  let volume = $state<Volume>()
  let title = $state<string>()
  let error = $state<string>()
  let busy = $state(false)

  async function pick() {
    const path = await open({ multiple: false, directory: false })
    if (!path) return
    busy = true
    error = undefined
    try {
      volume = await openVolume(path)
      title = fileName(path)
    } catch (e) {
      volume = undefined
      error = String(e)
    } finally {
      busy = false
    }
  }
</script>

<main>
  <header>
    <button onclick={pick} disabled={busy}>Open comic…</button>
    {#if volume}
      <span>{title ?? 'Comic'} · {volume.pages.length} pages</span>
    {/if}
  </header>

  {#if error}
    <p class="error" role="alert">{error}</p>
  {:else if volume}
    <ol>
      {#each volume.pages as page, i (i)}
        <li>{page}</li>
      {/each}
    </ol>
  {:else}
    <p class="empty">gutter</p>
  {/if}
</main>

<style>
  main {
    display: flex;
    flex-direction: column;
    height: 100%;
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

  ol {
    flex: 1;
    margin: 0;
    padding: 0 16px 16px 48px;
    overflow: auto;
    user-select: text;
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
