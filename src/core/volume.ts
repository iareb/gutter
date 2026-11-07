import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import type { Size } from './fit'

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
 * File name to show for a picked file. Android `content://` URIs carry no
 * readable name, so they get none.
 */
export function fileName(path: string): string | undefined {
  if (path.startsWith('content://')) return undefined
  return path.split(/[/\\]/).pop() || undefined
}
