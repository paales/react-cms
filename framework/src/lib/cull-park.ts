/**
 * Client state for cull-to-park — the module that decides what a
 * cullable parton's two Activity slots (see `cull-slot.tsx`) show.
 *
 * A cullable keepalive parton renders as a stable two-slot pair: a
 * CONTENT slot (cache variant `mk`) and a SKELETON slot (cache
 * variant `mk~cull` — see `cull-key.ts`). A culling flip is an
 * Activity MODE change on those slots, never a child replacement, so
 * the out-of-view content subtree PARKS (fiber alive, DOM kept,
 * effects unmounted) instead of being destroyed — and a return visit
 * restores it in place, client state intact.
 *
 * This module owns:
 *
 *   - the REPORTED viewport state per parton id — written by the
 *     visibility controller (`visibility.tsx`), read by `CullSlot`
 *     via a subscription. The report IS the display state: slots
 *     flip the moment the observer reports, while the controller's
 *     reload revalidates in the background (fp-skip semantics: a
 *     placeholder confirms the parked copy; fresh bytes replace it).
 *   - the parked-by-culling LRU — culled ids, most-recently-culled
 *     kept. Past `CULL_PARK_CAP`, the oldest id's parked content
 *     slots are destroyed (a return visit is then a cold render —
 *     the pre-parking behavior).
 *   - the per-slot content GENERATION — bumped when fresh content
 *     bytes land for a slot whose mounted fiber has been parked
 *     since its bytes were minted (`parkedSince`). The generation
 *     keys the content slot's Activity, so an fp-moved return
 *     REMOUNTS (drops the parked copy) while an fp-matched restore
 *     and every ordinary live update reconcile in place.
 *   - the observer refcount per id — a flip hands observation from
 *     one slot's `VisibilityObserver` to the other's (Activity
 *     hiding unmounts the parked slot's effects), so "the parton
 *     left the page" is COUNT REACHES ZERO AND STAYS THERE past the
 *     commit's cleanup→mount effect flush, not any single cleanup.
 */

import {
  _setIdPrunedListener,
  _setManifestPriorityIds,
  evictCulledContent,
} from "./partial-client-state.ts"

/** Max parked-by-culling subtrees kept alive. Most-recently-culled
 *  win; past the cap the oldest parked id's content slots are
 *  destroyed and its next cull-in renders cold. Bounds the hidden-DOM
 *  and fiber cost of a long scroll journey. */
export const CULL_PARK_CAP = 64

// ─── Reported viewport state ──────────────────────────────────────

/** id → last reported in-view state. Absent = no live report (cold /
 *  observer gone) — `CullSlot` falls back to the server-computed
 *  `culled` prop of its rendered payload. */
const _reported = new Map<string, boolean>()

/** ids whose reported state was dropped by `cullStateGone` while an
 *  ancestor's cached subtree may still hold their pre-drop emissions —
 *  a subtree parked inside a cached ancestor ages out of the client
 *  maps (content + fps destroyed) without its pair emission going
 *  anywhere. A pair re-mounting from such an emission primes the
 *  visibility controller with props minted BEFORE the park — the same
 *  stale evidence the live-report overlay exists to override, except
 *  the overlay's report side is gone too. The tombstone is the
 *  remaining signal: `_primeVisible` treats a tombstoned id as
 *  displayed-out (without content the skeleton is what shows), so the
 *  observer's first measurement is authoritative — an in-flip drives
 *  the revalidation, an out-agreement rides. Retired when fresh
 *  content stores for the id (`contentSlotStored` — the commit walk
 *  runs before the pair's prime effect, so a route-back's fresh
 *  emission primes normally). */
const _reportEvicted = new Set<string>()

/** Parked-by-culling LRU: ids currently in the culled state,
 *  insertion order = cull recency (re-culling re-inserts). */
const _parked = new Map<string, true>()

/** ids whose CONTENT slot's mounted fiber has been parked at some
 *  point since the slot's bytes were minted. A fresh content store
 *  for such an id is a RETURNING render (fp moved while parked) —
 *  bump the generation so the parked fiber is dropped. Cleared when
 *  the cull-in flip's reload settles (`clearParkedSince`), so later
 *  in-view live updates reconcile in place as usual. */
const _parkedSince = new Set<string>()

/** id → content-slot generation. Keys the content Activity. */
const _generation = new Map<string, number>()

// Parked ids keep their `?cached=` manifest slots ahead of the
// recency walk — most-recently-culled first. Without this, a busy
// live page's lane registrations churn a parked id out of the
// manifest and its next cull-in can't be fp-confirmed: the parked
// copy would be dropped for fresh bytes even when nothing changed.
_setManifestPriorityIds(() => [..._parked.keys()].reverse())

const _subscribers = new Set<() => void>()

function notify(): void {
  for (const cb of [..._subscribers]) cb()
}

/** Subscribe to any cull-state change (reported flips, generation
 *  bumps). `CullSlot`'s useSyncExternalStore subscription. */
export function subscribeCullState(cb: () => void): () => void {
  _subscribers.add(cb)
  return () => {
    _subscribers.delete(cb)
  }
}

/** Per-id snapshot for useSyncExternalStore — a stable string so an
 *  unrelated id's change doesn't re-render this slot. */
export function cullStateSnapshot(id: string): string {
  const r = _reported.get(id)
  return `${r === undefined ? "u" : r ? "1" : "0"}|${_generation.get(id) ?? 0}`
}

export function reportedVisibility(id: string): boolean | undefined {
  return _reported.get(id)
}

/** Whether `cullStateGone` evicted the id's reported state and no
 *  fresh content has stored since — the prime path's cold token (see
 *  `_reportEvicted` above). */
export function reportedStateEvicted(id: string): boolean {
  return _reportEvicted.has(id)
}

export function contentGeneration(id: string): number {
  return _generation.get(id) ?? 0
}

/**
 * The visibility controller's write side — called alongside its own
 * in-view bookkeeping on every real flip. Maintains the parked LRU
 * (cull-out enters + touches, cull-in leaves) and evicts past the cap.
 */
export function reportCullState(id: string, isInView: boolean): void {
  _reported.set(id, isInView)
  if (isInView) {
    _parked.delete(id)
  } else {
    // Re-insert so map order tracks cull recency.
    _parked.delete(id)
    _parked.set(id, true)
    _parkedSince.add(id)
    while (_parked.size > CULL_PARK_CAP) {
      const oldest = _parked.keys().next().value
      if (oldest === undefined) break
      _parked.delete(oldest)
      _parkedSince.delete(oldest)
      evictCulledContent(oldest)
    }
  }
  notify()
}

/** The id left the client maps — the merge layer's prune dropped its
 *  last cache/fp entries (`_setIdPrunedListener` below), so no commit
 *  references it rendered, skipped, or parked anymore. Drop every live
 *  per-id trace, leaving only the eviction tombstone: the id's pair
 *  emission can outlive its map entries inside a cached ancestor's
 *  subtree, and a restore that re-mounts it must not trust its
 *  pre-drop props (see `_reportEvicted`). Observer lifecycles are NOT
 *  this signal: an Activity flip can unmount one slot's observer in a
 *  different render pass than it mounts the other's, so a momentarily
 *  observer-less parton is still very much on the page. No notify: a
 *  pruned parton has no mounted slot left to update, and a journey
 *  across a large cullable field prunes many ids per commit —
 *  notifying from each would nest commit chains past React's
 *  update-depth limit. */
export function cullStateGone(id: string): void {
  _reported.delete(id)
  _parked.delete(id)
  _parkedSince.delete(id)
  _reportEvicted.add(id)
}

_setIdPrunedListener(cullStateGone)

/**
 * A fresh CONTENT-slot store landed for `id` (the commit walk calls
 * this from `cacheFromStreamingChildren` — base-variant stores only).
 * If the slot's mounted fiber has been parked since its bytes were
 * minted, the incoming bytes are a returning render whose fp moved —
 * drop the parked copy by bumping the slot's generation.
 *
 * No notify: the walk runs INSIDE the commit's render (or a lane
 * commit that re-renders the template itself), so the slot re-renders
 * with the new generation in the same pass — a subscriber setState
 * here would be an update-during-render.
 */
export function contentSlotStored(id: string): void {
  // Fresh content retires the eviction tombstone: from this store on,
  // the id's emissions are current evidence and priming may trust them.
  _reportEvicted.delete(id)
  if (!_parkedSince.has(id)) return
  _parkedSince.delete(id)
  _generation.set(id, (_generation.get(id) ?? 0) + 1)
}

/** A commit carried the server's CONFIRMATION placeholder for `id`'s
 *  content slot (fp matched — the parked copy is provably current;
 *  see `placeholderFor`'s confirm marker). The fiber counts as a live
 *  instance again: later stores must reconcile in place, not drop.
 *  Rides the same commit walk as `contentSlotStored`, so the two
 *  outcomes of a culling revalidation can't race each other. */
export function contentSlotConfirmed(id: string): void {
  _parkedSince.delete(id)
}

/** Test/HMR hook — reset every map. */
export function _resetCullPark(): void {
  _reported.clear()
  _reportEvicted.clear()
  _parked.clear()
  _parkedSince.clear()
  _generation.clear()
}

/** Introspection for tests: the parked LRU's current order. */
export function _parkedIds(): string[] {
  return [..._parked.keys()]
}

export function _isParkedSince(id: string): boolean {
  return _parkedSince.has(id)
}

// ─── Observer refcount ────────────────────────────────────────────
//
// One parton id can be observed by either slot's VisibilityObserver —
// a flip unmounts one observer and mounts the other within the SAME
// React effect flush (all cleanups run, then all mounts). "Gone" is
// therefore count == 0 AFTER that flush settles: the release schedules
// a microtask sweep, and a handoff's remount lands before it runs.

const _observerCount = new Map<string, number>()

/** Whether ANY cullable parton currently mounts a viewport observer.
 *  The heartbeat's live-fire gate: a page with observers will produce
 *  a first measurement (IntersectionObserver always fires an initial
 *  callback per observed target), so the live connection waits for it
 *  and opens with a measured `?visible=` seed; a page without
 *  observers has nothing to measure and fires immediately. */
export function _anyCullObservers(): boolean {
  for (const n of _observerCount.values()) if (n > 0) return true
  return false
}

export function registerCullObserver(id: string, onGone: (id: string) => void): () => void {
  _observerCount.set(id, (_observerCount.get(id) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const n = (_observerCount.get(id) ?? 1) - 1
    if (n > 0) {
      _observerCount.set(id, n)
      return
    }
    _observerCount.set(id, 0)
    queueMicrotask(() => {
      if ((_observerCount.get(id) ?? 0) === 0) {
        _observerCount.delete(id)
        onGone(id)
      }
    })
  }
}
