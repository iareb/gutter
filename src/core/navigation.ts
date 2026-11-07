/** A page change asked for by the reader. */
export type Move = 'next' | 'previous' | 'first' | 'last'

/**
 * Keyboard shortcuts, for left-to-right reading (manga direction comes in M3).
 * Shift+Space goes back, as in browsers.
 */
export function keyMove(key: string, shift = false): Move | undefined {
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
    case 'PageDown':
      return 'next'
    case 'ArrowLeft':
    case 'ArrowUp':
    case 'PageUp':
      return 'previous'
    case ' ':
      return shift ? 'previous' : 'next'
    case 'Home':
      return 'first'
    case 'End':
      return 'last'
  }
}

/** Tap and click zones: the left and right quarter of the page area. */
export function tapMove(x: number, width: number): Move | undefined {
  if (x < width * 0.25) return 'previous'
  if (x >= width * 0.75) return 'next'
}

/** The page (counted from 0) a move leads to. Stops at the first and last page. */
export function movePage(move: Move, page: number, count: number): number {
  switch (move) {
    case 'next':
      return Math.min(page + 1, count - 1)
    case 'previous':
      return Math.max(page - 1, 0)
    case 'first':
      return 0
    case 'last':
      return count - 1
  }
}
