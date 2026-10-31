<script lang="ts">
  // Spike S3: pick a CBZ with the system picker, let Rust read the first page,
  // show it with timings. Throwaway code, lives only on the spike/s3 branch.
  import { invoke } from '@tauri-apps/api/core'
  import { open } from '@tauri-apps/plugin-dialog'

  type ArchiveInfo = {
    sizeBytes: number
    entries: number
    pages: number
    firstPage: string
    openMs: number
    indexMs: number
  }

  let lines: string[] = $state([])
  let pageUrl: string | null = $state(null)
  let busy = $state(false)

  const ms = (n: number) => `${n.toFixed(1)} ms`
  const log = (line: string) => {
    // Also to the console: on Android it shows up in logcat as Tauri/Console
    console.log(`[S3] ${line}`)
    lines = [...lines, line]
  }

  async function openFile() {
    busy = true
    lines = []
    if (pageUrl) URL.revokeObjectURL(pageUrl)
    pageUrl = null

    try {
      const tPick = performance.now()
      const path = await open({ multiple: false, directory: false })
      if (!path) {
        log('Nessun file scelto')
        return
      }
      log(`Picker: ${ms(performance.now() - tPick)} (include il tempo della tua scelta)`)
      log(`URI: ${path}`)

      const info = await invoke<ArchiveInfo>('inspect_archive', { path })
      log(`Dimensione: ${(info.sizeBytes / 1024 / 1024).toFixed(1)} MB`)
      log(`Voci: ${info.entries}, pagine: ${info.pages}, prima: ${info.firstPage}`)
      log(`Rust apertura file: ${ms(info.openMs)}, lettura indice: ${ms(info.indexMs)}`)

      const tTotal = performance.now()
      const bytes = await invoke<ArrayBuffer>('read_first_page', { path })
      const tRead = performance.now() - tTotal
      log(`Prima pagina da Rust: ${(bytes.byteLength / 1024).toFixed(0)} KB in ${ms(tRead)}`)

      const tDecode = performance.now()
      const url = URL.createObjectURL(new Blob([bytes]))
      const img = new Image()
      img.src = url
      await img.decode()
      log(`Decodifica: ${ms(performance.now() - tDecode)} (${img.naturalWidth}×${img.naturalHeight})`)
      pageUrl = url
      log(`Totale dalla scelta alla pagina: ${ms(performance.now() - tTotal)}`)
    } catch (e) {
      log(`ERRORE: ${e}`)
    } finally {
      busy = false
    }
  }
</script>

<main>
  <button onclick={openFile} disabled={busy}>{busy ? 'Apertura…' : 'Apri file'}</button>
  {#if lines.length}
    <pre>{lines.join('\n')}</pre>
  {/if}
  {#if pageUrl}
    <img src={pageUrl} alt="Prima pagina" />
  {/if}
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

  button {
    font: inherit;
    padding: 12px 28px;
    border: 0;
    border-radius: 10px;
    background: #2a2a30;
    color: #eee;
  }

  pre {
    width: 100%;
    margin: 0;
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-all;
    user-select: text;
  }

  img {
    max-width: 100%;
  }
</style>
