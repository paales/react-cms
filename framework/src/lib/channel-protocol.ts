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
 * states facts about itself — viewport flips, delivery acks, viewport
 * telemetry, and window URL moves — addressed to the OPEN live
 * connection by its explicit id. The server answers `204` with no body — every rendered consequence of a
 * frame travels down the live stream as lane segments, never on this
 * response. Frame kinds split into three classes:
 *
 *   - **loss-tolerant** (`visible`, `detach`, `ack`) — statements the
 *     protocol re-establishes on its own (the next attach's seed, the
 *     keepalive backstop, the cumulative ack watermark), so a lost
 *     envelope costs nothing durable. These never enter the transport's
 *     retransmit buffer.
 *   - **lossy** (`telemetry`, `warm`) — newest-wins, droppable. Only
 *     the latest statement has value (an old scroll vector describes a
 *     viewport that no longer exists; a preload is advisory), so the
 *     transport keeps at most one pending frame per producer, a failed
 *     delivery is simply dropped, and no fallback exists. The class is
 *     in the grammar NOW so a datagram transport can map onto it later
 *     without a redesign.
 *   - **reliable** (`url`, `cancel`) — buffered by the client
 *     transport (per its producer's `reliable` declaration, see
 *     [[channel-client]]) until the downstream `applied` marker covers
 *     their envelope seq, and retransmitted at the next establishment
 *     with their ORIGINAL seqs. Application idempotence is per kind,
 *     by seq-ordered statement semantics (the shipped `visible` per-id
 *     seq gate is the model; a `url` frame at or below the session's
 *     consumed navigation seq for its scope is a stale restatement and
 *     applies as a no-op; a `cancel` at or below its scope's applied
 *     seq likewise) — never a whole-envelope replay gate, which would
 *     break out-of-order statement queueing.
 */

/** POST target for channel envelopes. Framework-owned, handled by
 *  `createRscHandler` before any app routing — inside a lightweight
 *  request scope (see [[connection-session]]'s `handleChannelPost`). */
export const CHANNEL_ENDPOINT = "/__parton/channel";

/** POST target for the ATTACH — the connection's opening statement.
 *  The dedicated path IS the dispatch signal: a POST here carries the
 *  full client statement as its JSON body and is answered by the held
 *  segmented stream. The server builds the connection's request state
 *  from the statement's `url` (same-origin-validated); no page URL
 *  ever carries transport params for it. */
export const ATTACH_ENDPOINT = "/__parton/live";

/** Max delivery seqs a connection may have in flight past the client's
 *  cumulative ack before the driver stops opening lanes — the server's
 *  backpressure gate (sizing rationale at [[segmented-response]]'s
 *  window). Protocol-level because BOTH sides size against it: the
 *  client's self-driven ack cadence (`ACK_FLUSH_THRESHOLD` in
 *  [[channel-client]], half this window) must free the gate well
 *  before it fills, so the number the cadence derives from and the
 *  number the gate enforces are one constant. */
export const UNACKED_DELIVERY_WINDOW = 64;

/**
 * The attach statement — the full client statement presented when a
 * live connection opens, as the attach POST's JSON body:
 *
 *   - `url` — the client's window URL statement (path + search). The
 *     server builds the connection's request state from it — route
 *     key, match gates, tracked reads all evaluate the stated URL —
 *     after validating it same-origin against the POST itself. A
 *     one-shot `?__force=` overlay may ride its query (a selector
 *     refetch that fired pre-establishment — the same overlay a `url`
 *     frame carries); the server strips it from request state and
 *     lanes the named targets after the region opens.
 *   - `cached` — the manifest: every `id:matchKey:fp` token the client
 *     holds, stating WHAT it has. Uncapped: the body has no
 *     request-line limit, and the client pool bounds it structurally
 *     (the action POST's `?cached=` URL form keeps its cap).
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
 *   - `frames` — attach-with-intent: FRAME-scoped `url` statements
 *     that fired before the connection existed, riding the attach they
 *     triggered (first interaction never waits). Applied inside the
 *     attach's own request scope — the session frame URL writes land
 *     there, where a fresh session cookie can ride the response — so
 *     the whole-tree first render already reads them. WINDOW intent
 *     needs no frame entry: the statement's `url` IS the window
 *     statement (the attach subsumes the URL timeline).
 */
export interface AttachStatement {
	url: string;
	cached: readonly string[];
	since: { epoch: string; ts: number } | null;
	visible: readonly string[] | null;
	/** Optional on the wire (absent = 0 — a client stating no upstream
	 *  watermark); the decoder always normalizes it in. */
	applied?: number;
	/** Optional on the wire; entries MUST carry a frame path (window
	 *  intent folds into `url` — a window-scoped entry is malformed). */
	frames?: UrlFrame[];
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
	if (typeof v.url !== "string" || v.url.length === 0) return null;
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
	// Attach-with-intent: frame-scoped url statements riding the attach
	// they triggered. Window intent has no place here — the statement's
	// `url` IS the window statement — so a frame-less entry is malformed.
	let frames: UrlFrame[] | undefined;
	if (v.frames !== null && v.frames !== undefined) {
		if (!Array.isArray(v.frames)) return null;
		frames = [];
		for (const raw of v.frames) {
			if (raw === null || typeof raw !== "object") return null;
			const decoded = decodeUrlFrameShape(raw as Record<string, unknown>);
			if (decoded === null || decoded.frame === undefined) return null;
			frames.push(decoded);
		}
	}
	return {
		url: v.url,
		cached: v.cached,
		since,
		visible,
		applied,
		...(frames !== undefined && frames.length > 0 ? { frames } : {}),
	};
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
 *
 * `dropped` names delivery seqs WITHIN the newly-acked range the client
 * received but did NOT hold: the content rendered as-of a navigation
 * point the client had already left, so its as-of guard
 * (`_channelDeliveryCommittable`) dropped it at arrival. The seq still
 * advances the client's contiguous watermark (a permanent gap would
 * wedge the window), so it rides the cumulative `delivered` — but the
 * server must not treat it as a holding: it EVICTS the delivery's
 * optimistic mirror promotions and never folds them into the acked
 * layer. Absent (or empty) = the client held every acked delivery. An
 * explicit drop statement, not a server-side inference: only the client
 * knows which arrivals its live navigation point superseded.
 */
export interface AckFrame {
	kind: "ack";
	delivered: number;
	dropped?: number[];
}

/**
 * Viewport telemetry — the client's scroll context, stated so the
 * server can anticipate (predictive cache warming is the first
 * consumer — see [[segmented-response]]'s warm pass). The LOSSY frame
 * class: newest-wins per flush, droppable, no fallback. Content v1:
 *
 *   - `viewport` — the scroll container's client box, CSS px.
 *   - `scroll` — position (`x`,`y`, the container's scrollLeft/Top)
 *     and velocity (`vx`,`vy`, px/s; signed).
 *   - `at` — the client's performance-clock timestamp (ms) of the
 *     measurement, a timing mark for correlating successive frames.
 *
 * Applying one updates the connection session's telemetry slot and
 * NOTHING else — no invalidation, no wake, never a render
 * ([[connection-session]]): the channel carries freshness statements,
 * and telemetry is context, not a dependency.
 */
export interface TelemetryFrame {
	kind: "telemetry";
	viewport: { w: number; h: number };
	scroll: { x: number; y: number; vx: number; vy: number };
	at: number;
}

/**
 * URL statement — a URL scope the client owns moved. Two scopes, one
 * kind: absent `frame`, the WINDOW URL (a navigation, a targeted
 * refetch restating the URL it targets, or a silent URL-only sync);
 * present, the named FRAME's URL (the ambient frame chain's segments —
 * a frame navigate/reload/traverse). The RELIABLE class: the frame
 * rides the transport's retransmit buffer until the downstream
 * `applied` marker covers its envelope seq.
 *
 *   - `url` — the target as path + search (an absolute same-origin URL
 *     is accepted and reduced). The server VALIDATES same-origin
 *     against the envelope's own request and answers `400` on a
 *     cross-origin target — a protocol violation, not extensibility.
 *     One-shot transport params (`partials`, a window statement's
 *     `__force` overlay) may ride the query for a targeted refetch;
 *     they never persist into request state.
 *   - `intent` — the client's history semantic for the move
 *     (`push`/`replace`; `silent` = URL-only sync or a same-URL
 *     targeted refetch). The client's history work is already done by
 *     the time the frame is sent (the statement describes, never
 *     requests), so the server's render behavior is intent-independent
 *     today; the field exists so the statement stays complete.
 *   - `frame` — the frame path (outer-most first, e.g.
 *     `["cart","tab"]`). Absent = window scope.
 *
 * A WINDOW statement latches on the connection session (newest seq
 * wins) and is consumed by the segment driver at wait entry —
 * navigation-first, ahead of pending flips — which applies the URL to
 * the connection's request state and answers with a full payload
 * segment in stream order. A FRAME statement writes the session frame
 * URL at the endpoint (the same store `?__frame=` writes through) and
 * latches per frame key; the driver consumes it by laning the frame's
 * targets EXPLICIT on the open region — frame content is a subtree,
 * never the whole route, so no region tear. Every emission carries the
 * consumed url-statement seq it was rendered AS-OF (see
 * [[fp-trailer-marker]]'s `seq` entry).
 */
export interface UrlFrame {
	kind: "url";
	url: string;
	intent: "push" | "replace" | "silent";
	streaming?: boolean;
	frame?: string[];
}

/**
 * Explicit supersede of a scope's in-flight renders. `scope` names a
 * frame's top-level name; the server aborts the open lanes whose
 * parton belongs to that scope — a superseding frame navigation sends
 * `cancel` + `url` in ONE envelope, and the in-order pass applies
 * cancel-then-url. RELIABLE class; idempotence is the per-scope seq
 * gate (a retransmitted cancel at or below the last applied seq for
 * its scope is a no-op, so it can never abort a newer statement's
 * render).
 */
export interface CancelFrame {
	kind: "cancel";
	scope: string;
}

/**
 * Warm intent — the client states a route it expects to visit
 * (`useNavigation().preload(target)` on hover). The LOSSY class, like
 * telemetry: newest-wins (one pending target — the latest hover),
 * droppable, no fallback — a preload is advisory. Applying one
 * replaces the session's warm slot and wakes the driver, whose park
 * point runs ONE byte-silent whole-tree render of the target URL into
 * the server's caches (same rules as the telemetry warm pass:
 * bounded, window-respecting, never keepalive activity) — the
 * navigation statement that follows renders against warm caches.
 * Same-origin-validated at the endpoint like `url` frames: the target
 * becomes a render's request state.
 */
export interface WarmFrame {
	kind: "warm";
	url: string;
}

/** The frame kinds shipped today. The grammar is open: an envelope may
 *  carry kinds this build doesn't know, and the decoder SKIPS those
 *  rather than erroring, the same extensibility rule the downstream
 *  marker grammar follows. */
export type ChannelFrame =
	| VisibleFrame
	| DetachFrame
	| AckFrame
	| TelemetryFrame
	| UrlFrame
	| CancelFrame
	| WarmFrame;

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
	if (typeof v.connection !== "string" || v.connection.length === 0)
		return null;
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
			// `dropped` is optional; when present it must be an array of
			// non-negative finite numbers — a malformed one is a protocol
			// violation like any known-kind field's (the envelope 400s).
			let dropped: number[] | undefined;
			if (f.dropped !== undefined && f.dropped !== null) {
				if (!Array.isArray(f.dropped)) return null;
				for (const d of f.dropped) {
					if (typeof d !== "number" || !Number.isFinite(d) || d < 0)
						return null;
				}
				dropped = f.dropped as number[];
			}
			frames.push({
				kind: "ack",
				delivered: f.delivered,
				...(dropped !== undefined && dropped.length > 0 ? { dropped } : {}),
			});
			continue;
		}
		if (f.kind === "telemetry") {
			// Strict-known: a malformed telemetry frame is a protocol
			// violation like any known kind's — lossy class means droppable
			// in transit, never sloppily decoded.
			const viewport = decodeFiniteRecord(f.viewport, ["w", "h"]);
			const scroll = decodeFiniteRecord(f.scroll, ["x", "y", "vx", "vy"]);
			if (viewport === null || scroll === null) return null;
			if (typeof f.at !== "number" || !Number.isFinite(f.at)) return null;
			frames.push({
				kind: "telemetry",
				viewport: viewport as TelemetryFrame["viewport"],
				scroll: scroll as TelemetryFrame["scroll"],
				at: f.at,
			});
			continue;
		}
		if (f.kind === "url") {
			// Strict-known: a malformed url frame is a protocol violation.
			// Same-origin validation needs the request and lives with the
			// endpoint (`handleChannelPost`) — the decoder checks shape only.
			const decoded = decodeUrlFrameShape(f);
			if (decoded === null) return null;
			frames.push(decoded);
			continue;
		}
		if (f.kind === "cancel") {
			// Strict-known: a malformed cancel frame is a protocol violation.
			if (typeof f.scope !== "string" || f.scope.length === 0) return null;
			frames.push({ kind: "cancel", scope: f.scope });
			continue;
		}
		if (f.kind === "warm") {
			// Strict-known: a malformed warm frame is a protocol violation.
			// Same-origin validation lives with the endpoint, like `url`.
			if (typeof f.url !== "string" || f.url.length === 0) return null;
			frames.push({ kind: "warm", url: f.url });
			continue;
		}
		// Unknown kind — skipped, never an error.
	}
	return { connection: v.connection, seq: v.seq, frames };
}

/** Decode the `url`-frame field shape (`kind` already established, or
 *  implied — the attach statement's `frames` entries). `null` when
 *  malformed. Frame scope, when present, is a non-empty path of
 *  non-empty segment names. */
function decodeUrlFrameShape(f: Record<string, unknown>): UrlFrame | null {
	if (typeof f.url !== "string" || f.url.length === 0) return null;
	if (f.intent !== "push" && f.intent !== "replace" && f.intent !== "silent")
		return null;
	let framePath: string[] | undefined;
	if (f.frame !== undefined && f.frame !== null) {
		if (!isStringArray(f.frame) || f.frame.length === 0) return null;
		if (f.frame.some((s) => s.length === 0)) return null;
		framePath = f.frame;
	}
	return {
		kind: "url",
		url: f.url,
		intent: f.intent,
		...(f.streaming === true ? { streaming: true } : {}),
		...(framePath ? { frame: framePath } : {}),
	};
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((x) => typeof x === "string");
}

/** Decode an object whose named keys must all be finite numbers.
 *  Returns the picked record, or `null` when any key is missing or
 *  non-finite. Unknown extra keys are ignored — the statement grows by
 *  adding fields. */
function decodeFiniteRecord(
	value: unknown,
	keys: readonly string[],
): Record<string, number> | null {
	if (value === null || typeof value !== "object") return null;
	const v = value as Record<string, unknown>;
	const out: Record<string, number> = {};
	for (const key of keys) {
		const n = v[key];
		if (typeof n !== "number" || !Number.isFinite(n)) return null;
		out[key] = n;
	}
	return out;
}
