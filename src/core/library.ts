import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import type { Direction } from './navigation'
import type { Mode, Settings } from './settings'

/** Where a volume was left, and the choices made while reading it (null: the View menu's). */
export type Reading = {
  /** Counted from 0. */
  page: number
  finished: boolean
  direction: Direction | null
  mode: Mode | null
  cover: boolean | null
}

/** A volume of the library, as `src-tauri/src/library.rs` keeps it. */
export type Entry = Reading & {
  id: number
  /** A path on a computer, a `content://` address on Android. */
  address: string
  name: string
  size: number
  fingerprint: string
  pages: number | null
  /** Milliseconds since 1970. */
  added: number
  opened: number | null
}

/** What adding a file did: see `library::Added` in Rust. */
export type Added = 'new' | 'known' | 'moved' | 'duplicate'

/**
 * Adds a file that was just opened to the library, or finds it there (also when
 * moved or renamed). With its page count given, Rust reads only its first and last 64 KB.
 */
export function addToLibrary(
  address: string,
  name: string | undefined,
  pages?: number,
): Promise<[Entry, Added]> {
  return invoke<[Entry, Added]>('library_add', {
    address,
    name: name ?? null,
    pages: pages ?? null,
  })
}

/** The volumes whose file does not open now: deleted, moved, renamed, or a permission lost. */
export function missingVolumes(): Promise<number[]> {
  return invoke<number[]>('library_missing')
}

/** Every volume of the library, the last opened first. */
export function listLibrary(): Promise<Entry[]> {
  return invoke<Entry[]>('library_list')
}

/**
 * Removes a volume from the library; the file is never touched. On Android the
 * permission to read a file picked alone is given back too (one picked through a
 * folder belongs to the folder's permission, and giving it back just fails).
 */
export async function removeFromLibrary(entry: Entry): Promise<void> {
  await invoke<boolean>('library_remove', { id: entry.id })
  if (entry.address.startsWith('content://')) {
    await invoke('plugin:documents|release', { uri: entry.address }).catch(() => {})
  }
}

export function markOpened(id: number, pages: number): Promise<boolean> {
  return invoke<boolean>('library_opened', { id, pages })
}

export function saveReading(id: number, reading: Reading): Promise<boolean> {
  return invoke<boolean>('library_save', { id, reading })
}

/**
 * Address of the cover of a library volume, served by the Rust `thumb` protocol:
 * `http://thumb.localhost/<id>` on Windows and Android, `thumb://localhost/<id>`
 * elsewhere. Made the first time it is asked for; a volume with no cover answers
 * 404, and the library shows a placeholder.
 */
export function coverUrl(id: number): string {
  return convertFileSrc(String(id), 'thumb')
}

/** The choices to read a volume with: its own where it has them, the menu's otherwise. */
export function choicesFor(reading: Reading | undefined, defaults: Settings): Settings {
  return {
    direction: reading?.direction ?? defaults.direction,
    mode: reading?.mode ?? defaults.mode,
    cover: reading?.cover ?? defaults.cover,
  }
}

/** The page to open a volume at: where it was left, kept inside the volume (the file may have changed). */
export function startPage(reading: Reading | undefined, count: number): number {
  if (!reading || count <= 0) return 0
  return Math.min(Math.max(0, Math.floor(reading.page)), count - 1)
}

/**
 * Saves the place at most once every `interval` ms: the first change at once, the
 * ones that follow in a burst (flipping through pages) once the interval is over,
 * only the last of them. `flush` saves what is waiting, at once: when the app goes
 * to the background, closes or opens another volume.
 */
export class PlaceSaver {
  private pending: Reading | undefined
  private last: string | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private until = 0

  constructor(
    private readonly save: (reading: Reading) => Promise<unknown>,
    private readonly interval = 1000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  set(reading: Reading): void {
    // The place already saved (a redraw, a page turned and turned back) is not saved again
    if (JSON.stringify(reading) === this.last) {
      this.pending = undefined
      return
    }
    this.pending = reading
    const wait = this.until - this.now()
    if (wait <= 0) this.write()
    else this.timer ??= setTimeout(() => this.write(), wait)
  }

  flush(): Promise<unknown> {
    return this.write()
  }

  private write(): Promise<unknown> {
    clearTimeout(this.timer)
    this.timer = undefined
    const reading = this.pending
    if (!reading) return Promise.resolve()
    this.pending = undefined
    this.last = JSON.stringify(reading)
    this.until = this.now() + this.interval
    // A place not saved is not worth an error on screen: reading goes on
    return this.save(reading).catch((e) => console.warn('[gutter] place not saved:', e))
  }
}
