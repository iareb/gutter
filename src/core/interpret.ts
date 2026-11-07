// Turns normalized input events into viewer actions. This first version knows
// only what the viewer did before the gesture engine: keys, and taps or clicks
// on the sides. The state machine of M2 step 2.3 replaces it; recordings
// replayed through it in tests keep the behavior from drifting.
import type { InputEvent } from './input'
import { keyMove, keyPan, keyZoom, tapMove, type Move } from './navigation'

export type Action =
  | { kind: 'move'; move: Move }
  /** Move a zoomed page by a fraction of the screen; at its edge, do `orMove` instead. */
  | { kind: 'pan'; fx: number; fy: number; orMove?: Move }
  | { kind: 'zoom'; how: 'in' | 'out' | 'fit' }

/** A tap moves less than this, in CSS pixels, and lasts less than TAP_MS. */
const TAP_SLOP = 10
const TAP_MS = 500

export type Context = {
  /** Width of the page area, in CSS pixels. */
  width: () => number
  zoomed: () => boolean
}

export class Interpreter {
  private downs = new Map<number, { x: number; y: number; t: number }>()

  constructor(private context: Context) {}

  feed(e: InputEvent): Action[] {
    switch (e.kind) {
      case 'key': {
        const zoom = keyZoom(e.key)
        if (zoom) return [{ kind: 'zoom', how: zoom }]
        const move = keyMove(e.key, e.shift)
        const pan = keyPan(e.key, e.shift)
        if (pan && this.context.zoomed())
          return [{ kind: 'pan', fx: pan[0], fy: pan[1], orMove: move }]
        return move ? [{ kind: 'move', move }] : []
      }
      case 'pointer': {
        if (e.phase === 'down') {
          // Another finger down: not a tap any more
          if (this.downs.size) this.downs.clear()
          else this.downs.set(e.id, { x: e.x, y: e.y, t: e.t })
          return []
        }
        const down = this.downs.get(e.id)
        if (!down) return []
        const moved = Math.hypot(e.x - down.x, e.y - down.y) > TAP_SLOP
        if (e.phase === 'move') {
          if (moved) this.downs.delete(e.id)
          return []
        }
        this.downs.delete(e.id)
        if (e.phase === 'cancel' || moved || e.t - down.t > TAP_MS) return []
        // On a zoomed page the sides do not turn it (design doc: one gesture, one action)
        if (this.context.zoomed()) return []
        const move = tapMove(e.x, this.context.width())
        return move ? [{ kind: 'move', move }] : []
      }
      case 'wheel':
        return []
    }
  }
}
