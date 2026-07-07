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
 *     an internal producer — piggybacked on any pending envelope, else
 *     the same rAF-coalesced flush every statement rides (no timers).
 *   - **The reliable class + retransmit.** Frames from producers
 *     declaring `reliable: true` are buffered per envelope (with the
 *     envelope's seq) until the downstream `applied` marker covers
 *     them, and retransmitted — original seqs, in order, ahead of new
 *     flushes — when the next connection establishes. The envelope seq
 *     is PAGE-LIFETIME monotonic for exactly this reason. The shipped
 *     kinds are all loss-tolerant (visible/detach statements re-seed;
 *     acks are connection-scoped and cumulative) so the buffer holds
 *     nothing today — the machinery exists for the url/cancel kinds.
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
} from "./channel-protocol.ts";
import {
	TAG_CONNECTION_ID,
	TAG_DELIVERY_SEQ,
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
	/** Contribute at most one frame to the envelope being assembled.
	 *  `connection` is the open connection's id, or `null` when none is
	 *  established — the producer's cue to deliver its pending
	 *  statements via its own discrete fallback instead (and return
	 *  `null`). Called only when an envelope can actually fire (never
	 *  while one is in flight), so the frame's content is always the
	 *  producer's latest state. */
	collect(connection: string | null): ChannelFrame | null;
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

/** Per-parton FIFO of lane delivery seqs read off the wire (`seq`
 *  entries precede their lane's `muxend`). Successive lanes for one
 *  parton commit in arrival order (the browser entry chains them), so
 *  the queue head always names the seq of the payload being
 *  committed. */
const pendingLaneSeqs = new Map<string, number[]>();
/** Highest contiguously committed delivery seq — the ack value. */
let deliveredWatermark = 0;
/** Committed seqs past a gap in the contiguous frontier. */
const deliveredOutOfOrder = new Set<number>();
/** The watermark value last carried on a collected ack frame. */
let lastAckCollected = 0;
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
	if (tag === TAG_DELIVERY_SEQ) {
		const text = new TextDecoder().decode(body);
		const nl = text.indexOf("\n");
		if (nl < 0) return; // segment form — fetch-local, see above
		const partonId = text.slice(0, nl);
		const seq = Number(text.slice(nl + 1));
		if (!Number.isFinite(seq)) return;
		let queue = pendingLaneSeqs.get(partonId);
		if (!queue) {
			queue = [];
			pendingLaneSeqs.set(partonId, queue);
		}
		queue.push(seq);
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

/** Parse a payload segment's delivery seq off a wire entry — the
 *  segment form of the `seq` tag (decimal body, no parton-id prefix).
 *  `null` for every other entry. The browser entry keeps the value
 *  FETCH-LOCAL and records it via `_segmentDeliveryCommitted` when the
 *  segment's payload commits. */
export function _segmentDeliverySeq(tag: string, body: Uint8Array): number | null {
	if (tag !== TAG_DELIVERY_SEQ) return null;
	const text = new TextDecoder().decode(body);
	if (text.includes("\n")) return null; // lane form — queued above
	const seq = Number(text);
	return Number.isFinite(seq) ? seq : null;
}

/** Record a committed delivery and schedule the coalesced ack when the
 *  contiguous frontier advanced. */
function commitDelivery(seq: number): void {
	if (seq <= deliveredWatermark) return;
	if (seq === deliveredWatermark + 1) {
		deliveredWatermark = seq;
		while (deliveredOutOfOrder.delete(deliveredWatermark + 1)) {
			deliveredWatermark += 1;
		}
		// Piggyback on any pending envelope, else ride the transport's
		// own rAF batch — the ack producer contributes iff the watermark
		// moved past the last collected value. No timers.
		if (deliveredWatermark > lastAckCollected) scheduleChannelFlush();
		return;
	}
	deliveredOutOfOrder.add(seq);
}

/** A payload segment on the live stream committed — record the seq its
 *  `seq` entry announced (the browser entry held it fetch-locally). */
export function _segmentDeliveryCommitted(seq: number): void {
	commitDelivery(seq);
}

/** A lane payload for `partonId` committed — consume the queue head
 *  minted when its `seq` entry was read. No-op when no seq is queued
 *  (a stream without deliveries: no session, or an older server). */
export function _laneDeliveryCommitted(partonId: string): void {
	const queue = pendingLaneSeqs.get(partonId);
	const seq = queue?.shift();
	if (queue !== undefined && queue.length === 0) pendingLaneSeqs.delete(partonId);
	if (seq !== undefined) commitDelivery(seq);
}

/** A lane payload for `partonId` was decoded but NOT committed (stale
 *  page guard, torn decode). Consume the queue head WITHOUT recording:
 *  attribution for later lanes stays aligned, and the watermark stalls
 *  at the dropped seq — the server never treats the drop as held. */
export function _laneDeliveryDropped(partonId: string): void {
	const queue = pendingLaneSeqs.get(partonId);
	queue?.shift();
	if (queue !== undefined && queue.length === 0) pendingLaneSeqs.delete(partonId);
}

/** The transport's own ack producer — cumulative committed delivery
 *  seq, contributed whenever the watermark advanced past the last
 *  collected value. Loss-tolerant: a lost ack is subsumed by the next
 *  one; a failed FIRST ack is the degrade signal (handled in `flush`,
 *  which sees the whole envelope's fate). */
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
	deliveredOutOfOrder.clear();
	deliveredWatermark = 0;
	lastAckCollected = 0;
	ackDeliveredOnConnection = false;
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
 *  clear the published id and the liveness marker. The heartbeat
 *  calls this when its fire's `finished` settles; fires are strictly
 *  sequential, so the settling connection's id is the current one. */
export function _channelConnectionClosed(): void {
	if (typeof document !== "undefined") {
		document.documentElement.removeAttribute("data-parton-live");
	}
	_setLiveConnectionId(null);
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
		const frame = producer.collect(connection);
		if (frame !== null) carried.push({ producer, frame });
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

// The transport's own ack producer rides the same producer contract
// every external statement source uses.
registerChannelProducer(ackProducer);

/** Test-only: reset the transport's module state (seq, in-flight
 *  serialization, registrations, delivery tracking, buffer, degrade). */
export function _resetChannelClient(): void {
	producers.clear();
	registerChannelProducer(ackProducer);
	establishListeners.clear();
	envelopeSeq = 0;
	rafScheduled = false;
	inFlight = false;
	reflushPending = false;
	pendingLaneSeqs.clear();
	deliveredOutOfOrder.clear();
	deliveredWatermark = 0;
	lastAckCollected = 0;
	ackDeliveredOnConnection = false;
	retransmitBuffer = [];
	appliedWatermark = 0;
	retransmitPending = false;
	degraded = false;
	_setLiveConnectionId(null);
}
