import { describe, expect, it } from 'vitest'
import { parseRecording, type InputEvent } from './input'
import { Interpreter, type Action } from './interpret'

const fitted = (width = 400) => new Interpreter({ width: () => width, zoomed: () => false })
const zoomedIn = (width = 400) => new Interpreter({ width: () => width, zoomed: () => true })
const run = (interpreter: Interpreter, events: InputEvent[]): Action[] =>
  events.flatMap((e) => interpreter.feed(e))

const finger = (phase: 'down' | 'move' | 'up' | 'cancel', t: number, x: number, y = 300, id = 1) =>
  ({ kind: 'pointer', phase, t, id, device: 'touch', x, y }) as const
const key = (key: string, t = 0, shift = false) => ({ kind: 'key', t, key, shift }) as const

describe('taps', () => {
  it('turns the page on the sides, not in the middle', () => {
    expect(run(fitted(), [finger('down', 0, 380), finger('up', 80, 381)])).toEqual([
      { kind: 'move', move: 'next' },
    ])
    expect(run(fitted(), [finger('down', 0, 20), finger('up', 80, 20)])).toEqual([
      { kind: 'move', move: 'previous' },
    ])
    expect(run(fitted(), [finger('down', 0, 200), finger('up', 80, 200)])).toEqual([])
  })

  it('ignores a finger that moved, a long press, a cancel and a second finger', () => {
    const fingerMoved = [finger('down', 0, 380), finger('move', 40, 340), finger('up', 80, 340)]
    expect(run(fitted(), fingerMoved)).toEqual([])
    expect(run(fitted(), [finger('down', 0, 380), finger('up', 900, 380)])).toEqual([])
    expect(run(fitted(), [finger('down', 0, 380), finger('cancel', 50, 380)])).toEqual([])
    const twoFingers = [
      finger('down', 0, 380),
      finger('down', 10, 20, 300, 2),
      finger('up', 60, 380),
    ]
    expect(run(fitted(), twoFingers)).toEqual([])
  })

  it('does nothing on the sides of a zoomed page', () => {
    expect(run(zoomedIn(), [finger('down', 0, 380), finger('up', 80, 380)])).toEqual([])
  })
})

describe('keys', () => {
  it('turns pages on a fitted page', () => {
    expect(run(fitted(), [key('ArrowRight'), key(' ', 0, true), key('End')])).toEqual([
      { kind: 'move', move: 'next' },
      { kind: 'move', move: 'previous' },
      { kind: 'move', move: 'last' },
    ])
  })

  it('pans a zoomed page, and says what to do at its edge', () => {
    expect(run(zoomedIn(), [key('ArrowDown'), key('Home')])).toEqual([
      { kind: 'pan', fx: 0, fy: 0.3, orMove: 'next' },
      { kind: 'move', move: 'first' },
    ])
  })

  it('zooms with + - 0', () => {
    expect(run(fitted(), [key('+'), key('-'), key('0')]).map((a) => a.kind)).toEqual([
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
    { eager: true, import: 'default' },
  )
  for (const [file, { recording, expected }] of Object.entries(files)) {
    it(file.split('/').pop()!, () => {
      const r = parseRecording(recording)
      const interpreter = new Interpreter({ width: () => r.area.width, zoomed: () => false })
      expect(run(interpreter, r.events)).toEqual(expected)
    })
  }
})
