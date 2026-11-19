import { describe, expect, it } from 'vitest'
import { keyMove, keyPan, keyZoom, leaveSide, tapMove } from './navigation'

describe('right-to-left reading', () => {
  it('mirrors the left and right arrows, not the others', () => {
    expect(keyMove('ArrowLeft', false, 'rtl')).toBe('next')
    expect(keyMove('ArrowRight', false, 'rtl')).toBe('previous')
    for (const key of ['ArrowDown', 'PageDown', ' '])
      expect(keyMove(key, false, 'rtl')).toBe('next')
    for (const key of ['ArrowUp', 'PageUp']) expect(keyMove(key, false, 'rtl')).toBe('previous')
    expect(keyMove('Home', false, 'rtl')).toBe('first')
    expect(keyMove('End', false, 'rtl')).toBe('last')
  })

  it('mirrors the tap zones', () => {
    expect(tapMove(10, 400, 'rtl')).toBe('next')
    expect(tapMove(390, 400, 'rtl')).toBe('previous')
    expect(tapMove(200, 400, 'rtl')).toBeUndefined()
  })

  it('says which way the page leaves ', () => {
    expect(leaveSide('next', 'ltr')).toBe(-1)
    expect(leaveSide('previous', 'ltr')).toBe(1)
    expect(leaveSide('next', 'rtl')).toBe(1)
    expect(leaveSide('previous', 'rtl')).toBe(-1)
  })
})

describe('keyPan', () => {
  it('moves a zoomed page in the direction of the arrow', () => {
    expect(keyPan('ArrowRight')).toEqual([0.3, 0])
    expect(keyPan('ArrowLeft')).toEqual([-0.3, 0])
    expect(keyPan('ArrowDown')).toEqual([0, 0.3])
    expect(keyPan('ArrowUp')).toEqual([0, -0.3])
  })

  it('moves almost a screen with Page Up/Down and Space', () => {
    expect(keyPan('PageDown')).toEqual([0, 0.9])
    expect(keyPan(' ')).toEqual([0, 0.9])
    expect(keyPan('PageUp')).toEqual([0, -0.9])
    expect(keyPan(' ', true)).toEqual([0, -0.9])
  })

  it('leaves Home and End to page navigation', () => {
    expect(keyPan('Home')).toBeUndefined()
    expect(keyPan('End')).toBeUndefined()
  })
})

describe('keyZoom', () => {
  it('zooms with + (or =, its unshifted key), - and 0', () => {
    expect(keyZoom('+')).toBe('in')
    expect(keyZoom('=')).toBe('in')
    expect(keyZoom('-')).toBe('out')
    expect(keyZoom('0')).toBe('fit')
    expect(keyZoom('a')).toBeUndefined()
  })
})

describe('keyMove', () => {
  it('goes forward and back with arrows and page keys', () => {
    for (const key of ['ArrowRight', 'ArrowDown', 'PageDown', ' '])
      expect(keyMove(key)).toBe('next')
    for (const key of ['ArrowLeft', 'ArrowUp', 'PageUp']) expect(keyMove(key)).toBe('previous')
  })

  it('goes back with Shift+Space', () => {
    expect(keyMove(' ', true)).toBe('previous')
  })

  it('jumps to the ends with Home and End', () => {
    expect(keyMove('Home')).toBe('first')
    expect(keyMove('End')).toBe('last')
  })

  it('ignores other keys', () => {
    for (const key of ['a', 'Enter', 'Escape', 'Tab']) expect(keyMove(key)).toBeUndefined()
  })
})

describe('tapMove', () => {
  it('uses the outer quarters of the page area', () => {
    expect(tapMove(0, 400)).toBe('previous')
    expect(tapMove(99, 400)).toBe('previous')
    expect(tapMove(300, 400)).toBe('next')
    expect(tapMove(399, 400)).toBe('next')
  })

  it('does nothing in the middle', () => {
    expect(tapMove(100, 400)).toBeUndefined()
    expect(tapMove(299, 400)).toBeUndefined()
  })
})
