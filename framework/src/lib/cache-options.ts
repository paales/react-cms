/**
 * Cache-Control-shaped options carried by `parton(..., { cache })`.
 *
 * Setting the `cache` prop activates byte-level caching: the
 * framework stores the rendered Flight bytes for the spec's
 * subtree and replays them on hit. Distinct from `expiresAt` in
 * `expires()` — that controls when the fp becomes stale (wake hint for
 * the segment driver, no byte storage). Caching needs an explicit
 * opt-in via this prop.
 *
 * - `maxAge`: HTTP-directive-style fresh window in seconds. After
 *   `maxAge` elapses the stored entry is stale and the next
 *   request misses.
 * - `staleWhileRevalidate`: additional seconds past `maxAge` during
 *   which stale bytes are served while a background refresh runs.
 * - `slowSource` (dev only): emit stored bytes in artificially
 *   throttled chunks so a hit-path replay exercises Suspense
 *   streaming end-to-end. Used by `cache-streaming-demo.tsx`.
 *
 * Future direction: `cache: true` (boolean) replacing the object
 * form, with TTL coming from vary's `expiresAt`. Not yet — for now
 * the prop is the byte-cache opt-in AND carries its own maxAge.
 */
export interface CacheOptions {
  maxAge?: number
  staleWhileRevalidate?: number
  /**
   * DEV / DEBUG ONLY. When set on a hit-path read, the stored bytes
   * are emitted through the decoder in chunks separated by `perChunkMs`
   * (default chunk size `chunkBytes`, 64 if omitted).
   *
   * Used to validate end-to-end that the cache's stream-replay path
   * preserves Suspense streaming — the same primitive a future
   * `<RemoteFrame>` uses to stitch a slow cross-origin Flight payload
   * into the host's outer render. Not for production: every hit pays
   * the artificial latency.
   */
  slowSource?: { perChunkMs: number; chunkBytes?: number }
}
