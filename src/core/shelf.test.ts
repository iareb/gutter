import { describe, expect, it } from 'vitest'
import type { Entry } from './library'
import { continueReading, newestFirst, progress, status, title, whereItWas } from './shelf'

let next = 1
const entry = (more: Partial<Entry> = {}): Entry => ({
  id: next++,
  address: 'a.cbz',
  name: 'Saga 01.cbz',
  size: 1,
  fingerprint: '1-00',
  pages: 40,
  added: 0,
  opened: null,
  page: 0,
  finished: false,
  direction: null,
  mode: null,
  cover: null,
  ...more,
})

describe('the library screen', () => {
  it('continues the last volumes opened, the latest first, at most three', () => {
    const a = entry({ opened: 10 })
    const b = entry({ opened: 30 })
    const c = entry({ opened: 20 })
    const d = entry({ opened: 5 })
    const never = entry()
    expect(continueReading([a, b, c, d, never]).map((e) => e.id)).toEqual([b.id, c.id, a.id])
  })

  it('does not continue a volume read to the end', () => {
    const done = entry({ opened: 50, finished: true })
    const reading = entry({ opened: 40 })
    expect(continueReading([done, reading])).toEqual([reading])
  })

  it('lists every volume, the newest added first', () => {
    const old = entry({ added: 1 })
    const recent = entry({ added: 9 })
    const middle = entry({ added: 5 })
    expect(newestFirst([old, recent, middle]).map((e) => e.added)).toEqual([9, 5, 1])
  })

  it('tells how far a volume is read', () => {
    expect(progress(entry())).toBe(0)
    expect(progress(entry({ opened: 1, page: 9, pages: 40 }))).toBe(0.25)
    expect(progress(entry({ opened: 1, page: 39, pages: 40 }))).toBe(1)
    expect(progress(entry({ opened: 1, page: 3, finished: true }))).toBe(1)
    expect(progress(entry({ opened: 1, pages: null }))).toBe(0)
  })

  it('says where a volume is', () => {
    expect(status(entry())).toBe('New')
    expect(status(entry({ opened: 1, page: 22 }))).toBe('Page 23 of 40')
    expect(status(entry({ opened: 1, page: 2, pages: null }))).toBe('Page 3')
    expect(status(entry({ opened: 1, finished: true }))).toBe('Finished')
  })

  it('says where a file was in words a reader knows', () => {
    expect(whereItWas('C:\\Comics\\Saga 01.cbz')).toBe('C:\\Comics\\Saga 01.cbz')
    expect(
      whereItWas(
        'content://com.android.externalstorage.documents/tree/primary%3ADownload%2Fcomics/document/primary%3ADownload%2Fcomics%2FSaga%2001.cbz',
      ),
    ).toBe('Download/comics/Saga 01.cbz')
    expect(
      whereItWas(
        'content://com.android.providers.downloads.documents/document/raw%3A%2Fstorage%2Femulated%2F0%2FDownload%2FSaga.cbz',
      ),
    ).toBe('Download/Saga.cbz')
    expect(whereItWas('content://x/document/%E0%A4%A')).toBe('content://x/document/%E0%A4%A')
  })

  it('shows a name without the extension of the file', () => {
    expect(title(entry({ name: 'Saga 01.cbz' }))).toBe('Saga 01')
    expect(title(entry({ name: 'Akira.v1.CBR' }))).toBe('Akira.v1')
    expect(title(entry({ name: 'notes' }))).toBe('notes')
    expect(title(entry({ name: '.cbz' }))).toBe('.cbz')
  })
})
