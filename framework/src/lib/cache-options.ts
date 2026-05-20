/**
 * Dev/debug options carried by `<Partial cache={…}>`.
 *
 * Caching itself is now driven by `expiresAt` / `staleUntil` returned
 * from `vary` — the framework strips those reserved keys from the
 * vary result, stores them on the partial's snapshot, and the
 * `<Cache>` wrapper consumes them as freshness boundaries. Authors
 * who just want byte caching never set the `cache` prop; they
 * declare `expiresAt: time.in(60_000)` (or `time.never`) in vary.
 *
 * The remaining `CacheOptions` exists solely for the `slowSource`
 * dev hook, which slows the hit-path byte replay so the Suspense
 * streaming behaviour is observable end-to-end. Not for production.
 */
export interface CacheOptions {
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
