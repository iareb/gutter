import { invoke } from '@tauri-apps/api/core'

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
 * File name to show for a picked file. Android `content://` URIs carry no
 * readable name, so they get none.
 */
export function fileName(path: string): string | undefined {
  if (path.startsWith('content://')) return undefined
  return path.split(/[/\\]/).pop() || undefined
}
