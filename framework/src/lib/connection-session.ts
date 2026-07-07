/**
 * Connection-session state — per-live-connection server state, keyed
 * by the SERVER-MINTED connection id the segment driver creates for
 * each `?live=1` stream it drives and ships downstream as the
 * stream's `conn` entry (see [[fp-trailer-marker]]).
 *
 * A live connection is long-lived (the segment driver parks it between
 * wakes), and some request dimensions move WHILE it is open. The first
 * such dimension is the viewport-visibility set behind the spec-level
 * `cull` option: the client states flips as `visible` frames on
 * channel envelopes ([[channel-protocol]]), the statement updates the
 * session's `visible` set, and the segment driver treats the flipped
 * ids like an invalidation wake — rendering them as lanes on the
 * EXISTING stream. The session's set IS part of the connection's
 * request state: the cull gate and the fingerprint fold's
 * store-and-reread both read it (session first, `?visible=` URL param
 * as the no-session fallback), so the read stays request-reproducible
 * — every re-evaluation during one wake agrees on the same set, and
 * every change to the set arrives with an explicit wake naming the ids
 * it flipped.
 *
 * Lifecycle: the segment driver mints the id and opens the session
 * when it starts driving a `?live=1` response (seeding `visible` from
 * the attach statement's seed, so the whole-tree first segment
 * already renders against the client's measured set; binding the
 * attach's scope + session identity for the envelope checks below) and
 * closes it when the drive loop exits (keepalive elapsed, client
 * abort, detach frame). An envelope for an unknown id answers `404` —
 * the explicit "this connection is gone" signal the client transport
 * falls back on.
 *
 * ── The channel endpoint ────────────────────────────────────────────
 * `handleChannelPost` is the body of `POST /__parton/channel`. Unlike
 * a render request it does no render — but it RUNS inside
 * `runWithRequestAsync` (the entry wraps it): a lightweight request
 * scope where the test scope resolves through the ALS and where a
 * channel interaction could mint Set-Cookie (the held stream's headers
 * are long gone by the time a frame arrives — this response is the one
 * place cookies can land). Three checks gate every envelope:
 *
 *   - Same-origin: `Origin` / `Sec-Fetch-Site` must not testify
 *     cross-site (`403`) — the JSON content-type is not a defense.
 *   - Scope binding: the envelope's resolved scope must equal the
 *     attach's. Isolation is the globally-unique connection id, never
 *     the scope; the scope check is an assert, and a mismatch answers
 *     `404`, not a cross-scope lookup.
 *   - Cookie binding: the envelope must carry the same session
 *     identity the attach carried (beacons carry cookies anyway).
 *     Anonymous pages bind to the empty identity. A mismatch answers
 *     `404` — indistinguishable from "connection gone", so a hostile
 *     beacon can't probe which of the two it hit.
 */

import { _setAttachStatement, getScope } from "../runtime/context.ts";
import { getSessionId, setSessionFrameUrl } from "../runtime/session.ts";
import {
	type AckFrame,
	type AttachStatement,
	type CancelFrame,
	type ChannelEnvelope,
	decodeAttachStatement,
	decodeChannelEnvelope,
	type TelemetryFrame,
	type UrlFrame,
	type VisibleFrame,
} from "./channel-protocol.ts";

/**
 * One pending flip — a statement about a single id, queued until the
 * segment driver drains it. A flip resolves against ITS OWN frame's
 * testimony, never against a later frame's `visible` snapshot:
 * mid-scroll bursts legitimately dip the snapshot (old chunks exit
 * before new skeletons mount and testify), the client states each
 * flip exactly once, and resolving an earlier in-flip against a later
 * dip would drop it forever. Only an explicit later statement about
 * the SAME id replaces a pending one.
 */
export interface PendingFlip {
	/** The statement: `true` when the id was in THAT frame's `visible`
	 *  snapshot (an in-flip — the driver lanes it), `false` when it
	 *  wasn't (an out-flip — the session-set update the frame already
	 *  applied is its entire server-side effect). */
	readonly inView: boolean;
	/** Envelope seq of the statement. A newer statement about the same
	 *  id replaces a pending one; a stale one (an older envelope
	 *  landing late) is discarded — the last statement about an id
	 *  wins, ordered by seq. */
	readonly seq: number;
	/** The client's cached tokens (`id:matchKey:fp`) for the id as of
	 *  the statement — its ACTUAL holdings, which the driver swaps into
	 *  the connection's cached override before the flip's lane renders
	 *  (see the `visible` frame's `cached` field). `undefined` when the
	 *  frame made no holdings statement (the override stays as
	 *  promoted). Consumed with the flip; a flip that defers past its
	 *  frame drops its tokens (they would be stale by the time the
	 *  deferred lane runs). */
	readonly cached?: readonly string[];
}

/**
 * The connection's latest viewport telemetry — a `telemetry` frame's
 * content plus the two facts the server adds: when it arrived
 * (`receivedAt`, this process's clock — the only clock a projection
 * can extrapolate on) and which envelope stated it (`seq`, the
 * newest-wins gate). Latest-wins, no history: the slot is CONTEXT the
 * server may consult (the segment driver's predictive warm pass is
 * the first consumer), never a dependency — updating it fires no
 * invalidation and no wake, and must never cause a render.
 */
/**
 * A latched `url` frame — the client's window URL statement, queued
 * until the segment driver consumes it at wait entry (navigation-first,
 * ahead of pending flips). Newest seq wins: a fresher statement about
 * the URL replaces an unconsumed older one — the older navigation was
 * superseded before the driver ever saw it, and rendering it would
 * only produce a segment the client's as-of guard drops. The driver's
 * mid-render supersede (a newer frame latching WHILE a navigation
 * segment renders) is the same replacement observed from inside the
 * render — the internal seam the explicit cancel frame kind will share.
 */
export interface PendingNavigation {
	/** Target as path + search, same-origin-validated at the endpoint. */
	readonly url: string;
	readonly intent: UrlFrame["intent"];
	/** Envelope seq of the statement — the client's navigation point,
	 *  and the AS-OF value every post-consume emission carries. */
	readonly seq: number;
}

/**
 * A latched FRAME url statement — a `url` frame carrying a `frame`
 * path, queued per frame key until the segment driver consumes it.
 * The statement's session-frame-URL write already happened at the
 * endpoint (the same `setSessionFrameUrl` store `?__frame=` writes
 * through — the endpoint response is also where a fresh session
 * cookie can mint); the driver's consume is the RENDER half: lane the
 * frame's targets explicit on the open region. Newest seq per key
 * wins; a seq at or below the key's consumed seq is a stale
 * restatement (retransmit idempotence).
 */
export interface PendingFrameNavigation {
	/** Dotted frame key (`"cart"`, `"products.list"`). */
	readonly key: string;
	/** Frame target as path + search. */
	readonly url: string;
	readonly intent: UrlFrame["intent"];
	/** Envelope seq of the statement — the AS-OF its covering lanes
	 *  carry, and the client's correlation for the fire's milestones. */
	readonly seq: number;
}

export interface SessionTelemetry {
	readonly viewport: { readonly w: number; readonly h: number };
	readonly scroll: {
		readonly x: number;
		readonly y: number;
		readonly vx: number;
		readonly vy: number;
	};
	/** The client's performance-clock ms at measurement. */
	readonly at: number;
	/** Server clock (ms epoch) when the statement was applied. */
	readonly receivedAt: number;
	/** Envelope seq of the statement — the newest-wins gate. */
	readonly seq: number;
}

export interface ConnectionSession {
	readonly id: string;
	/** Request scope the connection attached under (`"default"` in
	 *  prod; the per-worker test scope in dev). Envelopes must resolve
	 *  the same scope — the assert-and-404 above. */
	readonly scope: string;
	/** Session identity bound at attach — `getSessionId() ?? ""` as of
	 *  the attach request. The empty string IS an identity (the
	 *  anonymous page); every envelope must present the same one. The
	 *  attach is the explicit rebind point: every attach binds its own
	 *  request's identity fresh, so a session cookie minted
	 *  mid-connection (an action's `ensureSessionId`) fails the check —
	 *  the transport's 404 fallback covers the gap — until the next
	 *  attach carries the new cookie and envelopes work again. One
	 *  exception rebinds in place: a session id the ENDPOINT itself
	 *  mints while applying a frame url statement for an anonymous
	 *  binding (see `applyFrameUrlFrame`) — the same principal, handed
	 *  its identity on this very response. */
	boundSessionId: string;
	/** The connection's current visible set. `null` until the request's
	 *  `?visible=` seed or the first statement — the pre-measurement
	 *  state, in which reads fall back to the request URL (absent →
	 *  `undefined`, the cull gate's cold token). Replaced wholesale per
	 *  statement — and by the driver when it consumes an in-flip
	 *  statement the latest snapshot dipped below (the lane ships the
	 *  in-state, so the connection's knowledge for that id is "in
	 *  view"). Always replaced, never mutated in place, so a render
	 *  that grabbed the reference mid-statement keeps a consistent
	 *  view. */
	visible: ReadonlySet<string> | null;
	/** Last applied envelope seq — the stale-envelope gate for
	 *  `visible`. */
	lastSeq: number;
	/** Flipped ids awaiting a lane render, each carrying its
	 *  statement. The driver drains via `takeConnectionFlips`.
	 *  Insertion order is delivery order — frames send in-view flips
	 *  first, so lanes for the visible world start before stale
	 *  cull-outs'. */
	readonly pendingFlips: Map<string, PendingFlip>;
	/** The segment driver's channel wake arm: an applied frame notifies
	 *  every registered listener. The driver registers one per park and
	 *  removes it when the park ends (the wake-arm release invariant —
	 *  a long-idle connection holds at most one entry here). A frame
	 *  landing while the driver is busy has no listener to fire; its
	 *  effects sit on the session (`pendingFlips`, `detached`), which
	 *  the driver's wait-entry checks consume before the next park — no
	 *  statement vanishes. */
	readonly flipWakes: Set<() => void>;
	/** An explicit `detach` frame arrived — the client is gone. The
	 *  drive loop exits at its next wake (the frame fires the wake
	 *  arms) instead of holding the stream for the keepalive. */
	detached: boolean;
	/** Last minted DELIVERY seq — the per-connection monotonic counter
	 *  every payload segment and lane emission carries as its `seq`
	 *  entry (the ack currency). Minted by the driver at emission. */
	deliverySeq: number;
	/** Highest cumulative delivery seq the client has COMMITTED (`ack`
	 *  frames). `deliverySeq - ackedDeliverySeq` is the unacked window
	 *  the driver gates lane opening on. */
	ackedDeliverySeq: number;
	/** An `ack` frame — ANY ack frame — has arrived on this connection.
	 *  The duplex proof: a connection whose first delivery settled
	 *  without this ever flipping is degraded (never-acked) instead of
	 *  held behind a window that can never free. */
	firstAckReceived: boolean;
	/** Unacked emissions' holdings: delivery seq → the `(id, fp)` pairs
	 *  that emission carried, plus the navigation point it was rendered
	 *  as-of (the fold gate below). Folded into `ackedFps` (and dropped)
	 *  when the client's cumulative ack covers the seq; dies with the
	 *  connection otherwise. Bounded by the unacked delivery window —
	 *  the same signal that stops new lanes stops new records. */
	readonly pendingDeliveries: Map<
		number,
		{
			readonly tokens: ReadonlyArray<readonly [string, string]>;
			readonly asOf: number;
		}
	>;
	/** The mirror's ACKED layer: fps whose delivering emission the
	 *  client COMMITTED — client-proven holdings, consulted by the
	 *  fp-skip verdict on an optimistic-layer miss. Per-id sets capped
	 *  at `OVERRIDE_SET_CAP` like the optimistic layer's; resets with
	 *  the connection (reattach seeds the mirror from the attach
	 *  manifest and nothing else — the manifest IS the durable
	 *  evidence). A flip statement's `cached` tokens replace an id's
	 *  entry here too: the client's own attestation supersedes every
	 *  layer (acks report what the client GAINED, never what it
	 *  evicted — the flip statement is the eviction evidence). */
	readonly ackedFps: Map<string, Set<string>>;
	/** Highest upstream envelope seq applied on this connection. Seeded
	 *  from the attach statement's `applied` watermark (the client's
	 *  page-lifetime seq timeline — see [[channel-protocol]]); advanced
	 *  by every applied envelope. Arrival order is seq order because the
	 *  client transport serializes envelopes, so the max IS the
	 *  contiguous watermark. */
	appliedSeq: number;
	/** The `appliedSeq` value last shipped downstream as an `applied`
	 *  marker. The driver announces at its next wake whenever
	 *  `appliedSeq` has moved past this. */
	announcedAppliedSeq: number;
	/** When the connection's FIRST delivery-seq'd emission fully drained
	 *  onto the wire (`null` until one has). The anchor of the client's
	 *  ack obligation: from this moment a committing client's first ack
	 *  is at most one RTT + decode + rAF away, so the never-acked
	 *  degrade deadline measures from here — never from connection age. */
	firstDeliverySettledAt: number | null;
	/** The connection is DEGRADED — the driver stops holding (the drive
	 *  loop exits after settle) and the stream closes. Set with the
	 *  reason (`"never-acked"` today) when the first-ack deadline
	 *  elapses with `firstAckReceived` still false. */
	degradedReason: string | null;
	/** Latest viewport telemetry, or `null` before any statement.
	 *  Replaced wholesale per statement (newest-wins by envelope seq);
	 *  applying one is side-effect-free — see [[SessionTelemetry]]. */
	telemetry: SessionTelemetry | null;
	/** Latched window URL statement awaiting the driver — see
	 *  [[PendingNavigation]]. `null` when the request state reflects
	 *  every url frame heard so far. */
	pendingNav: PendingNavigation | null;
	/** Latched FRAME url statements awaiting the driver, keyed by frame
	 *  key (newest seq per key wins) — see [[PendingFrameNavigation]].
	 *  Drained via `takeConnectionFrameNavs`. */
	readonly pendingFrameNavs: Map<string, PendingFrameNavigation>;
	/** Highest consumed url-statement seq per frame key — the stale-
	 *  restatement gate for frame urls (the per-key twin of
	 *  `consumedNavSeq`). Advanced at consume. */
	readonly consumedFrameNavSeqs: Map<string, number>;
	/** Highest applied `cancel` seq per scope — the retransmit-
	 *  idempotence gate: a cancel at or below its scope's recorded seq
	 *  applies as a no-op, so a replayed cancel can never abort a newer
	 *  statement's render. */
	readonly cancelSeqByScope: Map<string, number>;
	/** The driver's cancel arm: an applied `cancel` frame calls every
	 *  registered listener with its scope, synchronously at apply — the
	 *  driver aborts the scope's open lane renders there (the same
	 *  reach the window supersede's nav-latch arm has into a suspended
	 *  render). Disposer-registered for the drive's lifetime. */
	readonly cancelListeners: Set<(scope: string) => void>;
	/** Route key of the request state this connection currently renders
	 *  — set at open, moved by the driver at a window-navigation
	 *  consume. What an action's consequence reservation resolves the
	 *  route snapshots through (the driver isn't on the stack there). */
	routeKey: string | null;
	/** Delivery seqs assigned AHEAD of their lane render — an action's
	 *  consequence reservation (`_reserveActionConsequences` in
	 *  [[segmented-response]]): minted inside the action's invalidation
	 *  transaction, BEFORE the bump wakes the driver, so the covering
	 *  lane's seq is known when the action response returns. The pump
	 *  takes an id's assignment at iteration start; a skip path that
	 *  drops the id voids it instead (`voidSeqs`). Re-reserving an id
	 *  with an unconsumed assignment reuses it — one render of the
	 *  latest state covers both writes. */
	readonly assignedLaneSeqs: Map<string, number>;
	/** Assigned-but-never-emitted delivery seqs — a reservation whose
	 *  lane was skipped (parked flip, snapshot gone, navigation tear).
	 *  The driver flushes them as a `seqvoid` entry at its next
	 *  emission point; the client counts each PROCESSED so the
	 *  contiguous ack watermark can pass them (a silent gap would wedge
	 *  the unacked window and hold every consequence gate forever). */
	readonly voidSeqs: Set<number>;
	/** Highest url-frame seq LATCHED on this session (advanced at
	 *  envelope apply, ahead of the driver's consume). The ack fold
	 *  gate: a pending delivery whose `asOf` predates this was — or by
	 *  protocol will be — dropped by the client (its as-of guard uses
	 *  the same two numbers), so its ack frees the window WITHOUT
	 *  folding its fps into the acked layer. Genuinely-held pre-nav
	 *  commits whose ack arrives after the latch are discarded too —
	 *  conservative: an over-fetch, never a phantom holding. */
	statedNavSeq: number;
	/** Seq of the last url frame the driver APPLIED to the connection's
	 *  request state — the AS-OF every emission carries (`0` = the
	 *  attach's own request state, before any navigation). Advanced only
	 *  at consume time, never at latch: an emission between latch and
	 *  consume still rendered the pre-navigation state and must say so. */
	consumedNavSeq: number;
}

/** Per-id bound on every mirror layer's fp / matchKey sets — the
 *  server-side twin of the client's `FP_CAP_PER_VARIANT`: a live
 *  parton drifting every lane (each bump folds a fresh invalidation
 *  ts) would grow its set unboundedly over a long-held connection.
 *  Oldest-first eviction keeps the newest few — enough for the next
 *  render's skip check; an evicted entry only costs an over-fetch,
 *  never staleness. */
export const OVERRIDE_SET_CAP = 8;

export function capOverrideSet(set: Set<string>): void {
	while (set.size > OVERRIDE_SET_CAP) {
		const oldest = set.values().next().value;
		if (oldest === undefined) break;
		set.delete(oldest);
	}
}

// Survives dev-server module re-evaluation: a held live connection's
// driver keeps the store instance it opened its session in, while the
// channel endpoint resolves this module fresh per edit — both must
// address the SAME map, or every envelope answers `404` (forcing the
// discrete fallback) until the heartbeat's next reopen and the
// driver's sessions leak in the abandoned instance. globalThis keying
// is inert in production: one evaluation per process.
const sessions = ((
	globalThis as Record<string, unknown>
).__partonConnectionSessions ??= new Map<string, ConnectionSession>()) as Map<
	string,
	ConnectionSession
>;

/** Open (register) a session for a live connection. Called by the
 *  segment driver before its first segment renders, so an envelope can
 *  land at any point of the connection's lifetime. `binding` carries
 *  the attach's scope + session identity for the envelope checks;
 *  omitted (session-level tests) it binds the default scope and the
 *  anonymous identity. */
export function _openConnectionSession(
	id: string,
	initialVisible: ReadonlySet<string> | null,
	binding?: { scope?: string; sessionId?: string; applied?: number },
): ConnectionSession {
	const session: ConnectionSession = {
		id,
		scope: binding?.scope ?? "default",
		boundSessionId: binding?.sessionId ?? "",
		visible: initialVisible,
		lastSeq: 0,
		pendingFlips: new Map(),
		flipWakes: new Set(),
		detached: false,
		deliverySeq: 0,
		ackedDeliverySeq: 0,
		firstAckReceived: false,
		pendingDeliveries: new Map(),
		ackedFps: new Map(),
		// The attach statement's upstream watermark seeds both sides of
		// the applied gate: the client's envelope seqs are page-lifetime,
		// so the new session continues the one timeline instead of
		// restarting an ambiguous one, and the marker never announces
		// below what the client already heard.
		appliedSeq: binding?.applied ?? 0,
		announcedAppliedSeq: binding?.applied ?? 0,
		firstDeliverySettledAt: null,
		degradedReason: null,
		telemetry: null,
		pendingNav: null,
		pendingFrameNavs: new Map(),
		consumedFrameNavSeqs: new Map(),
		cancelSeqByScope: new Map(),
		cancelListeners: new Set(),
		routeKey: null,
		assignedLaneSeqs: new Map(),
		voidSeqs: new Set(),
		statedNavSeq: 0,
		consumedNavSeq: 0,
	};
	sessions.set(id, session);
	return session;
}

/**
 * Record an emission's holdings against its delivery seq — the `(id,
 * fp)` pairs a payload segment or lane carried, captured by the driver
 * at the same walk that promotes them into the optimistic layer, plus
 * the navigation point the emission was rendered as-of. When the
 * client's cumulative ack covers the seq, the pairs fold into the
 * ACKED layer and the record dies — gated on the as-of (see
 * `statedNavSeq`): a delivery the client's navigation point dropped
 * must never become acked evidence. A record whose seq the client
 * already acked (the ack raced the driver's post-drain bookkeeping)
 * folds immediately instead of pending forever, through the same gate.
 */
export function _recordDelivery(
	session: ConnectionSession,
	seq: number,
	tokens: ReadonlyArray<readonly [string, string]>,
	asOf = 0,
): void {
	if (seq <= session.ackedDeliverySeq) {
		if (asOf >= session.statedNavSeq) foldAckedTokens(session, tokens);
		return;
	}
	session.pendingDeliveries.set(seq, { tokens, asOf });
}

function foldAckedTokens(
	session: ConnectionSession,
	tokens: ReadonlyArray<readonly [string, string]>,
): void {
	for (const [id, fp] of tokens) {
		let set = session.ackedFps.get(id);
		if (!set) {
			set = new Set();
			session.ackedFps.set(id, set);
		}
		set.add(fp);
		capOverrideSet(set);
	}
}

/**
 * Apply an `ack` frame: the client states its highest contiguously
 * COMMITTED delivery seq. Any ack frame — advancing or not — is the
 * duplex proof (`firstAckReceived`). An advancing ack folds the covered
 * pending deliveries into the ACKED layer and frees the unacked window;
 * the caller fires the wake arms so a driver parked behind the window
 * re-evaluates. Cumulative: a stale or duplicate ack is a no-op — the
 * watermark only moves forward.
 */
function applyAckFrame(session: ConnectionSession, frame: AckFrame): boolean {
	session.firstAckReceived = true;
	if (frame.delivered <= session.ackedDeliverySeq) return false;
	session.ackedDeliverySeq = frame.delivered;
	for (const [seq, record] of session.pendingDeliveries) {
		if (seq <= frame.delivered) {
			// The as-of fold gate: an acked delivery rendered before the
			// latest latched navigation is one the client PROCESSED (the ack
			// keeps the watermark contiguous and frees the window) but does
			// not HOLD — its commit was dropped at the client's navigation
			// point, by the same asOf-vs-navSeq comparison. Discard without
			// folding; the record's freeing role is complete.
			if (record.asOf >= session.statedNavSeq) {
				foldAckedTokens(session, record.tokens);
			}
			session.pendingDeliveries.delete(seq);
		}
	}
	return true;
}

/** Unregister a session — the drive loop exited; the stream is closed
 *  or closing. Envelopes for the id now answer `404`. */
export function _closeConnectionSession(id: string): void {
	sessions.delete(id);
}

/** Look up an OPEN session by its minted id — the rsc harness's window
 *  into per-connection state (ack watermarks, the acked mirror layer,
 *  the degrade reason). `undefined` once the drive loop has closed
 *  it. */
export function _peekConnectionSession(
	id: string,
): ConnectionSession | undefined {
	return sessions.get(id);
}

/**
 * Apply a visibility statement to its connection. Returns `false` when
 * no session holds the id (connection closed / never opened) — the
 * caller's explicit fallback signal.
 *
 * `visible` replaces the session set only from statements at or past
 * the last applied envelope (`seq` gate — `>=`, so a later frame in
 * the SAME envelope stands, while a stale envelope can't regress a
 * newer set). `changed` ids queue into `pendingFlips` carrying the
 * statement's OWN testimony about each id — its presence in THIS
 * frame's snapshot — because that testimony, not the latest set, is
 * what the flip resolves against (see [[PendingFlip]]). A superseded
 * envelope's flips still queue (they still need their lane render);
 * per id, the statement with the highest seq stands. Always notifies
 * the flip wakes so a parked driver re-evaluates.
 */
export function reportConnectionVisibility(
	id: string,
	seq: number,
	changed: readonly string[],
	visible: readonly string[],
	cached?: readonly string[],
): boolean {
	const session = sessions.get(id);
	if (!session) return false;
	const inView = new Set(visible);
	for (const c of changed) {
		const prior = session.pendingFlips.get(c);
		if (prior !== undefined && seq < prior.seq) continue;
		session.pendingFlips.set(c, {
			inView: inView.has(c),
			seq,
			// The client's holdings for this flip. An EMPTY list is a
			// statement ("I hold nothing for this id" — the flip's lane must
			// render rather than confirm a phantom copy); an ABSENT `cached`
			// makes no statement and leaves the override as promoted.
			cached:
				cached === undefined
					? undefined
					: cached.filter((t) => t.startsWith(`${c}:`)),
		});
	}
	if (seq >= session.lastSeq) {
		session.lastSeq = seq;
		session.visible = new Set(visible);
	}
	for (const wake of [...session.flipWakes]) wake();
	return true;
}

/** Drain the session's pending flips — id → the statement it resolves
 *  against. A statement landing right after the drain re-queues into
 *  `pendingFlips`, which the driver's wait-entry check consumes
 *  before its next park — no statement vanishes into a consumed
 *  wake. */
export function takeConnectionFlips(
	session: ConnectionSession,
): Map<string, PendingFlip> {
	const flips = new Map(session.pendingFlips);
	session.pendingFlips.clear();
	return flips;
}

/**
 * Latch a `url` frame on its session. Newest statement wins (`>=` so a
 * later frame in the SAME envelope stands); a frame at or below the
 * consumed navigation seq is a stale restatement (a retransmit whose
 * navigation the request state already reflects) and applies as a
 * no-op — the per-kind idempotence contract. The latch also advances
 * `statedNavSeq` (the ack fold gate) IMMEDIATELY: an ack in the same
 * envelope was computed by a client whose navigation point was already
 * set when the url statement was created, so the gate must see the
 * statement first (`handleChannelPost` latches url frames ahead of the
 * in-order pass for the same reason). Always wakes the driver — the
 * navigation is the highest-priority latch at wait entry.
 */
function applyUrlFrame(
	session: ConnectionSession,
	seq: number,
	frame: UrlFrame,
	requestUrl: string,
): void {
	if (seq > session.statedNavSeq) session.statedNavSeq = seq;
	if (seq <= session.consumedNavSeq) return;
	if (session.pendingNav !== null && seq < session.pendingNav.seq) return;
	// Reduce to path + search on the session's own timeline — the origin
	// was validated against the envelope's request; the driver re-resolves
	// against ITS request at consume time.
	const target = new URL(frame.url, requestUrl);
	session.pendingNav = {
		url: target.pathname + target.search,
		intent: frame.intent,
		seq,
	};
}

/** Consume the session's latched navigation — the driver's wait-entry
 *  take (navigation-first, ahead of `takeConnectionFlips`). A newer
 *  frame latching right after the take re-queues into `pendingNav`,
 *  which both the mid-render supersede watch and the next wait entry
 *  observe — no statement vanishes. */
export function takeConnectionNavigation(
	session: ConnectionSession,
): PendingNavigation | null {
	const nav = session.pendingNav;
	session.pendingNav = null;
	return nav;
}

/**
 * Apply a FRAME-scoped url statement. Two halves, split by where the
 * state lives:
 *
 *   - The session frame URL is COOKIE-BACKED shared state, written
 *     HERE — inside the envelope's own request scope, where the
 *     client's `__frame_sid` cookie resolves and a freshly-minted
 *     session cookie can ride the endpoint's `204` (the one channel
 *     response that can carry Set-Cookie). This is the same store the
 *     discrete `?__frame=` param writes through in `PartialRoot`.
 *   - The RENDER latches per frame key for the driver
 *     (`pendingFrameNavs`), which lanes the frame's targets on the
 *     open region at its next wake.
 *
 * Newest seq per key wins; a seq at or below the key's consumed seq
 * is a stale restatement and applies as a no-op — including the
 * session write, so a retransmit can never regress a newer frame URL.
 */
function applyFrameUrlFrame(
	session: ConnectionSession,
	seq: number,
	frame: UrlFrame,
	framePath: readonly string[],
	requestUrl: string,
): void {
	const key = framePath.join(".");
	if (seq <= (session.consumedFrameNavSeqs.get(key) ?? 0)) return;
	const prior = session.pendingFrameNavs.get(key);
	if (prior !== undefined && seq < prior.seq) return;
	const target = new URL(frame.url, requestUrl);
	const url = target.pathname + target.search;
	setSessionFrameUrl(framePath, url);
	// A cookie-less page's first frame statement mints the session id
	// right here (`ensureSessionId` inside the endpoint's scope — the
	// `204` carries the Set-Cookie). Rebind the connection to the
	// identity it just handed this same client; without the rebind
	// every subsequent envelope would 404 against the stale anonymous
	// binding until the next attach.
	if (session.boundSessionId === "") {
		session.boundSessionId = getSessionId() ?? "";
	}
	session.pendingFrameNavs.set(key, { key, url, intent: frame.intent, seq });
}

/** Drain the session's latched frame navigations — key → newest
 *  statement. A statement landing right after the drain re-queues;
 *  the driver's wait-entry check consumes it before the next park. */
export function takeConnectionFrameNavs(
	session: ConnectionSession,
): Map<string, PendingFrameNavigation> {
	const navs = new Map(session.pendingFrameNavs);
	session.pendingFrameNavs.clear();
	return navs;
}

/**
 * Apply a `cancel` frame: fire the driver's cancel listeners with the
 * scope so the scope's open lane renders abort — synchronously at
 * apply, the same immediacy the window supersede has through the
 * nav-latch arm. Gated per scope by seq (`>` — a retransmitted cancel
 * at or below the recorded seq is a no-op, so a replay can never
 * abort a render a NEWER statement started). The frame-url statement
 * that supersedes rides the SAME envelope after its cancel (frames
 * are ordered within the envelope), so the in-order pass gives
 * cancel-then-url.
 */
function applyCancelFrame(
	session: ConnectionSession,
	seq: number,
	frame: CancelFrame,
): void {
	if (seq <= (session.cancelSeqByScope.get(frame.scope) ?? 0)) return;
	session.cancelSeqByScope.set(frame.scope, seq);
	for (const listener of [...session.cancelListeners]) listener(frame.scope);
}

/**
 * Apply a `telemetry` frame: replace the session's telemetry slot,
 * newest-wins by envelope seq (a stale envelope landing late cannot
 * regress a fresher statement; `>=` so a later frame in the SAME
 * envelope stands). Deliberately fires NO wake and records NO
 * invalidation — the design invariant: the channel carries freshness
 * statements, and telemetry is CONTEXT, not a dependency. Telemetry
 * alone must never cause a render; consumers (the segment driver's
 * warm pass) read the slot when they are awake for their own reasons.
 */
function applyTelemetryFrame(
	session: ConnectionSession,
	seq: number,
	frame: TelemetryFrame,
): void {
	if (session.telemetry !== null && seq < session.telemetry.seq) return;
	session.telemetry = {
		viewport: frame.viewport,
		scroll: frame.scroll,
		at: frame.at,
		receivedAt: Date.now(),
		seq,
	};
}

/** Apply a `detach` frame: mark the session and fire the wake arms so
 *  the parked driver exits its drive loop (which closes the session)
 *  instead of holding the stream for the keepalive. Best-effort by
 *  nature — a lost detach leaves the keepalive timeout as the
 *  backstop. */
function detachConnectionSession(session: ConnectionSession): void {
	session.detached = true;
	for (const wake of [...session.flipWakes]) wake();
}

/**
 * Decode an attach POST's body into its statement and stash it on the
 * request store — the one seam both the entry (`createRscHandler`) and
 * the in-process live-drive harness bind an attach through, so the
 * driver's statement reads see identical state on both paths. Runs
 * inside `runWithRequestAsync`; returns `null` on a malformed body
 * (the entry answers `400` — a protocol violation, like a malformed
 * known-kind frame).
 */
export async function applyAttachStatement(
	request: Request,
): Promise<AttachStatement | null> {
	let decoded: AttachStatement | null;
	try {
		decoded = decodeAttachStatement(await request.json());
	} catch {
		return null;
	}
	if (decoded !== null) _setAttachStatement(decoded);
	return decoded;
}

/**
 * True when the request's browser-stated provenance is same-origin.
 * `Sec-Fetch-Site` is the primary signal (`same-origin`; `none` is a
 * non-site initiation); a present `Origin` must equal the request's
 * own. Requests carrying NEITHER header (non-browser clients, the
 * in-process test harness) pass — the cookie binding is the
 * credential check; this check exists to stop cross-site pages from
 * riding a victim's cookies onto the endpoint.
 */
function isSameOriginPost(request: Request): boolean {
	const site = request.headers.get("sec-fetch-site");
	if (site !== null && site !== "same-origin" && site !== "none") return false;
	const origin = request.headers.get("origin");
	if (origin !== null) {
		try {
			if (new URL(origin).origin !== new URL(request.url).origin) return false;
		} catch {
			return false;
		}
	}
	return true;
}

/**
 * The framework endpoint body for `POST /__parton/channel` — decode,
 * check, dispatch. Runs inside `runWithRequestAsync` (the entry wraps
 * it): `getScope()` / `getSessionId()` read this envelope's own
 * request. `204` (no body) on success: every rendered consequence
 * travels down the live stream as lanes, never on this response.
 * `403` on cross-site provenance. `400` on a malformed envelope, a
 * malformed known-kind frame (unknown kinds are skipped by the
 * decoder, not errors), or a `url` frame naming a cross-origin target
 * — a violation, and nothing from the envelope applies. `404` when the connection isn't open OR the
 * envelope's scope / session identity doesn't match the attach's —
 * one indistinguishable "connection gone" answer, the client
 * transport's signal to fall back to the discrete path.
 */
export async function handleChannelPost(request: Request): Promise<Response> {
	if (!isSameOriginPost(request)) return new Response(null, { status: 403 });
	let envelope: ChannelEnvelope;
	try {
		const decoded = decodeChannelEnvelope(await request.json());
		if (decoded === null) return new Response(null, { status: 400 });
		envelope = decoded;
	} catch {
		return new Response(null, { status: 400 });
	}
	const session = sessions.get(envelope.connection);
	if (!session) return new Response(null, { status: 404 });
	if (getScope() !== session.scope) return new Response(null, { status: 404 });
	if ((getSessionId() ?? "") !== session.boundSessionId)
		return new Response(null, { status: 404 });
	// Same-origin validation for url frames, BEFORE anything applies: a
	// cross-origin target is a protocol violation (`400`, nothing from
	// the envelope applied) — the channel states this origin's URL state,
	// never another's. Path-relative targets resolve same-origin by
	// construction.
	for (const frame of envelope.frames) {
		if (frame.kind !== "url") continue;
		try {
			if (new URL(frame.url, request.url).origin !== new URL(request.url).origin)
				return new Response(null, { status: 400 });
		} catch {
			return new Response(null, { status: 400 });
		}
	}
	// Latch WINDOW url frames AHEAD of the in-order pass: an ack riding
	// the same envelope was computed by a client whose navigation point
	// was already set when the url statement was created (statement time
	// precedes the coalesced flush), so the fold gate must see the url
	// statement first regardless of producer order within the envelope.
	// FRAME url frames stay in the in-order pass — they never move the
	// fold gate (`statedNavSeq` is window-scoped), and a superseding
	// frame navigation's `cancel` precedes its url within the envelope,
	// which the in-order pass honors for free.
	let wakeNeeded = false;
	for (const frame of envelope.frames) {
		if (frame.kind !== "url" || frame.frame !== undefined) continue;
		applyUrlFrame(session, envelope.seq, frame, request.url);
		wakeNeeded = true;
	}
	for (const frame of envelope.frames) {
		switch (frame.kind) {
			case "visible":
				applyVisibleFrame(session, envelope.seq, frame);
				break;
			case "detach":
				detachConnectionSession(session);
				break;
			case "ack":
				// An advancing ack frees the unacked delivery window — the
				// parked driver must re-evaluate its coalesced dirty set.
				if (applyAckFrame(session, frame)) wakeNeeded = true;
				break;
			case "telemetry":
				// No wake contribution: telemetry alone must never cause a
				// render (see applyTelemetryFrame). The envelope-level applied
				// watermark below advances as for any envelope.
				applyTelemetryFrame(session, envelope.seq, frame);
				break;
			case "cancel":
				applyCancelFrame(session, envelope.seq, frame);
				break;
			case "url":
				// Window statements latched above, ahead of the in-order pass.
				if (frame.frame !== undefined) {
					applyFrameUrlFrame(
						session,
						envelope.seq,
						frame,
						frame.frame,
						request.url,
					);
					wakeNeeded = true;
				}
				break;
		}
	}
	// The envelope applied — advance the upstream watermark. Arrival
	// order is seq order (the client transport serializes envelopes), so
	// the max is the contiguous watermark; per-frame-kind seq gates own
	// idempotence, never a whole-envelope replay gate (a stale
	// envelope's flips must still queue).
	if (envelope.seq > session.appliedSeq) {
		session.appliedSeq = envelope.seq;
		// The driver announces the advance downstream (the `applied`
		// marker) at its next wake — give it one.
		if (session.appliedSeq > session.announcedAppliedSeq) wakeNeeded = true;
	}
	if (wakeNeeded) for (const wake of [...session.flipWakes]) wake();
	return new Response(null, { status: 204 });
}

function applyVisibleFrame(
	session: ConnectionSession,
	seq: number,
	frame: VisibleFrame,
): void {
	reportConnectionVisibility(
		session.id,
		seq,
		frame.changed,
		frame.visible,
		frame.cached,
	);
}
