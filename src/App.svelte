<script lang="ts">
  // Spike trackpad-pinch: logs every input event the webview delivers during trackpad gestures,
  // and drives a test square with the events that look like a pinch.
  import { invoke } from '@tauri-apps/api/core'
  import { listen } from '@tauri-apps/api/event'
  import { onMount } from 'svelte'

  type Row = { t: number; type: string; detail: string }

  let rows = $state<Row[]>([])
  let counts = $state<Record<string, number>>({})
  let scale = $state(1)
  let panX = $state(0)
  let panY = $state(0)
  let viewportScale = $state(1)
  let blockDefault = $state(true)

  const start = performance.now()
  let gestureBase = 1

  function log(type: string, detail: string) {
    const t = Math.round(performance.now() - start)
    counts[type] = (counts[type] ?? 0) + 1
    rows = [{ t, type, detail }, ...rows].slice(0, 200)
    invoke('spike_log', { line: `${t} ${type} ${detail}` }).catch(() => {})
  }

  function mods(e: MouseEvent | WheelEvent | KeyboardEvent) {
    return [e.ctrlKey && 'ctrl', e.shiftKey && 'shift', e.altKey && 'alt', e.metaKey && 'meta']
      .filter(Boolean)
      .join('+')
  }

  function onWheel(e: WheelEvent) {
    if (blockDefault) e.preventDefault()
    log(
      'wheel',
      `dx=${e.deltaX.toFixed(2)} dy=${e.deltaY.toFixed(2)} mode=${e.deltaMode} mods=${mods(e) || '-'}`,
    )
    if (e.ctrlKey) scale *= Math.exp(-e.deltaY / 100)
    else {
      panX -= e.deltaX
      panY -= e.deltaY
    }
  }

  type GestureEvent = UIEvent & { scale: number; rotation: number }

  function onGesture(e: Event) {
    if (blockDefault) e.preventDefault()
    const g = e as GestureEvent
    log(e.type, `scale=${g.scale?.toFixed(3)} rotation=${g.rotation?.toFixed(1)}`)
    if (e.type === 'gesturestart') gestureBase = scale
    if (e.type === 'gesturechange') scale = gestureBase * g.scale
  }

  function onTouch(e: TouchEvent) {
    if (blockDefault) e.preventDefault()
    log(e.type, `touches=${e.touches.length}`)
  }

  function onPointer(e: PointerEvent) {
    if (e.type === 'pointermove' && e.buttons === 0) return
    log(e.type, `id=${e.pointerId} kind=${e.pointerType} x=${e.clientX} y=${e.clientY}`)
  }

  function onKey(e: KeyboardEvent) {
    log(e.type, `key=${e.key} mods=${mods(e) || '-'}`)
  }

  function reset() {
    rows = []
    counts = {}
    scale = 1
    panX = 0
    panY = 0
    log('reset', '')
  }

  onMount(() => {
    const opts = { passive: false }
    window.addEventListener('wheel', onWheel, opts)
    for (const type of ['gesturestart', 'gesturechange', 'gestureend'])
      window.addEventListener(type, onGesture, opts)
    for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel'])
      window.addEventListener(type, onTouch as (e: Event) => void, opts)
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'])
      window.addEventListener(type, onPointer as (e: Event) => void)
    window.addEventListener('keydown', onKey)

    const vv = window.visualViewport
    const onViewport = () => {
      viewportScale = vv?.scale ?? 1
      log('viewport', `scale=${viewportScale.toFixed(3)} dpr=${devicePixelRatio}`)
    }
    vv?.addEventListener('resize', onViewport)

    // Linux only: touchpad pinch caught on the GTK widget in Rust (see intercept_pinch).
    type Pinch = { phase: number; scale: number; x: number; y: number; fingers: number }
    const phases = ['begin', 'update', 'end', 'cancel']
    const unlisten = listen<Pinch>('pinch', ({ payload: p }) => {
      log(
        `pinch-${phases[p.phase] ?? p.phase}`,
        `scale=${p.scale.toFixed(3)} x=${p.x.toFixed(0)} y=${p.y.toFixed(0)} fingers=${p.fingers}`,
      )
      if (p.phase === 0) gestureBase = scale
      if (p.phase === 1) scale = gestureBase * p.scale
    })

    log('start', `ua=${navigator.userAgent} dpr=${devicePixelRatio}`)
    return () => unlisten.then((f) => f())
  })
</script>

<main>
  <section class="stage">
    <div
      class="square"
      style:transform="translate({panX}px, {panY}px) scale({scale})"
      aria-hidden="true"
    ></div>
  </section>

  <aside>
    <div class="status">
      <span>square scale <b>{scale.toFixed(2)}</b></span>
      <span>page zoom <b>{viewportScale.toFixed(2)}</b></span>
      <label><input type="checkbox" bind:checked={blockDefault} /> preventDefault</label>
      <button onclick={reset}>Reset</button>
    </div>
    <div class="counts">
      {#each Object.entries(counts) as [type, n] (type)}
        <span>{type}: <b>{n}</b></span>
      {/each}
    </div>
    <ol>
      {#each rows as row (row)}
        <li><span class="t">{row.t}</span> <b>{row.type}</b> {row.detail}</li>
      {/each}
    </ol>
  </aside>
</main>

<style>
  main {
    display: grid;
    grid-template-columns: 1fr 420px;
    height: 100%;
  }

  .stage {
    display: grid;
    place-items: center;
    overflow: hidden;
  }

  .square {
    width: 160px;
    height: 160px;
    background: repeating-linear-gradient(45deg, #c8c8d0 0 10px, #33333a 10px 20px);
    transform-origin: center;
  }

  aside {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border-left: 1px solid #26262c;
    font:
      12px/1.4 ui-monospace,
      monospace;
  }

  .status,
  .counts {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    padding: 8px;
    border-bottom: 1px solid #26262c;
  }

  b {
    color: #e4e4ea;
  }

  ol {
    flex: 1;
    margin: 0;
    padding: 8px;
    overflow: auto;
    list-style: none;
  }

  .t {
    display: inline-block;
    width: 6ch;
    color: #5a5a62;
    text-align: right;
  }
</style>
