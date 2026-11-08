// The gesture engine: a state machine that turns normalized input events into
// viewer actions, following the design doc's rule that a gesture produces
// exactly one kind of action: it moves the view or turns the page, never both.
//
// States: idle; pressed (a pointer is down and has not moved yet); pan
// (dragging a zoomed page); swipe (a finger dragging a fitted page); pinch (two
// fingers); done (the gesture is over but fingers are still down: they are
// ignored until all are up, so the end of a pinch cannot become a pan).
// After a swipe has turned the page, pointer input is ignored for TURN_LOCK_MS:
// the "page change in progress" state of the design doc.
//
// Thresholds are first guesses: step 2.4 tunes them on real devices.
import type { InputEvent, PointerInput } from './input'
import { keyMove, keyPan, keyZoom, tapMove, type Move } from './navigation'

export type Action =
  | { kind: 'move'; move: Move }
  /** Move a zoomed page by a fraction of the screen; at its edge, do `orMove` instead. */
  | { kind: 'pan'; fx: number; fy: number; orMove?: Move }
  /** Drag a zoomed page by CSS pixels: the page follows the pointer. */
  | { kind: 'drag'; dx: number; dy: number }
  | { kind: 'zoom'; how: 'in' | 'out' | 'fit' }
  /** Zoom by `factor` keeping the point (x, y) of the page area, in CSS pixels, still. */
  | { kind: 'zoomAt'; factor: number; x: number; y: number }

/** A tap moves less than this, in CSS pixels, and lasts less than TAP_MS. */
export const TAP_SLOP = 10
export const TAP_MS = 500
/** A swipe turns the page past both a distance (fraction of the width) and a speed. */
export const SWIPE_DISTANCE = 0.15
export const SWIPE_SPEED = 0.3 // CSS pixels per millisecond
export const TURN_LOCK_MS = 250

export type Context = {
  /** Width of the page area, in CSS pixels. */
  width: () => number
  zoomed: () => boolean
}

type Point = { x: number; y: number }
type State =
  | { kind: 'idle' }
  | { kind: 'pressed'; id: number; device: PointerInput['device']; start: Point; t0: number }
  | { kind: 'pan'; id: number; last: Point }
  | { kind: 'swipe'; id: number; start: Point; t0: number }
  | { kind: 'pinch'; fingers: Map<number, Point>; distance: number }
  | { kind: 'done' }

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
const middle = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

export class GestureEngine {
  private state: State = { kind: 'idle' }
  /** Pointers currently down, wherever the state machine is. */
  private down = new Map<number, Point>()
  private lockedUntil = -Infinity

  constructor(private context: Context) {}

  /** For tests and debugging. */
  get stateKind() {
    return this.state.kind
  }

  feed(e: InputEvent): Action[] {
    switch (e.kind) {
      case 'key':
        return this.key(e.key, e.shift)
      case 'wheel':
        return [] // step 2.5
      case 'pointer':
        return this.pointer(e)
    }
  }

  private key(key: string, shift: boolean): Action[] {
    const zoom = keyZoom(key)
    if (zoom) return [{ kind: 'zoom', how: zoom }]
    const move = keyMove(key, shift)
    const pan = keyPan(key, shift)
    if (pan && this.context.zoomed()) return [{ kind: 'pan', fx: pan[0], fy: pan[1], orMove: move }]
    return move ? [{ kind: 'move', move }] : []
  }

  private pointer(e: PointerInput): Action[] {
    const p = { x: e.x, y: e.y }
    if (e.phase === 'down') this.down.set(e.id, p)
    if (e.phase === 'move' && this.down.has(e.id)) this.down.set(e.id, p)
    const ended = e.phase === 'up' || e.phase === 'cancel'
    if (ended) this.down.delete(e.id)

    const actions = this.step(e, p)
    // Every gesture ends when the last pointer is up
    if (ended && this.down.size === 0) this.state = { kind: 'idle' }
    return actions
  }

  private step(e: PointerInput, p: Point): Action[] {
    const s = this.state
    switch (s.kind) {
      case 'idle':
        if (e.phase !== 'down') return []
        if (e.t < this.lockedUntil) {
          // The page is still turning: this pointer is ignored to the end
          this.state = { kind: 'done' }
          return []
        }
        this.state = { kind: 'pressed', id: e.id, device: e.device, start: p, t0: e.t }
        return []

      case 'pressed': {
        if (e.phase === 'down') return this.startPinch()
        if (e.id !== s.id) return []
        if (e.phase === 'cancel') return []
        if (e.phase === 'up') {
          const tap = distance(p, s.start) <= TAP_SLOP && e.t - s.t0 <= TAP_MS
          // On a zoomed page the sides do not turn it (design doc: one gesture, one action)
          if (!tap || this.context.zoomed()) return []
          const move = tapMove(p.x, this.context.width())
          return move ? [{ kind: 'move', move }] : []
        }
        if (distance(p, s.start) <= TAP_SLOP) return []
        if (this.context.zoomed()) {
          this.state = { kind: 'pan', id: s.id, last: p }
          return [{ kind: 'drag', dx: p.x - s.start.x, dy: p.y - s.start.y }]
        }
        // A mouse dragging a fitted page does nothing; a finger may be swiping
        this.state =
          s.device === 'mouse'
            ? { kind: 'done' }
            : { kind: 'swipe', id: s.id, start: s.start, t0: s.t0 }
        return []
      }

      case 'pan': {
        if (e.phase === 'down') return this.startPinch()
        if (e.id !== s.id || e.phase !== 'move') return []
        const action: Action = { kind: 'drag', dx: p.x - s.last.x, dy: p.y - s.last.y }
        this.state = { ...s, last: p }
        return [action]
      }

      case 'swipe': {
        if (e.phase === 'down') return this.startPinch()
        if (e.id !== s.id || e.phase !== 'up') return []
        const dx = p.x - s.start.x
        const dy = p.y - s.start.y
        const far = Math.abs(dx) >= SWIPE_DISTANCE * this.context.width()
        const fast = Math.abs(dx) / Math.max(e.t - s.t0, 1) >= SWIPE_SPEED
        if (!far || !fast || Math.abs(dx) < Math.abs(dy)) return []
        this.lockedUntil = e.t + TURN_LOCK_MS
        // Left to right reading: pulling the page to the left brings the next one
        return [{ kind: 'move', move: dx < 0 ? 'next' : 'previous' }]
      }

      case 'pinch': {
        if (!s.fingers.has(e.id)) return []
        if (e.phase !== 'move') {
          // One finger lifted: the pinch is over, the other finger does nothing
          this.state = { kind: 'done' }
          return []
        }
        const [a, b] = [...s.fingers.keys()].map((id) => this.down.get(id)!)
        const before = s.distance
        const now = distance(a, b)
        s.fingers.set(e.id, p)
        if (before < 1 || now < 1) return []
        this.state = { ...s, distance: now }
        const center = middle(a, b)
        return [{ kind: 'zoomAt', factor: now / before, x: center.x, y: center.y }]
      }

      case 'done':
        return []
    }
  }

  /** A second finger: whatever the first was doing, this is now a pinch. */
  private startPinch(): Action[] {
    if (this.down.size !== 2) {
      this.state = { kind: 'done' }
      return []
    }
    const fingers = new Map(this.down)
    const [a, b] = [...fingers.values()]
    this.state = { kind: 'pinch', fingers, distance: distance(a, b) }
    return []
  }
}
