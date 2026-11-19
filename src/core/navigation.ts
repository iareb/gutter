/** A page change asked for by the reader. */
export type Move = 'next' | 'previous' | 'first' | 'last'

/** Reading direction: left to right, or right to left (manga). */
export type Direction = 'ltr' | 'rtl'

/** The same move seen in a mirror: in right-to-left reading the next page is on the left. */
const mirror = (move: Move, direction: Direction): Move =>
  direction === 'ltr' ? move : move === 'next' ? 'previous' : move === 'previous' ? 'next' : move

/**
 * Keyboard shortcuts. The left and right arrows follow the reading direction
 * (in right to left the left arrow goes forward); down, PageDown and Space
 * always go forward. Shift+Space goes back, as in browsers.
 */
export function keyMove(
  key: string,
  shift = false,
  direction: Direction = 'ltr',
): Move | undefined {
  switch (key) {
    case 'ArrowRight':
      return mirror('next', direction)
    case 'ArrowLeft':
      return mirror('previous', direction)
    case 'ArrowDown':
    case 'PageDown':
      return 'next'
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

/**
 * Tap and click zones: the left and right quarter of the page area. In
 * right-to-left reading the left one goes forward.
 */
export function tapMove(x: number, width: number, direction: Direction = 'ltr'): Move | undefined {
  if (x < width * 0.25) return mirror('previous', direction)
  if (x >= width * 0.75) return mirror('next', direction)
}

/**
 * Which way the page on screen leaves when the reader moves on: -1 to the left,
 * 1 to the right. The new page comes in from the other side.
 */
export function leaveSide(move: 'next' | 'previous', direction: Direction): -1 | 1 {
  const forward = move === 'next' ? -1 : 1
  return direction === 'ltr' ? forward : (-forward as -1 | 1)
}
