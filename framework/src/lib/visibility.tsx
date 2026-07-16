"use client"

/**
 * View culling — the client half of the spec-level `cull` gate.
 *
 * A parton declared with `cull:` ([[partial]]) is CULLABLE: its
 * fingerprint folds its resolved viewport state, and its emission is a
 * two-slot `<CullPair>` whose slots each wrap their child in a
 * `<Fragment ref>` observed by an IntersectionObserver via React
 * 19.3's `FragmentInstance.observeUsing` — no wrapper element, no
 * `data-*` id stamping. The pair already knows its parton's id, so
 * reports arrive as `{ id, inView }` straight from its closure.
 *
 * Reports funnel into a module-level controller (mirroring the refetch
 * batch / partial cache — client state lives at module scope, not in
 * context). The controller's baseline for each id is what's actually
 * DISPLAYED: `CullPair` primes it on mount (`_primeVisible`, the
 * emission's server-computed state overlaid by any live report — the
 * same precedence the pair's own display uses), so a first measurement
 * that agrees with the server's seed is a no-op — only a real DELTA
 * dispatches. Every delta
 * is mirrored into the cull-park display state (`cull-park.ts`) first —
 * the parton's Activity slots swap the moment the observer reports
 * (see `cull-pair.tsx`); the dispatch below is the REVALIDATION, not
 * the swap. Because the skeleton ships inline with every pair, a
 * cull-OUT is complete after the local swap — the server only needs to
 * know about it to keep the connection session's lane parking honest.
 * The controller is the channel's first PRODUCER ([[channel-client]]):
 * each delta schedules a transport flush (rAF-coalesced, one envelope
 * in flight) — measurement-only state (`newlyMeasured`) is a PASSENGER
 * instead, riding the next driven flush — and at flush time the
 * controller contributes ONE `visible` frame ([[channel-protocol]])
 * addressed to the open connection. No response body — the server
 * updates the connection session's visible set and renders the
 * flipped-IN partons as lane segments on the EXISTING stream, so flips
 * never race the connection's own renders. With NO connection
 * (`collect(null)` — pre-establishment, or between keepalive close and
 * the next attach) the statements simply STAY PENDING: the next
 * attach's `visible` seed states the full set, its whole-tree first
 * segment materializes anything in view, and the queued flips ride the
 * fresh connection's first flush (the establishment sync drives one) —
 * their lanes then fp-skip to confirmation placeholders where the
 * segment already delivered the bytes. A failed delivery (connection
 * gone) hands the frame back (`deliveryFailed`); the re-owned flips
 * pend the same way.
 *
 * A flipped-in parton's bytes settle its parked state through the
 * commit walk: fresh bytes drop the parked fiber, a confirmation
 * placeholder re-arms it as a live instance (see `cull-park.ts`).
 * fp-skip prunes the rest.
 *
 * A cullable parton's observer lives in whichever of its two slots is
 * currently visible (a hidden Activity unmounts its effects), so a
 * flip HANDS OFF observation between slots — possibly across render
 * passes. Observer teardown is therefore refcounted with a post-flush
 * sweep (`registerCullObserver`), never read as a page departure.
 */

import React, { useEffect, useRef } from "react"
import {
  type ChannelProducer,
  _reportContentEvicted,
  onChannelEstablished,
  registerChannelProducer,
  scheduleChannelFlush,
} from "./channel-registry.ts"
import type { ChannelFrame, VisibleFrame } from "./channel-protocol.ts"
import {
  registerCullObserver,
  reportCullState,
  reportedStateEvicted,
  reportedVisibility,
} from "./cull-park.ts"
import { _getLiveConnectionId, cachedTokensFor } from "./partial-client-state.ts"

/** How far beyond the viewport a parton counts as "in view" — the runway,
 *  so a parton fills before it's literally on screen. Expressed as an
 *  IntersectionObserver `rootMargin`. */
const RUNWAY = "600px 0px"

/** Max flipped ids per `visible` frame. The ids ride the envelope's
 *  JSON body (no request-line limit), so the cap only bounds how many
 *  concurrent lane renders one statement can ask of the server. */
const POST_FLUSH_BATCH = 256

/** The subset of `FragmentInstance` (React 19.3) this module uses. The
 *  installed react-dom exposes these; `@types/react` may not type a
 *  Fragment `ref` yet, so we shape it locally and cast at the ref site.
 *  `observeUsing` is duck-typed in react-dom — it only ever calls
 *  `observer.observe(child)` / `observer.unobserve(child)` (on attach,
 *  detach, and newly committed fragment children) — so it takes the
 *  {@link SlotObserver} facade over the shared native observer. */
interface FragmentInstance {
  observeUsing(observer: SlotObserver): void
  unobserveUsing(observer: SlotObserver): void
  getClientRects(): DOMRect[]
}

// ─── Controller (module-level client state) ───────────────────────────

/** ids currently within the runway-expanded viewport. Primed with each
 *  pair's server-computed display state before any measurement, so the
 *  set always mirrors what's on screen. */
const inView = new Set<string>()
/** ids with at least one real IntersectionObserver report — past the
 *  first report, priming is inert and the observer is the only writer. */
const everReported = new Set<string>()
/** ids whose in/out state changed since the last flush — the dispatch set. */
let changed = new Set<string>()
/** A first measurement landed for an id since the last flush. Even
 *  when it AGREES with the primed display state (no flip, nothing to
 *  revalidate), the connection session hasn't heard of the id — its
 *  `?visible=` seed and any earlier sync predate the id's observer
 *  (late-adopting subtrees measure after hydration). The next flush
 *  folds a full-set report (empty `changed`) so the session's parking
 *  stays honest — but the state is a PASSENGER, never a driver (the
 *  ack-cadence precedent): it marks the producer dirty and requests
 *  no flush of its own. An agreeing measurement has zero urgency —
 *  an out-agreement's absence from the session set already parks it
 *  correctly, and an in-agreement only lags its LIVE lane cadence,
 *  which the next driven envelope (a real flip, a threshold ack) or
 *  the next attach's seed re-establishes. During a scroll across a
 *  cullable field, every lane commit mounts fresh skeletons whose
 *  first measurements agree — a flush per wave would be one
 *  cookie-laden POST per frame saying nothing. */
let newlyMeasured = false
/** Whether ANY viewport report has landed yet. Gates the visible-set
 *  param/report: before the first report the correct wire state is
 *  "unmeasured" (no set at all — partons render their cold seed), never
 *  the empty set (which means "everything out"). */
let measured = false
/** Callbacks awaiting the first measurement (the heartbeat's live-fire
 *  gate — see `_onFirstMeasurement`). */
let measurementWaiters: (() => void)[] = []

/** A full-set sync is due on the next flush (`changed` may be empty —
 *  nothing to lane-render, just state sync). Armed at each
 *  connection's first measurement (see the establishment listener
 *  below): flips that fired between the connection's `?visible=` seed
 *  and its establishment rode the reload fallback, so the session's
 *  set may lag the client's — the sync closes that gap. Unlike
 *  `newlyMeasured`, this state DRIVES a flush: the lag can cover
 *  partons the user is looking at (their fallback reload already
 *  materialized them, but the session would park their lanes), and
 *  nothing else is guaranteed to flush soon after establishment — a
 *  catch-up attach on a quiet route opens straight into lanes and may
 *  never commit a delivery, so even the first-ack flush can't be
 *  counted on to carry it. Once per establishment, so the cost is one
 *  envelope per connection, not one per measurement wave. */
let fullSyncPending = false

/**
 * Prime an id's viewport state from its DISPLAY state (`CullPair`'s
 * mount effect passes the emission's `culled` prop). Inert once the id
 * has a real report — from then on the observer is the only writer.
 * Priming is what makes the first measurement a DELTA check against
 * what's actually shown: without it, every seeded-visible parton's
 * first "in view" report would read as a flip and dispatch a page-wide
 * revalidation at boot.
 *
 * The pair's display prefers the LIVE REPORT overlay over the emission
 * prop (`CullPair`: `reported ?? culled`), so the prime does too: a
 * restored parked subtree re-mounts pairs whose emissions were minted
 * BEFORE their cull-outs, and the raw prop would prime a baseline the
 * display contradicts — the observer's first real measurement (a
 * genuine flip against the showing skeleton) would read as a no-delta
 * duplicate and never dispatch, stranding the subtree as a skeleton
 * no report can ever revive. When the report side of that overlay was
 * itself evicted (`reportedStateEvicted` — the page-membership prune
 * dropped the id's state while a cached ancestor still holds its
 * pre-park emission), the raw prop is the same stale evidence with
 * nothing left to override it: the prime falls COLD instead — the id's
 * content is gone, the skeleton is what shows, so the baseline is out
 * and the observer's first measurement is authoritative (an in-flip
 * drives the revalidation, an out-agreement rides). Doesn't touch
 * `measured` — a primed set is still an unmeasured one.
 */
export function _primeVisible(id: string, isInView: boolean): void {
  if (everReported.has(id)) return
  const reported = reportedVisibility(id)
  const displayed = reported !== undefined ? reported : reportedStateEvicted(id) ? false : isInView
  if (displayed) inView.add(id)
  else inView.delete(id)
}

/** Report a cullable parton's MEASURED viewport state. Idempotent per
 *  state: only a delta against the current display state (primed or
 *  previously reported) schedules a dispatch. Every delta also updates
 *  the cull-park display state, so the parton's Activity slots swap
 *  immediately — the scheduled dispatch is the revalidation, not the
 *  swap. A FIRST measurement that agrees with the primed state only
 *  marks the producer dirty (`newlyMeasured`) — a passenger on the
 *  next driven flush, never a flush of its own. */
export function reportVisible(id: string, isInView: boolean): void {
  if (!measured) {
    measured = true
    const waiters = measurementWaiters
    measurementWaiters = []
    for (const cb of waiters) cb()
  }
  if (!everReported.has(id)) {
    everReported.add(id)
    newlyMeasured = true
  }
  if (inView.has(id) === isInView) return
  if (isInView) inView.add(id)
  else inView.delete(id)
  changed.add(id)
  reportCullState(id, isInView)
  schedule()
}

/** Whether any viewport measurement has landed this page. */
export function _visibilityMeasured(): boolean {
  return measured
}

/**
 * A commit REGRESSED a displayed cull pair from content to skeleton
 * without a client-stated out-flip — `CullPair`'s regression detector
 * (the producer that knows: its content slot's child stopped being
 * real while its live report still says in-view). Two consequences,
 * both explicit signals:
 *
 *   - the controller's baseline resets (the `reportGone` shape), so
 *     the skeleton observer's next measurement is a DELTA that
 *     dispatches — without it the id is "already in view" and the
 *     exactly-once flip machinery would never re-state it, leaving
 *     the skeleton permanent;
 *   - the loss rides upstream (`_reportContentEvicted`, DRIVEN — the
 *     user is looking at the regression, so the revocation and the
 *     in-view re-lane must land within one RTT), so the server
 *     revokes the id's mirror credit and the re-stated flip's lane
 *     re-renders instead of confirming the destroyed copy.
 */
export function _visibilityContentRegressed(id: string): void {
  inView.delete(id)
  everReported.delete(id)
  _reportContentEvicted(id, { drive: true })
}

/** Run `cb` at the first viewport measurement — immediately when one
 *  has already landed. The heartbeat gates its live fire on this so
 *  the connection opens with a measured `?visible=` seed (see
 *  `live-page-heartbeat.tsx`). */
export function _onFirstMeasurement(cb: () => void): void {
  if (measured) {
    cb()
    return
  }
  measurementWaiters.push(cb)
}

/** The current visible set as ids, or `undefined` before the first
 *  viewport report (the unmeasured state — no statement). The
 *  heartbeat seeds each attach's `visible` with this so the connection
 *  session starts from the client's measured set and the whole-tree
 *  first segment already renders against it. */
export function _visibleSetIds(): string[] | undefined {
  if (!measured) return undefined
  return [...inView]
}

// Arm the full-set sync per established connection, at the first
// measurement — whichever side of the establishment it lands on (a
// catch-up boot can establish the connection while hydration is still
// adopting the observers' subtrees). Without the deferred arm, a
// connection established pre-measurement never learns the set:
// agreements with the primed display state aren't flips, so no
// statement would ever carry it. Failure needs no handling: a failed
// sync means the connection is gone, and the transport already fell
// back.
function armEstablishmentSync(connection: string): void {
  _onFirstMeasurement(() => {
    if (_getLiveConnectionId() !== connection) return
    fullSyncPending = true
    schedule()
  })
}
onChannelEstablished(armEstablishmentSync)

/** Every observer of a cullable parton released past a commit flush.
 *  Drop it from the live set so the visible set doesn't carry a stale
 *  id. `changed` is deliberately NOT touched: a pending flip must still
 *  revalidate. Observer teardown is not a page-departure signal — an
 *  Activity flip can unmount one slot's observer in an earlier render
 *  pass than it mounts the other's, so the count passes through zero
 *  while the parton is very much on the page; cancelling its pending
 *  flip here would strand a restored subtree unrevalidated. A truly
 *  departed id costs at most one harmless extra dispatch target, and
 *  the hygiene self-heals: a re-mounting observer's initial
 *  IntersectionObserver callback re-reports the id. Page-membership
 *  teardown for the cull-park state rides the merge layer's prune
 *  instead (see `cull-park.ts`). */
function reportGone(id: string): void {
  inView.delete(id)
  // A returning instance re-primes from its fresh emission's display
  // state before its observer's first report.
  everReported.delete(id)
}

function schedule(): void {
  scheduleChannelFlush()
}

/**
 * The controller as a channel producer. `collect` runs at the
 * transport's flush: with a connection open it consumes the pending
 * deltas into ONE `visible` frame; with none it contributes nothing —
 * the statements stay pending and ride the next establishment's first
 * flush (the establishment sync drives one), while the attach's own
 * `visible` seed and whole-tree first segment carry the current
 * truth. `deliveryFailed` re-owns a frame's flips when its envelope
 * didn't land — they pend the same way until the heartbeat
 * re-establishes.
 */
const visibilityProducer: ChannelProducer = {
  collect(connection: string | null): VisibleFrame | null {
    if (connection === null) return null
    if (changed.size === 0 && !newlyMeasured && !fullSyncPending) return null
    // A statement commits nothing client-side, so it cannot supersede
    // or tear a mid-flight route swap the way a reload can — no
    // navigation-transition deferral on this path.
    newlyMeasured = false
    fullSyncPending = false
    // Viewport first — the same rule as the reload path below: flips the
    // user can SEE outrank stale cull-outs, both across batches (the cap
    // slices in-view flips first) and within one frame (the server
    // starts lanes in `changed` order, so in-view renders lead).
    const all = [...changed]
    const inViewFlips = all.filter((id) => inView.has(id))
    const outFlips = all.filter((id) => !inView.has(id))
    const ordered = [...inViewFlips, ...outFlips]
    const targets = ordered.slice(0, POST_FLUSH_BATCH)
    changed = new Set(ordered.slice(POST_FLUSH_BATCH))
    if (changed.size > 0) schedule()
    return {
      kind: "visible",
      changed: targets,
      visible: [...inView],
      // The client's actual holdings for the flipped ids — what the
      // server may confirm with a placeholder instead of re-rendering.
      cached: cachedTokensFor(targets),
    }
  },
  deliveryFailed(frame: ChannelFrame): void {
    if (frame.kind !== "visible") return
    for (const id of frame.changed) changed.add(id)
    schedule()
  },
}
registerChannelProducer(visibilityProducer)

/** Test-only: reset the controller's module state and re-register its
 *  transport hooks — `_resetChannelClient` clears the producer and
 *  establishment-listener registries this module joined at import.
 *  Both re-registrations are idempotent (same references, Set-backed
 *  registries). Also drains the shared-observer pool: a pooled native
 *  observer minted under one test's `IntersectionObserver` stub must
 *  not serve the next test's slots. */
export function _resetVisibilityController(): void {
  inView.clear()
  everReported.clear()
  changed = new Set()
  newlyMeasured = false
  measured = false
  measurementWaiters = []
  fullSyncPending = false
  sweepScheduled = false
  for (const shared of _sharedObservers.values()) shared.io.disconnect()
  _sharedObservers.clear()
  registerChannelProducer(visibilityProducer)
  onChannelEstablished(armEstablishmentSync)
}

// ─── Shared IntersectionObserver pool ─────────────────────────────────
//
// ONE native IntersectionObserver per rootMargin config (the root is
// always the viewport), shared by every slot that observes with that
// runway. Per-instance observers don't scale: the browser recomputes
// each observer's intersections independently on every layout-dirtied
// frame, so a dense cullable field (hundreds of mounted pairs) pays
// hundreds of native `computeIntersections` passes per frame where one
// pass over the same elements would do. The pool keeps the per-slot
// semantics intact — each slot subscribes a handler for exactly the
// elements React attaches through its facade, and the shared callback
// routes each native batch to the owning handlers, one call per slot
// per batch (the same shape a per-instance callback delivered).

/** What a slot hands to `FragmentInstance.observeUsing` — the facade
 *  over the shared native observer. Object identity is the attach
 *  handle React tracks in `_observers`, so each slot keeps ONE facade
 *  for its whole effect lifetime. */
interface SlotObserver {
  observe(el: Element): void
  unobserve(el: Element): void
  /** Release the slot's subscriptions and its pool reference. */
  disconnect(): void
}

type SlotEntryHandler = (entries: IntersectionObserverEntry[]) => void

interface SharedObserver {
  io: IntersectionObserver
  /** element → the slot handlers subscribed to it. Normally one; an
   *  outer transparent cullable can share host children with a nested
   *  one (no host element of its own between them). */
  subs: Map<Element, Set<SlotEntryHandler>>
  /** Live facades — the pool reference count. */
  handles: number
}

const _sharedObservers = new Map<string, SharedObserver>()

function acquireSlotObserver(rootMargin: string, onEntries: SlotEntryHandler): SlotObserver {
  let shared = _sharedObservers.get(rootMargin)
  if (!shared) {
    const subs = new Map<Element, Set<SlotEntryHandler>>()
    const io = new IntersectionObserver(
      (entries) => {
        // Route each entry to its element's subscribers, batched per
        // handler so a slot sees one callback per native batch — the
        // per-slot aggregate logic is unchanged from the per-instance
        // observer it replaces.
        const perHandler = new Map<SlotEntryHandler, IntersectionObserverEntry[]>()
        for (const entry of entries) {
          const handlers = subs.get(entry.target)
          if (!handlers) continue
          for (const handler of handlers) {
            let batch = perHandler.get(handler)
            if (!batch) perHandler.set(handler, (batch = []))
            batch.push(entry)
          }
        }
        for (const [handler, batch] of perHandler) handler(batch)
      },
      { rootMargin },
    )
    shared = { io, subs, handles: 0 }
    _sharedObservers.set(rootMargin, shared)
  }
  const pool = shared
  pool.handles += 1
  /** Elements THIS facade attached — released wholesale on disconnect. */
  const own = new Set<Element>()
  let disconnected = false
  const drop = (el: Element): void => {
    const handlers = pool.subs.get(el)
    if (!handlers || !handlers.delete(onEntries)) return
    if (handlers.size === 0) {
      pool.subs.delete(el)
      pool.io.unobserve(el)
    }
  }
  return {
    observe(el: Element): void {
      if (disconnected) return
      own.add(el)
      let handlers = pool.subs.get(el)
      if (!handlers) {
        pool.subs.set(el, (handlers = new Set([onEntries])))
        pool.io.observe(el)
        return
      }
      if (handlers.has(onEntries)) return
      handlers.add(onEntries)
      // The element is already tracked, so a plain `observe` is a
      // native no-op and fires NO initial entry for the new
      // subscriber. Cycle it: the re-observe's initial callback
      // carries current geometry to every subscriber — the new one
      // gets its first measurement, the existing ones an idempotent
      // re-report (same state, no delta).
      pool.io.unobserve(el)
      pool.io.observe(el)
    },
    unobserve(el: Element): void {
      if (disconnected) return
      own.delete(el)
      drop(el)
    },
    disconnect(): void {
      if (disconnected) return
      disconnected = true
      for (const el of own) drop(el)
      own.clear()
      pool.handles -= 1
      if (pool.handles === 0) {
        pool.io.disconnect()
        _sharedObservers.delete(rootMargin)
      }
    },
  }
}

// ─── Boundary observer ────────────────────────────────────────────────

/** Re-attach handles for every mounted boundary observer, keyed by
 *  parton id. Each handle re-attaches ITS observer to the fragment's
 *  current host children — but only when the observer tracks nothing
 *  (see `_sweepEmptyVisibilityObservers`). */
const reattachHandles = new Map<string, Set<() => void>>()

/**
 * Re-attach every observer that currently tracks ZERO connected nodes
 * to its fragment's current host children.
 *
 * Why this exists: `FragmentInstance.observeUsing` attaches the
 * observer to the host children React knows about AT THAT MOMENT. A
 * cullable boundary whose content is still materializing when its
 * effect runs — dehydrated nested boundaries on a fast prod
 * hydration, unresolved Flight lazies — has NO host children yet, and
 * children that materialize later are not attached retroactively. An
 * observer over an empty fragment never fires: the parton never
 * reports, the connection's visible set never learns it exists, and
 * everything the server parks behind it stays parked.
 *
 * The sweep runs on the framework's own content-arrival signals — a
 * cullable boundary's observer mounting (nested partons hydrating or
 * materializing) and every `PartialsClient` commit (lane commits,
 * payload swaps, substitutions) — never on a timer. Observers that
 * track at least one connected node are left alone, so a sweep is
 * O(observers) map walks and re-fires IntersectionObserver callbacks
 * only for boundaries that were unmeasurable before it.
 *
 * Those signals fire in BURSTS — a scroll's flip wave mounts a whole
 * column of observers in one commit, each a sweep request — so the
 * requests coalesce to ONE sweep per microtask (`sweepScheduled`).
 * Without it the wave is O(mounts × observers); with it, O(observers),
 * run once after the commit's DOM has fully materialized. A microtask
 * (not a timer) keeps it in the same frame, and the re-observe's
 * IntersectionObserver callback is async either way, so nothing waits
 * longer for content to become measurable.
 */
let sweepScheduled = false

export function _sweepEmptyVisibilityObservers(): void {
  // One sweep per microtask — a commit's burst of requests collapses to
  // a single O(observers) walk (see the coalescing note above).
  if (sweepScheduled) return
  sweepScheduled = true
  queueMicrotask(() => {
    sweepScheduled = false
    for (const handles of reattachHandles.values()) {
      for (const handle of handles) handle()
    }
  })
}

/**
 * Wraps a cullable parton's children in a `<Fragment ref>` and observes
 * their viewport intersection, reporting to the controller under the
 * parton's own id. Rendered by `PartialErrorBoundary` only when the server
 * marked the parton cullable; non-cullable partons render their children
 * bare (no Fragment, no observer, zero cost).
 *
 * The Fragment is transparent (no DOM) and renders identically on server
 * and client, so it doesn't shift the hydrated tree; the ref attaches and
 * the observer starts only on the client, in an effect.
 */
export function VisibilityObserver({
  id,
  rootMargin: rootMarginProp,
  children,
}: {
  id: string
  /** Observer runway (`cull.rootMargin`); omitted → the default RUNWAY. */
  rootMargin?: string
  children: React.ReactNode
}): React.ReactNode {
  const ref = useRef<FragmentInstance | null>(null)
  const rootMargin = rootMarginProp ?? RUNWAY
  useEffect(() => {
    const inst = ref.current
    if (!inst || typeof inst.observeUsing !== "function") return
    // This slot now observes the parton. A culling flip hands the
    // observation to the parton's other slot; the refcount + sweep
    // distinguishes that handoff from the parton actually leaving
    // the page.
    const release = registerCullObserver(id, reportGone)
    // An IO callback batch contains only the nodes whose intersection
    // CHANGED — with many observed children (a fragment of chunk
    // subtrees), one leaving node must not read as "the whole parton
    // left". Track per-node state and report the aggregate. The native
    // observer is SHARED per rootMargin (see the pool above); this
    // slot's facade subscribes exactly the elements React attaches.
    const nodeState = new Map<Element, boolean>()
    const io = acquireSlotObserver(rootMargin, (entries) => {
      for (const e of entries) nodeState.set(e.target, e.isIntersecting)
      for (const el of [...nodeState.keys()]) {
        if (!el.isConnected) nodeState.delete(el)
      }
      // Zero connected nodes is UNMEASURABLE, not "out" — the parton
      // is mid-swap (a flip lane replacing its body disconnects the
      // old nodes before the new ones report). Reporting "out" here
      // starts a flip loop: out → cull lane → placeholder commits →
      // intersects → "in" → content lane → swap → transient empty →
      // "out" → … at rAF rate, remounting the subtree every cycle.
      // Stay silent; the new nodes' initial callback (placement
      // attach or the empty-observer sweep) carries real evidence.
      if (nodeState.size === 0) return
      reportVisible(id, [...nodeState.values()].some(Boolean))
    })
    inst.observeUsing(io)
    // Late-materializing content: if the fragment had no host children
    // when `observeUsing` ran (dehydrated nested boundaries, unresolved
    // lazies), this observer watches nothing and can never report. The
    // handle re-attaches to the CURRENT host children; the sweep calls
    // it only while the observer tracks zero connected nodes.
    const reattachIfEmpty = (): void => {
      for (const el of [...nodeState.keys()]) {
        if (!el.isConnected) nodeState.delete(el)
      }
      if (nodeState.size > 0) return
      try {
        inst.unobserveUsing(io)
      } catch {
        // nothing was attached
      }
      inst.observeUsing(io)
    }
    let handles = reattachHandles.get(id)
    if (!handles) {
      handles = new Set()
      reattachHandles.set(id, handles)
    }
    handles.add(reattachIfEmpty)
    // This mount IS a content-arrival signal for ancestors: a nested
    // cullable materializing means an enclosing boundary's fragment may
    // have just gained its first host children.
    _sweepEmptyVisibilityObservers()
    return () => {
      const set = reattachHandles.get(id)
      if (set) {
        set.delete(reattachIfEmpty)
        if (set.size === 0) reattachHandles.delete(id)
      }
      try {
        inst.unobserveUsing(io)
      } catch {
        // unobserve after the fragment's nodes already left the tree
      }
      io.disconnect()
      release()
    }
  }, [id, rootMargin])
  // `ref` on a Fragment yields a FragmentInstance (React 19.3). Built via
  // `createElement` so the ref prop isn't gated by the JSX intrinsic types
  // (the installed react-dom supports it even where `@types/react` doesn't).
  return React.createElement(React.Fragment, { ref } as never, children)
}
