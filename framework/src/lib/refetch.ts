/**
 * Targeted-refetch flush — the late-loaded CHANNEL half.
 *
 * `enqueueRefetch` (eager, `refetch-dispatch.ts`) accumulates a
 * same-tick batch and, once per batch, dynamically imports this module
 * and calls `flushRefetchBatch`. A batch states the page URL with the
 * effective ids as its one-shot `?__force=` overlay (intent "silent");
 * the response arrives on the held stream as a whole-tree payload
 * segment with the targets laned explicit after the reopen.
 * Pre-establishment batches latch and ride the attach they trigger
 * (`_channelNavigate`'s attach-with-intent). A DEGRADED page has no
 * freshness transport: fires resolve as no-ops — the page is
 * browser-native, and document loads are its renders.
 *
 * This half touches the channel transport (`_channelNavigate`), so it
 * stays out of the eager callers' static closure — reached only through
 * the dispatch seam's per-batch dynamic import.
 *
 * The framework-internal "silent navigation" info brand lives in the
 * eager `silent-info.ts`; the caller-facing `enqueueRefetch` /
 * `RefetchMilestones` live in `refetch-dispatch.ts`.
 */

import { _channelNavigate } from "./channel-client.ts"
import { _bindRefetchFlush, type RefetchEntry } from "./refetch-dispatch.ts"

export type { RefetchMilestones } from "./refetch-dispatch.ts"

/** A batch entry with its milestone resolvers attached — the shape the
 *  dispatch seam accumulates and hands to `flushRefetchBatch`. */
export interface RefetchBatchEntry extends RefetchEntry {
  /** Resolver for this entry's `streaming` milestone — the covering
   *  segment's commit. */
  resolveStreaming: () => void
  rejectStreaming: (err: unknown) => void
  /** Resolver for this entry's `finished` milestone — the covering
   *  segment's settle. */
  resolveFinished: () => void
  rejectFinished: (err: unknown) => void
}

// Ids of refetch statements whose covering segment has not settled.
// The transport keeps ONE pending url frame (newest statement wins
// pre-flush), so a batch flushed while an earlier batch is still
// uncovered must RESTATE the earlier targets — its `?__force=` is the
// union — or a same-frame pair of distinct-target fires would drop
// the first fire's targets. Restating a force that was already served
// costs one extra explicit lane render; dropping one loses the refetch.
const _uncoveredForces = new Map<object, readonly string[]>()

/**
 * Flush one accumulated batch as a single `?__force=` url statement.
 * Called (once per batch) from the eager dispatch seam's microtask.
 */
export function flushRefetchBatch(batch: RefetchBatchEntry[]): void {
  const idSet = new Set<string>()
  let streamingMode = false
  for (const entry of batch) {
    for (const id of entry.ids) idSet.add(id)
    if (entry.streaming) streamingMode = true
  }

  // Combine per-entry signals so the batched statement aborts when any
  // caller superseded. Batched callers share fate by construction —
  // they're one statement. (In practice batched entries usually come
  // from the same event handler; cross-supersede happens only across
  // microtasks so each fire is in its own batch.)
  const signals = batch.map((e) => e.signal).filter((s): s is AbortSignal => s != null)
  const signal =
    signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals)

  // The batch as a url statement: the page URL with the ids as its
  // `?__force=` overlay, intent "silent". `__force`, not a target
  // list: the statement's segment is WHOLE-TREE (every parton
  // re-evaluates the stated URL; fp-skip prunes the unchanged to
  // placeholders), with the named targets forced past fp-skip
  // server-side. The
  // connection's mirror is the manifest — nothing re-advertises.
  // Pre-establishment the statement latches and rides the attach it
  // triggers; only a DEGRADED page answers null.
  const stated = new URL(window.location.href)
  const restated = new Set(idSet)
  for (const ids of _uncoveredForces.values()) {
    for (const id of ids) restated.add(id)
  }
  if (restated.size > 0) {
    stated.searchParams.set("__force", [...restated].join(","))
  }
  const routed = _channelNavigate({
    url: stated.pathname + stated.search,
    intent: "silent",
    streaming: streamingMode,
    signal,
  })
  if (!routed) {
    // Degraded: no freshness transport exists. Resolve as no-ops — the
    // page's renders are document loads now.
    for (const e of batch) {
      e.resolveStreaming()
      e.resolveFinished()
    }
    return
  }
  if (idSet.size > 0) {
    const token = {}
    _uncoveredForces.set(token, [...idSet])
    // The covering segment's settle retires the restatement duty —
    // rejections (abort, teardown) retire it too.
    routed.finished.then(
      () => _uncoveredForces.delete(token),
      () => _uncoveredForces.delete(token),
    )
  }
  routed.streaming.then(
    () => {
      for (const e of batch) e.resolveStreaming()
    },
    (err) => {
      for (const e of batch) e.rejectStreaming(err)
    },
  )
  routed.finished.then(
    () => {
      for (const e of batch) e.resolveFinished()
    },
    (err) => {
      for (const e of batch) e.rejectFinished(err)
    },
  )
}

// Bind the flush into the eager dispatch seam the moment this module
// loads — from here on `enqueueRefetch` dispatches synchronously, and
// any batch buffered before the live layer arrived replays in order.
_bindRefetchFlush(flushRefetchBatch)
