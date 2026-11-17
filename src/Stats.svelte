<script lang="ts">
  // Development overlay (step 3.1): what the page store holds and how long the
  // last page change took. Shown in development builds, and in a release build
  // when localStorage has gutter.stats = 1.
  import type { PageStore, Snapshot } from './core/pages'

  let { store }: { store: PageStore } = $props()
  let s = $state<Snapshot>()

  $effect(() => {
    s = store.snapshot()
    const timer = setInterval(() => (s = store.snapshot()), 250)
    ;(window as unknown as { __gutter?: unknown }).__gutter = { snapshot: () => store.snapshot() }
    return () => clearInterval(timer)
  })

  const mb = (bytes: number) => (bytes / 1048576).toFixed(1)
</script>

{#if s}
  <aside>
    <div>
      cache {mb(s.used)} / {mb(s.budget)} MB · {s.entries} entries · {s.bitmaps} bitmaps alive ({s.made}
      made, {s.closed} closed)
    </div>
    <div>
      fetch {s.fetchMs?.toFixed(0) ?? '–'} ms · decode {s.decodeMs?.toFixed(0) ?? '–'} ms · hits {s.hits}
      / misses {s.misses}
    </div>
    <div>
      last turn: {s.turn
        ? `page ${s.turn.page + 1} in ${s.turn.ms.toFixed(1)} ms (${s.turn.ready ? 'ready' : 'not ready'})`
        : '–'}
    </div>
    <div>pages: {s.pages.map(([p, b]) => `${p + 1}:${mb(b)}`).join(' ')}</div>
  </aside>
{/if}

<style>
  aside {
    position: absolute;
    left: 8px;
    bottom: 8px;
    z-index: 2;
    padding: 4px 8px;
    font:
      11px/1.4 ui-monospace,
      monospace;
    color: #cfe;
    background: #000c;
    border-radius: 4px;
    pointer-events: none;
  }
</style>
