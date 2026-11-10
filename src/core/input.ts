// Normalized input events: what every platform's input becomes before the
// gesture engine sees it. Plain data, so a gesture can be recorded to a file
// on a device and replayed in a test.

/** Milliseconds since the recording or the page started. */
type Timed = { t: number }

export type PointerInput = Timed & {
  kind: 'pointer'
  phase: 'down' | 'move' | 'up' | 'cancel'
  /** Tells fingers apart during a multi-touch gesture. */
  id: number
  device: 'touch' | 'mouse' | 'pen'
  /** CSS pixels from the top left corner of the page area. */
  x: number
  y: number
}

export type WheelInput = Timed & {
  kind: 'wheel'
  /** In CSS pixels: line and page deltas are converted. */
  dx: number
  dy: number
  ctrl: boolean
  x: number
  y: number
}

/** A touchpad pinch reported by the platform itself, not as wheel events. */
export type PinchInput = Timed & {
  kind: 'pinch'
  phase: 'begin' | 'update' | 'end' | 'cancel'
  /** Relative to the start of the pinch: 1 at the start. */
  scale: number
  /** CSS pixels from the top left corner of the page area. */
  x: number
  y: number
}

export type KeyInput = Timed & {
  kind: 'key'
  key: string
  shift: boolean
}

export type InputEvent = PointerInput | WheelInput | PinchInput | KeyInput

/** A recorded gesture: the events and the screen they happened on. */
export type Recording = {
  version: 1
  /** Free text: device and webview, to know where a recording comes from. */
  device: string
  /** The page area, in CSS pixels, and the pixel density. */
  area: { width: number; height: number; dpr: number }
  events: InputEvent[]
}

const LINE = 16

export function fromPointer(e: PointerEvent, area: DOMRect, t0: number): PointerInput | undefined {
  const phase = (
    { pointerdown: 'down', pointermove: 'move', pointerup: 'up', pointercancel: 'cancel' } as const
  )[e.type as 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel']
  if (!phase) return undefined
  return {
    kind: 'pointer',
    t: Math.round(e.timeStamp - t0),
    phase,
    id: e.pointerId,
    device: e.pointerType === 'touch' || e.pointerType === 'pen' ? e.pointerType : 'mouse',
    x: round(e.clientX - area.left),
    y: round(e.clientY - area.top),
  }
}

export function fromWheel(e: WheelEvent, area: DOMRect, t0: number): WheelInput {
  // deltaMode: 0 pixels, 1 lines, 2 pages
  const unit = e.deltaMode === 1 ? LINE : e.deltaMode === 2 ? area.height : 1
  return {
    kind: 'wheel',
    t: Math.round(e.timeStamp - t0),
    dx: round(e.deltaX * unit),
    dy: round(e.deltaY * unit),
    ctrl: e.ctrlKey,
    x: round(e.clientX - area.left),
    y: round(e.clientY - area.top),
  }
}

/** A pinch sent by the native side: the position is in the window, in CSS pixels. */
export type NativePinch = { phase: PinchInput['phase']; scale: number; x: number; y: number }

export function fromPinch(p: NativePinch, area: DOMRect, t: number): PinchInput {
  return {
    kind: 'pinch',
    t: Math.round(t),
    phase: p.phase,
    scale: p.scale,
    x: round(p.x - area.left),
    y: round(p.y - area.top),
  }
}

export function fromKey(e: KeyboardEvent, t0: number): KeyInput {
  return { kind: 'key', t: Math.round(e.timeStamp - t0), key: e.key, shift: e.shiftKey }
}

const round = (n: number) => Math.round(n * 100) / 100

/** Checks that parsed JSON is a recording this version can replay. */
export function parseRecording(json: unknown): Recording {
  const r = json as Recording
  if (r?.version !== 1 || !Array.isArray(r.events) || !r.area) {
    throw new Error('Not a gutter input recording (version 1)')
  }
  return r
}
