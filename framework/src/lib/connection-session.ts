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
import { getSessionId } from "../runtime/session.ts";
import {
	type AckFrame,
	type AttachStatement,
	type ChannelEnvelope,
	decodeAttachStatement,
	decodeChannelEnvelope,
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
	 *  attach carries the new cookie and envelopes work again. */
	readonly boundSessionId: string;
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
	 *  that emission carried. Folded into `ackedFps` (and dropped) when
	 *  the client's cumulative ack covers the seq; dies with the
	 *  connection otherwise. Bounded by the unacked delivery window —
	 *  the same signal that stops new lanes stops new records. */
	readonly pendingDeliveries: Map<number, ReadonlyArray<readonly [string, string]>>;
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
const sessions = ((globalThis as Record<string, unknown>).__partonConnectionSessions ??=
	new Map<string, ConnectionSession>()) as Map<string, ConnectionSession>;

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
	};
	sessions.set(id, session);
	return session;
}

/**
 * Record an emission's holdings against its delivery seq — the `(id,
 * fp)` pairs a payload segment or lane carried, captured by the driver
 * at the same walk that promotes them into the optimistic layer. When
 * the client's cumulative ack covers the seq, the pairs fold into the
 * ACKED layer and the record dies. A record whose seq the client
 * already acked (the ack raced the driver's post-drain bookkeeping)
 * folds immediately instead of pending forever.
 */
export function _recordDelivery(
	session: ConnectionSession,
	seq: number,
	tokens: ReadonlyArray<readonly [string, string]>,
): void {
	if (seq <= session.ackedDeliverySeq) {
		foldAckedTokens(session, tokens);
		return;
	}
	session.pendingDeliveries.set(seq, tokens);
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
	for (const [seq, tokens] of session.pendingDeliveries) {
		if (seq <= frame.delivered) {
			foldAckedTokens(session, tokens);
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
 * `403` on cross-site provenance. `400` on a malformed envelope or a
 * malformed known-kind frame (unknown kinds are skipped by the
 * decoder, not errors). `404` when the connection isn't open OR the
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
	let wakeNeeded = false;
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
