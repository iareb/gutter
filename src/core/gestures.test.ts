import { describe, expect, it } from 'vitest'
import { GestureEngine, SWIPE_DISTANCE, TURN_LOCK_MS, type Action } from './gestures'
import { parseRecording, type InputEvent } from './input'

const WIDTH = 400
const engine = (zoomed = false) => new GestureEngine({ width: () => WIDTH, zoomed: () => zoomed })
const run = (e: GestureEngine, events: InputEvent[]): Action[] => events.flatMap((x) => e.feed(x))

type Phase = 'down' | 'move' | 'up' | 'cancel'
const finger = (phase: Phase, t: number, x: number, y = 300, id = 1) =>
  ({ kind: 'pointer', phase, t, id, device: 'touch', x, y }) as const
const mouse = (phase: Phase, t: number, x: number, y = 300) =>
  ({ kind: 'pointer', phase, t, id: 1, device: 'mouse', x, y }) as const
const key = (key: string, t = 0, shift = false) => ({ kind: 'key', t, key, shift }) as const

/** A finger dragged from x0 to x1 in `ms`, in 10 steps. */
function drag(x0: number, x1: number, ms: number, t0 = 0, y0 = 300, y1 = y0): InputEvent[] {
  const events: InputEvent[] = [finger('down', t0, x0, y0)]
  for (let i = 1; i <= 10; i++) {
    events.push(
      finger('move', t0 + (ms * i) / 10, x0 + ((x1 - x0) * i) / 10, y0 + ((y1 - y0) * i) / 10),
    )
  }
  events.push(finger('up', t0 + ms, x1, y1))
  return events
}
const next = { kind: 'move', move: 'next' }
const previous = { kind: 'move', move: 'previous' }

describe('taps', () => {
  it('turn the page on the sides, not in the middle', () => {
    expect(run(engine(), [finger('down', 0, 380), finger('up', 80, 381)])).toEqual([next])
    expect(run(engine(), [finger('down', 0, 20), finger('up', 80, 20)])).toEqual([previous])
    expect(run(engine(), [finger('down', 0, 200), finger('up', 80, 200)])).toEqual([])
  })

  it('do not count when the pointer moved, the press was long or was cancelled', () => {
    expect(run(engine(), [finger('down', 0, 380), finger('up', 900, 380)])).toEqual([])
    expect(run(engine(), [finger('down', 0, 380), finger('cancel', 50, 380)])).toEqual([])
    expect(
      run(engine(), [mouse('down', 0, 380), mouse('move', 40, 300), mouse('up', 80, 300)]),
    ).toEqual([])
  })

  it('do nothing on the sides of a zoomed page', () => {
    expect(run(engine(true), [finger('down', 0, 380), finger('up', 80, 380)])).toEqual([])
  })

  it('all count when quick, one after the other', () => {
    const taps = [0, 1, 2, 3, 4, 5].flatMap((i) => [
      finger('down', i * 60, 380),
      finger('up', i * 60 + 30, 380),
    ])
    expect(run(engine(), taps)).toEqual(Array(6).fill(next))
  })
})

describe('swipes on a fitted page', () => {
  it('turn the page when far and fast enough', () => {
    expect(run(engine(), drag(350, 150, 150))).toEqual([next])
    expect(run(engine(), drag(50, 250, 150))).toEqual([previous])
  })

  it('do nothing when too short, too slow or mostly vertical', () => {
    const short = SWIPE_DISTANCE * WIDTH - 10
    expect(run(engine(), drag(300, 300 - short, 50))).toEqual([])
    expect(run(engine(), drag(350, 150, 2000))).toEqual([])
    expect(run(engine(), drag(300, 100, 150, 0, 100, 400))).toEqual([])
  })

  it('turn exactly one page, and ignore a pointer during the page change', () => {
    const e = engine()
    expect(run(e, drag(350, 150, 150))).toEqual([next])
    // A second flick right after: the page is still turning
    expect(run(e, drag(350, 150, 100, 160))).toEqual([])
    // Once the page change is over, swipes work again
    expect(run(e, drag(350, 150, 100, 150 + TURN_LOCK_MS + 10))).toEqual([next])
  })

  it('do not happen with a mouse: dragging a fitted page does nothing', () => {
    const mouseDrag = [
      mouse('down', 0, 350),
      mouse('move', 50, 250),
      mouse('move', 100, 150),
      mouse('up', 150, 150),
    ]
    expect(run(engine(), mouseDrag)).toEqual([])
  })
})

describe('dragging a zoomed page', () => {
  it('moves the view with the pointer, and never turns the page', () => {
    const actions = run(engine(true), drag(350, 150, 150))
    expect(actions.every((a) => a.kind === 'drag')).toBe(true)
    const dx = actions.reduce((sum, a) => sum + (a.kind === 'drag' ? a.dx : 0), 0)
    expect(dx).toBeCloseTo(-200)
  })

  it('works with the mouse too', () => {
    const actions = run(engine(true), [
      mouse('down', 0, 200),
      mouse('move', 20, 230, 320),
      mouse('up', 40, 230, 320),
    ])
    expect(actions).toEqual([{ kind: 'drag', dx: 30, dy: 20 }])
  })
})

describe('pinch', () => {
  it('zooms around the point between the fingers', () => {
    const actions = run(engine(), [
      finger('down', 0, 150, 300, 1),
      finger('down', 10, 250, 300, 2),
      finger('move', 30, 100, 300, 1),
      finger('move', 40, 300, 300, 2),
    ])
    expect(actions).toEqual([
      { kind: 'zoomAt', factor: 1.5, x: 175, y: 300 },
      { kind: 'zoomAt', factor: 200 / 150, x: 200, y: 300 },
    ])
  })

  it('ends when a finger lifts: the other one neither pans nor swipes nor taps', () => {
    const e = engine()
    const actions = run(e, [
      finger('down', 0, 150, 300, 1),
      finger('down', 10, 250, 300, 2),
      finger('move', 30, 300, 300, 2),
      finger('up', 50, 300, 300, 2),
      finger('move', 60, 50, 300, 1),
      finger('up', 70, 20, 300, 1),
    ])
    expect(actions.map((a) => a.kind)).toEqual(['zoomAt'])
    expect(e.stateKind).toBe('idle')
  })

  it('takes over a swipe in progress: no page turn', () => {
    const actions = run(engine(), [
      finger('down', 0, 350, 300, 1),
      finger('move', 20, 300, 300, 1),
      finger('down', 30, 100, 300, 2),
      finger('move', 40, 150, 300, 1),
      finger('up', 60, 150, 300, 1),
      finger('up', 70, 100, 300, 2),
    ])
    expect(actions.some((a) => a.kind === 'move')).toBe(false)
  })
})

describe('keys', () => {
  it('turn pages on a fitted page', () => {
    expect(run(engine(), [key('ArrowRight'), key(' ', 0, true), key('End')])).toEqual([
      next,
      previous,
      { kind: 'move', move: 'last' },
    ])
  })

  it('pan a zoomed page, and say what to do at its edge', () => {
    expect(run(engine(true), [key('ArrowDown'), key('Home')])).toEqual([
      { kind: 'pan', fx: 0, fy: 0.3, orMove: 'next' },
      { kind: 'move', move: 'first' },
    ])
  })

  it('zoom with + - 0', () => {
    expect(run(engine(), [key('+'), key('-'), key('0')]).map((a) => a.kind)).toEqual([
      'zoom',
      'zoom',
      'zoom',
    ])
  })
})

// Gestures recorded on real devices, with the actions they must produce.
// A gesture bug gets its recording added here, so it can never come back.
describe('recordings', () => {
  const files = import.meta.glob<{ recording: unknown; expected: Action[] }>(
    '/tests/recordings/*.json',
    {
      eager: true,
      import: 'default',
    },
  )
  for (const [file, { recording, expected }] of Object.entries(files)) {
    it(file.split('/').pop()!, () => {
      const r = parseRecording(recording)
      const e = new GestureEngine({ width: () => r.area.width, zoomed: () => false })
      expect(run(e, r.events)).toEqual(expected)
    })
  }
})
