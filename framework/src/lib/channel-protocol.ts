/**
 * The channel's upstream wire protocol — the envelope shape shared by
 * the client transport and the server's connection-session layer
 * ([[connection-session]]), plus the ATTACH statement (the body of the
 * heartbeat's live-fire POST — the full client statement a connection
 * opens with). Import-safe on
 * both sides: no server or DOM dependencies, just the endpoint path,
 * the grammar, and its decoders.
 *
 * An envelope is one coalesced, fire-and-forget POST: the client
 * states facts about itself — viewport flips and delivery acks today;
 * URL moves and telemetry are reserved kinds (see
 * `docs/notes/channel-design.md`) — addressed to the OPEN live
 * connection by its explicit id. The server answers `204` with no body — every rendered consequence of a
 * frame travels down the live stream as lane segments, never on this
 * response. Frame kinds split into two classes:
 *
 *   - **loss-tolerant** (`visible`, `detach`, `ack`) — statements the
 *     protocol re-establishes on its own (the next attach's seed, the
 *     keepalive backstop, the cumulative ack watermark), so a lost
 *     envelope costs nothing durable. These never enter the transport's
 *     retransmit buffer.
 *   - **reliable** (the url / cancel kinds later packages add) —
 *     buffered by the client transport (per its producer's `reliable`
 *     declaration, see [[channel-client]]) until the downstream
 *     `applied` marker covers their envelope seq, and retransmitted at
 *     the next attach with their ORIGINAL seqs. Application idempotence
 *     is per kind, by seq-ordered statement semantics (the shipped
 *     `visible` per-id seq gate is the model) — never a whole-envelope
 *     replay gate, which would break out-of-order statement queueing.
 */

/** POST target for channel envelopes. Framework-owned, handled by
 *  `createRscHandler` before any app routing — inside a lightweight
 *  request scope (see [[connection-session]]'s `handleChannelPost`). */
export const CHANNEL_ENDPOINT = "/__parton/channel";

/** Request-shape marker for the ATTACH — the heartbeat's live fire as
 *  a POST whose body carries the client statement below. The explicit
 *  dispatch signal `parseRenderRequest` keys on: an `_.rsc` POST with
 *  this header is the attach (full segmented drive + fp-trailer), one
 *  with `x-rsc-action` is an action (commit-only, one segment) — the
 *  body's shape decides nothing. */
export const ATTACH_HEADER = "x-parton-attach";

/**
 * The attach statement — the full client statement presented when a
 * live connection opens, as the attach POST's JSON body:
 *
 *   - `cached` — the manifest: every `id:matchKey:fp` token the client
 *     holds, stating WHAT it has. Uncapped: the body has no
 *     request-line limit, and the client pool bounds it structurally
 *     (the discrete `?cached=` URL form keeps its cap).
 *   - `since` — the catch-up anchor, stating WHEN the client last
 *     heard: the document's registry timeline point. `null` when the
 *     client has no anchor (reopens, post-navigation fires).
 *   - `visible` — the viewport seed, stating what the client SEES.
 *     `null` is the unmeasured state (no statement); an empty array is
 *     a measurement ("nothing in view").
 *   - `applied` — the upstream watermark, stating what the client last
 *     HEARD the server apply: the highest upstream envelope seq from a
 *     downstream `applied` marker (0 before any). The upstream seq is
 *     page-lifetime monotonic, so the new session seeds its applied
 *     watermark here and the marker stays monotonic across reattaches.
 *     Composition with the other timeline fields: `since` bounds the
 *     DOWNSTREAM resync window (what the initial segment must cover),
 *     `applied` anchors the UPSTREAM timeline (what the marker may
 *     assume already announced), and delivery acks bound the mirror —
 *     three statements about three different clocks, never competing
 *     resync mechanisms.
 */
export interface AttachStatement {
	cached: readonly string[];
	since: { epoch: string; ts: number } | null;
	visible: readonly string[] | null;
	/** Optional on the wire (absent = 0 — a client stating no upstream
	 *  watermark); the decoder always normalizes it in. */
	applied?: number;
}

/**
 * Decode a parsed JSON body into an attach statement. Returns `null`
 * when the statement is malformed (the entry answers `400`). Unknown
 * fields are IGNORED, never errors — the statement grows by adding
 * fields (the ack watermark seeds here next), and an old server must
 * stay indifferent to a newer client's statement.
 */
export function decodeAttachStatement(value: unknown): AttachStatement | null {
	if (value === null || typeof value !== "object") return null;
	const v = value as Record<string, unknown>;
	if (!isStringArray(v.cached)) return null;
	let since: AttachStatement["since"] = null;
	if (v.since !== null && v.since !== undefined) {
		if (typeof v.since !== "object") return null;
		const s = v.since as Record<string, unknown>;
		if (typeof s.epoch !== "string" || s.epoch.length === 0) return null;
		if (typeof s.ts !== "number" || !Number.isFinite(s.ts) || s.ts < 0)
			return null;
		since = { epoch: s.epoch, ts: s.ts };
	}
	let visible: AttachStatement["visible"] = null;
	if (v.visible !== null && v.visible !== undefined) {
		if (!isStringArray(v.visible)) return null;
		visible = v.visible;
	}
	// Absent `applied` normalizes to 0 — a client from before the ack
	// package states no upstream watermark, and 0 is exactly that.
	let applied = 0;
	if (v.applied !== null && v.applied !== undefined) {
		if (
			typeof v.applied !== "number" ||
			!Number.isFinite(v.applied) ||
			v.applied < 0
		)
			return null;
		applied = v.applied;
	}
	return { cached: v.cached, since, visible, applied };
}

/**
 * A viewport-visibility statement — the culling controller's report as
 * a channel frame. Statement semantics live with the connection
 * session ([[connection-session]]): each `changed` id's DIRECTION is
 * its presence in this frame's `visible` snapshot (present = in-flip,
 * absent = out-flip); the flip resolves against its own frame's
 * statement, never a later frame's snapshot. Ordered viewport-first
 * (in-view flips before cull-outs) so the visible world's lanes lead.
 */
export interface VisibleFrame {
	kind: "visible";
	/** Parton ids whose in/out state flipped since the last statement. */
	changed: string[];
	/** The complete visible set as of this frame. Replaces the
	 *  connection's set wholesale (no incremental merge). */
	visible: string[];
	/** The client's CURRENT cached tokens (`id:matchKey:fp`) for the
	 *  `changed` ids — its actual holdings at flip time, which the
	 *  driver swaps into the connection's cached override before a
	 *  direct flip's lane renders. An EMPTY array is a statement ("I
	 *  hold nothing"); an ABSENT field makes no holdings statement. */
	cached?: string[];
}

/**
 * Explicit close — the client is leaving (tab close, cross-origin
 * navigation), sent via a keepalive fetch on `pagehide`. Best-effort
 * by nature (an unload beacon can always be lost); the driver's
 * keepalive timeout remains the backstop. The driver wakes, exits its
 * drive loop, and closes the session.
 */
export interface DetachFrame {
	kind: "detach";
}

/**
 * Cumulative delivery ack — the client states the highest CONTIGUOUSLY
 * COMMITTED delivery seq (the `seq` entries payload segments and lanes
 * carry, recorded at commit time, never at decode). Cumulative, so a
 * lost or reordered ack costs nothing: any later ack subsumes it, and
 * applying one twice is a no-op (the session's watermark only moves
 * forward). Connection-scoped — delivery seqs restart per connection —
 * so acks never enter the retransmit buffer. On the server the ack is
 * what advances the mirror's ACKED layer (the fps the acked emissions
 * carried become client-proven holdings) and what frees the unacked
 * delivery window the driver gates lane opening on.
 */
export interface AckFrame {
	kind: "ack";
	delivered: number;
}

/** The frame kinds shipped today. The grammar is open: an envelope may
 *  carry kinds this build doesn't know (url / cancel / telemetry land
 *  in later packages — `docs/notes/channel-design.md` § Wire shape),
 *  and the decoder SKIPS those rather than erroring, the same
 *  extensibility rule the downstream marker grammar follows. */
export type ChannelFrame = VisibleFrame | DetachFrame | AckFrame;

export interface ChannelEnvelope {
	/** The live connection this envelope addresses. An explicit token,
	 *  never inferred: an envelope for a connection the server doesn't
	 *  hold gets a `404`, the transport's fall-back-to-discrete
	 *  signal. */
	connection: string;
	/** PAGE-LIFETIME monotonic envelope sequence — minted by the client
	 *  transport and never restarted at establishment, so retransmitted
	 *  reliable envelopes keep their original seqs across reattaches and
	 *  the downstream `applied` marker names one unambiguous timeline.
	 *  The server applies a `visible` frame's snapshot only from
	 *  envelopes at or past the last applied seq, so two in-flight POSTs
	 *  can't commit an older set over a newer one; per-id flip
	 *  statements order by seq independently (a stale envelope's flips
	 *  still queue — see [[connection-session]]). */
	seq: number;
	/** Frames, ordered within the envelope. */
	frames: ChannelFrame[];
}

/**
 * Decode a parsed JSON body into an envelope. Returns `null` when the
 * envelope itself — or any KNOWN-kind frame — is malformed (the
 * endpoint answers `400`: a protocol violation, not extensibility).
 * Frames of UNKNOWN kind are dropped from the result, not errors: the
 * grammar grows by adding kinds, and an old server must stay
 * indifferent to a newer client's frames.
 */
export function decodeChannelEnvelope(value: unknown): ChannelEnvelope | null {
	if (value === null || typeof value !== "object") return null;
	const v = value as Record<string, unknown>;
	if (typeof v.connection !== "string" || v.connection.length === 0) return null;
	if (typeof v.seq !== "number" || !Number.isFinite(v.seq)) return null;
	if (!Array.isArray(v.frames)) return null;
	const frames: ChannelFrame[] = [];
	for (const raw of v.frames) {
		if (raw === null || typeof raw !== "object") return null;
		const f = raw as Record<string, unknown>;
		if (typeof f.kind !== "string") return null;
		if (f.kind === "visible") {
			if (!isStringArray(f.changed) || !isStringArray(f.visible)) return null;
			if (f.cached !== undefined && !isStringArray(f.cached)) return null;
			frames.push({
				kind: "visible",
				changed: f.changed,
				visible: f.visible,
				cached: f.cached,
			});
			continue;
		}
		if (f.kind === "detach") {
			frames.push({ kind: "detach" });
			continue;
		}
		if (f.kind === "ack") {
			if (
				typeof f.delivered !== "number" ||
				!Number.isFinite(f.delivered) ||
				f.delivered < 0
			)
				return null;
			frames.push({ kind: "ack", delivered: f.delivered });
			continue;
		}
		// Unknown kind — skipped, never an error.
	}
	return { connection: v.connection, seq: v.seq, frames };
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((x) => typeof x === "string");
}
