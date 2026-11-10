import { describe, expect, it } from 'vitest'
import {
  DOUBLE_TAP_MS,
  GestureEngine,
  SWIPE_DISTANCE,
  TURN_LOCK_MS,
  WHEEL_GAP_MS,
  type Action,
  type Edges,
} from './gestures'
import { parseRecording, type InputEvent } from './input'

const WIDTH = 400
const NO_EDGES: Edges = { left: false, right: false, top: false, bottom: false }
const ALL_EDGES: Edges = { left: true, right: true, top: true, bottom: true }
const engine = (zoomed = false, edges: Partial<Edges> = {}) =>
  new GestureEngine({
    width: () => WIDTH,
    zoomed: () => zoomed,
    edges: () => ({ ...NO_EDGES, ...edges }),
  })
const run = (e: GestureEngine, events: InputEvent[]): Action[] => events.flatMap((x) => e.feed(x))
/** The actions without the page following the finger, which come on every move. */
const discrete = (actions: Action[]) => actions.filter((a) => a.kind !== 'follow')
const swipe = (e: GestureEngine, events: InputEvent[]) => discrete(run(e, events))

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
const turnNext = { kind: 'turn', move: 'next' }
const turnPrevious = { kind: 'turn', move: 'previous' }
const settle = { kind: 'settle' }
const controls = { kind: 'controls' }

describe('taps', () => {
  it('turn the page on the sides, and ask for the controls in the middle', () => {
    expect(run(engine(), [finger('down', 0, 380), finger('up', 80, 381)])).toEqual([next])
    expect(run(engine(), [finger('down', 0, 20), finger('up', 80, 20)])).toEqual([previous])
    expect(run(engine(), [finger('down', 0, 200), finger('up', 80, 200)])).toEqual([controls])
  })

  it('ask for the controls on a zoomed page too, but not on its sides', () => {
    expect(run(engine(true), [finger('down', 0, 200), finger('up', 80, 200)])).toEqual([controls])
    expect(run(engine(true), [finger('down', 0, 20), finger('up', 80, 20)])).toEqual([])
  })

  it('in the middle with the mouse too', () => {
    expect(run(engine(), [mouse('down', 0, 200), mouse('up', 60, 200)])).toEqual([controls])
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
    expect(swipe(engine(), drag(350, 150, 150))).toEqual([turnNext])
    expect(swipe(engine(), drag(50, 250, 150))).toEqual([turnPrevious])
  })

  it('move the page with the finger until it lifts', () => {
    const actions = run(engine(), drag(350, 150, 150))
    const follows = actions.filter((a) => a.kind === 'follow')
    expect(follows.length).toBe(10)
    expect(follows.at(-1)).toEqual({ kind: 'follow', dx: -200 })
  })

  it('slide back in place when they do not turn the page', () => {
    const actions = run(engine(), drag(300, 260, 50))
    expect(actions.at(-1)).toEqual(settle)
    expect(
      swipe(engine(), [...drag(350, 150, 150).slice(0, 5), finger('cancel', 80, 250)]),
    ).toEqual([settle])
  })

  it('do nothing when too short, too slow or mostly vertical', () => {
    const short = SWIPE_DISTANCE * WIDTH - 10
    expect(swipe(engine(), drag(300, 300 - short, 50))).toEqual([settle])
    expect(swipe(engine(), drag(350, 150, 2000))).toEqual([settle])
    expect(swipe(engine(), drag(300, 100, 150, 0, 100, 400))).toEqual([settle])
  })

  it('turn exactly one page, and ignore a pointer during the page change', () => {
    const e = engine()
    expect(swipe(e, drag(350, 150, 150))).toEqual([turnNext])
    // A second flick right after: the page is still turning
    expect(run(e, drag(350, 150, 100, 160))).toEqual([])
    // Once the page change is over, swipes work again
    expect(swipe(e, drag(350, 150, 100, 150 + TURN_LOCK_MS + 10))).toEqual([turnNext])
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
  it('moves the view with the pointer, and never turns the page away from its edges', () => {
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

describe('swiping a zoomed page at its edge', () => {
  it('turns the page when pulled past the edge on screen', () => {
    // Right edge on screen: pulling the page to the left brings the next page
    expect(swipe(engine(true, { right: true }), drag(350, 150, 150))).toEqual([turnNext])
    expect(swipe(engine(true, { left: true }), drag(50, 250, 150))).toEqual([turnPrevious])
  })

  it('pans instead when pulled away from that edge, or mostly up and down', () => {
    const atRight = { right: true }
    const back = run(engine(true, atRight), drag(50, 250, 150))
    expect(back.every((a) => a.kind === 'drag')).toBe(true)
    const down = run(engine(true, atRight), drag(300, 250, 150, 0, 100, 400))
    expect(down.every((a) => a.kind === 'drag')).toBe(true)
  })

  it('never happens with a mouse: it keeps dragging', () => {
    const actions = run(engine(true, ALL_EDGES), [
      mouse('down', 0, 350),
      mouse('move', 50, 150),
      mouse('up', 100, 150),
    ])
    expect(actions.every((a) => a.kind === 'drag')).toBe(true)
  })
})

describe('double tap', () => {
  const tap = (t: number, x: number, y = 300) => [
    finger('down', t, x, y),
    finger('up', t + 40, x, y),
  ]

  it('zooms 2x on the tapped point of a fitted page', () => {
    // The first tap asks for the controls; the app drops that when the second arrives
    expect(run(engine(), [...tap(0, 200), ...tap(150, 205, 305)])).toEqual([
      controls,
      { kind: 'zoomAt', factor: 2, x: 205, y: 305 },
    ])
  })

  it('goes back to fit on a zoomed page, also on its sides', () => {
    expect(run(engine(true), [...tap(0, 380), ...tap(150, 380)])).toEqual([
      { kind: 'zoom', how: 'fit' },
    ])
  })

  it('needs the two taps close in time and space', () => {
    expect(run(engine(), [...tap(0, 200), ...tap(40 + DOUBLE_TAP_MS + 10, 200)])).toEqual([
      controls,
      controls,
    ])
    expect(run(engine(), [...tap(0, 160), ...tap(150, 240)])).toEqual([controls, controls])
  })

  it('does not wait on the sides of a fitted page: two taps there turn two pages', () => {
    expect(run(engine(), [...tap(0, 380), ...tap(150, 380)])).toEqual([next, next])
  })

  it('takes three taps as a double tap and a single one', () => {
    const e = engine()
    const kinds = run(e, [...tap(0, 200), ...tap(150, 200), ...tap(300, 200)]).map((a) => a.kind)
    expect(kinds).toEqual(['controls', 'zoomAt', 'controls'])
  })

  it('is not made by a tap after a drag', () => {
    expect(
      run(engine(), [...drag(200, 180, 100), ...tap(150, 180)]).some((a) => a.kind === 'zoomAt'),
    ).toBe(false)
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
    expect(actions.some((a) => a.kind === 'turn')).toBe(false)
    // The page that followed the first finger goes back in place
    expect(actions).toContainEqual(settle)
  })
})

describe('wheel', () => {
  const wheel = (t: number, dy: number, extra: Partial<{ dx: number; ctrl: boolean }> = {}) =>
    ({ kind: 'wheel', t, dx: 0, dy, ctrl: false, x: 100, y: 200, ...extra }) as const
  const notches = (n: number, dy = 100, t0 = 0, every = 120) =>
    Array.from({ length: n }, (_, i) => wheel(t0 + i * every, dy))

  it('turns one page per notch on a fitted page', () => {
    expect(run(engine(), notches(3))).toEqual([next, next, next])
    expect(run(engine(), notches(2, -100))).toEqual([previous, previous])
  })

  it('turns once for a small steady scroll that adds up to a page', () => {
    const smooth = Array.from({ length: 10 }, (_, i) => wheel(i * 16, 10))
    expect(run(engine(), smooth)).toEqual([next])
  })

  // A two-finger flick on a trackpad: steps grow, peak, then decay as inertia, 16 ms apart
  const flick = (t0: number, sign = 1, peak = 84) => {
    const steps: number[] = [2, 6, 14, 30, 50, peak]
    for (let d = peak * 0.92; d > 0.4; d *= 0.92) steps.push(d)
    return steps.map((d, i) => wheel(t0 + i * 16, sign * d))
  }

  it('turns exactly one page per trackpad flick, inertia included', () => {
    const events = flick(0)
    expect(events.length).toBeGreaterThan(40)
    expect(run(engine(), events)).toEqual([next])
    expect(run(engine(), flick(0, -1))).toEqual([previous])
  })

  it('turns one page per flick when flicks are a pause apart', () => {
    const e = engine()
    expect(run(e, [...flick(0), ...flick(2000)])).toEqual([next, next])
  })

  it('takes a new flick during the inertia of the last one', () => {
    const first = flick(0)
    const t = first[30].t // well into the tail
    const second = flick(t + 16)
    const events = [...first.slice(0, 31), ...second]
    expect(run(engine(), events)).toEqual([next, next])
  })

  it('takes a flick the other way during the inertia as a page back', () => {
    const first = flick(0)
    const second = flick(first[25].t + 16, -1)
    expect(run(engine(), [...first.slice(0, 26), ...second])).toEqual([next, previous])
  })

  it('does not turn for a short, slow scroll', () => {
    const slow = Array.from({ length: 20 }, (_, i) => wheel(i * 16, 1.5))
    expect(run(engine(), slow)).toEqual([])
  })

  it('does not take the noise at the end of inertia for a new flick', () => {
    const events = flick(0)
    const end = events.at(-1)!.t
    const noise = Array.from({ length: 30 }, (_, i) => wheel(end + (i + 1) * 16, i % 2 ? 0.4 : 3))
    expect(run(engine(), [...events, ...noise])).toEqual([next])
  })

  it('keeps a flick to one page when a stall delays its big steps', () => {
    const events = flick(0).map((e, i) => (i >= 6 ? { ...e, t: e.t + 80 } : e))
    expect(run(engine(), events)).toEqual([next])
  })

  it('keeps a flick that starts with a big step to one page', () => {
    const events = [60, 84, 77, 71, 65, 55, 40, 30, 20, 12, 6, 3, 1].map((d, i) => wheel(i * 16, d))
    expect(run(engine(), events)).toEqual([next])
  })

  it('still turns one page per mouse notch, however fast they come', () => {
    const fast = [0, 60, 120, 180].map((t) => wheel(t, 100))
    expect(run(engine(), fast)).toEqual([next, next, next, next])
  })

  it('scrolls a zoomed page instead', () => {
    const actions = run(engine(true), notches(2))
    expect(actions).toHaveLength(2)
    // Scrolling down shows more of the bottom: the page moves up
    for (const a of actions) expect(a).toMatchObject({ kind: 'drag', dy: -100 })
  })

  it('turns a zoomed page only in a new burst that starts at its edge', () => {
    let atBottom = false
    const e = new GestureEngine({
      width: () => WIDTH,
      zoomed: () => true,
      edges: () => ({ ...NO_EDGES, bottom: atBottom }),
    })
    // Scrolling down reaches the bottom in the middle of a burst: no page turn
    expect(run(e, notches(1)).map((a) => a.kind)).toEqual(['drag'])
    atBottom = true
    expect(run(e, notches(2, 100, 120)).map((a) => a.kind)).toEqual(['drag', 'drag'])
    // After a pause, the next notch turns the page
    expect(run(e, notches(1, 100, 240 + WHEEL_GAP_MS + 10))).toEqual([next])
    // Scrolling back up from the bottom edge scrolls
    expect(run(e, notches(1, -100, 2000)).map((a) => a.kind)).toEqual(['drag'])
  })

  it('turns a zoomed page once for a flick that starts at its edge', () => {
    const e = engine(true, { bottom: true })
    expect(run(e, flick(0)).filter((a) => a.kind === 'move')).toEqual([next])
  })

  it('treats small Ctrl steps as a pinch, zooming smoothly', () => {
    const [a] = run(engine(), [wheel(0, -10, { ctrl: true })])
    expect(a.kind === 'zoomAt' && a.factor).toBeCloseTo(Math.exp(0.1))
  })

  it('zooms on the cursor with Ctrl: down zooms out, up zooms in', () => {
    const [out] = run(engine(), [wheel(0, 100, { ctrl: true })])
    const [inward] = run(engine(), [wheel(0, -100, { ctrl: true })])
    expect(out).toMatchObject({ kind: 'zoomAt', x: 100, y: 200 })
    expect(out.kind === 'zoomAt' && out.factor).toBeCloseTo(0.8)
    expect(inward.kind === 'zoomAt' && inward.factor).toBeCloseTo(1.25)
  })
})

describe('native pinch', () => {
  const pinch = (phase: 'begin' | 'update' | 'end' | 'cancel', scale: number, x = 120, y = 80) =>
    ({ kind: 'pinch', t: 0, phase, scale, x, y }) as const

  it('zooms by how much the scale changed since the last update', () => {
    const actions = run(engine(), [
      pinch('begin', 1),
      pinch('update', 1.5),
      pinch('update', 1.8, 130, 90),
      pinch('end', 1.8),
    ])
    expect(actions).toEqual([
      { kind: 'zoomAt', factor: 1.5, x: 120, y: 80 },
      { kind: 'zoomAt', factor: 1.8 / 1.5, x: 130, y: 90 },
    ])
  })

  it('starts from scale 1 again for the next pinch', () => {
    const e = engine()
    run(e, [pinch('begin', 1), pinch('update', 2), pinch('end', 2)])
    expect(run(e, [pinch('begin', 1), pinch('update', 0.5), pinch('cancel', 0.5)])).toEqual([
      { kind: 'zoomAt', factor: 0.5, x: 120, y: 80 },
    ])
  })

  it('ignores updates that change nothing or are not numbers', () => {
    expect(run(engine(), [pinch('begin', 1), pinch('update', 1), pinch('update', NaN)])).toEqual([])
  })
})

describe('double click', () => {
  it('zooms like a double tap', () => {
    const click = (t: number) => [mouse('down', t, 200), mouse('up', t + 60, 200)]
    expect(run(engine(), [...click(0), ...click(150)])).toEqual([
      controls,
      { kind: 'zoomAt', factor: 2, x: 200, y: 300 },
    ])
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
      const e = new GestureEngine({
        width: () => r.area.width,
        zoomed: () => false,
        edges: () => ALL_EDGES,
      })
      // `expected` lists the discrete actions: following the finger is left out
      expect(discrete(run(e, r.events)).filter((a) => a.kind !== 'settle')).toEqual(expected)
    })
  }
})
