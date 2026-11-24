import { Channel, invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { isAndroid } from './volume'

/** A file to add: its address and, when the system gave it, its name. */
export type ToAdd = { address: string; name?: string }

/** What adding many files did (`library::Report` in Rust). */
export type Report = {
  added: number
  known: number
  moved: number
  duplicate: number
  failed: { name: string; error: string }[]
}

export type Progress = { done: number; total: number }

/** CBZ and CBR, and CB7, which is not read yet and is reported as such. */
export function isComic(name: string): boolean {
  return /\.(cbz|cbr|cb7)$/i.test(name)
}

/** Adds many files, one after the other, telling how far it has got. */
export function addMany(files: ToAdd[], onprogress: (p: Progress) => void): Promise<Report> {
  const progress = new Channel<Progress>()
  progress.onmessage = onprogress
  return invoke<Report>('library_add_many', { files, progress })
}

/** Asks for comics, several at once. Undefined when the reader cancels. */
export async function pickFiles(): Promise<ToAdd[] | undefined> {
  if (isAndroid()) {
    type Result = { files: { uri: string; name?: string }[] }
    try {
      const { files } = await invoke<Result>('plugin:documents|pick_files', {
        args: { action: 'open', multiple: true },
      })
      return files.map((f) => ({ address: f.uri, name: f.name }))
    } catch (e) {
      if (String(e).includes('cancelled')) return undefined
      throw e
    }
  }
  const paths = await open({
    multiple: true,
    directory: false,
    filters: [{ name: 'Comics', extensions: ['cbz', 'cbr', 'cb7'] }],
  })
  return paths ? paths.map((address) => ({ address })) : undefined
}

/**
 * Asks for a folder and finds the comics in it and in its subfolders. On Android
 * the folder is kept, to be listed again when the library opens; on a computer it
 * is added once (watching it is for later). Undefined when the reader cancels.
 */
export async function pickFolder(): Promise<ToAdd[] | undefined> {
  if (isAndroid()) {
    let folder: { uri: string }
    try {
      folder = await invoke<{ uri: string }>('plugin:documents|pick_folder')
    } catch (e) {
      if (String(e).includes('cancelled')) return undefined
      throw e
    }
    await invoke('library_remember_folder', { address: folder.uri })
    return listFolder(folder.uri)
  }
  const path = await open({ multiple: false, directory: true })
  return path ? scanPaths([path]) : undefined
}

/** The comics in a folder picked on Android, through the documents plugin. */
export async function listFolder(uri: string): Promise<ToAdd[]> {
  type Listed = { files: { uri: string; path: string }[] }
  const { files } = await invoke<Listed>('plugin:documents|list_folder', { uri })
  return files
    .filter((f) => isComic(f.path))
    .map((f) => ({ address: f.uri, name: f.path.split('/').pop() }))
}

/** The comics in files and folders on a computer: picked, or dropped on the window. */
export async function scanPaths(paths: string[]): Promise<ToAdd[]> {
  const found = await invoke<string[]>('library_scan', { paths })
  return found.map((address) => ({ address }))
}

/**
 * Lists the folders picked on Android again and adds what is new in them: the
 * volumes already in are counted without being read. A folder whose permission is
 * gone is left alone. Nothing on a computer, where a folder is added once.
 */
export async function rescanFolders(): Promise<Report | undefined> {
  if (!isAndroid()) return undefined
  const folders = await invoke<string[]>('library_folders')
  if (folders.length === 0) return undefined
  const files: ToAdd[] = []
  for (const uri of folders) files.push(...(await listFolder(uri).catch(() => [])))
  return addMany(files, () => {})
}

const comics = (n: number) => (n === 1 ? '1 comic' : `${n} comics`)

/** What adding did, in a sentence or two. The files that could not be added are listed apart. */
export function summary(report: Report): string {
  const parts: string[] = []
  if (report.added) parts.push(`Added ${comics(report.added)}.`)
  if (report.moved)
    parts.push(`Found ${comics(report.moved)} again at a new place, with where you left them.`)
  if (report.known) parts.push(`${comics(report.known)} already in the library.`)
  if (report.duplicate)
    parts.push(`${comics(report.duplicate)} left out: copies of comics already in the library.`)
  if (report.failed.length) parts.push(`${comics(report.failed.length)} could not be added:`)
  return parts.join(' ') || 'No comics found there.'
}
