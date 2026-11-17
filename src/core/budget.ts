const MB = 1024 * 1024

/** Phones and tablets: the webview's graphics memory is not ours to spend. */
const mobile = () => /Android|iPhone|iPad/i.test(navigator.userAgent)

/**
 * Bytes the page cache may hold: the encoded pages kept and the decoded bitmaps
 * counted at 4 bytes a pixel. The page being read is never dropped, so a very
 * large page can take the cache above this. Set from the measurements in
 * docs/spikes/page-memory.md.
 */
export function defaultBudget(): number {
  return mobile() ? 96 * MB : 192 * MB
}
