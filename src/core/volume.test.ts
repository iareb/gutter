import { describe, expect, it, vi } from 'vitest'
import { fileName, pageUrl } from './volume'

// Outside the app there is no Tauri runtime: mimic convertFileSrc on Windows and Android
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string, protocol: string) =>
    `http://${protocol}.localhost/${encodeURIComponent(path)}`,
}))

describe('pageUrl', () => {
  it('addresses a page of a volume through the page protocol', () => {
    expect(pageUrl({ id: 3, pages: ['1.jpg', '2.jpg'] }, 1)).toBe('http://page.localhost/3/1')
  })
})

describe('fileName', () => {
  it('takes the last part of a path on any system', () => {
    expect(fileName('/home/me/comics/Issue 1.cbz')).toBe('Issue 1.cbz')
    expect(fileName('C:\\Users\\me\\Issue 1.cbz')).toBe('Issue 1.cbz')
  })

  it('gives no name for Android content URIs', () => {
    expect(fileName('content://com.android.providers.downloads.documents/document/msf%3A1')).toBe(
      undefined,
    )
  })
})
