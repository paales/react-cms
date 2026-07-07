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
 * controller contributes its statement over one of two paths:
 *
 *   - **Live connection open** (`collect` receives the id): a
 *     `visible` frame ([[channel-protocol]]) on the envelope,
 *     addressed to the connection. No response body — the server
 *     updates the connection session's visible set and renders the
 *     flipped-IN partons as lane segments on the EXISTING stream, so
 *     flips never race the connection's own renders. A failed
 *     delivery (connection gone) hands the frame back
 *     (`deliveryFailed`) and the batch falls back to the reload path.
 *   - **No live connection** (`collect` receives `null`): SELF-REFETCH
 *     the flipped-IN partons by id, carrying the full visible set as
 *     `?visible=` so each re-rendered parton reads its own bit,
 *     stamped `?__cullFlip=1` so the explicit targets may fp-skip (the
 *     culling revalidation). Cull-OUTs are dropped here — they have no
 *     server-relevant effect without a session, and the next live
 *     fire's `?visible=` seed carries the full truth.
 *
 * Either way a flipped-in parton's bytes settle its parked state
 * through the commit walk: fresh bytes drop the parked fiber, a
 * confirmation placeholder re-arms it as a live instance (see
 * `cull-park.ts`). fp-skip prunes the rest. Dispatch serializes across
 * both paths: one in flight, re-firing with the latest set when it
 * changes.
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
	onChannelEstablished,
	registerChannelProducer,
	scheduleChannelFlush,
} from "./channel-client.ts"
import type { ChannelFrame, VisibleFrame } from "./channel-protocol.ts"
import { registerCullObserver, reportCullState, reportedVisibility } from "./cull-park.ts"
import { _getLiveConnectionId, cachedTokensFor } from "./partial-client-state.ts"
import { enqueueRefetch } from "./refetch.ts"

/** How far beyond the viewport a parton counts as "in view" — the runway,
 *  so a parton fills before it's literally on screen. Expressed as an
 *  IntersectionObserver `rootMargin`. */
const RUNWAY = "600px 0px"

/** Max flipped ids per culling reload. A fast scroll across a large
 *  cullable field (the website's chunk world) can flip hundreds of
 *  partons in one coalesced flush; unbatched, the `?partials=` list
 *  alone would blow the server's request-line limit. Remaining flips
 *  stay in `changed` and ride the next serialized flush. */
const FLUSH_BATCH = 48

/** Max flipped ids per `visible` frame. The ids ride the envelope's
 *  JSON body (no request-line limit), so the cap is much higher than
 *  the reload path's — it only bounds how many concurrent lane renders
 *  one statement can ask of the server. */
const POST_FLUSH_BATCH = 256

/** The subset of `FragmentInstance` (React 19.3) this module uses. The
 *  installed react-dom exposes these; `@types/react` may not type a
 *  Fragment `ref` yet, so we shape it locally and cast at the ref site. */
interface FragmentInstance {
	observeUsing(observer: IntersectionObserver): void
	unobserveUsing(observer: IntersectionObserver): void
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
/** A reload-fallback dispatch is in flight. Serializes the fallback
 *  path AND blocks the frame path while it runs — one dispatch in
 *  flight across both, same as the transport's own envelope
 *  serialization; newer flips accumulate in `changed` and re-fire
 *  when it lands. */
let fallbackInFlight = false

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
 * no report can ever revive. Doesn't touch `measured` — a primed set
 * is still an unmeasured one.
 */
export function _primeVisible(id: string, isInView: boolean): void {
	if (everReported.has(id)) return
	const reported = reportedVisibility(id)
	const displayed = reported === undefined ? isInView : reported
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

/** The current visible set as a `?visible=` param value — the URL
 *  carrier the discrete (no-session) paths read; same unmeasured
 *  contract as `_visibleSetIds`. */
export function _visibleSetParam(): string | undefined {
	return _visibleSetIds()?.join(",")
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
 * deltas into ONE `visible` frame; with none it delivers via the
 * reload fallback below and contributes nothing. `deliveryFailed`
 * re-owns a frame's flips when its envelope didn't land — the
 * transport has already cleared the published id, so the re-queued
 * batch (and everything after it, until the heartbeat re-establishes)
 * rides the reload fallback.
 */
const visibilityProducer: ChannelProducer = {
	collect(connection: string | null): VisibleFrame | null {
		// One dispatch in flight across both paths: while a fallback
		// reload runs, the frame path waits too — its completion
		// re-schedules, and the flips ride whichever path is current then.
		if (fallbackInFlight) return null
		if (connection === null) {
			void flushFallback()
			return null
		}
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
 *  registries). */
export function _resetVisibilityController(): void {
	inView.clear()
	everReported.clear()
	changed = new Set()
	newlyMeasured = false
	measured = false
	measurementWaiters = []
	fullSyncPending = false
	fallbackInFlight = false
	registerChannelProducer(visibilityProducer)
	onChannelEstablished(armEstablishmentSync)
}

/**
 * Reload fallback (no live connection): culling is a POST-SETTLE
 * operation. A refetch fired while a page navigation is still
 * committing supersedes it and tears the route swap — the old route
 * stays visible and the new one never lands (the IO fires as the new
 * route's cold partons mount, i.e. mid-navigation). Defer until the
 * in-flight navigation finishes, then re-flush. `navigation.transition`
 * is the real signal (non-null only while a navigation is committing),
 * so this doesn't guess.
 */
async function flushFallback(): Promise<void> {
	if (fallbackInFlight || (changed.size === 0 && !newlyMeasured)) return
	const transition = (
		window as unknown as { navigation?: { transition?: { finished: Promise<unknown> } | null } }
	).navigation?.transition
	if (transition) {
		transition.finished.then(schedule, schedule)
		return
	}
	// Only flips the user can SEE ride the reload — their content needs
	// materializing. Cull-OUTs are already complete (the pair swapped to
	// its inline skeleton locally) and have no server-relevant effect
	// without a connection session; consume them here — the next live
	// fire's `?visible=` seed carries the full set. First-measurement
	// syncs likewise: with no session to inform they're moot.
	newlyMeasured = false
	const inViewFlips = [...changed].filter((id) => inView.has(id))
	const targets = inViewFlips.slice(0, FLUSH_BATCH)
	changed = new Set(inViewFlips.slice(FLUSH_BATCH))
	if (targets.length === 0) return
	fallbackInFlight = true
	try {
		await enqueueRefetch({
			labels: targets,
			streaming: false,
			live: false,
			cullFlip: true,
			params: { visible: [...inView].join(",") },
		}).finished
	} catch {
		// AbortError on supersede / NavigationError on a racing nav — both
		// benign here; the next flush re-fires with the current set.
	} finally {
		fallbackInFlight = false
		if (changed.size > 0) schedule()
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
 */
export function _sweepEmptyVisibilityObservers(): void {
	for (const handles of reattachHandles.values()) {
		for (const handle of handles) handle()
	}
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
		// left". Track per-node state and report the aggregate.
		const nodeState = new Map<Element, boolean>()
		const io = new IntersectionObserver(
			(entries) => {
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
			},
			{ rootMargin },
		)
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
