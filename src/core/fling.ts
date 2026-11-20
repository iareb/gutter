// The inertia of vertical scroll: when the finger leaves the strip it keeps
// going at the speed it had, slowing down the way a list on a phone does.

/** Time constant of the slowing down: after it the speed is about a third. */
export const FLING_TIME_MS = 325
/** Below this speed, in pixels per millisecond, the strip stops. */
export const FLING_STOP = 0.02
/** A release slower than this is a drop, not a fling. */
export const FLING_START = 0.15
/** Only the last moments of a drag tell its speed. */
const WINDOW_MS = 100

/** The speed of a drag, from its last positions. */
export class Velocity {
  private samples: { t: number; y: number }[] = []

  add(t: number, y: number) {
    this.samples.push({ t, y })
    while (this.samples.length > 2 && t - this.samples[0].t > WINDOW_MS) this.samples.shift()
  }

  /** Pixels per millisecond; 0 when the finger had stopped before letting go. */
  get(now: number): number {
    const last = this.samples[this.samples.length - 1]
    const first = this.samples[0]
    if (!last || last === first || now - last.t > WINDOW_MS / 2) return 0
    return (last.y - first.y) / (last.t - first.t)
  }

  clear() {
    this.samples = []
  }
}

/**
 * One step of a fling: how far it goes in `dt` milliseconds from speed `v`, and
 * the speed after. The distance is the exact integral of the slowing speed, so
 * that the length of a fling does not depend on the frame rate.
 */
export function decay(v: number, dt: number): { distance: number; v: number } {
  const k = Math.exp(-dt / FLING_TIME_MS)
  return { distance: v * FLING_TIME_MS * (1 - k), v: v * k }
}
