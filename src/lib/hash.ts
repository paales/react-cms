/**
 * djb2 hash — fast, non-crypto, sufficient for cache keys and fingerprints.
 * Returns a short base-36 string.
 */
export function djb2(s: string): string {
  let hash = 5381
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(36)
}
