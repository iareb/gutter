import { describe, expect, it } from 'vitest'
import { fileName } from './volume'

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
