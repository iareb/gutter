<script lang="ts">
  // Spike S1: show CBZ pages through the page:// custom protocol, time page
  // changes, compare with IPC. Throwaway code, lives only on the spike/s1 branch.
  import { convertFileSrc, invoke } from '@tauri-apps/api/core'
  import { open } from '@tauri-apps/plugin-dialog'

  type VolumeInfo = {
    id: number
    sizeBytes: number
    pages: number
    openMs: number
    indexMs: number
  }

  let lines: string[] = $state([])
  let volume: VolumeInfo | null = $state(null)
  let page = $state(0)
  let busy = $state(false)
  let viewer: HTMLDivElement

  const ms = (n: number) => `${n.toFixed(1)} ms`
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
  const log = (line: string) => {
    // Also to the console: on Android it shows up in logcat as Tauri/Console
    console.log(`[S1] ${line}`)
    lines = [...lines, line]
  }

  // http://page.localhost/<id> on Windows and Android, page://localhost/<id> elsewhere
  const pageUrl = (id: number, n: number) => `${convertFileSrc(String(id), 'page')}/${n}`

  async function decode(src: string) {
    const img = new Image()
    img.src = src
    await img.decode()
    return img
  }

  /** Loads a page through page:// and swaps it in once decoded. Returns elapsed ms. */
  async function showPage(n: number) {
    const t0 = performance.now()
    const img = await decode(pageUrl(volume!.id, n))
    const elapsed = performance.now() - t0
    viewer.replaceChildren(img)
    page = n
    return elapsed
  }

  async function run(task: () => Promise<void>) {
    busy = true
    try {
      await task()
    } catch (e) {
      log(`ERRORE: ${e}`)
    } finally {
      busy = false
    }
  }

  const openFile = () =>
    run(async () => {
      const path = await open({ multiple: false, directory: false })
      if (!path) return
      lines = []
      viewer.replaceChildren()

      const t0 = performance.now()
      volume = await invoke<VolumeInfo>('open_volume', { path })
      log(`Dimensione: ${(volume.sizeBytes / 1024 / 1024).toFixed(1)} MB, pagine: ${volume.pages}`)
      log(`Rust apertura file: ${ms(volume.openMs)}, lettura indice: ${ms(volume.indexMs)}`)
      log(`Indirizzo pagina 1: ${pageUrl(volume.id, 0)}`)
      const first = await showPage(0)
      log(`Prima pagina via page://: ${ms(first)}`)
      log(`Totale dalla scelta alla prima pagina: ${ms(performance.now() - t0)}`)
    })

  const go = (delta: number) =>
    run(async () => {
      const n = page + delta
      if (!volume || n < 0 || n >= volume.pages) return
      log(`Pagina ${n + 1}: ${ms(await showPage(n))}`)
    })

  /** Same page, 3 runs each: transfer time (bytes in JS) and decode time, IPC vs page://. */
  const compare = () =>
    run(async () => {
      if (!volume) return
      const id = volume.id
      const result = { ipc: { transfer: [] as number[], decode: [] as number[] }, protocol: { transfer: [] as number[], decode: [] as number[] } }

      for (let i = 0; i < 3; i++) {
        let t = performance.now()
        const ipcBytes = await invoke<ArrayBuffer>('read_page', { id, page })
        result.ipc.transfer.push(performance.now() - t)
        let url = URL.createObjectURL(new Blob([ipcBytes]))
        t = performance.now()
        await decode(url)
        result.ipc.decode.push(performance.now() - t)
        URL.revokeObjectURL(url)

        t = performance.now()
        const protocolBytes = await (await fetch(pageUrl(id, page))).arrayBuffer()
        result.protocol.transfer.push(performance.now() - t)
        url = URL.createObjectURL(new Blob([protocolBytes]))
        t = performance.now()
        await decode(url)
        result.protocol.decode.push(performance.now() - t)
        URL.revokeObjectURL(url)
      }

      log(`Confronto pagina ${page + 1} (media di 3):`)
      log(`  IPC     trasferimento ${ms(avg(result.ipc.transfer))}, decodifica ${ms(avg(result.ipc.decode))}`)
      log(`  page:// trasferimento ${ms(avg(result.protocol.transfer))}, decodifica ${ms(avg(result.protocol.decode))}`)
    })
</script>

<main>
  <div class="controls">
    <button onclick={openFile} disabled={busy}>Apri file</button>
    <button onclick={() => go(-1)} disabled={busy || !volume || page === 0}>◀</button>
    <span>{volume ? `${page + 1} / ${volume.pages}` : ''}</span>
    <button onclick={() => go(1)} disabled={busy || !volume || page === volume.pages - 1}>▶</button>
    <button onclick={compare} disabled={busy || !volume}>Confronta</button>
  </div>
  {#if lines.length}
    <pre>{lines.join('\n')}</pre>
  {/if}
  <div class="viewer" bind:this={viewer}></div>
</main>

<style>
  main {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    height: 100%;
    padding: 48px 12px 12px;
    box-sizing: border-box;
    overflow: auto;
  }

  .controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }

  button {
    font: inherit;
    padding: 10px 18px;
    border: 0;
    border-radius: 10px;
    background: #2a2a30;
    color: #eee;
  }

  button:disabled {
    opacity: 0.4;
  }

  pre {
    width: 100%;
    margin: 0;
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-all;
    user-select: text;
  }

  .viewer :global(img) {
    max-width: 100%;
  }
</style>
