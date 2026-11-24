import type { Entry } from './library'

/** Volumes shown under "Continue reading": the last ones opened, the latest first. */
export const CONTINUE = 3

/** The last volumes opened and not finished, the latest first. */
export function continueReading(entries: Entry[], count = CONTINUE): Entry[] {
  return entries
    .filter((e) => e.opened !== null && !e.finished)
    .sort((a, b) => (b.opened ?? 0) - (a.opened ?? 0) || b.id - a.id)
    .slice(0, count)
}

/** Every volume, the newest added first. */
export function newestFirst(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) => b.added - a.added || b.id - a.id)
}

/** How far a volume is read, from 0 to 1: the page reached over the pages. */
export function progress(entry: Entry): number {
  if (entry.finished) return 1
  if (entry.opened === null || !entry.pages) return 0
  return Math.min(1, (entry.page + 1) / entry.pages)
}

/** What a card says under its name. */
export function status(entry: Entry): string {
  if (entry.finished) return 'Finished'
  if (entry.opened === null) return 'New'
  return entry.pages ? `Page ${entry.page + 1} of ${entry.pages}` : `Page ${entry.page + 1}`
}

/** A volume's name without the extension of its file: "Saga 01.cbz" is "Saga 01". */
export function title(entry: Entry): string {
  return entry.name.replace(/\.(cbz|cbr|zip|rar|cb7)$/i, '') || entry.name
}
