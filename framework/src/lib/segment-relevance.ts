/**
 * Snapshot-relevance vocabulary for the streaming segment driver: the
 * route wake subscription (each live connection's registration into
 * the inverted wake index — bump-time delivery to exactly the
 * connections a selector touches), lane-carrier escalation, and the
 * scan-based twins that stay off the bump path (the action-reservation
 * selector match, cookie-dep routing, and the parity filter).
 *
 * Lives in its own module (rather than inside `segmented-response.ts`)
 * so all of it is unit-testable without dragging in the render graph
 * (`partial.tsx` et al.) that the driver imports.
 */

import {
  _closeWakeSubscription,
  _compileSurfaceQuery,
  _deliverToWakeSubscription,
  _openWakeSubscription,
  _queryCompiledMatchingTs,
  _seedWakeSubscriptionPending,
  _selectorMatchesSurface,
  _setWakeSubscriptionEntry,
  _removeWakeSubscriptionEntry,
  type CompiledSurfaceQuery,
  type ParsedSelector,
  type WakeSubscriberContext,
  type WakeSubscription,
} from "../runtime/invalidation-registry.ts"
import { effectiveExpiresAt, type PartialSnapshot } from "./partial-registry.ts"

/**
 * The ids whose snapshots a bump with `ts > sinceTs` touched, mapped
 * to their lane carriers. The surface per snapshot is its `varyKey`
 * (stable-stringified vary result) unioned with its `constraintArgs`
 * (bound-cell args) — the same inputs the live fp folds through
 * `queryMatchingTs`; a bump for a different partition (another
 * viewer's cart) or to an unrendered label never matches.
 *
 * This is the PULL form of the wake index's push delivery — retired
 * from the driver's bump path (the index delivers at commit time) but
 * kept as the parity oracle: `_assertWakeParity` re-derives the lane
 * set from scratch and asserts delivery covers it post-park.
 */
export function _routeMatchingBumpIds(
  snapshots: ReadonlyMap<string, PartialSnapshot>,
  sinceTs: number,
): string[] {
  const ids: string[] = []
  for (const [id, snap] of snapshots) {
    if (_queryCompiledMatchingTs(snap.labels, surfaceQueryOf(snap)) > sinceTs) ids.push(id)
  }
  return _escalateToLaneCarriers(ids, snapshots)
}

/**
 * The nearest snapshot that can actually CARRY a lane — one with an
 * `emittedFp`, an addressable client identity the client can swap in
 * place. A matched parton without one (a selector-less spec: a layout
 * wrapper, or a cell-bound child like a cart line) has no client slot,
 * so its own lane would render but commit to nothing; the update must
 * ride its nearest addressable ancestor's lane instead — whose render
 * re-renders the subtree containing it, exactly as a whole-tree segment
 * does on the non-lane path. `parentPath` is root-first ending at the
 * immediate parent, so the nearest ancestor is at the tail. Returns
 * `null` when neither the id nor any ancestor is addressable (nothing
 * can carry the update — the caller drops it).
 */
function laneCarrierFor(
  id: string,
  snapshots: ReadonlyMap<string, PartialSnapshot>,
): string | null {
  const snap = snapshots.get(id)
  if (!snap) return null
  if (snap.emittedFp) return id
  for (let i = snap.parentPath.length - 1; i >= 0; i--) {
    const ancestorId = snap.parentPath[i]
    if (ancestorId === id) continue
    if (snapshots.get(ancestorId)?.emittedFp) return ancestorId
  }
  return null
}

/** Map matched ids to their lane carriers (`laneCarrierFor`), dropping
 *  the uncarriable and deduping — several non-addressable children of
 *  one addressable ancestor collapse to a single ancestor lane, so its
 *  one render re-renders them all. First-occurrence order is preserved
 *  (delivery order for the driver's lane pass). Exported for the
 *  driver's bump drain: the pending set holds MATCHED ids; the drain
 *  escalates against snapshots current at render. */
export function _escalateToLaneCarriers(
  matched: Iterable<string>,
  snapshots: ReadonlyMap<string, PartialSnapshot>,
): string[] {
  const carriers: string[] = []
  const seen = new Set<string>()
  for (const id of matched) {
    const carrier = laneCarrierFor(id, snapshots)
    if (carrier === null || seen.has(carrier)) continue
    seen.add(carrier)
    carriers.push(carrier)
  }
  return carriers
}

/**
 * The ids whose snapshots any of `selectors` would touch — the same
 * label + constraint-subset predicate as `_routeMatchingBumpIds`, but
 * against PENDING (un-flushed) selectors instead of registry entries.
 * The action-consequence reservation runs this inside the action's
 * invalidation transaction, before the commit wakes any driver.
 */
export function _routeMatchingSelectorIds(
  snapshots: ReadonlyMap<string, PartialSnapshot>,
  selectors: readonly ParsedSelector[],
): string[] {
  if (selectors.length === 0) return []
  const ids: string[] = []
  for (const [id, snap] of snapshots) {
    const surface = surfaceQueryOf(snap).surface
    const hit = selectors.some(
      (s) => snap.labels.includes(s.name) && _selectorMatchesSurface(s.constraints, surface),
    )
    if (hit) ids.push(id)
  }
  return _escalateToLaneCarriers(ids, snapshots)
}

/**
 * The ids whose snapshots READ one of the changed cookies — snapshots
 * whose tracked-read `deps` include `cookie:<name>` for any `name` in
 * `changed`. The per-parton driver lanes exactly these when a `cookie`
 * frame updates the connection's cookie overlay, so a client cookie
 * change re-renders only the `cookie()` readers (their fp folds the
 * overlay through `parseCookies`), never the whole route.
 *
 * Cookie deps are TRACKED READS, not labels, so they never ride the
 * registry-bump path (`_routeMatchingBumpIds` matches `snap.labels`).
 * That is deliberate: a cookie change is PER-CONNECTION (this client's
 * jar), so it wakes only its own session's driver via the flip-wake arm
 * — never a process-global `refreshSelector` that would spuriously wake
 * every peer connection.
 */
export function _routeMatchingCookieIds(
  snapshots: ReadonlyMap<string, PartialSnapshot>,
  changed: ReadonlySet<string>,
): string[] {
  if (changed.size === 0) return []
  const ids: string[] = []
  for (const [id, snap] of snapshots) {
    const deps = snap.deps
    if (!deps) continue
    for (const name of changed) {
      if (deps.has(`cookie:${name}`)) {
        ids.push(id)
        break
      }
    }
  }
  return ids
}

function constraintSurface(snap: PartialSnapshot): Record<string, unknown> {
  let varyInputs: Record<string, unknown> | null = null
  if (snap.varyKey) {
    try {
      varyInputs = JSON.parse(snap.varyKey) as Record<string, unknown>
    } catch {
      varyInputs = null
    }
  }
  return {
    ...(varyInputs ?? {}),
    ...(snap.constraintArgs ?? {}),
  }
}

/**
 * Per-snapshot memo of the compiled constraint-surface query. The
 * surface's inputs (`varyKey`, `constraintArgs`) are fixed when
 * `PartialBoundary` constructs the snapshot (a re-render registers a
 * FRESH snapshot object), so the varyKey JSON.parse and the probe-key
 * enumeration run once per snapshot — not once per snapshot per bump,
 * which under ticker traffic (hundreds of bumps/sec against hundreds
 * of route snapshots, re-filtered by every held connection's driver)
 * was a standing CPU tax.
 */
const surfaceQueries = new WeakMap<PartialSnapshot, CompiledSurfaceQuery>()

function surfaceQueryOf(snap: PartialSnapshot): CompiledSurfaceQuery {
  let query = surfaceQueries.get(snap)
  if (query === undefined) {
    query = _compileSurfaceQuery(constraintSurface(snap))
    surfaceQueries.set(snap, query)
  }
  return query
}

/** Whether `deps` records `id`'s own cull-gate read
 *  (`visible:<id>?seed=…`) — the snapshot is a cullable spec whose
 *  visibility the session set gates. Shared by the driver's drain-time
 *  park check (`isParkedOnConnection`) and the subscription's
 *  registration-time park gates, so both read the SAME signal. */
export function _hasCullGateDep(deps: ReadonlySet<string> | undefined, id: string): boolean {
  if (!deps) return false
  const prefix = `visible:${id}`
  for (const d of deps) {
    if (d === prefix || d.startsWith(`${prefix}?`)) return true
  }
  return false
}

// ─── The deadline wheel ───────────────────────────────────────────────

/** The deadline wheel's slot grid (ms). Declared `expires()` boundaries
 *  round UP onto this absolute-epoch grid, so independent per-parton
 *  cadences due within one slot share a single timer firing (every
 *  connection's slots align — the grid is epoch-anchored, not
 *  connection-anchored). Bounds a connection's expiry wake rate at
 *  1000/grid regardless of how many cadences the route declares; a
 *  boundary is serviced at most one slot late. */
export const EXPIRY_COALESCE_MS = 25

/**
 * A live connection's deadline wheel — the expiry arm's delivery-side
 * structure (the time twin of the inverted wake index). Maintained by
 * `_syncRouteWakeSubscription`'s pointer-diff: a snapshot's declared
 * `expires()` boundary inserts its id into the boundary's grid slot, a
 * re-render moves it, a drop removes it. ONE standing timer, armed at
 * the head slot, is the connection's whole expiry arm — no per-wake
 * scan ever re-derives "the next deadline"; the head IS the next
 * deadline.
 *
 * A slot firing removes its ids from the wheel and delivers them into
 * the subscription's pending set (`_deliverToWakeSubscription` — the
 * same park gating bumps get: parked carriers record silently, no
 * wake). Removal-at-fire is the dedup: a forever-past-due parked
 * boundary fires exactly once and re-enters the wheel only when a
 * fresh render re-registers its snapshot — for a parked parton, the
 * flip-in revalidation, whose drain is the catch-up.
 *
 * Release discipline: the wheel dies wholesale with its subscription
 * (`_closeRouteWakeSubscription` → `_closeDeadlineWheel` clears the
 * timer and every slot), and a connection whose route declares no
 * boundaries holds no timer at all — the soak's B/wake ≈ 0 invariant.
 */
export interface DeadlineWheel {
  /** slot (absolute grid epoch ms) → ids whose boundary rounds into it. */
  readonly slots: Map<number, Set<string>>
  /** id → its current slot — the move/remove handle, and the oracle's
   *  "still armed" probe. */
  readonly slotOf: Map<string, number>
  /** The head-slot timer (null when the wheel is empty or closed). */
  timer: ReturnType<typeof setTimeout> | null
  /** The slot the timer is armed at (null with no timer). */
  armedSlot: number | null
  closed: boolean
  /** Fires the due ids into the connection's pending set. */
  readonly deliver: (ids: readonly string[]) => void
}

export function _openDeadlineWheel(deliver: (ids: readonly string[]) => void): DeadlineWheel {
  return {
    slots: new Map(),
    slotOf: new Map(),
    timer: null,
    armedSlot: null,
    closed: false,
    deliver,
  }
}

export function _closeDeadlineWheel(wheel: DeadlineWheel): void {
  wheel.closed = true
  if (wheel.timer !== null) clearTimeout(wheel.timer)
  wheel.timer = null
  wheel.armedSlot = null
  wheel.slots.clear()
  wheel.slotOf.clear()
}

/** The grid slot a boundary fires in: rounded UP onto the absolute
 *  grid, and never before the next grid point from `now` — an
 *  already-due boundary (a body that keeps declaring past deadlines)
 *  fires at most once per slot instead of spinning the drain at
 *  event-loop speed, the pacing the retired per-wake arm had. */
function deadlineSlot(expiresAt: number, now: number): number {
  const grid = EXPIRY_COALESCE_MS
  return Math.max(Math.ceil(expiresAt / grid) * grid, Math.floor(now / grid) * grid + grid)
}

/** Insert or move `id`'s boundary; a missing/non-finite boundary
 *  (`undefined`, the `+Infinity` "never" sentinel) removes it. */
export function _scheduleDeadline(
  wheel: DeadlineWheel,
  id: string,
  expiresAt: number | undefined,
): void {
  if (wheel.closed) return
  if (expiresAt === undefined || !Number.isFinite(expiresAt)) {
    _removeDeadline(wheel, id)
    return
  }
  const slot = deadlineSlot(expiresAt, Date.now())
  const prev = wheel.slotOf.get(id)
  if (prev === slot) return
  if (prev !== undefined) detachDeadline(wheel, id, prev)
  wheel.slotOf.set(id, slot)
  let ids = wheel.slots.get(slot)
  if (!ids) {
    ids = new Set()
    wheel.slots.set(slot, ids)
  }
  ids.add(id)
  rearmWheel(wheel)
}

export function _removeDeadline(wheel: DeadlineWheel, id: string): void {
  const slot = wheel.slotOf.get(id)
  if (slot === undefined) return
  wheel.slotOf.delete(id)
  detachDeadline(wheel, id, slot)
  rearmWheel(wheel)
}

function detachDeadline(wheel: DeadlineWheel, id: string, slot: number): void {
  const ids = wheel.slots.get(slot)
  if (!ids) return
  ids.delete(id)
  if (ids.size === 0) wheel.slots.delete(slot)
}

/** Keep the one timer at the head slot. Slot count is bounded by the
 *  route's distinct cadence phases inside the declared horizon, so the
 *  min scan is cheap; it runs only on mutation and at fire, never per
 *  wake. */
function rearmWheel(wheel: DeadlineWheel): void {
  if (wheel.closed) return
  let head: number | null = null
  for (const slot of wheel.slots.keys()) {
    if (head === null || slot < head) head = slot
  }
  if (head === wheel.armedSlot && (head === null || wheel.timer !== null)) return
  if (wheel.timer !== null) clearTimeout(wheel.timer)
  wheel.timer = null
  wheel.armedSlot = head
  if (head === null) return
  wheel.timer = setTimeout(() => fireDueSlots(wheel), Math.max(0, head - Date.now()))
}

function fireDueSlots(wheel: DeadlineWheel): void {
  wheel.timer = null
  wheel.armedSlot = null
  if (wheel.closed) return
  const now = Date.now()
  let due: string[] | null = null
  for (const [slot, ids] of wheel.slots) {
    if (slot > now) continue
    for (const id of ids) {
      ;(due ??= []).push(id)
      wheel.slotOf.delete(id)
    }
    wheel.slots.delete(slot)
  }
  rearmWheel(wheel)
  if (due !== null) wheel.deliver(due)
}

// ─── The route wake subscription ──────────────────────────────────────

/**
 * A live connection's registration into the inverted wake index: one
 * subscription per connection, holding an index entry per route
 * snapshot. `registered` remembers WHICH snapshot object each entry
 * was built from, so a sync is a pointer-diff over the route map —
 * a re-render registers a FRESH snapshot object, and only those ids
 * recompile their surface and re-register.
 */
export interface RouteWakeSubscription {
  readonly sub: WakeSubscription
  /** id → the snapshot object whose surface/carrier is registered. */
  readonly registered: Map<string, PartialSnapshot>
  /** The connection's deadline wheel — declared `expires()` boundaries,
   *  maintained by the same sync diff that registers the index entries;
   *  fires due ids into `sub.pending` through the shared delivery
   *  gate. */
  readonly wheel: DeadlineWheel
}

export function _openRouteWakeSubscription(context: WakeSubscriberContext): RouteWakeSubscription {
  const sub = _openWakeSubscription(context)
  const wheel = _openDeadlineWheel((ids) => _deliverToWakeSubscription(sub, ids))
  return { sub, registered: new Map(), wheel }
}

export function _closeRouteWakeSubscription(rws: RouteWakeSubscription): void {
  _closeDeadlineWheel(rws.wheel)
  _closeWakeSubscription(rws.sub)
  rws.registered.clear()
}

/**
 * Diff the subscription against the route's current snapshots. Runs
 * whenever the driver is awake anyway (lanes open, a wake's drain, a
 * navigation/reconcile segment) — never per bump, which is the point:
 * an idle connection's subscription is exactly as fresh as its last
 * wake, and deliveries against it are exact for every surface
 * registered then.
 *
 * `coveredTs` closes the register-after-bump window: a NEW or REPLACED
 * entry probes the registry once, and a matching bump newer than the
 * driver's cursor seeds the id into the pending set — the record the
 * subscription didn't cover while the bump landed still lanes (a
 * bump the fresh render already folded seeds too; that lane fp-skips
 * to a confirmation — over-fetch, never stale).
 */
export function _syncRouteWakeSubscription(
  rws: RouteWakeSubscription,
  snapshots: ReadonlyMap<string, PartialSnapshot>,
  coveredTs: number,
): void {
  for (const [id, snap] of snapshots) {
    if (rws.registered.get(id) === snap) continue
    const query = surfaceQueryOf(snap)
    const carrier = laneCarrierFor(id, snapshots)
    _setWakeSubscriptionEntry(rws.sub, id, {
      labels: snap.labels,
      query,
      carrier,
      carrierParkGates: carrier === null ? null : carrierParkGates(carrier, snapshots),
    })
    rws.registered.set(id, snap)
    // The wheel rides the same diff: the fresh snapshot's declared
    // boundary is its next wake — insert/move (a re-render's box read
    // is final by sync time: the driver only syncs post-drain).
    _scheduleDeadline(rws.wheel, id, effectiveExpiresAt(snap))
    if (_queryCompiledMatchingTs(snap.labels, query) > coveredTs) {
      _seedWakeSubscriptionPending(rws.sub, id)
    }
  }
  if (rws.registered.size !== snapshots.size) {
    for (const id of [...rws.registered.keys()]) {
      if (!snapshots.has(id)) {
        _removeWakeSubscriptionEntry(rws.sub, id)
        _removeDeadline(rws.wheel, id)
        rws.registered.delete(id)
      }
    }
  }
}

/** The ids whose absence from the session's visible set parks
 *  `carrierId` — its own id when cull-gated, plus every cull-gated
 *  ancestor. The registration-time image of `isParkedOnConnection`'s
 *  drain-time walk (which stays authoritative — a stale gate here
 *  only mis-times a wake, never what lanes). `null` = never parked. */
function carrierParkGates(
  carrierId: string,
  snapshots: ReadonlyMap<string, PartialSnapshot>,
): readonly string[] | null {
  const snap = snapshots.get(carrierId)
  if (!snap) return null
  let gates: string[] | null = null
  if (_hasCullGateDep(snap.deps, carrierId)) (gates ??= []).push(carrierId)
  for (const ancestorId of snap.parentPath) {
    if (ancestorId === carrierId) continue
    const ancestor = snapshots.get(ancestorId)
    if (!ancestor) continue
    if (_hasCullGateDep(ancestor.deps, ancestorId)) (gates ??= []).push(ancestorId)
  }
  return gates
}

// ─── Parity cross-check (opt-in, DEV/tests) ───────────────────────────

let wakeParityCheck = typeof process !== "undefined" && process.env?.PARTON_WAKE_PARITY === "1"

/** Enable/disable the wake-index parity assert — the regression probe
 *  for any wake-path change. Off by default (the oracle re-runs the
 *  retired per-route filter, exactly the cost the index removed);
 *  enabled by the parity rsc suite and via `PARTON_WAKE_PARITY=1`. */
export function _setWakeParityCheck(on: boolean): void {
  wakeParityCheck = on
}

export function _wakeParityCheckEnabled(): boolean {
  return wakeParityCheck
}

/**
 * Assert delivery covers every lane the retired pull model would
 * produce — the staleness direction, and the exact contract: both
 * sides escalate to carriers against the same snapshots and drop
 * PARKED carriers (`isParked`, the drain's own filter), and the
 * pull side's set must be a subset of the delivered one. The contract
 * spans BOTH delivery sources: bumps (the inverted wake index vs the
 * retired per-wake relevance filter) and, when `expiry` is supplied,
 * time boundaries (the deadline wheel vs the retired per-wake
 * `min(expiresAt)` scan).
 *
 * Deliberately NOT strict equality. An id's registered labels can
 * SHRINK between delivery and drain — a cull-out re-registers the
 * id's CULLED variant, whose labels drop the cell labels — so a
 * delivered id can stop matching the filter by drain time. Those
 * extras are harmless by construction: the id is parked (dropped
 * here, exactly as the drain drops it) or was flipped back in, where
 * its lane renders CURRENT state and dedups with the flip's own lane
 * — an over-fetch, never staleness. The filter itself is equally
 * time-inconsistent in the other direction (it re-matches old bumps
 * against snapshots registered after them — which the sync's
 * covered-record probe mirrors), so post-park subset IS the lane-set
 * equivalence. `delivered` ids whose snapshot vanished drop at
 * escalation on both sides.
 *
 * The expiry side's expected set is every snapshot whose declared
 * boundary elapsed (`expiresAt <= now`) and is not otherwise COVERED —
 * `covered(id)` states the legitimate non-delivery holds: the id is
 * still armed in the wheel (fires at most one slot late), its lane is
 * open (the in-flight render is the service; its drain re-arms the
 * wheel), it is deferred behind the unacked delivery window (the
 * freeing ack's drain lanes it), or this wake's flip/cookie worklist
 * already carries it. What remains must be in the delivered set —
 * a due boundary absent from both the wheel and the pending set is a
 * lost deadline, exactly the under-delivery the oracle exists to
 * catch.
 */
export function _assertWakeParity(
  snapshots: ReadonlyMap<string, PartialSnapshot>,
  sinceTs: number,
  delivered: ReadonlySet<string>,
  isParked: (id: string) => boolean,
  expiry?: {
    /** Wall clock the due set is derived at. */
    now: number
    /** The legitimate non-delivery holds for a due id (see above). */
    covered: (id: string) => boolean
  },
): void {
  const expected = _routeMatchingBumpIds(snapshots, sinceTs).filter((id) => !isParked(id))
  if (expiry !== undefined) {
    const due: string[] = []
    for (const [id, snap] of snapshots) {
      const exp = effectiveExpiresAt(snap)
      if (exp === undefined || !Number.isFinite(exp) || exp > expiry.now) continue
      if (expiry.covered(id)) continue
      due.push(id)
    }
    for (const id of _escalateToLaneCarriers(due, snapshots)) {
      if (isParked(id) || expiry.covered(id) || expected.includes(id)) continue
      expected.push(id)
    }
  }
  const present: string[] = []
  for (const id of delivered) if (snapshots.has(id)) present.push(id)
  const actual = new Set(_escalateToLaneCarriers(present, snapshots).filter((id) => !isParked(id)))
  const missing = expected.filter((id) => !actual.has(id))
  if (missing.length === 0) return
  throw new Error(
    `wake-parity violation — the pull model would lane [${missing.join(", ")}] ` +
      `but delivery holds [${[...actual].join(", ")}]`,
  )
}
