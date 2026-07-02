/**
 * Time scope — the render clock.
 *
 * The `time()` hook (and a cell partition callback's `time` field)
 * carries a snapshot of the current request's wall-clock time plus a
 * handful of pre-computed boundary timestamps. Authors derive wake
 * boundaries from these without `Date.now()` math inline, and all
 * derived values in one call see a consistent capture.
 *
 *   const clock = time()
 *   expires(clock.nextMinute)
 *   const minute = Math.floor(clock.now / 60_000)
 *
 * `nextSecond` / `nextMinute` / `nextHour` are epoch boundaries
 * (same in every timezone). `nextDay` is a UTC-day boundary.
 * `time.in(ms)` returns `now + ms` for explicit "lives N ms" cases.
 * `time.never` is `+Infinity`, the sentinel for content with no
 * expiry.
 */

export interface TimeScope {
  /** Current Unix epoch ms, captured once per scope construction. All
   *  derived fields are computed against this value, so one capture
   *  sees consistent time. */
  readonly now: number
  /** Timestamp of the next whole-second boundary after `now`. */
  readonly nextSecond: number
  /** Timestamp of the next whole-minute boundary after `now`. */
  readonly nextMinute: number
  /** Timestamp of the next whole-hour boundary after `now`. */
  readonly nextHour: number
  /** Timestamp of the next UTC-day boundary after `now`. */
  readonly nextDay: number
  /** Returns `now + ms`. Useful for explicit fixed lifetimes:
   *  `expires(time().in(60_000))` declares a 60s freshness window. */
  in(ms: number): number
  /** Sentinel for "never expires" (`Number.POSITIVE_INFINITY`). */
  readonly never: number
}

const SECOND_MS = 1_000
const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/** Construct a `TimeScope` against `Date.now()`. */
export function buildTimeScope(): TimeScope {
  const now = Date.now()
  return {
    now,
    nextSecond: (Math.floor(now / SECOND_MS) + 1) * SECOND_MS,
    nextMinute: (Math.floor(now / MINUTE_MS) + 1) * MINUTE_MS,
    nextHour: (Math.floor(now / HOUR_MS) + 1) * HOUR_MS,
    nextDay: (Math.floor(now / DAY_MS) + 1) * DAY_MS,
    in(ms: number) {
      return now + ms
    },
    never: Number.POSITIVE_INFINITY,
  }
}
