import { describe, expect, it } from 'vitest'
import { isComic, summary, type Report } from './adding'

const report = (more: Partial<Report> = {}): Report => ({
  added: 0,
  known: 0,
  moved: 0,
  duplicate: 0,
  failed: [],
  ...more,
})

describe('adding comics', () => {
  it('takes CBZ, CBR and CB7 files only', () => {
    expect(['a.cbz', 'B.CBR', 'c.cb7'].every(isComic)).toBe(true)
    expect(['a.zip', 'notes.txt', 'a.cbz.part'].some(isComic)).toBe(false)
  })

  it('says what adding did', () => {
    expect(summary(report({ added: 12, known: 3 }))).toBe(
      'Added 12 comics. 3 comics already in the library.',
    )
    expect(summary(report({ added: 1 }))).toBe('Added 1 comic.')
    expect(summary(report({ moved: 1 }))).toBe(
      'Found 1 comic again at a new place, with where you left them.',
    )
    expect(summary(report({ duplicate: 2 }))).toBe(
      '2 comics left out: copies of comics already in the library.',
    )
    expect(summary(report({ added: 2, failed: [{ name: 'x.cbz', error: 'broken' }] }))).toBe(
      'Added 2 comics. 1 comic could not be added:',
    )
  })

  it('says so when a folder holds no comics', () => {
    expect(summary(report())).toBe('No comics found there.')
  })
})
