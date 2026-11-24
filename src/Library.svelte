<script lang="ts">
  import { summary, type Report } from './core/adding'
  import { coverUrl, type Entry } from './core/library'
  import { continueReading, newestFirst, progress, status, title, whereItWas } from './core/shelf'

  type Props = {
    entries: Entry[]
    /** Shown above the covers: a volume that could not be opened. */
    error?: string
    onopen: (entry: Entry) => void
    onremove: (entry: Entry) => void
    /** Volumes whose file does not open now: shown greyed out. */
    missing: Set<number>
    /** Looks for the file of a volume that went away. */
    onfind: (entry: Entry) => void
    /** What the last adding did, until it is closed. */
    report?: Report
    onclosereport: () => void
    onaddfiles: () => void
    onaddfolder: () => void
  }
  let {
    entries,
    error,
    missing,
    report,
    onopen,
    onfind,
    onremove,
    onclosereport,
    onaddfiles,
    onaddfolder,
  }: Props = $props()

  /** The volume that went away whose dialog is open. */
  let lost = $state<Entry>()

  /**
   * Closes the dialog of a volume that went away and acts on that volume. The volume
   * is taken before the dialog closes: what the dialog shows lets go of it then (this
   * once sent nothing to Find it).
   */
  function settle(act: (entry: Entry) => void) {
    const entry = lost
    lost = undefined
    if (entry) act(entry)
  }

  const reading = $derived(continueReading(entries))
  const all = $derived(newestFirst(entries))

  /** The volume whose menu is open (a long press or a right click). */
  let asked = $state<Entry>()
  /** Covers that could not be loaded: a plain card with the name instead. */
  let noCover = $state<Record<number, boolean>>({})

  /**
   * Covers are asked for when their card comes near the screen, not all at once:
   * each one may be made then, and a library may hold hundreds.
   */
  function lazy(img: HTMLImageElement, src: string) {
    const observer = new IntersectionObserver(
      (seen) => {
        if (seen.some((s) => s.isIntersecting)) {
          img.src = src
          observer.disconnect()
        }
      },
      { rootMargin: '300px' },
    )
    observer.observe(img)
    return { destroy: () => observer.disconnect() }
  }

  // A long press with a finger opens the menu; a right click does on a computer
  const LONG_PRESS_MS = 500
  let press: { id: number; x: number; y: number; timer: ReturnType<typeof setTimeout> } | undefined
  /** The press became a long press: the click that follows does not open the volume. */
  let pressed = false

  function down(event: PointerEvent, entry: Entry) {
    if (event.pointerType === 'mouse') return
    pressed = false
    const timer = setTimeout(() => {
      pressed = true
      asked = entry
    }, LONG_PRESS_MS)
    press = { id: event.pointerId, x: event.clientX, y: event.clientY, timer }
  }

  function move(event: PointerEvent) {
    if (press?.id !== event.pointerId) return
    // Scrolling the grid is not a long press
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10) cancel()
  }

  function cancel() {
    clearTimeout(press?.timer)
    press = undefined
  }

  function click(entry: Entry) {
    if (pressed) {
      pressed = false
      return
    }
    if (missing.has(entry.id)) lost = entry
    else onopen(entry)
  }

  function contextmenu(event: MouseEvent, entry: Entry) {
    event.preventDefault()
    cancel()
    asked = entry
  }

  function remove() {
    if (asked) onremove(asked)
    asked = undefined
  }

  // The dialogs close on Escape
  $effect(() => {
    if (!asked && !lost) return
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') asked = lost = undefined
    }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  })
</script>

{#snippet card(entry: Entry, big: boolean)}
  <button
    class="card"
    class:big
    class:gone={missing.has(entry.id)}
    title={entry.name}
    onclick={() => click(entry)}
    oncontextmenu={(event) => contextmenu(event, entry)}
    onpointerdown={(event) => down(event, entry)}
    onpointermove={move}
    onpointerup={cancel}
    onpointercancel={cancel}
  >
    <span class="cover">
      {#if noCover[entry.id]}
        <span class="placeholder">{title(entry)}</span>
      {:else}
        <img
          alt=""
          draggable="false"
          decoding="async"
          use:lazy={coverUrl(entry.id)}
          onerror={() => (noCover = { ...noCover, [entry.id]: true })}
        />
      {/if}
      {#if progress(entry) > 0}
        <span class="bar"><span style:width="{progress(entry) * 100}%"></span></span>
      {/if}
    </span>
    <span class="name">{title(entry)}</span>
    <small>{missing.has(entry.id) ? 'Missing: tap to find it' : status(entry)}</small>
  </button>
{/snippet}

<div class="library">
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if report}
    <div class="report" role="status">
      <p>{summary(report)}</p>
      {#if report.failed.length}
        <ul>
          {#each report.failed as failed, i (i)}
            <li><strong>{failed.name}</strong>: {failed.error}</li>
          {/each}
        </ul>
      {/if}
      <button class="close" aria-label="Close" onclick={onclosereport}>✕</button>
    </div>
  {/if}
  {#if entries.length === 0}
    <div class="empty">
      <p>Your library is empty.</p>
      <p>
        <small
          >Add your comics, or a whole folder of them: each one opens again where you left it.</small
        >
      </p>
      <div class="adds">
        <button class="add" onclick={onaddfiles}>Add comics…</button>
        <button class="add" onclick={onaddfolder}>Add a folder…</button>
      </div>
    </div>
  {:else}
    {#if reading.length > 0}
      <h2>Continue reading</h2>
      <div class="row">
        {#each reading as entry (entry.id)}{@render card(entry, true)}{/each}
      </div>
    {/if}
    <h2>All comics <small>{entries.length}</small></h2>
    <div class="grid">
      {#each all as entry (entry.id)}{@render card(entry, false)}{/each}
    </div>
  {/if}
</div>

{#if lost}
  {@const entry = lost}
  <div class="scrim" role="presentation" onclick={() => (lost = undefined)}></div>
  <div class="dialog" role="dialog" aria-modal="true" aria-label="A comic that went away">
    <p><strong>{title(entry)}</strong> cannot be found.</p>
    <p><small>It was at {whereItWas(entry.address)}</small></p>
    <p>
      <small
        >If you moved or renamed it, find it again: it keeps where you left it. Or remove it from
        the library.</small
      >
    </p>
    <div class="actions">
      <button onclick={() => (lost = undefined)}>Cancel</button>
      <button onclick={() => settle(onremove)}>Remove</button>
      <button class="primary" onclick={() => settle(onfind)}>Find it…</button>
    </div>
  </div>
{/if}

{#if asked}
  <div class="scrim" role="presentation" onclick={() => (asked = undefined)}></div>
  <div class="dialog" role="dialog" aria-modal="true" aria-label="Remove from the library">
    <p>Remove <strong>{title(asked)}</strong> from the library?</p>
    <p><small>The file stays where it is. Opening it again adds it back from the start.</small></p>
    <div class="actions">
      <button onclick={() => (asked = undefined)}>Cancel</button>
      <button class="danger" onclick={remove}>Remove</button>
    </div>
  </div>
{/if}

<style>
  .library {
    flex: 1;
    min-height: 0;
    padding: 8px 16px 24px;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  h2 {
    margin: 16px 0 10px;
    font-size: 0.95rem;
    font-weight: 600;
    letter-spacing: 0.02em;
    opacity: 0.85;
  }

  h2 small {
    margin-left: 6px;
    font-weight: 400;
    opacity: 0.6;
  }

  .row,
  .grid {
    display: grid;
    gap: 18px 14px;
  }

  /* At most three, as wide as the screen allows but not wider than a cover needs */
  .row {
    grid-template-columns: repeat(3, minmax(0, 200px));
  }

  /* Two columns on a phone, as many as fit on a computer */
  .grid {
    grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
  }

  .card {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    padding: 0;
    font: inherit;
    color: inherit;
    text-align: left;
    background: none;
    border: 0;
    cursor: pointer;
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
    -webkit-tap-highlight-color: transparent;
  }

  .cover {
    position: relative;
    display: grid;
    place-items: center;
    overflow: hidden;
    aspect-ratio: 2 / 3;
    background: #1f1f24;
    border-radius: 6px;
    box-shadow: 0 2px 8px #0006;
  }

  .card:focus-visible .cover,
  .card:hover .cover {
    outline: 2px solid #8a9bff;
    outline-offset: 2px;
  }

  /* The whole cover, never cropped: a spread or an odd shape shows as it is */
  img {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  .placeholder {
    padding: 12px;
    font-size: 0.85rem;
    text-align: center;
    word-break: break-word;
    opacity: 0.7;
  }

  .bar {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    height: 4px;
    background: #0008;
  }

  .bar > span {
    display: block;
    height: 100%;
    background: #8a9bff;
  }

  .name {
    display: -webkit-box;
    overflow: hidden;
    font-size: 0.85rem;
    line-height: 1.25;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }

  small {
    font-size: 0.75rem;
    opacity: 0.6;
  }

  .empty {
    display: grid;
    gap: 4px;
    place-content: center;
    min-height: 60%;
    text-align: center;
  }

  .empty p {
    margin: 0;
  }

  .add,
  .dialog button {
    padding: 8px 16px;
    font: inherit;
    color: #e4e4ea;
    background: #26262c;
    border: 1px solid #34343c;
    border-radius: 6px;
  }

  .adds {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    justify-content: center;
    margin-top: 14px;
  }

  .report {
    position: relative;
    margin: 8px 0;
    padding: 10px 40px 10px 14px;
    background: #1f1f24;
    border: 1px solid #34343c;
    border-radius: 8px;
  }

  .report p {
    margin: 0;
  }

  .report ul {
    margin: 6px 0 0;
    padding-left: 18px;
    font-size: 0.85rem;
    opacity: 0.85;
  }

  .close {
    position: absolute;
    top: 6px;
    right: 6px;
    width: 30px;
    height: 30px;
    padding: 0;
    font: inherit;
    color: inherit;
    background: none;
    border: 0;
    opacity: 0.7;
  }

  .error {
    margin: 8px 0;
    color: #e08a8a;
  }

  .scrim {
    position: fixed;
    inset: 0;
    z-index: 4;
    background: #0008;
  }

  .dialog {
    position: fixed;
    top: 50%;
    left: 50%;
    z-index: 5;
    width: min(360px, calc(100% - 32px));
    padding: 16px 18px;
    background: #1f1f24;
    border: 1px solid #34343c;
    border-radius: 10px;
    box-shadow: 0 12px 32px #000a;
    transform: translate(-50%, -50%);
  }

  .dialog p {
    margin: 0 0 8px;
  }

  .actions {
    display: flex;
    gap: 10px;
    justify-content: flex-end;
    margin-top: 14px;
  }

  /* A volume whose file went away: there, but not to be read */
  .card.gone .cover {
    filter: grayscale(1);
    opacity: 0.4;
  }

  .card.gone .name {
    opacity: 0.6;
  }

  .dialog p small {
    word-break: break-word;
  }

  .dialog .primary {
    color: #fff;
    background: #3a4690;
    border-color: #4c59b0;
  }

  .dialog .danger {
    color: #ffd0d0;
    background: #5a2a2e;
    border-color: #7a3a40;
  }
</style>
