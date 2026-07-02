/**
 * Connection-session state — per-live-connection server state, keyed by
 * the explicit connection id (`?__conn=`) the client's heartbeat mints
 * for each `?live=1` stream it opens.
 *
 * A live connection is long-lived (the segment driver parks it between
 * wakes), and some request dimensions move WHILE it is open. The first
 * such dimension is the viewport-visibility set behind the `visible()`
 * hook: the client reports flips as fire-and-forget POSTs to
 * [[visibility-protocol]]'s endpoint, the report updates the session's
 * `visible` set, and the segment driver treats the flipped ids like an
 * invalidation wake — rendering them as lanes on the EXISTING stream.
 * The session's set IS part of the connection's request state:
 * `visible()` and the fingerprint fold's store-and-reread both read it
 * (session first, `?visible=` URL param as the no-session fallback), so
 * the read stays request-reproducible — every re-evaluation during one
 * wake agrees on the same set, and every change to the set arrives with
 * an explicit wake naming the ids it flipped.
 *
 * Lifecycle: the segment driver opens the session when it starts
 * driving a `?live=1&__conn=` response (seeding `visible` from the
 * request's `?visible=` param, so the whole-tree first segment already
 * renders against the client's measured set) and closes it when the
 * drive loop exits (keepalive elapsed, client abort). A report for an
 * unknown id returns `false` → the endpoint answers `404`, the explicit
 * "this connection is gone" signal the client controller falls back on.
 */

import {
	isVisibilityReport,
	type VisibilityReport,
} from "./visibility-protocol.ts";

export interface ConnectionSession {
	readonly id: string;
	/** The connection's current visible set. `null` until the request's
	 *  `?visible=` seed or the first report — the pre-measurement state,
	 *  in which reads fall back to the request URL (absent → `undefined`,
	 *  the `visible()` cold token). Replaced wholesale per report, never
	 *  mutated, so a render that grabbed the reference mid-report keeps a
	 *  consistent view. */
	visible: ReadonlySet<string> | null;
	/** Last applied report seq — the stale-report gate for `visible`. */
	lastSeq: number;
	/** Flipped ids awaiting a lane render. The driver drains via
	 *  `takeConnectionFlips`. */
	readonly pendingFlips: Set<string>;
	/** Resolves when a report lands — the segment driver's visibility
	 *  wake arm. Re-armed by `takeConnectionFlips`. */
	flipped: Promise<void>;
	_signalFlip: () => void;
}

const sessions = new Map<string, ConnectionSession>();

function armFlipWake(session: ConnectionSession): void {
	session.flipped = new Promise<void>((resolve) => {
		session._signalFlip = resolve;
	});
}

/** Open (register) a session for a live connection. Called by the
 *  segment driver before its first segment renders, so a report can
 *  land at any point of the connection's lifetime. */
export function _openConnectionSession(
	id: string,
	initialVisible: ReadonlySet<string> | null,
): ConnectionSession {
	const session: ConnectionSession = {
		id,
		visible: initialVisible,
		lastSeq: 0,
		pendingFlips: new Set(),
		flipped: Promise.resolve(),
		_signalFlip: () => {},
	};
	armFlipWake(session);
	sessions.set(id, session);
	return session;
}

/** Unregister a session — the drive loop exited; the stream is closed
 *  or closing. Reports for the id now return `false` (→ `404`). */
export function _closeConnectionSession(id: string): void {
	sessions.delete(id);
}

/**
 * Apply a visibility report to its connection. Returns `false` when no
 * session holds the id (connection closed / never opened) — the
 * caller's explicit fallback signal.
 *
 * `visible` replaces the session set only when the report is newer than
 * the last applied one (`seq` gate); `changed` ids merge into
 * `pendingFlips` unconditionally — a superseded report's flips still
 * need their lane render, and the render reads the CURRENT set either
 * way. Always signals the flip wake so the parked driver re-evaluates.
 */
export function reportConnectionVisibility(
	id: string,
	seq: number,
	changed: readonly string[],
	visible: readonly string[],
): boolean {
	const session = sessions.get(id);
	if (!session) return false;
	for (const c of changed) session.pendingFlips.add(c);
	if (seq > session.lastSeq) {
		session.lastSeq = seq;
		session.visible = new Set(visible);
	}
	session._signalFlip();
	return true;
}

/** Drain the session's pending flips and re-arm the flip wake. The
 *  drain and re-arm are one step so a report landing right after the
 *  drain arms a fresh wake instead of vanishing into a consumed one. */
export function takeConnectionFlips(session: ConnectionSession): string[] {
	const flips = [...session.pendingFlips];
	session.pendingFlips.clear();
	armFlipWake(session);
	return flips;
}

/**
 * The framework endpoint body for `POST /__parton/visible` — decode,
 * validate, apply. `204` (no body) on success: the flipped partons'
 * bytes travel down the live stream as lanes, never on this response.
 * `404` when the connection isn't open — the client controller's signal
 * to deliver the batch via the render-reload fallback. `400` on a
 * malformed body.
 */
export async function handleVisibilityReport(
	request: Request,
): Promise<Response> {
	let report: VisibilityReport;
	try {
		const body: unknown = await request.json();
		if (!isVisibilityReport(body))
			throw new Error("malformed visibility report");
		report = body;
	} catch {
		return new Response(null, { status: 400 });
	}
	const applied = reportConnectionVisibility(
		report.connection,
		report.seq,
		report.changed,
		report.visible,
	);
	return new Response(null, { status: applied ? 204 : 404 });
}
