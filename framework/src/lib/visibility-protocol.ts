/**
 * The visibility-report wire protocol — the shape shared by the client
 * controller ([[visibility]]) and the server's connection-session layer
 * ([[connection-session]]). Import-safe on both sides: no server or DOM
 * dependencies, just the endpoint path and the report body.
 *
 * A report is a fire-and-forget POST: the client's visibility controller
 * sends viewport flips to the OPEN live connection (identified by the
 * explicit `connection` token the heartbeat minted) instead of firing a
 * render-reload that would race that connection's own renders. The
 * server answers `204` with no body — the rendered bytes for the flipped
 * partons come down the live stream as lane segments, never on this
 * response.
 */

/** POST target for visibility reports. Framework-owned, handled by
 *  `createRscHandler` before any app routing. */
export const VISIBILITY_ENDPOINT = "/__parton/visible";

/** JSON body of a visibility report. */
export interface VisibilityReport {
	/** The live connection this report addresses — the `__conn` token the
	 *  heartbeat minted for its current `?live=1` stream. An explicit
	 *  token, never inferred: a report for a connection the server no
	 *  longer holds gets a `404`, which tells the controller to deliver
	 *  those flips via the render-reload fallback instead. */
	connection: string;
	/** Monotonic per-client sequence. The server applies `visible` only
	 *  from reports newer than the last one applied, so two in-flight
	 *  POSTs can't commit an older set over a newer one. `changed` ids
	 *  are merged regardless — a superseded report's flips still need
	 *  their lane render (the CURRENT set decides what they render). */
	seq: number;
	/** Parton ids whose in/out state flipped since the last report — the
	 *  ids the segment driver renders as lanes. Ordered viewport-first
	 *  (in-view flips before cull-outs); the driver starts lanes in this
	 *  order so the visible world's renders lead. */
	changed: string[];
	/** The complete visible set as of this report. Replaces the
	 *  connection's set wholesale (no incremental merge). */
	visible: string[];
}

/** Runtime validation for a decoded report body. */
export function isVisibilityReport(value: unknown): value is VisibilityReport {
	if (value === null || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.connection === "string" &&
		v.connection.length > 0 &&
		typeof v.seq === "number" &&
		Array.isArray(v.changed) &&
		v.changed.every((x) => typeof x === "string") &&
		Array.isArray(v.visible) &&
		v.visible.every((x) => typeof x === "string")
	);
}
