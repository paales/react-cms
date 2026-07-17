/**
 * Targeted-refetch dispatch — the EAGER accumulation seam.
 *
 * Framework-internal id-based forcing (the defer activators' `useActivate`
 * fire, the interactive-embed bridge's post-write echo) goes through
 * `enqueueRefetch`. Authors never target partons: their refresh signals
 * are cells and `tag()`.
 *
 * This module owns the SYNCHRONOUS half — the microtask batch: multiple
 * fires in one tick accumulate into one `_batchRef` and coalesce into a
 * single flush. Keeping the accumulation eager is what preserves that
 * coalescing: two activators firing in the same task must produce ONE
 * `?__force=a,b` statement, not two. The channel FLUSH
 * (`flushRefetchBatch` — the `_channelNavigate` statement) lives in the
 * late-loaded `refetch.ts`; the batch's microtask dynamically imports it
 * ONCE per batch, so the heavy channel transport stays out of the eager
 * callers' static closure without splitting a same-tick batch across the
 * async import.
 */

import type { RefetchBatchEntry } from "./refetch.ts"

// ─── The lazy flush bind ──────────────────────────────────────────
//
// The channel FLUSH (`flushRefetchBatch`) lives in the late-loaded
// `refetch.ts`; it binds itself here on load. Once bound, a batch's
// microtask calls it SYNCHRONOUSLY — no per-batch `import()`, so the
// dispatch's timing (and the unit tests' microtask model) is unchanged
// from a single eager module. A batch flushed before the bind (the live
// layer hasn't loaded yet — rare, activators/embeds fire post-commit)
// buffers and replays in order on bind, and triggers the load.

type FlushFn = (batch: RefetchBatchEntry[]) => void
let boundFlush: FlushFn | null = null
const bufferedBatches: RefetchBatchEntry[][] = []

/** `refetch.ts` binds its flush here on load; buffered batches replay in
 *  order. */
export function _bindRefetchFlush(fn: FlushFn): void {
  boundFlush = fn
  const pending = bufferedBatches.splice(0)
  for (const batch of pending) fn(batch)
}

function dispatchBatch(batch: RefetchBatchEntry[]): void {
  if (boundFlush !== null) {
    boundFlush(batch)
    return
  }
  bufferedBatches.push(batch)
  // Trigger the load so the bind (and this batch's replay) happens; a
  // dynamic import keeps the channel out of this eager module's static
  // closure.
  void import("./refetch.ts")
}

/** Two-milestone return mirroring the navigation handles. */
export interface RefetchMilestones {
  streaming: Promise<void>
  finished: Promise<void>
}

/** The caller-facing entry — ids + render mode + optional abort signal.
 *  `enqueueRefetch` attaches this batch's milestone resolvers before
 *  handing it to the flush. */
export interface RefetchEntry {
  /** Effective parton ids — become the statement's `?__force=` overlay.
   *  The server resolves each against the route's snapshots and lanes it
   *  EXPLICIT. */
  ids: string[]
  /** Render mode for the commit — `false` (default) wraps in
   *  `startTransition`; `true` opts into progressive streaming with
   *  Suspense fallbacks. Mirrors the `streaming` option on
   *  `FrameworkNavigateOptions` / `FrameworkReloadOptions`. */
  streaming: boolean
  /** Abort signal for this entry — a superseding fire sets this to a
   *  fresh `AbortController`'s signal; a superseded fire's record rejects
   *  with AbortError. */
  signal?: AbortSignal
}

let _batchRef: RefetchBatchEntry[] = []
let _batchScheduled = false

/**
 * Enqueue a targeted refetch. Multiple calls in the same microtask
 * coalesce into one statement. Returns synchronously with
 * `{streaming, finished}` promises — the caller can attach handlers on
 * either milestone independently. On supersede, the shared `AbortSignal`
 * propagates an `AbortError` to both milestones.
 */
export function enqueueRefetch(entry: RefetchEntry): RefetchMilestones {
  let resolveStreaming!: () => void
  let rejectStreaming!: (err: unknown) => void
  let resolveFinished!: () => void
  let rejectFinished!: (err: unknown) => void
  const streaming = new Promise<void>((res, rej) => {
    resolveStreaming = res
    rejectStreaming = rej
  })
  const finished = new Promise<void>((res, rej) => {
    resolveFinished = res
    rejectFinished = rej
  })
  // Pre-attach no-op handlers so a rejection that lands before the
  // downstream consumer's `.then(_, handler)` registers doesn't surface
  // as unhandledrejection. The pre-attach does NOT consume the rejection
  // — subsequent handlers still see the error.
  streaming.catch(() => {})
  finished.catch(() => {})

  _batchRef.push({
    ...entry,
    resolveStreaming,
    rejectStreaming,
    resolveFinished,
    rejectFinished,
  })
  if (!_batchScheduled) {
    _batchScheduled = true
    queueMicrotask(() => {
      const batch = _batchRef
      _batchRef = []
      _batchScheduled = false
      // One flush per BATCH — the same-tick coalescing (the point of the
      // eager accumulation) is already done; `dispatchBatch` delegates to
      // the bound channel flush, or buffers + triggers the load if the
      // live layer hasn't bound it yet. Batches dispatch in schedule
      // order (the `_uncoveredForces` restatement relies on it).
      dispatchBatch(batch)
    })
  }
  return { streaming, finished }
}
