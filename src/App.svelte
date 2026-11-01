<script lang="ts">
  // Spikes resize-quality and image-formats: open gutter-formats.cbz, check
  // which formats the webview decodes with the right colors, and measure how
  // well each downscaling method removes moire from 1 px stripes.
  // Throwaway code, lives only on the spike/resize-quality branch.
  import { convertFileSrc, invoke } from '@tauri-apps/api/core'
  import { open } from '@tauri-apps/plugin-dialog'

  type VolumeInfo = { id: number; sizeBytes: number; names: string[]; openMs: number; indexMs: number }
  type Rgb = [number, number, number]
  type Method = { name: string; resize: (blob: Blob, w: number, h: number) => Promise<CanvasImageSource> }

  // Quadrant colors of the format pages (see make_formats_cbz.py)
  const COLORS: Rgb[] = [[220, 30, 30], [30, 180, 60], [30, 60, 220], [128, 128, 128]]
  // Same quadrants as greyscale, for the 16 bit PNG
  const GREYS: Rgb[] = [[87, 87, 87], [121, 121, 121], [69, 69, 69], [128, 128, 128]]
  const SAMPLES = [[0.25, 0.15], [0.75, 0.15], [0.25, 0.85], [0.75, 0.85]]
  const TOLERANCE = 12
  // Non-integer ratio, like a real page fitted to a screen
  const SCALE = 1 / 3.3
  const RUNS = 3

  let lines: string[] = $state([])
  let busy = $state(false)
  let thumbs: HTMLDivElement
  let results: HTMLDivElement

  const ms = (n: number) => `${n.toFixed(1)} ms`
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
  const log = (line: string) => {
    // Also to the console: on Android it shows up in logcat as Tauri/Console
    console.log(`[IMG] ${line}`)
    lines = [...lines, line]
  }

  // http://page.localhost/<id> on Windows and Android, page://localhost/<id> elsewhere
  const pageUrl = (id: number, n: number) => `${convertFileSrc(String(id), 'page')}/${n}`
  const fetchBlob = async (url: string) => (await fetch(url)).blob()

  function canvas(w: number, h: number) {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    return c
  }

  /** Pixels of an image drawn 1:1, without any scaling. */
  function pixels(source: CanvasImageSource, w: number, h: number) {
    const ctx = canvas(w, h).getContext('2d', { willReadFrequently: true })!
    ctx.drawImage(source, 0, 0)
    return ctx.getImageData(0, 0, w, h)
  }

  const size = (source: CanvasImageSource) => {
    const s = source as { width: number; height: number }
    return [s.width, s.height]
  }

  // ---- Formats -------------------------------------------------------------

  async function checkFormat(id: number, n: number, name: string) {
    const url = pageUrl(id, n)
    const blob = await fetchBlob(url)
    const t0 = performance.now()
    let bitmap: ImageBitmap
    try {
      bitmap = await createImageBitmap(blob)
    } catch (e) {
      // Is it createImageBitmap or the format? Try the <img> path too.
      const img = new Image()
      img.src = url
      const viaImg = await img.decode().then(() => 'si', () => 'no')
      log(`  ${name}: NON DECODIFICATO (${e}); con <img>: ${viaImg}`)
      return
    }
    const decodeMs = performance.now() - t0

    const { width: w, height: h } = bitmap
    const data = pixels(bitmap, w, h).data
    const expected = name.includes('16bit') ? GREYS : COLORS
    const wrong = SAMPLES.map(([fx, fy], i) => {
      const at = (Math.floor(fy * h) * w + Math.floor(fx * w)) * 4
      const got: Rgb = [data[at], data[at + 1], data[at + 2]]
      const off = got.some((v, c) => Math.abs(v - expected[i][c]) > TOLERANCE)
      return off ? `atteso ${expected[i]} trovato ${got}` : null
    }).filter(Boolean)

    const verdict = wrong.length ? `COLORI SBAGLIATI: ${wrong.join('; ')}` : 'ok'
    log(`  ${name}: ${verdict}, ${w}x${h}, decodifica ${ms(decodeMs)}`)

    const thumb = canvas(120, 180)
    thumb.getContext('2d')!.drawImage(bitmap, 0, 0, 120, 180)
    thumb.title = name
    thumbs.append(thumb)
    bitmap.close()
  }

  // ---- Resize --------------------------------------------------------------

  const cib = (quality: ResizeQuality): Method => ({
    name: `createImageBitmap ${quality}`,
    resize: (blob, w, h) => createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: quality }),
  })

  /** Decode at full size, then one drawImage with high smoothing. */
  const canvasOneStep: Method = {
    name: 'canvas un passo',
    resize: async (blob, w, h) => {
      const full = await createImageBitmap(blob)
      const out = canvas(w, h)
      const ctx = out.getContext('2d')!
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(full, 0, 0, w, h)
      full.close()
      return out
    },
  }

  /** Halve until within 2x of the target, then a last high-quality step: the design's fallback. */
  const canvasSteps: Method = {
    name: 'canvas a passi',
    resize: async (blob, w, h) => {
      let source: CanvasImageSource = await createImageBitmap(blob)
      let [sw, sh] = size(source)
      while (sw / 2 >= w) {
        sw = Math.round(sw / 2)
        sh = Math.round(sh / 2)
        const step = canvas(sw, sh)
        const ctx = step.getContext('2d')!
        ctx.imageSmoothingQuality = 'high'
        ctx.drawImage(source, 0, 0, sw, sh)
        source = step
      }
      const out = canvas(w, h)
      const ctx = out.getContext('2d')!
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(source, 0, 0, w, h)
      return out
    },
  }

  const METHODS = [cib('high'), cib('medium'), cib('low'), cib('pixelated'), canvasOneStep, canvasSteps]

  /**
   * Standard deviation of brightness inside the stripe areas. A perfect
   * downscale turns 1 px stripes into flat grey (0); moire raises it.
   */
  function stripeScore(image: ImageData) {
    const { width: w, height: h, data } = image
    const values: number[] = []
    // Top half: vertical stripes; bottom half: horizontal ones. Margins keep the label band out.
    for (const [y0, y1] of [[0.05, 0.4], [0.6, 0.95]]) {
      for (let y = Math.floor(y0 * h); y < y1 * h; y++) {
        for (let x = Math.floor(0.05 * w); x < 0.95 * w; x++) {
          const i = (y * w + x) * 4
          values.push((data[i] + data[i + 1] + data[i + 2]) / 3)
        }
      }
    }
    const mean = values.reduce((a, b) => a + b, 0) / values.length
    const sd = Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length)
    return { mean, sd }
  }

  const grade = (sd: number) => (sd < 8 ? 'liscio' : sd < 25 ? 'un po\' di moiré' : 'MOIRÉ FORTE')

  async function checkResize(id: number, n: number, name: string) {
    const blob = await fetchBlob(pageUrl(id, n))
    const original = await createImageBitmap(blob)
    const w = Math.round(original.width * SCALE)
    const h = Math.round(original.height * SCALE)
    log(`  ${name}: ${original.width}x${original.height} → ${w}x${h}`)
    original.close()

    for (const method of METHODS) {
      const times: number[] = []
      let result: CanvasImageSource | null = null
      try {
        for (let i = 0; i < RUNS; i++) {
          const t0 = performance.now()
          result = await method.resize(blob, w, h)
          times.push(performance.now() - t0)
        }
      } catch (e) {
        log(`    ${method.name}: ERRORE ${e}`)
        continue
      }
      const [rw, rh] = size(result!)
      if (rw !== w || rh !== h) {
        log(`    ${method.name}: IGNORA IL RESIZE, esce ${rw}x${rh}`)
        continue
      }
      const { mean, sd } = stripeScore(pixels(result!, w, h))
      log(`    ${method.name}: ${grade(sd)} (dev. std ${sd.toFixed(1)}, media ${mean.toFixed(0)}), ${ms(median(times))}`)
      show(result!, `${name} · ${method.name}`)
    }
  }

  /** Shows a result at 1:1 device pixels, so the screen does not rescale it. */
  function show(source: CanvasImageSource, label: string) {
    const [w, h] = size(source)
    const c = canvas(w, h)
    c.getContext('2d')!.drawImage(source, 0, 0)
    c.style.width = `${w / devicePixelRatio}px`
    const figure = document.createElement('figure')
    const caption = document.createElement('figcaption')
    caption.textContent = label
    figure.append(caption, c)
    results.append(figure)
  }

  // ---- Run -----------------------------------------------------------------

  const openFile = async () => {
    busy = true
    try {
      const path = await open({ multiple: false, directory: false })
      if (!path) return
      lines = []
      thumbs.replaceChildren()
      results.replaceChildren()

      const volume = await invoke<VolumeInfo>('open_volume', { path })
      log(navigator.userAgent)
      log(`devicePixelRatio ${devicePixelRatio}, ${volume.names.length} immagini`)

      log('Formati:')
      for (const [n, name] of volume.names.entries()) {
        if (!name.includes('resize')) await checkFormat(volume.id, n, name)
      }
      log(`Ridimensionamento (scala 1/${(1 / SCALE).toFixed(1)}, mediana di ${RUNS}):`)
      for (const [n, name] of volume.names.entries()) {
        if (name.includes('resize')) await checkResize(volume.id, n, name)
      }
      log('Fine.')
    } catch (e) {
      log(`ERRORE: ${e}`)
    } finally {
      busy = false
    }
  }
</script>

<main>
  <button onclick={openFile} disabled={busy}>{busy ? 'In corso…' : 'Apri file'}</button>
  {#if lines.length}
    <pre>{lines.join('\n')}</pre>
  {/if}
  <div class="thumbs" bind:this={thumbs}></div>
  <div class="results" bind:this={results}></div>
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

  .thumbs {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    justify-content: center;
  }

  .results :global(figure) {
    margin: 0 0 16px;
  }

  .results :global(figcaption) {
    font-size: 12px;
    margin-bottom: 4px;
  }
</style>
