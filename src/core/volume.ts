import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { decode } from './decode'
import type { Size } from './fit'
import type { Loaders } from './pages'

export type Volume = {
  id: number
  /** Archive entry names, in reading order. */
  pages: string[]
}

/** Opens a file picked in the system picker. Rejects with a readable message. */
export function openVolume(path: string): Promise<Volume> {
  return invoke<Volume>('open_volume', { path })
}

/**
 * Address of page `n` (counted from 0), served by the Rust `page` protocol:
 * `http://page.localhost/<id>/<n>` on Windows and Android,
 * `page://localhost/<id>/<n>` elsewhere.
 */
export function pageUrl(volume: Volume, n: number): string {
  return `${convertFileSrc(String(volume.id), 'page')}/${n}`
}

export type PageData = {
  bytes: Blob
  /** From the image header; missing for formats Rust cannot measure. */
  size?: Size
}

/** Fetches the encoded bytes of a page. Rejects with the message Rust sent. */
export function loadPage(volume: Volume, n: number): Promise<PageData> {
  return fetchPage(pageUrl(volume, n))
}

/**
 * Fetches a page decoded by Rust and converted to PNG, for when the webview
 * cannot decode the original. Lossless, but much slower than the original.
 */
export function loadConvertedPage(volume: Volume, n: number): Promise<PageData> {
  return fetchPage(`${pageUrl(volume, n)}/png`)
}

async function fetchPage(url: string): Promise<PageData> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(await response.text())
  const width = Number(response.headers.get('x-page-width'))
  const height = Number(response.headers.get('x-page-height'))
  const bytes = await response.blob()
  return width && height ? { bytes, size: { width, height } } : { bytes }
}

/**
 * Sizes of pages `from` to `to` (excluded), read by Rust from their image
 * headers: enough to lay out double pages without fetching them. Null where
 * it cannot be told.
 */
export async function pageSizes(
  volume: Volume,
  from: number,
  to: number,
): Promise<(Size | null)[]> {
  const sizes = await invoke<([number, number] | null)[]>('page_sizes', { id: volume.id, from, to })
  return sizes.map((s) => (s ? { width: s[0], height: s[1] } : null))
}

/** What the page store needs to fetch and decode the pages of a volume. */
export function pageLoaders(volume: Volume): Loaders {
  return {
    load: (n) => loadPage(volume, n),
    convert: (n) => loadConvertedPage(volume, n),
    decode,
    probe: async (blob) => {
      const bitmap = await createImageBitmap(blob).catch(() => undefined)
      if (!bitmap) return undefined
      const size = { width: bitmap.width, height: bitmap.height }
      bitmap.close()
      return size
    },
  }
}

/** A file picked to read: its address and, when known, its name. */
export type Picked = { address: string; name?: string }

/** Android, where files come through the documents plugin. */
export const isAndroid = () => /Android/i.test(navigator.userAgent)

/**
 * Asks the reader for a comic. On Android through the documents plugin, which
 * keeps the permission to read the file after the app closes and gives its real
 * name (the dialog plugin's address stops working: docs/spikes/android-library.md);
 * elsewhere through the dialog plugin, whose paths do not expire. Undefined when
 * the reader cancels.
 */
export async function pickComic(): Promise<Picked | undefined> {
  if (isAndroid()) {
    type Result = { files: { uri: string; name?: string }[] }
    try {
      const { files } = await invoke<Result>('plugin:documents|pick_files', {
        args: { action: 'open', multiple: false },
      })
      return files[0] && { address: files[0].uri, name: files[0].name }
    } catch (e) {
      if (String(e).includes('cancelled')) return undefined
      throw e
    }
  }
  const path = await open({ multiple: false, directory: false })
  return path ? { address: path, name: fileName(path) } : undefined
}

/**
 * File name to show for a path. Android `content://` addresses carry no
 * readable name, so they get none here: the documents plugin gives it.
 */
export function fileName(path: string): string | undefined {
  if (path.startsWith('content://')) return undefined
  return path.split(/[/\\]/).pop() || undefined
}
