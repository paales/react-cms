/**
 * ChannelClient — the client transport for the channel's upstream role
 * ([[channel-protocol]]; design: docs/notes/channel-design.md). One
 * module owning everything between a producer's statement and the
 * envelope on the wire:
 *
 *   - **Envelope assembly + seq.** Each flush collects at most one
 *     frame per registered producer, wraps them in one
 *     `{connection, seq, frames}` envelope, and POSTs it fire-and-
 *     forget (`keepalive: true`, so an in-flight envelope survives a
 *     page unload). `seq` is per-connection monotonic, restarting at
 *     establishment.
 *   - **Coalescing + serialization.** Flushes coalesce per animation
 *     frame and serialize — one envelope in flight; a flush requested
 *     mid-flight re-fires when it lands. Producers therefore batch
 *     naturally: everything stated within one frame rides one POST.
 *   - **The fallback signal.** A non-`204` answer (connection gone,
 *     attach-binding mismatch) or a network failure clears the
 *     published connection id and hands each carried frame back to
 *     its producer (`deliveryFailed`) — the producer re-owns the
 *     statements and delivers them via its own discrete fallback. A
 *     flush with NO connection open calls `collect(null)`: the
 *     producer's cue to deliver via that fallback directly.
 *   - **Connection lifecycle.** The heartbeat establishes the
 *     connection id here when its live fire's subscription is proven
 *     open, and closes it when the connection settles;
 *     `<html data-parton-live>` rides the same two moments (the
 *     liveness marker specs and tooling wait on). Establishment
 *     listeners let producers arm connection-scoped work (the
 *     visibility controller's full-set sync).
 *   - **Detach.** `pagehide` sends a final `detach` frame via a
 *     keepalive fetch — the explicit close. Best-effort by nature;
 *     the server's keepalive timeout remains the backstop.
 *   - **Delivery acks.** The transport tracks the delivery seqs the
 *     stream's emissions carry (`seq` entries) and the seqs the merge
 *     layer COMMITS (the browser entry's lane/segment commit hooks),
 *     and acks the highest contiguously committed value upstream via
 *     an internal producer. The ack is a PASSENGER, never a driver:
 *     a watermark advance marks the producer dirty and any envelope
 *     other frames justify carries the current value for free —
 *     except the connection's FIRST committed delivery (the prompt
 *     duplex proof the degrade machinery times) and the unacked count
 *     crossing `ACK_FLUSH_THRESHOLD`, which request the same
 *     rAF-coalesced flush every statement rides (no timers).
 *   - **The reliable class + retransmit.** Frames from producers
 *     declaring `reliable: true` are buffered per envelope (with the
 *     envelope's seq) until the downstream `applied` marker covers
 *     them, and retransmitted — original seqs, in order, ahead of new
 *     flushes — when the next connection establishes. The envelope seq
 *     is PAGE-LIFETIME monotonic for exactly this reason. The url
 *     producer is the first reliable-class source (visible/detach
 *     statements re-seed; acks are connection-scoped and cumulative;
 *     telemetry is LOSSY — dropped, never redelivered) — though in
 *     practice its buffered frames retire at the next ATTACH rather
 *     than retransmit (the attach's own request line restates the
 *     URL — see the navigation section below).
 *   - **Degrade.** A connection that commits deliveries but cannot get
 *     its FIRST ack through (the envelope carrying it fails — blocked
 *     `/__parton/*` POSTs, ad-blockers) proves the duplex broken. The
 *     transport marks the PAGE degraded — sticky for the page
 *     lifetime — and the heartbeat stops holding live attaches,
 *     falling back to periodic discrete reloads (`_channelIsDegraded`).
 */

import {
	CHANNEL_ENDPOINT,
	type ChannelEnvelope,
	type ChannelFrame,
	UNACKED_DELIVERY_WINDOW,
	type UrlFrame,
} from "./channel-protocol.ts";
import {
	TAG_CONNECTION_ID,
	TAG_DELIVERY_SEQ,
	TAG_MUX_LIVE,
	TAG_SEQ_VOID,
	TAG_UPSTREAM_APPLIED,
} from "./fp-trailer-marker.ts";
import {
	_getLiveConnectionId,
	_setLiveConnectionId,
} from "./partial-client-state.ts";

/** A source of upstream frames (the visibility controller is the
 *  first). Registered once at module scope; consulted on every
 *  envelope flush. */
export interface ChannelProducer {
	/** Contribute the producer's frames to the envelope being assembled
	 *  — one frame for most producers; an ordered array where one
	 *  statement is several frames (the frame-navigation producer's
	 *  cancel-then-url pair). `connection` is the open connection's id,
	 *  or `null` when none is established — the producer's cue to
	 *  deliver its pending statements via its own discrete fallback
	 *  instead (and return `null`). Called only when an envelope can
	 *  actually fire (never while one is in flight), so the frames'
	 *  content is always the producer's latest state. */
	collect(connection: string | null): ChannelFrame | ChannelFrame[] | null;
	/** The envelope carrying this producer's frame was not applied —
	 *  connection gone (`404`-equivalent) or the POST never reached the
	 *  server. The transport has already cleared the published id; the
	 *  producer re-owns the frame's statements and delivers them via
	 *  its fallback. Never called for a `reliable` producer's frames —
	 *  the transport's retransmit buffer owns their redelivery. */
	deliveryFailed(frame: ChannelFrame): void;
	/** Declares this producer's frames RELIABLE-class: they must reach
	 *  the server even across a torn connection, so the transport
	 *  buffers them (keyed by envelope seq) until the downstream
	 *  `applied` marker proves application, and retransmits survivors
	 *  at the next establishment. Application idempotence is the frame
	 *  kind's own contract (seq-ordered statement semantics). Absent /
	 *  false: loss-tolerant — a failed envelope hands the frame back
	 *  via `deliveryFailed`. */
	reliable?: boolean;
}

const producers = new Set<ChannelProducer>();
const establishListeners = new Set<(connection: string) => void>();

export function registerChannelProducer(producer: ChannelProducer): void {
	producers.add(producer);
}

/** Run `cb` with the connection id every time a live connection is
 *  established — producers arm connection-scoped work here (e.g. the
 *  visibility controller's full-set sync at first measurement). */
export function onChannelEstablished(cb: (connection: string) => void): void {
	establishListeners.add(cb);
}

// PAGE-LIFETIME monotonic envelope seq — never restarted at
// establishment, so retransmitted reliable envelopes keep their
// original seqs across reattaches and the server's `applied` marker
// names one unambiguous timeline (seeded per attach from
// `_channelAppliedWatermark`).
let envelopeSeq = 0;
let rafScheduled = false;
let inFlight = false;
let reflushPending = false;

// ─── Delivery tracking (per established connection) ─────────────────
//
// Delivery seqs are PER-CONNECTION: the server mints them at emission
// and the client records them at COMMIT — the merge-layer moment the
// bytes become the page (a decoded-but-dropped payload is never
// recorded, so its seq stalls the watermark and the server never
// treats it as held). The ack is cumulative: the highest CONTIGUOUSLY
// committed seq. Lanes commit concurrently across partons, so commits
// can land out of order — the out-of-order set fills the gaps until
// the contiguous frontier catches up.

/** One delivery announcement off the wire: the per-connection seq plus
 *  the navigation point it was rendered as-of (the consumed
 *  url-statement envelope seq; `0` = the attach's own request state).
 *  Two optional flags extend the lane form: `live` — the announcement
 *  was a `muxlive` frame (a PRODUCER lane: seq + as-of arrive while
 *  the body still streams, so the consumer commits progressively and
 *  the `muxend` comes at producer resolve); `nav` — the FRAME url
 *  statement seq whose consume spawned the lane (the frame fire's
 *  milestone correlation). */
export interface WireDelivery {
	seq: number;
	asOf: number;
	live?: boolean;
	nav?: number;
}

/** Per-parton FIFO of lane deliveries read off the wire (`seq`
 *  entries precede their lane's `muxend`; a producer lane's `muxlive`
 *  announcement arrives mid-body). Successive lanes for one parton
 *  commit in arrival order (the browser entry chains them), so the
 *  queue head always names the delivery of the payload being
 *  committed. */
const pendingLaneSeqs = new Map<string, WireDelivery[]>();
/** One-shot wakes for a producer announcement landing on an open lane
 *  body — the lane handler races the trailer against this while it
 *  waits to learn whether the body is a producer stream. Disposal is
 *  explicit (the handler releases its waiter when the race settles),
 *  never a reaction on a promise that outlives the race. */
const laneProducerWaiters = new Map<string, Set<() => void>>();

/** Register a one-shot wake for `partonId`'s next producer
 *  announcement. Returns the disposer. */
export function _onLaneProducerAnnounce(
	partonId: string,
	wake: () => void,
): () => void {
	let waiters = laneProducerWaiters.get(partonId);
	if (!waiters) {
		waiters = new Set();
		laneProducerWaiters.set(partonId, waiters);
	}
	waiters.add(wake);
	return () => {
		const set = laneProducerWaiters.get(partonId);
		if (!set) return;
		set.delete(wake);
		if (set.size === 0) laneProducerWaiters.delete(partonId);
	};
}

// ─── Action consequence gates ────────────────────────────────────────
//
// An action POST on an attached page names its connection
// (`x-parton-conn`); the response carries the delivery seqs the
// action's invalidation consequences will ride (reserved server-side
// inside the action's transaction — `_reserveActionConsequences`).
// The optimistic overlay must hold until the committed watermark
// covers them: cleared at the returnValue alone, a consequence lane
// delayed behind window coalescing would flash the STALE
// server-authoritative value exactly when the delay is longest. A
// gate resolves when the contiguous watermark passes its max seq
// (voided seqs count — the `seqvoid` entry), and every gate releases
// when the connection ends (its seqs are dead; the reattach's
// whole-tree render is the catch-up — over-fetch, never frozen).

interface ConsequenceGate {
	max: number;
	resolve: () => void;
	promise: Promise<void>;
}

const consequenceGates = new Set<ConsequenceGate>();

/** Register an action response's consequence seqs. Called by the
 *  action transport (the browser entry's server callback) the moment
 *  the response headers are in hand — strictly before the action's
 *  returned promise resolves, so an overlay awaiting the write can
 *  always observe its own gate. */
export function _registerActionConsequences(seqs: readonly number[]): void {
	if (seqs.length === 0) return;
	const max = Math.max(...seqs);
	// The inverse ordering race: the consequence lane committed before
	// the POST resolved — the watermark already covers it, no gate.
	if (deliveredWatermark >= max) return;
	let resolve!: () => void;
	const promise = new Promise<void>((res) => {
		resolve = res;
	});
	const gate: ConsequenceGate = { max, resolve, promise };
	consequenceGates.add(gate);
}

/** Every outstanding consequence gate as one promise — the overlay's
 *  clear point awaits it after the write POST resolves. Resolved
 *  immediately when nothing is outstanding (no channel, no
 *  reservations): unchanged behavior. */
export function _awaitActionConsequences(): Promise<void> {
	if (consequenceGates.size === 0) return Promise.resolve();
	return Promise.all([...consequenceGates].map((g) => g.promise)).then(
		() => undefined,
	);
}

function sweepConsequenceGates(): void {
	if (consequenceGates.size === 0) return;
	for (const gate of [...consequenceGates]) {
		if (deliveredWatermark >= gate.max) {
			consequenceGates.delete(gate);
			gate.resolve();
		}
	}
}

function releaseAllConsequenceGates(): void {
	for (const gate of [...consequenceGates]) gate.resolve();
	consequenceGates.clear();
}
/** Highest contiguously committed delivery seq — the ack value. */
let deliveredWatermark = 0;
/** Committed seqs past a gap in the contiguous frontier. */
const deliveredOutOfOrder = new Set<number>();
/** The watermark value last carried on a collected ack frame. */
let lastAckCollected = 0;
/** Unacked-commit count at which the transport DRIVES a flush for the
 *  ack's own sake — half the server's backpressure window, so a client
 *  under sustained lane traffic acks once per threshold crossing and
 *  the window always keeps 2× headroom. Below the threshold the ack is
 *  a PASSENGER: the watermark rides whatever envelope other statements
 *  justify, because every envelope costs the browser's full Cookie
 *  header (~3.5–4.5KB under a commerce cookie jar — [[channel]]'s cost
 *  section) and no consumer of the ack needs per-commit resolution:
 *  the mirror's hot layer is the OPTIMISTIC skip-set, and the window
 *  only needs freeing well before it fills. */
const ACK_FLUSH_THRESHOLD = UNACKED_DELIVERY_WINDOW / 2;
/** An ack frame for the CURRENT connection has been delivered (its
 *  envelope answered 204). Until it has, an ack-carrying envelope's
 *  failure means the connection never acked once — the degrade
 *  signal. */
let ackDeliveredOnConnection = false;

// ─── Reliable-class buffer + upstream watermark ──────────────────────

/** Reliable frames awaiting the server's `applied` marker, keyed by
 *  the envelope seq that carried them (ascending). Only frames from
 *  `reliable: true` producers enter; loss-tolerant co-riders of the
 *  same envelope self-heal and must not replay. */
let retransmitBuffer: Array<{ seq: number; frames: ChannelFrame[] }> = [];
/** Highest upstream envelope seq the server has stated applied (the
 *  downstream `applied` marker) — what prunes the buffer and what the
 *  next attach statement presents as its `applied` watermark. */
let appliedWatermark = 0;
/** Establishment found survivors in the buffer — the next flush sends
 *  them (original seqs, in order) before collecting producers. */
let retransmitPending = false;

// ─── Degrade (page-lifetime) ─────────────────────────────────────────

/** The duplex is proven broken for this page: a connection committed
 *  deliveries but the envelope carrying its FIRST ack failed (blocked
 *  POST path, connection-gone race). Sticky for the page lifetime —
 *  the heartbeat reads it and degrades to periodic discrete reloads
 *  instead of holding lanes-first live attaches whose window can
 *  never free. */
let degraded = false;

/** Whether the channel is page-degraded — the heartbeat's cue to fire
 *  discrete reloads (GET-shaped, capped `?cached=`) instead of live
 *  attaches. */
export function _channelIsDegraded(): boolean {
	return degraded;
}

/** The upstream-applied watermark last heard from the server — the
 *  attach statement's `applied` field (see [[channel-protocol]]). */
export function _channelAppliedWatermark(): number {
	return appliedWatermark;
}

// ─── Window navigation over the channel ──────────────────────────────
//
// A window navigation or batched selector refetch on an ATTACHED,
// non-degraded page is a `url` frame: the client states its URL (with
// any one-shot `?partials=` overlay), the server's driver answers with
// a payload segment in stream order, and the caller's milestones
// resolve at that segment's commit/settle — never at a fetch lifecycle,
// because there is no fetch. The pieces:
//
//   - **The navigation point.** `navPoint` is the envelope seq the next
//     url frame ships with, reserved AT STATEMENT TIME (`envelopeSeq +
//     1` — flushes serialize, so the reservation is exact) because the
//     client's URL advances at click time, ahead of the stream: from
//     this instant, any delivery rendered as-of an older navigation
//     must not commit. The as-of guard (`_channelDeliveryCommittable`)
//     is the pageUrlKey stale-commit guard generalized into the
//     protocol; the discrete GET path keeps the pageUrlKey twin.
//   - **The producer.** RELIABLE class: url frames ride the retransmit
//     buffer until the `applied` marker covers them. One pending frame,
//     newest-wins — a statement superseded before its flush was a
//     navigation the client already navigated past, and the covering
//     segment for the newest statement resolves every older fire's
//     milestones too (their content IS the newest URL's render).
//   - **The attach subsumes.** The attach's own request line states the
//     URL, so an attach fire retires the navigation point, drops
//     buffered url frames, and re-owns any still-pending records — a
//     fresh connection opens with as-of 0 on both sides.
//   - **Falling back.** No connection at statement or flush time, a
//     failed envelope, or the stream closing under pending records
//     hands the LATEST statement to the discrete GET transport
//     (`window.__rsc_partial_refetch`) and chains every pending
//     record's milestones onto that fire — first interaction never
//     waits on attach, and a torn channel never strands a navigation.

interface PendingNavRecord {
	/** The navigation point this record's statement set — a committed
	 *  segment rendered as-of ≥ this resolves the record. */
	navSeq: number;
	/** The stated URL (path + search, may carry a `?partials=` overlay)
	 *  — what the discrete fallback re-fires. */
	url: string;
	/** The caller's commit-mode wish (`streaming: true` = progressive /
	 *  raw). A covering segment commits in transition mode when any
	 *  covered record asked for it. */
	streaming: boolean;
	streamingResolved: boolean;
	settled: boolean;
	resolveStreaming: () => void;
	rejectStreaming: (err: unknown) => void;
	resolveFinished: () => void;
	rejectFinished: (err: unknown) => void;
}

let navPoint = 0;
let statedWindowUrl: string | null = null;
let pendingNavFrame: UrlFrame | null = null;
let pendingNavRecords: PendingNavRecord[] = [];
/** One-shot claim the navigate-event listener sets when it routes a
 *  window navigation through the channel — the heartbeat's deferred
 *  abort check consumes it and keeps the stream (the navigation rides
 *  it; tearing it would strand the nav segment). Explicit
 *  producer-written signal, set synchronously during the event
 *  dispatch, read in the same task's microtask. */
let windowNavClaim = false;
/** The heartbeat's registered live-stream aborter — the escape hatch a
 *  claimed-then-unroutable navigation pulls (`_channelAbortLiveStream`)
 *  so the stream reopens on the now-current URL instead of idling on
 *  the old one for the keepalive. */
let liveStreamAbort: (() => void) | null = null;

/** Whether window navigations / selector refetches ride the channel
 *  right now: a connection is established and the page is not
 *  degraded. Consulted by the navigate-event listener (the claim), the
 *  refetch dispatcher, and the browser entry's routing. */
export function _channelNavAvailable(): boolean {
	return !degraded && _getLiveConnectionId() !== null;
}

/** The client's navigation point — the envelope seq of its latest url
 *  statement on the open connection (`0` = none since attach). */
export function _channelNavPoint(): number {
	return navPoint;
}

/** The URL of the latest channel url statement (path + search), or
 *  `null` when the attach's own URL is the connection's last word —
 *  the live stream's expected-page identity moves with it. */
export function _channelStatedWindowUrl(): string | null {
	return statedWindowUrl;
}

export function _channelClaimWindowNav(): void {
	windowNavClaim = true;
}

export function _channelConsumeWindowNavClaim(): boolean {
	const claimed = windowNavClaim;
	windowNavClaim = false;
	return claimed;
}

export function _registerLiveStreamAbort(abort: (() => void) | null): void {
	liveStreamAbort = abort;
}

export function _channelAbortLiveStream(): void {
	liveStreamAbort?.();
}

/** A server-initiated url push (a `url` trailer) applies only when the
 *  client hasn't navigated past the state the push was rendered as-of:
 *  client-wins-at-higher-envelope-seq. `asOf` is the delivery's wire
 *  as-of on the live stream, or the navigation point captured at issue
 *  time for a discrete response (the client-local as-of of a request
 *  it issued itself); `undefined` — a caller with no correlation —
 *  applies unconditionally. */
export function _serverUrlPushApplies(asOf: number | undefined): boolean {
	return asOf === undefined || asOf >= navPoint;
}

/** The as-of commit guard for seq'd deliveries on the live stream —
 *  the protocol form of the stale-commit decision: commit iff the
 *  delivery was rendered as-of the client's current navigation point
 *  or later. The twin pageUrlKey guard survives on the discrete GET
 *  path; both are reached through the browser entry's one guard seam. */
export function _channelDeliveryCommittable(asOf: number): boolean {
	return asOf >= navPoint;
}

/**
 * State a window navigation / selector refetch on the open channel.
 * Returns the fire's `{streaming, finished}` milestones, or `null`
 * when the channel can't carry it (pre-attach, degraded) — the
 * caller's cue to take the discrete GET path with its own guards. With
 * `record: false` the statement is fire-and-forget (a silent URL-only
 * sync — no milestones to keep).
 */
export function _channelNavigate(init: {
	url: string;
	intent: UrlFrame["intent"];
	streaming?: boolean;
	signal?: AbortSignal;
	record?: boolean;
}): { streaming: Promise<void>; finished: Promise<void> } | null {
	if (!_channelNavAvailable()) return null;
	// Reserve the statement's envelope seq: flushes serialize and only
	// collect-flushes mint, so the next envelope is exactly
	// `envelopeSeq + 1` — and the navigation point must advance NOW
	// (click time), before any flush, or a pre-nav delivery landing in
	// the reservation window would still commit.
	navPoint = envelopeSeq + 1;
	statedWindowUrl = init.url;
	pendingNavFrame = { kind: "url", url: init.url, intent: init.intent };
	scheduleChannelFlush();
	if (init.record === false) return { streaming: Promise.resolve(), finished: Promise.resolve() };
	let resolveStreaming!: () => void;
	let rejectStreaming!: (err: unknown) => void;
	let resolveFinished!: () => void;
	let rejectFinished!: (err: unknown) => void;
	const streaming = new Promise<void>((res, rej) => {
		resolveStreaming = res;
		rejectStreaming = rej;
	});
	const finished = new Promise<void>((res, rej) => {
		resolveFinished = res;
		rejectFinished = rej;
	});
	streaming.catch(() => {});
	finished.catch(() => {});
	const record: PendingNavRecord = {
		navSeq: navPoint,
		url: init.url,
		streaming: init.streaming === true,
		streamingResolved: false,
		settled: false,
		resolveStreaming,
		rejectStreaming,
		resolveFinished,
		rejectFinished,
	};
	pendingNavRecords.push(record);
	if (init.signal) {
		const onAbort = (): void => {
			if (record.settled) return;
			record.settled = true;
			pendingNavRecords = pendingNavRecords.filter((r) => r !== record);
			const err = new DOMException("navigation superseded", "AbortError");
			if (!record.streamingResolved) record.rejectStreaming(err);
			record.rejectFinished(err);
		};
		if (init.signal.aborted) onAbort();
		else init.signal.addEventListener("abort", onAbort, { once: true });
	}
	return { streaming, finished };
}

/** True when a covering commit (`asOf` ≥ some pending record's navSeq)
 *  should land as a TRANSITION commit — any covered caller asked for
 *  the atomic swap (`streaming: false`). No covered record → the live
 *  stream's default raw commit. */
export function _channelNavPrefersTransition(asOf: number): boolean {
	return pendingNavRecords.some(
		(r) => !r.settled && r.navSeq <= asOf && !r.streaming,
	);
}

/** A payload segment rendered as-of `asOf` COMMITTED on the live
 *  stream — resolve the `streaming` milestone of every record it
 *  covers (their content is this render). The as-of spans BOTH url
 *  scopes (it advances at every consume, window and frame alike), so
 *  a whole-tree segment covers frame records too: its render read the
 *  consumed session frame URLs. */
export function _channelNavSegmentCommitted(asOf: number): void {
	for (const record of pendingNavRecords) {
		if (record.settled || record.streamingResolved) continue;
		if (record.navSeq > asOf) continue;
		record.streamingResolved = true;
		record.resolveStreaming();
	}
	for (const record of pendingFrameNavRecords) {
		if (record.settled || record.streamingResolved) continue;
		if (record.seq > asOf) continue;
		record.streamingResolved = true;
		record.resolveStreaming();
	}
}

/** A covering payload segment SETTLED (its trailers resolved — the
 *  render fully drained) — resolve `finished` and retire the records. */
export function _channelNavSegmentSettled(asOf: number): void {
	const remaining: PendingNavRecord[] = [];
	for (const record of pendingNavRecords) {
		if (record.settled) continue;
		if (record.navSeq > asOf) {
			remaining.push(record);
			continue;
		}
		record.settled = true;
		if (!record.streamingResolved) {
			record.streamingResolved = true;
			record.resolveStreaming();
		}
		record.resolveFinished();
	}
	pendingNavRecords = remaining;
	const remainingFrames: PendingFrameNavRecord[] = [];
	for (const record of pendingFrameNavRecords) {
		if (record.settled) continue;
		if (record.seq > asOf) {
			remainingFrames.push(record);
			continue;
		}
		record.settled = true;
		if (!record.streamingResolved) {
			record.streamingResolved = true;
			record.resolveStreaming();
		}
		record.resolveFinished();
	}
	pendingFrameNavRecords = remainingFrames;
	pruneFrameSeqKeys();
}

/**
 * The attach subsumes the URL timeline: its own request line IS the
 * client's URL statement, so buffered url frames retire (never
 * retransmitted — the frames' navigation is already the attach URL),
 * the navigation point resets (the new connection's deliveries open
 * as-of 0 on both sides), and any records a closing connection left
 * behind fall back to the discrete transport. Called by the browser
 * entry at attach fire, before the POST.
 */
export function _channelNavSubsumedByAttach(): void {
	navPoint = 0;
	statedWindowUrl = null;
	pendingNavFrame = null;
	// Frame statements retire from the retransmit path too — the
	// attach's whole-tree render reads the SESSION frame URLs, and a
	// replayed frame url could regress a newer discrete frame nav made
	// while the connection was down. Un-covered frame fires re-fire
	// DISCRETE below instead (the attach's request line restates the
	// window URL but not frame URLs).
	pendingFrameFrames.clear();
	pendingCancelScopes.clear();
	if (retransmitBuffer.length > 0) {
		retransmitBuffer = retransmitBuffer
			.map((entry) => ({
				seq: entry.seq,
				frames: entry.frames.filter(
					(f) => f.kind !== "url" && f.kind !== "cancel",
				),
			}))
			.filter((entry) => entry.frames.length > 0);
	}
	fallbackPendingNavs();
	fallbackPendingFrameNavs();
}

/** Hand every pending navigation to the discrete transport: one GET
 *  for the LATEST statement's URL (older fires' content is that URL's
 *  render — same rule the covering segment applies), all records'
 *  milestones chained onto it. The channel's leg is over for them:
 *  connection gone, or the stream closed before their segment. */
function fallbackPendingNavs(): void {
	if (pendingNavRecords.length === 0) return;
	const records = pendingNavRecords;
	pendingNavRecords = [];
	const latest = records[records.length - 1];
	const handler =
		typeof window !== "undefined"
			? (
					window as Window & {
						__rsc_partial_refetch?: (
							url: string,
						) => { streaming: Promise<void>; finished: Promise<void> };
					}
				).__rsc_partial_refetch
			: undefined;
	if (!handler) {
		// No transport (SSR, teardown) — settle as no-ops so callers
		// never hang.
		for (const r of records) {
			if (r.settled) continue;
			r.settled = true;
			if (!r.streamingResolved) r.resolveStreaming();
			r.resolveFinished();
		}
		return;
	}
	const url = new URL(latest.url, window.location.origin);
	const fire = handler(url.toString());
	fire.streaming.then(
		() => {
			for (const r of records) {
				if (r.settled || r.streamingResolved) continue;
				r.streamingResolved = true;
				r.resolveStreaming();
			}
		},
		(err) => {
			for (const r of records) {
				if (r.settled || r.streamingResolved) continue;
				r.streamingResolved = true;
				r.rejectStreaming(err);
			}
		},
	);
	fire.finished.then(
		() => {
			for (const r of records) {
				if (r.settled) continue;
				r.settled = true;
				r.resolveFinished();
			}
		},
		(err) => {
			for (const r of records) {
				if (r.settled) continue;
				r.settled = true;
				r.rejectFinished(err);
			}
		},
	);
}

/** The url producer — RELIABLE class (see the module header). One
 *  pending frame, newest-wins; `collect(null)` — the flush found no
 *  connection — is the cue to hand the pending navigation to the
 *  discrete fallback. */
const urlProducer: ChannelProducer = {
	reliable: true,
	collect(connection: string | null): ChannelFrame | null {
		if (pendingNavFrame === null) return null;
		if (connection === null) {
			pendingNavFrame = null;
			fallbackPendingNavs();
			return null;
		}
		const frame = pendingNavFrame;
		pendingNavFrame = null;
		return frame;
	},
	deliveryFailed(): void {
		// Reliable class — the retransmit buffer owns redelivery; the
		// pending-record fallback rides the connection-loss paths.
	},
};

// ─── Frame navigation over the channel ───────────────────────────────
//
// A frame navigate/reload/traverse on an ATTACHED, non-degraded page
// is a FRAME-scoped `url` statement: the endpoint writes the session
// frame URL (the same store `?__frame=` writes through), the driver
// lanes the frame's targets on the HELD stream, and the fire's
// milestones resolve off the covering lane's `nav=<seq>` correlation
// flag — `streaming` at its commit, `finished` at its settle (a
// whole-tree segment whose as-of covers the statement resolves them
// too: its render reflects the consumed frame URL). The frame
// long-poll's dedicated connection — and the deferred-abort supersede
// that managed it — retire on this path: a newer statement for the
// same frame ships `cancel` + `url` in ONE envelope, and the server
// aborts the superseded in-flight render directly. Pre-attach and
// degraded pages keep the discrete `__frame` GET exactly as before.

interface PendingFrameNavRecord {
	/** Dotted frame key — the statement's scope. */
	key: string;
	/** Top-level frame name — the discrete fallback's `?partials=`
	 *  narrowing and the cancel scope. */
	topLabel: string;
	/** The statement's envelope seq — a covering lane flagged
	 *  `nav >= seq` (same key) or a whole-tree segment with
	 *  `asOf >= seq` resolves the record. */
	seq: number;
	/** The stated frame URL — what the discrete fallback re-fires. */
	url: string;
	streaming: boolean;
	streamingResolved: boolean;
	settled: boolean;
	resolveStreaming: () => void;
	rejectStreaming: (err: unknown) => void;
	resolveFinished: () => void;
	rejectFinished: (err: unknown) => void;
}

/** Unsent frame statements, newest per frame key. */
let pendingFrameFrames = new Map<string, UrlFrame>();
/** Cancel co-riders for the next flush — scopes whose in-flight
 *  render a newer statement supersedes. Emitted BEFORE the url frames
 *  in the producer's contribution (cancel-then-url in one envelope). */
let pendingCancelScopes = new Set<string>();
let pendingFrameNavRecords: PendingFrameNavRecord[] = [];
/** Statement seq → frame key, for the covering-lane correlation (the
 *  wire flag carries only the seq). Pruned as records retire. */
const frameSeqKeys = new Map<number, string>();

/**
 * State a frame navigation on the open channel. Returns the fire's
 * `{streaming, finished}` milestones, or `null` when the channel
 * can't carry it (pre-attach, degraded) — the caller's cue to take
 * the discrete `__frame` GET with its own machinery.
 */
export function _channelFrameNavigate(init: {
	path: readonly string[];
	url: string;
	intent: UrlFrame["intent"];
	streaming?: boolean;
	signal?: AbortSignal;
}): { streaming: Promise<void>; finished: Promise<void> } | null {
	if (!_channelNavAvailable()) return null;
	const key = init.path.join(".");
	const topLabel = init.path[0];
	// Reserve the statement's envelope seq — flushes serialize and only
	// collect-flushes mint, so the next envelope is exactly
	// `envelopeSeq + 1`. Statements batched into the same flush share
	// the seq; each record still correlates through its own key.
	const seq = envelopeSeq + 1;
	// A prior unsettled statement for this frame is superseded — its
	// in-flight render on the server is moot. The cancel rides the SAME
	// envelope, ahead of the url frame; the deferred-abort machinery
	// this replaces lives on only for the discrete GET path.
	if (pendingFrameNavRecords.some((r) => r.key === key && !r.settled)) {
		pendingCancelScopes.add(topLabel);
	}
	pendingFrameFrames.set(key, {
		kind: "url",
		url: init.url,
		intent: init.intent,
		frame: [...init.path],
	});
	frameSeqKeys.set(seq, key);
	scheduleChannelFlush();
	let resolveStreaming!: () => void;
	let rejectStreaming!: (err: unknown) => void;
	let resolveFinished!: () => void;
	let rejectFinished!: (err: unknown) => void;
	const streaming = new Promise<void>((res, rej) => {
		resolveStreaming = res;
		rejectStreaming = rej;
	});
	const finished = new Promise<void>((res, rej) => {
		resolveFinished = res;
		rejectFinished = rej;
	});
	streaming.catch(() => {});
	finished.catch(() => {});
	const record: PendingFrameNavRecord = {
		key,
		topLabel,
		seq,
		url: init.url,
		streaming: init.streaming === true,
		streamingResolved: false,
		settled: false,
		resolveStreaming,
		rejectStreaming,
		resolveFinished,
		rejectFinished,
	};
	pendingFrameNavRecords.push(record);
	if (init.signal) {
		const onAbort = (): void => {
			if (record.settled) return;
			record.settled = true;
			pendingFrameNavRecords = pendingFrameNavRecords.filter(
				(r) => r !== record,
			);
			pruneFrameSeqKeys();
			const err = new DOMException("navigation superseded", "AbortError");
			if (!record.streamingResolved) record.rejectStreaming(err);
			record.rejectFinished(err);
		};
		if (init.signal.aborted) onAbort();
		else init.signal.addEventListener("abort", onAbort, { once: true });
	}
	return { streaming, finished };
}

function pruneFrameSeqKeys(): void {
	for (const [seq, key] of [...frameSeqKeys]) {
		if (!pendingFrameNavRecords.some((r) => r.key === key && r.seq <= seq)) {
			frameSeqKeys.delete(seq);
		}
	}
}

/** A lane flagged `nav=<navSeq>` COMMITTED — the covering render for
 *  its statement's frame. Resolve `streaming` for every record of
 *  that frame the statement covers. */
export function _channelFrameLaneCommitted(navSeq: number): void {
	const key = frameSeqKeys.get(navSeq);
	if (key === undefined) return;
	for (const record of pendingFrameNavRecords) {
		if (record.settled || record.streamingResolved) continue;
		if (record.key !== key || record.seq > navSeq) continue;
		record.streamingResolved = true;
		record.resolveStreaming();
	}
}

/** A `nav=<navSeq>`-flagged lane SETTLED (its body closed and its fp
 *  trailer applied) — resolve `finished` and retire the covered
 *  records. */
export function _channelFrameLaneSettled(navSeq: number): void {
	const key = frameSeqKeys.get(navSeq);
	if (key === undefined) return;
	const remaining: PendingFrameNavRecord[] = [];
	for (const record of pendingFrameNavRecords) {
		if (record.settled) continue;
		if (record.key !== key || record.seq > navSeq) {
			remaining.push(record);
			continue;
		}
		record.settled = true;
		if (!record.streamingResolved) {
			record.streamingResolved = true;
			record.resolveStreaming();
		}
		record.resolveFinished();
	}
	pendingFrameNavRecords = remaining;
	pruneFrameSeqKeys();
}

/** Hand every pending frame navigation to the discrete transport —
 *  one `__frame` GET per frame key for the LATEST statement's URL,
 *  every covered record's milestones chained onto it. The channel's
 *  leg is over for them: connection gone, the stream closed before
 *  their covering lane, or an attach re-opened the timeline (a frame
 *  URL is session state the attach's request line does NOT restate,
 *  so unlike window records these always re-fire). */
function fallbackPendingFrameNavs(): void {
	if (pendingFrameNavRecords.length === 0) return;
	const records = pendingFrameNavRecords;
	pendingFrameNavRecords = [];
	frameSeqKeys.clear();
	const handler =
		typeof window !== "undefined"
			? (
					window as Window & {
						__rsc_partial_refetch?: (
							url: string,
						) => { streaming: Promise<void>; finished: Promise<void> };
					}
				).__rsc_partial_refetch
			: undefined;
	const byKey = new Map<string, PendingFrameNavRecord[]>();
	for (const record of records) {
		const list = byKey.get(record.key);
		if (list) list.push(record);
		else byKey.set(record.key, [record]);
	}
	for (const [key, list] of byKey) {
		const latest = list[list.length - 1];
		if (!handler) {
			for (const r of list) {
				if (r.settled) continue;
				r.settled = true;
				if (!r.streamingResolved) r.resolveStreaming();
				r.resolveFinished();
			}
			continue;
		}
		const refetchUrl = new URL(window.location.href);
		refetchUrl.searchParams.set("__frame", key);
		refetchUrl.searchParams.set("__frameUrl", latest.url);
		refetchUrl.searchParams.set("partials", latest.topLabel);
		if (latest.streaming) refetchUrl.searchParams.set("streaming", "1");
		const fire = handler(refetchUrl.toString());
		fire.streaming.then(
			() => {
				for (const r of list) {
					if (r.settled || r.streamingResolved) continue;
					r.streamingResolved = true;
					r.resolveStreaming();
				}
			},
			(err) => {
				for (const r of list) {
					if (r.settled || r.streamingResolved) continue;
					r.streamingResolved = true;
					r.rejectStreaming(err);
				}
			},
		);
		fire.finished.then(
			() => {
				for (const r of list) {
					if (r.settled) continue;
					r.settled = true;
					r.resolveFinished();
				}
			},
			(err) => {
				for (const r of list) {
					if (r.settled) continue;
					r.settled = true;
					r.rejectFinished(err);
				}
			},
		);
	}
}

/** The frame-navigation producer — RELIABLE class. One url frame per
 *  frame key (newest statement wins pre-flush), each superseding
 *  statement's cancel ORDERED AHEAD of the urls in its contribution.
 *  `collect(null)` hands every pending statement to the discrete
 *  fallback. */
const frameNavProducer: ChannelProducer = {
	reliable: true,
	collect(connection: string | null): ChannelFrame[] | null {
		if (pendingFrameFrames.size === 0 && pendingCancelScopes.size === 0) {
			return null;
		}
		if (connection === null) {
			pendingFrameFrames.clear();
			pendingCancelScopes.clear();
			fallbackPendingFrameNavs();
			return null;
		}
		const frames: ChannelFrame[] = [];
		for (const scope of pendingCancelScopes) {
			frames.push({ kind: "cancel", scope });
		}
		pendingCancelScopes.clear();
		for (const frame of pendingFrameFrames.values()) frames.push(frame);
		pendingFrameFrames.clear();
		return frames;
	},
	deliveryFailed(): void {
		// Reliable class — the retransmit buffer owns redelivery; the
		// pending-record fallback rides the connection-loss paths.
	},
};

/**
 * Wire-entry hook for the segmented-stream reader (`splitSegments`'
 * `onEntry`): the browser entry hands every trailer ENTRY here as it
 * is read. Three tags are the transport's:
 *
 *   - `conn` — the server-minted connection id, the establishment
 *     handshake. Receiving it proves the session is open (the driver
 *     mints ids only at session open), so producers can address the
 *     connection immediately, even while the first segment's render
 *     is still draining.
 *   - `seq` (lane form, `<parton-id>\n<seq>`) — a lane delivery's seq,
 *     queued per parton until the browser entry's commit hook consumes
 *     it. The segment form (no newline) is fetch-local — the browser
 *     entry parses it via `_segmentDeliverySeq` so a concurrent
 *     discrete fetch can never consume the live stream's pending seq.
 *   - `applied` — the server's cumulative upstream-applied watermark:
 *     prunes the reliable-envelope buffer and seeds the next attach.
 *
 * Entries of other tags pass through untouched — their consumers read
 * the segment's trailer map.
 */
export function _channelWireEntry(tag: string, body: Uint8Array): void {
	if (tag === TAG_DELIVERY_SEQ || tag === TAG_MUX_LIVE) {
		const text = new TextDecoder().decode(body);
		const nl = text.indexOf("\n");
		if (nl < 0) return; // segment form — fetch-local, see above
		const partonId = text.slice(0, nl);
		const delivery = parseDeliveryBody(text.slice(nl + 1));
		if (delivery === null) return;
		if (tag === TAG_MUX_LIVE) delivery.live = true;
		let queue = pendingLaneSeqs.get(partonId);
		if (!queue) {
			queue = [];
			pendingLaneSeqs.set(partonId, queue);
		}
		queue.push(delivery);
		// A producer announcement arrives MID-BODY — wake the lane
		// handler that is already decoding this parton so it can switch
		// to the progressive commit path instead of waiting for a drain
		// that only comes at producer resolve.
		if (tag === TAG_MUX_LIVE) {
			const waiters = laneProducerWaiters.get(partonId);
			if (waiters) {
				laneProducerWaiters.delete(partonId);
				for (const wake of [...waiters]) wake();
			}
		}
		return;
	}
	if (tag === TAG_SEQ_VOID) {
		// Assigned-but-never-emitted delivery seqs (an action's
		// consequence reservation whose lane was skipped) — count each
		// PROCESSED so the contiguous watermark passes them and the
		// consequence gates they anchored release.
		const text = new TextDecoder().decode(body);
		for (const token of text.split(" ")) {
			const seq = Number(token);
			if (Number.isFinite(seq) && seq > 0) commitDelivery(seq);
		}
		return;
	}
	if (tag === TAG_UPSTREAM_APPLIED) {
		const applied = Number(new TextDecoder().decode(body));
		if (!Number.isFinite(applied) || applied <= appliedWatermark) return;
		appliedWatermark = applied;
		if (retransmitBuffer.length > 0) {
			retransmitBuffer = retransmitBuffer.filter((e) => e.seq > applied);
		}
		return;
	}
	if (tag !== TAG_CONNECTION_ID) return;
	_channelEstablished(new TextDecoder().decode(body));
}

/** Parse a `<seq> <asof>[ nav=<n>]` delivery body. `null` when
 *  malformed. Unknown trailing tokens are ignored — the body grows by
 *  adding flags. */
function parseDeliveryBody(text: string): WireDelivery | null {
	const tokens = text.split(" ").filter(Boolean);
	const seq = Number(tokens[0]);
	if (!Number.isFinite(seq)) return null;
	const asOfRaw = tokens.length > 1 ? Number(tokens[1]) : 0;
	const delivery: WireDelivery = {
		seq,
		asOf: Number.isFinite(asOfRaw) ? asOfRaw : 0,
	};
	for (const token of tokens.slice(2)) {
		if (token.startsWith("nav=")) {
			const nav = Number(token.slice(4));
			if (Number.isFinite(nav)) delivery.nav = nav;
		}
	}
	return delivery;
}

/** Parse a payload segment's delivery off a wire entry — the segment
 *  form of the `seq` tag (`<seq> <asof>`, no parton-id prefix). `null`
 *  for every other entry. The browser entry keeps the value FETCH-LOCAL
 *  and records it via `_segmentDeliveryCommitted` when the segment's
 *  payload commits (or consumes it via the stale-drop paths). */
export function _segmentDelivery(
	tag: string,
	body: Uint8Array,
): WireDelivery | null {
	if (tag !== TAG_DELIVERY_SEQ) return null;
	const text = new TextDecoder().decode(body);
	if (text.includes("\n")) return null; // lane form — queued above
	return parseDeliveryBody(text);
}

/** Record a committed delivery. A contiguous-frontier advance leaves
 *  the ack producer dirty and nothing more — a PASSENGER: any flush
 *  other frames justify (visibility statements, detach, future kinds)
 *  collects the current watermark for free. Exactly two advances drive
 *  a flush of their own, on the normal rAF-coalesced path (no timers):
 *  the connection's FIRST committed delivery — the prompt duplex proof
 *  both sides' degrade machinery times — and the unacked count
 *  crossing `ACK_FLUSH_THRESHOLD`. */
function commitDelivery(seq: number): void {
	if (seq <= deliveredWatermark) return;
	if (seq === deliveredWatermark + 1) {
		deliveredWatermark = seq;
		while (deliveredOutOfOrder.delete(deliveredWatermark + 1)) {
			deliveredWatermark += 1;
		}
		sweepConsequenceGates();
		if (
			lastAckCollected === 0 ||
			deliveredWatermark - lastAckCollected >= ACK_FLUSH_THRESHOLD
		) {
			scheduleChannelFlush();
		}
		return;
	}
	deliveredOutOfOrder.add(seq);
}

/** A payload segment on the live stream committed — record the seq its
 *  `seq` entry announced (the browser entry held it fetch-locally). */
export function _segmentDeliveryCommitted(seq: number): void {
	commitDelivery(seq);
}

/** Peek the delivery the NEXT commit for `partonId` would consume —
 *  the merge layer's as-of guard reads it after a lane's decode (the
 *  `seq` entry precedes the lane's `muxend`, so it is queued by then).
 *  `null` when the lane carried no delivery (no session). */
export function _lanePendingDelivery(partonId: string): WireDelivery | null {
	return pendingLaneSeqs.get(partonId)?.[0] ?? null;
}

/** A lane payload for `partonId` committed — consume the queue head
 *  minted when its `seq` entry was read. No-op when no seq is queued
 *  (a stream without deliveries: no session, or an older server). */
export function _laneDeliveryCommitted(partonId: string): void {
	const delivery = consumeLaneDelivery(partonId);
	if (delivery !== null) commitDelivery(delivery.seq);
}

/** A lane payload for `partonId` was decoded but NOT committed (stale
 *  page guard on a DYING stream, torn decode). Consume the queue head
 *  WITHOUT recording: attribution for later lanes stays aligned, and
 *  the watermark stalls at the dropped seq — the server never treats
 *  the drop as held. Only for streams whose life ends with the drop;
 *  a drop on a CONTINUING stream is the as-of drop below. */
export function _laneDeliveryDropped(partonId: string): void {
	consumeLaneDelivery(partonId);
}

/** A lane payload for `partonId` was dropped by the AS-OF guard — it
 *  predates the client's navigation point on a stream that lives on.
 *  Consume the queue head and count the delivery PROCESSED: the
 *  watermark advances (a permanent gap would wedge the window and
 *  force a reconnect on every raced navigation), and the server's fold
 *  gate — the same asOf-vs-navSeq comparison — keeps the processed
 *  drop out of the acked mirror. */
export function _laneDeliveryDroppedStale(partonId: string): void {
	const delivery = consumeLaneDelivery(partonId);
	if (delivery !== null) commitDelivery(delivery.seq);
}

function consumeLaneDelivery(partonId: string): WireDelivery | null {
	const queue = pendingLaneSeqs.get(partonId);
	const delivery = queue?.shift() ?? null;
	if (queue !== undefined && queue.length === 0) pendingLaneSeqs.delete(partonId);
	return delivery;
}

/** A payload segment was dropped by the as-of guard (or arrived torn
 *  under a supersede) on a continuing stream — consume its delivery as
 *  PROCESSED so the watermark stays contiguous; the server's fold gate
 *  keeps it out of the acked mirror. */
export function _segmentDeliveryDroppedStale(seq: number): void {
	commitDelivery(seq);
}

/** The transport's own ack producer — cumulative committed delivery
 *  seq, contributed whenever the watermark advanced past the last
 *  collected value. A passenger on whatever envelope flushes (the two
 *  advances that drive one live at `commitDelivery`). Loss-tolerant: a
 *  lost ack is subsumed by the next one; a failed FIRST ack is the
 *  degrade signal (handled in `flush`, which sees the whole envelope's
 *  fate). */
const ackProducer: ChannelProducer = {
	collect(connection: string | null): ChannelFrame | null {
		if (connection === null) return null;
		if (deliveredWatermark <= lastAckCollected) return null;
		lastAckCollected = deliveredWatermark;
		return { kind: "ack", delivered: deliveredWatermark };
	},
	deliveryFailed(): void {
		// Per-connection ack state resets at the next establishment; the
		// degrade decision lives in the flush's failure path.
	},
};

/**
 * Publish an established live connection. Called from the wire entry
 * above when the stream's `conn` handshake arrives; from here
 * producers address the connection with envelopes. Sets the
 * `data-parton-live` liveness marker and resets the per-connection
 * DELIVERY tracking (delivery seqs restart with the session; the
 * acked mirror layer resets with the connection — the attach manifest
 * is the durable evidence). The ENVELOPE seq is page-lifetime and
 * deliberately not reset — retransmitted reliable envelopes keep
 * their original seqs; establishment is their natural retransmit
 * point.
 */
export function _channelEstablished(connection: string): void {
	pendingLaneSeqs.clear();
	laneProducerWaiters.clear();
	deliveredOutOfOrder.clear();
	deliveredWatermark = 0;
	lastAckCollected = 0;
	ackDeliveredOnConnection = false;
	// Consequence gates anchor on the PREVIOUS connection's delivery
	// seqs — dead numbers now. Release them: the fresh connection's
	// whole-tree render is the catch-up (over-fetch, never a frozen
	// overlay).
	releaseAllConsequenceGates();
	retransmitPending = retransmitBuffer.length > 0;
	_setLiveConnectionId(connection);
	if (typeof document !== "undefined") {
		// Presence-only: the marker says "a live push channel is
		// established", never WHICH connection — the id is the envelope
		// credential and stays out of the DOM.
		document.documentElement.setAttribute("data-parton-live", "");
	}
	for (const cb of [...establishListeners]) cb(connection);
	if (retransmitPending) scheduleChannelFlush();
}

/** The live connection settled (keepalive elapsed, abort, error) —
 *  clear the published id and the liveness marker, and hand any
 *  navigation records the stream never answered to the discrete
 *  transport (their segment can no longer arrive). The heartbeat
 *  calls this when its fire's `finished` settles; fires are strictly
 *  sequential, so the settling connection's id is the current one. */
export function _channelConnectionClosed(): void {
	if (typeof document !== "undefined") {
		document.documentElement.removeAttribute("data-parton-live");
	}
	_setLiveConnectionId(null);
	fallbackPendingNavs();
	fallbackPendingFrameNavs();
	// The connection's delivery seqs are dead — a gate anchored on them
	// can never pass. Release: the reattach's whole-tree render carries
	// the consequences (over-fetch, never a frozen overlay).
	releaseAllConsequenceGates();
}

/** Request an envelope flush. Coalesced per animation frame (the
 *  producers' statement cadence) and inert during SSR — same guard
 *  the visibility controller's dispatch always had. */
export function scheduleChannelFlush(): void {
	if (rafScheduled || typeof requestAnimationFrame === "undefined") return;
	rafScheduled = true;
	requestAnimationFrame(() => {
		rafScheduled = false;
		void flush();
	});
}

async function flush(): Promise<void> {
	// Serialize: one envelope in flight. A flush requested meanwhile
	// re-fires when it lands (the `finally` below), so no statement is
	// stranded behind a consumed rAF.
	if (inFlight) {
		reflushPending = true;
		return;
	}
	const connection = _getLiveConnectionId();

	// Retransmit-first: a fresh establishment replays the reliable
	// buffer's survivors — original seqs, in order — before any new
	// envelope, so the server sees the page-lifetime seq timeline in
	// order. A failure mid-replay keeps the rest buffered for the next
	// establishment; the frames' producers are never handed back
	// (`reliable` — the buffer owns redelivery).
	if (retransmitPending && connection !== null) {
		inFlight = true;
		try {
			for (const entry of [...retransmitBuffer]) {
				if (_getLiveConnectionId() !== connection) return;
				const ok = await postEnvelope({
					connection,
					seq: entry.seq,
					frames: entry.frames,
				});
				if (!ok) {
					if (_getLiveConnectionId() === connection) _setLiveConnectionId(null);
					return;
				}
			}
			retransmitPending = false;
		} finally {
			inFlight = false;
			reflushPending = false;
		}
		// Collect whatever producers accumulated while replaying — on
		// failure too: the fallback cue (`collect(null)`) must reach
		// them, or statements strand until their next delta.
		scheduleChannelFlush();
		return;
	}

	const carried: Array<{ producer: ChannelProducer; frame: ChannelFrame }> = [];
	for (const producer of [...producers]) {
		const contributed = producer.collect(connection);
		if (contributed === null) continue;
		// A producer's array contribution stays in ITS order within the
		// envelope — the frame-navigation producer's cancel-then-url pair
		// relies on it.
		for (const frame of Array.isArray(contributed)
			? contributed
			: [contributed]) {
			carried.push({ producer, frame });
		}
	}
	if (connection === null || carried.length === 0) return;
	const carriesAck = carried.some((c) => c.frame.kind === "ack");
	inFlight = true;
	try {
		const seq = ++envelopeSeq;
		// Reliable frames enter the buffer BEFORE the POST — a failed (or
		// silently lost) envelope must leave them retransmittable. Only
		// the reliable frames: loss-tolerant co-riders self-heal and must
		// not replay.
		const reliableFrames = carried
			.filter((c) => c.producer.reliable === true)
			.map((c) => c.frame);
		if (reliableFrames.length > 0) {
			retransmitBuffer.push({ seq, frames: reliableFrames });
		}
		const delivered = await postEnvelope({
			connection,
			seq,
			frames: carried.map((c) => c.frame),
		});
		if (!delivered) {
			// The server's explicit "connection not open" signal (or the
			// POST never reached it). Clear the published id so producers'
			// re-owned statements — and everything after them, until the
			// heartbeat re-establishes — ride the discrete fallback.
			// Reliable frames stay in the buffer; their producers are not
			// handed back.
			if (_getLiveConnectionId() === connection) _setLiveConnectionId(null);
			for (const { producer, frame } of carried) {
				if (producer.reliable !== true) producer.deliveryFailed(frame);
			}
			// The envelope carried this connection's FIRST ack and it never
			// got through: the client committed deliveries the server will
			// never learn about — the duplex is broken (a blocked
			// `/__parton/*` POST path). Sticky page-lifetime degrade: the
			// heartbeat stops holding lanes-first live attaches and falls
			// back to periodic discrete reloads, so liveness never freezes
			// behind an unacked window.
			if (carriesAck && !ackDeliveredOnConnection) degraded = true;
			// Pending navigations — window and frame alike — can't reach the
			// server on this connection anymore: hand them to the discrete
			// transport NOW, and abort the held stream (it still renders the
			// state the page just left; the heartbeat reopens current).
			if (pendingNavRecords.length > 0 || pendingFrameNavRecords.length > 0) {
				fallbackPendingNavs();
				fallbackPendingFrameNavs();
				_channelAbortLiveStream();
			}
		} else if (carriesAck) {
			ackDeliveredOnConnection = true;
		}
	} finally {
		inFlight = false;
		if (reflushPending) {
			reflushPending = false;
			scheduleChannelFlush();
		}
	}
}

/** POST one envelope. `true` iff the server applied it (`204`);
 *  `false` on any other answer or a network failure. */
async function postEnvelope(envelope: ChannelEnvelope): Promise<boolean> {
	try {
		const res = await fetch(CHANNEL_ENDPOINT, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(envelope),
			// Fire-and-forget: let an in-flight envelope survive a page unload.
			keepalive: true,
		});
		return res.status === 204;
	} catch {
		return false;
	}
}

/** Send the explicit close for the open connection (if any) and clear
 *  the published id — a bfcache restore re-establishes via the
 *  heartbeat's next fire. The keepalive fetch is the one transport
 *  that survives the unload in progress. */
function sendDetach(): void {
	const connection = _getLiveConnectionId();
	if (connection === null) return;
	_setLiveConnectionId(null);
	void postEnvelope({
		connection,
		seq: ++envelopeSeq,
		frames: [{ kind: "detach" }],
	});
}

if (typeof window !== "undefined") {
	// `pagehide` covers tab close, cross-origin navigation, and bfcache
	// entry — every way the page stops being able to consume the held
	// stream. Same-origin soft navigations never fire it.
	window.addEventListener("pagehide", sendDetach);
}

// The transport's own producers — the ack passenger, the window url
// statement source, and the frame-navigation source — ride the same
// producer contract every external statement source uses.
registerChannelProducer(ackProducer);
registerChannelProducer(urlProducer);
registerChannelProducer(frameNavProducer);

/** Test-only: reset the transport's module state (seq, in-flight
 *  serialization, registrations, delivery tracking, buffer, degrade,
 *  navigation, frame navigation, consequence gates). */
export function _resetChannelClient(): void {
	producers.clear();
	registerChannelProducer(ackProducer);
	registerChannelProducer(urlProducer);
	registerChannelProducer(frameNavProducer);
	establishListeners.clear();
	envelopeSeq = 0;
	rafScheduled = false;
	inFlight = false;
	reflushPending = false;
	pendingLaneSeqs.clear();
	laneProducerWaiters.clear();
	deliveredOutOfOrder.clear();
	deliveredWatermark = 0;
	lastAckCollected = 0;
	ackDeliveredOnConnection = false;
	retransmitBuffer = [];
	appliedWatermark = 0;
	retransmitPending = false;
	degraded = false;
	navPoint = 0;
	statedWindowUrl = null;
	pendingNavFrame = null;
	pendingNavRecords = [];
	pendingFrameFrames = new Map();
	pendingCancelScopes = new Set();
	pendingFrameNavRecords = [];
	frameSeqKeys.clear();
	consequenceGates.clear();
	windowNavClaim = false;
	liveStreamAbort = null;
	_setLiveConnectionId(null);
}
