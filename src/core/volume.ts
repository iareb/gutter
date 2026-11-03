import { convertFileSrc, invoke } from '@tauri-apps/api/core'

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

/**
 * File name to show for a picked file. Android `content://` URIs carry no
 * readable name, so they get none.
 */
export function fileName(path: string): string | undefined {
  if (path.startsWith('content://')) return undefined
  return path.split(/[/\\]/).pop() || undefined
}
