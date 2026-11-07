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

/**
 * How far the same keys move a zoomed page, as a fraction of the screen.
 * At the edge in that direction they turn the page instead (see keyMove).
 */
export function keyPan(key: string, shift = false): [number, number] | undefined {
  switch (key) {
    case 'ArrowRight':
      return [0.3, 0]
    case 'ArrowLeft':
      return [-0.3, 0]
    case 'ArrowDown':
      return [0, 0.3]
    case 'ArrowUp':
      return [0, -0.3]
    case 'PageDown':
      return [0, 0.9]
    case 'PageUp':
      return [0, -0.9]
    case ' ':
      return [0, shift ? -0.9 : 0.9]
  }
}

/** Zoom keys, until the gesture engine brings pinch and Ctrl+wheel. */
export function keyZoom(key: string): 'in' | 'out' | 'fit' | undefined {
  switch (key) {
    case '+':
    case '=':
      return 'in'
    case '-':
      return 'out'
    case '0':
      return 'fit'
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
