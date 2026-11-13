// The gesture engine: a state machine that turns normalized input events into
// viewer actions, following the design doc's rule that a gesture produces
// exactly one kind of action: it moves the view or turns the page, never both.
//
// States: idle; pressed (a pointer is down and has not moved yet); pan
// (dragging a zoomed page); swipe (a finger dragging the page sideways to turn
// it); pinch (two fingers); done (the gesture is over but fingers are still
// down: they are ignored until all are up, so the end of a pinch cannot become
// a pan). After a swipe has turned the page, pointer input is ignored for
// TURN_LOCK_MS: the "page change in progress" state of the design doc.
//
// A swipe starts on a fitted page, or on a zoomed page that is already at its
// edge in the direction of the swipe: there the page cannot move any further,
// so pulling it turns it. The gesture that brought the page to its edge stays a
// pan to the end; it takes a new one to turn.
//
// A double tap zooms 2x on the tapped point, and on a zoomed page goes back to
// fit. On a fitted page only the middle of the screen takes double taps: taps
// on the sides turn the page at once, without waiting to see if a second tap
// comes.
//
// The wheel turns one page per notch on a fitted page. On a zoomed page it
// scrolls; like the swipe, it turns the page only in a new burst of wheel
// events that starts at the edge in that direction, so scrolling down to the
// bottom of a page never runs on into the next one. Ctrl+wheel zooms on the
// cursor: small steps are how Chromium reports a trackpad pinch.
//
// A trackpad's two-finger scroll is a stream of small wheel events that keeps
// going after the fingers lift (inertia). One flick turns one page: once it
// has, the rest of the stream is ignored until it ends (a pause) or a new flick
// starts, which shows as the deltas growing again after they had shrunk, or
// changing direction. A mouse notch is a single big step after a pause: each
// one turns a page. A pinch reported natively (Linux) arrives as pinch events.
import type { InputEvent, PinchInput, PointerInput, WheelInput } from './input'
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
  /** During a swipe: show the page shifted sideways by `dx` CSS pixels, under the finger. */
  | { kind: 'follow'; dx: number }
  /** A swipe that does not turn the page: slide it back in place. */
  | { kind: 'settle' }
  /** A swipe that turns the page: slide it out of the screen, then show the new one. */
  | { kind: 'turn'; move: 'next' | 'previous' }

/** A tap moves less than this, in CSS pixels, and lasts less than TAP_MS. */
export const TAP_SLOP = 10
export const TAP_MS = 500
/** A second tap within this time and distance of the first makes a double tap. */
export const DOUBLE_TAP_MS = 300
export const DOUBLE_TAP_SLOP = 30
export const DOUBLE_TAP_ZOOM = 2
/** A swipe turns the page past both a distance (fraction of the width) and a speed. */
export const SWIPE_DISTANCE = 0.15
export const SWIPE_SPEED = 0.3 // CSS pixels per millisecond
export const TURN_LOCK_MS = 250
/** Wheel distance, in CSS pixels, that turns a page: a mouse notch is about 100. */
export const WHEEL_STEP = 50
/** A pause longer than this between wheel events starts a new burst. */
export const WHEEL_GAP_MS = 300
/** A step this big, after a short pause, is a mouse notch; a trackpad sends small ones. */
export const NOTCH_GAP_MS = 40
/** Deltas below this are noise when telling a new flick from the tail of the last one. */
export const WHEEL_NOISE = 10
/** Ctrl+wheel steps smaller than WHEEL_STEP are a pinch; this is its zoom per pixel (exp). */
export const PINCH_WHEEL_ZOOM = 0.01
/** Ctrl+wheel zooms by this factor every 100 CSS pixels of wheel: one notch. */
export const WHEEL_ZOOM = 1.25

export type Context = {
  /** Width of the page area, in CSS pixels. */
  width: () => number
  zoomed: () => boolean
  /** Which sides of a zoomed page are on screen: past them it cannot be dragged. */
  edges: () => Edges
}

export type Edges = { left: boolean; right: boolean; top: boolean; bottom: boolean }

/** A stream of wheel events: a flick and its inertia, or a run of notches. */
type Burst = {
  last: number
  dir: number
  /** Whether it started where it can turn the page. */
  atEdge: boolean
  sum: number
  /** It already turned a page: the rest of the stream is its inertia. */
  turned: boolean
  /** It had a step smaller than a notch: a trackpad, whose big steps are never notches. */
  smooth: boolean
  /** The size of the previous step: a mouse sends the same one every notch. */
  lastSize: number
  /** The biggest step so far; once steps fall well below it the flick is dying out. */
  peak: number
  falling: boolean
  /** The smallest step since it started falling. */
  trough: number
}

type Point = { x: number; y: number }
type Pressed = {
  kind: 'pressed'
  id: number
  device: PointerInput['device']
  start: Point
  t0: number
}
type State =
  | { kind: 'idle' }
  | Pressed
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
  /** The last tap that could be the first half of a double tap. */
  private lastTap: { t: number; p: Point } | undefined
  /** The wheel events going on: whether they started at an edge, and how far they went. */
  private burst: Burst | undefined
  /** The scale of the native pinch going on, relative to its start. */
  private pinchScale = 1

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
        return this.wheel(e)
      case 'pinch':
        return this.nativePinch(e)
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

  private wheel(e: WheelInput): Action[] {
    if (e.ctrl) {
      this.burst = undefined
      if (e.dy === 0) return []
      // Wheel down zooms out, as in browsers
      const factor =
        Math.abs(e.dy) < WHEEL_STEP
          ? Math.exp(-e.dy * PINCH_WHEEL_ZOOM)
          : WHEEL_ZOOM ** (-e.dy / 100)
      return [{ kind: 'zoomAt', factor, x: e.x, y: e.y }]
    }
    const vertical = Math.abs(e.dy) >= Math.abs(e.dx)
    const delta = vertical ? e.dy : e.dx
    if (delta === 0) return []
    const size = Math.abs(delta)

    let b = this.burst
    const gap = b ? e.t - b.last : Infinity
    if (!b || gap > WHEEL_GAP_MS || this.newFlick(b, delta)) {
      b = this.burst = {
        last: e.t,
        dir: Math.sign(delta),
        atEdge: !this.context.zoomed() || this.wheelAtEdge(vertical, delta),
        sum: 0,
        turned: false,
        smooth: false,
        lastSize: 0,
        peak: 0,
        falling: false,
        trough: Infinity,
      }
    }
    // A stall (a page being decoded) can make a trackpad's big steps arrive late:
    // only a stream of big steps and nothing else is a mouse
    if (size < WHEEL_STEP) b.smooth = true
    // A mouse notch is a big step after a pause, or the same big step again when the
    // wheel is spun: a trackpad's big steps vary
    const notch = size >= WHEEL_STEP && !b.smooth && (gap >= NOTCH_GAP_MS || size === b.lastSize)
    b.lastSize = size
    b.last = e.t
    if (!notch) {
      if (!b.falling) {
        b.peak = Math.max(b.peak, size)
        if (size < b.peak * 0.7) {
          b.falling = true
          b.trough = size
        }
      } else {
        b.trough = Math.min(b.trough, size)
      }
    }

    // Scrolling down shows more of the bottom: the page moves up
    if (!b.atEdge) return [{ kind: 'drag', dx: -e.dx, dy: -e.dy }]
    const move = delta > 0 ? 'next' : 'previous'
    if (notch) {
      // The rest of a fast flick that began with a big step is not a new notch
      b.turned = true
      return [{ kind: 'move', move }]
    }
    // The inertia of a flick that has turned the page
    if (b.turned) return []
    b.sum += delta
    if (Math.abs(b.sum) < WHEEL_STEP) return []
    b.turned = true
    return [{ kind: 'move', move: b.sum > 0 ? 'next' : 'previous' }]
  }

  /** Whether this step starts a new flick inside a stream: it turns around, or grows again. */
  private newFlick(b: Burst, delta: number) {
    const size = Math.abs(delta)
    if (size >= WHEEL_NOISE && Math.sign(delta) !== b.dir) return true
    return b.falling && size > b.trough * 2 + WHEEL_NOISE
  }

  /** A pinch on a touchpad reported natively: zoom by how much the scale changed. */
  private nativePinch(e: PinchInput): Action[] {
    this.burst = undefined
    if (e.phase !== 'update') {
      // Begin, end or cancel: the next update is relative to a fresh start
      this.pinchScale = 1
      return []
    }
    const factor = e.scale / this.pinchScale
    this.pinchScale = e.scale
    if (!Number.isFinite(factor) || factor <= 0 || factor === 1) return []
    return [{ kind: 'zoomAt', factor, x: e.x, y: e.y }]
  }

  /** Whether a zoomed page already shows its edge in the wheel's direction. */
  private wheelAtEdge(vertical: boolean, delta: number) {
    const edges = this.context.edges()
    if (vertical) return delta > 0 ? edges.bottom : edges.top
    return delta > 0 ? edges.right : edges.left
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
          this.lastTap = undefined
          this.state = { kind: 'done' }
          return []
        }
        this.state = { kind: 'pressed', id: e.id, device: e.device, start: p, t0: e.t }
        return []

      case 'pressed': {
        if (e.phase === 'down') {
          this.lastTap = undefined
          return this.startPinch()
        }
        if (e.id !== s.id) return []
        if (e.phase === 'cancel') {
          this.lastTap = undefined
          return []
        }
        if (e.phase === 'up') return this.tap(s, p, e.t)
        const dx = p.x - s.start.x
        const dy = p.y - s.start.y
        if (Math.hypot(dx, dy) <= TAP_SLOP) return []
        // Moved: not a tap, and not the first half of a double tap
        this.lastTap = undefined
        const zoomed = this.context.zoomed()
        // A mouse never swipes: dragging a fitted page with it does nothing
        if (s.device !== 'mouse' && (!zoomed || this.pullsAtEdge(dx, dy))) {
          this.state = { kind: 'swipe', id: s.id, start: s.start, t0: s.t0 }
          return [{ kind: 'follow', dx }]
        }
        if (zoomed) {
          this.state = { kind: 'pan', id: s.id, last: p }
          return [{ kind: 'drag', dx, dy }]
        }
        this.state = { kind: 'done' }
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
        // A second finger makes it a pinch: the page goes back in place first
        if (e.phase === 'down') return [{ kind: 'settle' }, ...this.startPinch()]
        if (e.id !== s.id) return []
        const dx = p.x - s.start.x
        if (e.phase === 'move') return [{ kind: 'follow', dx }]
        if (e.phase === 'cancel') return [{ kind: 'settle' }]
        const dy = p.y - s.start.y
        const far = Math.abs(dx) >= SWIPE_DISTANCE * this.context.width()
        const fast = Math.abs(dx) / Math.max(e.t - s.t0, 1) >= SWIPE_SPEED
        if (!far || !fast || Math.abs(dx) < Math.abs(dy)) return [{ kind: 'settle' }]
        this.lockedUntil = e.t + TURN_LOCK_MS
        // Left to right reading: pulling the page to the left brings the next one
        return [{ kind: 'turn', move: dx < 0 ? 'next' : 'previous' }]
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

  /**
   * Whether dragging a zoomed page by (dx, dy) pulls it sideways past an edge
   * that is already on screen: there it cannot move, so the drag is a swipe.
   */
  private pullsAtEdge(dx: number, dy: number) {
    if (Math.abs(dx) <= Math.abs(dy)) return false
    const edges = this.context.edges()
    // Pulling the page to the left asks for more of its right side
    return dx < 0 ? edges.right : edges.left
  }

  /** The pointer went up without moving: a tap, maybe the second of a double tap. */
  private tap(s: Pressed, p: Point, t: number): Action[] {
    const last = this.lastTap
    this.lastTap = undefined
    if (distance(p, s.start) > TAP_SLOP || t - s.t0 > TAP_MS) return []
    const double =
      last !== undefined && s.t0 - last.t <= DOUBLE_TAP_MS && distance(p, last.p) <= DOUBLE_TAP_SLOP
    if (this.context.zoomed()) {
      // On a zoomed page the sides do not turn it (design doc: one gesture, one action)
      if (double) return [{ kind: 'zoom', how: 'fit' }]
    } else {
      const move = tapMove(p.x, this.context.width())
      if (move) return [{ kind: 'move', move }]
      if (double) return [{ kind: 'zoomAt', factor: DOUBLE_TAP_ZOOM, x: p.x, y: p.y }]
    }
    this.lastTap = { t, p }
    return []
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
