import { describe, expect, it } from 'vitest'
import { keyMove, movePage, tapMove } from './navigation'

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

describe('movePage', () => {
  it('moves one page at a time', () => {
    expect(movePage('next', 3, 20)).toBe(4)
    expect(movePage('previous', 3, 20)).toBe(2)
  })

  it('stops at the ends instead of wrapping', () => {
    expect(movePage('next', 19, 20)).toBe(19)
    expect(movePage('previous', 0, 20)).toBe(0)
  })

  it('jumps to the first and last page', () => {
    expect(movePage('first', 7, 20)).toBe(0)
    expect(movePage('last', 7, 20)).toBe(19)
  })

  it('handles a single page', () => {
    for (const move of ['next', 'previous', 'first', 'last'] as const) {
      expect(movePage(move, 0, 1)).toBe(0)
    }
  })
})
