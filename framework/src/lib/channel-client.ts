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
 *
 * Loss-tolerant by design: no retransmit buffer, no delivery acks —
 * only frame kinds whose statements are re-established by the next
 * heartbeat fire's seed may ride the channel (the design note's
 * reliable-class frames wait on the ack machinery).
 */

import {
	CHANNEL_ENDPOINT,
	type ChannelEnvelope,
	type ChannelFrame,
} from "./channel-protocol.ts";
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
	 *  its fallback. */
	deliveryFailed(frame: ChannelFrame): void;
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

let envelopeSeq = 0;
let rafScheduled = false;
let inFlight = false;
let reflushPending = false;

/**
 * Publish an established live connection. Called when the
 * subscription is provably open server-side; from here producers
 * address it with envelopes. Sets the `data-parton-live` liveness
 * marker and restarts the envelope seq (per-connection monotonic —
 * the server session's seq gate starts fresh with the session).
 */
export function _channelEstablished(connection: string): void {
	envelopeSeq = 0;
	_setLiveConnectionId(connection);
	if (typeof document !== "undefined") {
		document.documentElement.setAttribute("data-parton-live", connection);
	}
	for (const cb of [...establishListeners]) cb(connection);
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
	const carried: Array<{ producer: ChannelProducer; frame: ChannelFrame }> = [];
	for (const producer of [...producers]) {
		const frame = producer.collect(connection);
		if (frame !== null) carried.push({ producer, frame });
	}
	if (connection === null || carried.length === 0) return;
	inFlight = true;
	try {
		const delivered = await postEnvelope({
			connection,
			seq: ++envelopeSeq,
			frames: carried.map((c) => c.frame),
		});
		if (!delivered) {
			// The server's explicit "connection not open" signal (or the
			// POST never reached it). Clear the published id so producers'
			// re-owned statements — and everything after them, until the
			// heartbeat re-establishes — ride the discrete fallback.
			if (_getLiveConnectionId() === connection) _setLiveConnectionId(null);
			for (const { producer, frame } of carried) producer.deliveryFailed(frame);
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

/** Test-only: reset the transport's module state (seq, in-flight
 *  serialization, registrations). */
export function _resetChannelClient(): void {
	producers.clear();
	establishListeners.clear();
	envelopeSeq = 0;
	rafScheduled = false;
	inFlight = false;
	reflushPending = false;
	_setLiveConnectionId(null);
}
