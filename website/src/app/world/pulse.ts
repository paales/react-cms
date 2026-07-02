import { localCell } from "@parton/framework"

/**
 * The world's pulse — one counter cell, partitioned per chunk
 * coordinate. Server-owned state: it keeps counting whether or not
 * any client has the chunk's content in view, which is exactly what
 * a returning (re-culled-in) chunk demonstrates by showing the
 * caught-up value.
 */
export const chunkPulse = localCell({
  id: "world.pulse",
  shape: "number",
  initial: 0,
})

/**
 * Per-chunk background ticker: increments the chunk's pulse partition
 * at random intervals. Each chunk draws a BASE rate from its
 * coordinates (deterministic spatial variety — some neighborhoods are
 * hot, some sleepy) and jitters every tick, clamped to 0.1–5s, so the
 * network lights' frequency colors mean something. Tickers start on a
 * chunk's first content render and are LRU-capped: past the cap the
 * oldest ticker dies (its chain checks membership), so a public
 * instance can't accumulate unbounded timers.
 */
// Survives HMR module replacement: a reloaded module reuses the same
// set, so running chains stay owned and chunks don't double-tick.
const tickers = ((globalThis as Record<string, unknown>).__worldPulseTickers ??=
  new Set<string>()) as Set<string>
const TICKER_CAP = 512

export function ensurePulseTicker(cx: number, cy: number): void {
  const key = `${cx},${cy}`
  if (tickers.has(key)) return
  if (tickers.size >= TICKER_CAP) {
    const oldest = tickers.values().next().value
    if (oldest !== undefined) tickers.delete(oldest)
  }
  tickers.add(key)

  const base = 400 + ((((cx * 7 + cy * 13) % 9) + 9) % 9) * 500
  const schedule = (): void => {
    const jitter = 0.5 + Math.random()
    const delay = Math.min(5_000, Math.max(100, base * jitter))
    setTimeout(() => {
      if (!tickers.has(key)) return
      const next = chunkPulse.peek({ cx, cy }) + 1
      void chunkPulse.set(next, { partition: { cx, cy } }).then(schedule, schedule)
    }, delay)
  }
  schedule()
}
