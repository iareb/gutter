import type { Direction } from './navigation'

/** How pages are laid out. Double page and vertical scroll come later in M3. */
export type Mode = 'single'

/**
 * The reader's choices that hold for every volume. Kept in the webview's
 * storage, which survives closing the app; the reading position and choices for
 * one volume come with the library (M4).
 */
export type Settings = {
  direction: Direction
  mode: Mode
}

export const DEFAULT_SETTINGS: Settings = { direction: 'ltr', mode: 'single' }

const KEY = 'gutter.settings'

/** Reads the settings, keeping the default for anything missing or not understood. */
export function parseSettings(text: string | null): Settings {
  let raw: unknown
  try {
    raw = text ? JSON.parse(text) : undefined
  } catch {
    raw = undefined
  }
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    direction:
      r.direction === 'rtl' || r.direction === 'ltr' ? r.direction : DEFAULT_SETTINGS.direction,
    mode: r.mode === 'single' ? r.mode : DEFAULT_SETTINGS.mode,
  }
}

export function loadSettings(
  storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage,
): Settings {
  try {
    return parseSettings(storage?.getItem(KEY) ?? null)
  } catch {
    // Storage can be refused (a private window): the defaults are used
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(
  settings: Settings,
  storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage,
): void {
  try {
    storage?.setItem(KEY, JSON.stringify(settings))
  } catch {
    // Not saved: the choice still holds until the app is closed
  }
}
