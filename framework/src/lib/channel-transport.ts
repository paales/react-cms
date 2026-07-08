/**
 * The channel transport seam — the byte/message plumbing under the
 * channel's two roles, pluggable behind one interface so the channel
 * SEMANTICS (frames, delivery seqs, acks, the connection-session
 * mirror — [[channel-protocol]], [[channel-client]]) stay
 * transport-agnostic while the pipe swaps.
 *
 *   - **downstream** — `open(statement, signal)` hands back a byte
 *     stream of the `\xFF`-marker wire the splitter
 *     ([[fp-trailer-split]]) already parses; the browser entry reads it.
 *   - **upstream** — `send(envelope)` delivers one coalesced envelope;
 *     the boolean is the whole contract ("the server will see it"). The
 *     client transport ([[channel-client]]) owns reliability above this
 *     (the retransmit buffer + the downstream `applied` marker), so a
 *     transport that can't answer per-message returns `true`.
 *   - **close** — release whatever the transport holds.
 *
 * The default is the FETCH transport — two discrete POSTs (`/__parton/
 * live` held open for downstream, `/__parton/channel` fire-and-forget
 * for upstream), the shape the whole protocol grew up on. A full-duplex
 * transport (WebSocket, WebTransport) folds both roles onto one
 * connection behind the same interface; it carries the SAME marker
 * bytes (an OPAQUE TUNNEL — no reframing), so only this module changes.
 */

import {
	ATTACH_ENDPOINT,
	type AttachStatement,
	CHANNEL_ENDPOINT,
	CHANNEL_WS_ENDPOINT,
	CHANNEL_WT_ENDPOINT,
	type ChannelEnvelope,
} from "./channel-protocol.ts";
import { TAG_CONNECTION_ID } from "./fp-trailer-marker.ts";
import { splitSegments } from "./fp-trailer-split.ts";
import { NavigationError } from "../runtime/navigation-error.ts";

/**
 * The pluggable seam. One transport instance owns whatever connection
 * state its plumbing needs (a full-duplex transport's `send` reuses the
 * socket `open` established); the fetch transport is stateless.
 */
export interface ChannelTransport {
	/**
	 * Open the downstream: state the attach and hand back the held
	 * segmented byte stream. Throws `NavigationError` (network / http)
	 * on a failed establishment and `AbortError` untouched (a normal
	 * supersede, never a degrade signal). `signal` is the fire's abort:
	 * the fetch transport never wires it to the request itself (aborting
	 * the fetch tears a partially-committed Flight tree) — the caller
	 * passes it to the splitter, which aborts cooperatively at a segment
	 * boundary.
	 */
	open(
		statement: AttachStatement,
		signal?: AbortSignal,
	): Promise<{ body: ReadableStream<Uint8Array> }>;
	/** Deliver one envelope upstream. `true` = the server will see it. */
	send(envelope: ChannelEnvelope): Promise<boolean>;
	/** Release the transport's held connection (a no-op for fetch — its
	 *  attach fetch tears via the splitter, its envelopes are discrete). */
	close(): void;
}

/**
 * The fetch transport — the default, HTTP/1.1+. `open` POSTs the attach
 * statement to `/__parton/live` and hands back the held response body;
 * `send` POSTs one envelope to `/__parton/channel` fire-and-forget
 * (`keepalive: true`, so an in-flight envelope survives a page unload)
 * and reads the `204`. `close` is a no-op: each attach is its own
 * fetch (torn cooperatively via the caller's splitter signal) and every
 * envelope is a discrete request, so there is no held socket to release.
 *
 * `fetch` is referenced at CALL time, never captured at module load, so
 * a test's `vi.stubGlobal("fetch", …)` still observes these requests.
 */
export const fetchTransport: ChannelTransport = {
	async open(statement) {
		// The signal is deliberately NOT passed to `fetch`. Aborting the
		// fetch errors `response.body` mid-read, tearing a
		// partially-committed Flight tree; the caller passes the signal to
		// `splitSegments` instead, which aborts at a SEGMENT BOUNDARY.
		let response: Response;
		try {
			response = await fetch(ATTACH_ENDPOINT, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(statement),
			});
		} catch (err) {
			// AbortError stays untouched — a normal lifecycle signal, not a
			// failure. Everything else maps to a typed NavigationError so
			// consumers branch on `kind` without string matching.
			if (err instanceof Error && err.name === "AbortError") throw err;
			throw new NavigationError({
				kind: "network",
				url: ATTACH_ENDPOINT,
				cause: err,
			});
		}
		if (!response.ok || !response.body) {
			throw new NavigationError({
				kind: "http",
				url: ATTACH_ENDPOINT,
				status: response.status,
			});
		}
		return { body: response.body };
	},
	async send(envelope) {
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
	},
	close() {},
};

let currentTransport: ChannelTransport = fetchTransport;

/** The transport the channel currently uses — the fetch transport by
 *  default; `setChannelTransport` swaps it before the first attach. */
export function getChannelTransport(): ChannelTransport {
	return currentTransport;
}

/** Install a transport. Default stays fetch until something opts in
 *  (the WebSocket selection at boot). Passing no argument restores the
 *  default — the test reset hook. */
export function setChannelTransport(transport?: ChannelTransport): void {
	currentTransport = transport ?? fetchTransport;
}

/**
 * The WebSocket transport — the opt-in full-duplex pipe. ONE socket
 * carries both roles: the attach statement + upstream envelopes go up as
 * JSON text, the SAME `\xFF`-marker downstream byte stream comes down as
 * binary messages (an OPAQUE TUNNEL — the server tunnels
 * `driveSegmentedResponse`'s bytes unchanged, so `splitSegments` parses
 * them exactly as over fetch). Reliability lives ABOVE the transport
 * (the retransmit buffer + the downstream `applied` marker), so `send`
 * is fire-and-forget → `true`; no per-message ack is needed. One
 * instance owns its current socket: `open` establishes it (and `send`
 * reuses it) for the fire's lifetime, `close` releases it.
 */
export class WebSocketTransport implements ChannelTransport {
	private ws: WebSocket | null = null;
	/** Explicit ws:// URL — the browser derives it from `location`; a
	 *  test points it at an ephemeral server. */
	private readonly url: string | undefined;

	constructor(url?: string) {
		this.url = url;
	}

	open(
		statement: AttachStatement,
		signal?: AbortSignal,
	): Promise<{ body: ReadableStream<Uint8Array> }> {
		if (signal?.aborted) return Promise.reject(abortError());
		const url = this.url ?? channelWsUrl();
		let ws: WebSocket;
		try {
			ws = new WebSocket(url);
		} catch (err) {
			return Promise.reject(
				new NavigationError({ kind: "network", url, cause: err }),
			);
		}
		ws.binaryType = "arraybuffer";
		this.ws = ws;

		// The downstream: binary frames feed the stream `splitSegments`
		// reads. A stream `cancel` (the caller's cooperative abort at a
		// segment boundary — the signal goes to `splitSegments`, never
		// here) closes the socket, the WebSocket twin of the fetch body's
		// cancel.
		let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
		const body = new ReadableStream<Uint8Array>({
			start(c) {
				controller = c;
			},
			cancel() {
				try {
					ws.close();
				} catch {}
			},
		});

		return new Promise<{ body: ReadableStream<Uint8Array> }>(
			(resolve, reject) => {
				let opened = false;
				// Pre-establishment abort closes the socket and rejects; once
				// open, the signal is the splitter's (via the caller), so this
				// listener is dropped.
				const onAbort = (): void => {
					try {
						ws.close();
					} catch {}
					reject(abortError());
				};
				signal?.addEventListener("abort", onAbort, { once: true });

				ws.onmessage = (ev: MessageEvent): void => {
					if (ev.data instanceof ArrayBuffer) {
						try {
							controller?.enqueue(new Uint8Array(ev.data));
						} catch {}
					}
				};
				ws.onopen = (): void => {
					opened = true;
					signal?.removeEventListener("abort", onAbort);
					try {
						ws.send(JSON.stringify(statement));
					} catch (err) {
						try {
							ws.close();
						} catch {}
						reject(new NavigationError({ kind: "network", url, cause: err }));
						return;
					}
					resolve({ body });
				};
				ws.onclose = (): void => {
					if (opened) {
						// A clean close (keepalive elapse, server wind-down) ends the
						// body stream — `splitSegments` finishes, the caller resolves
						// `finished`.
						try {
							controller?.close();
						} catch {}
					} else {
						signal?.removeEventListener("abort", onAbort);
						reject(new NavigationError({ kind: "http", url, status: 0 }));
					}
				};
				ws.onerror = (): void => {
					if (opened) {
						try {
							controller?.error(new Error("WebSocket error"));
						} catch {}
					} else {
						signal?.removeEventListener("abort", onAbort);
						reject(
							new NavigationError({
								kind: "network",
								url,
								cause: new Error("WebSocket error"),
							}),
						);
					}
				};
			},
		);
	}

	send(envelope: ChannelEnvelope): Promise<boolean> {
		const ws = this.ws;
		if (ws === null || ws.readyState !== WebSocket.OPEN)
			return Promise.resolve(false);
		try {
			ws.send(JSON.stringify(envelope));
			return Promise.resolve(true);
		} catch {
			return Promise.resolve(false);
		}
	}

	close(): void {
		const ws = this.ws;
		this.ws = null;
		if (ws !== null) {
			try {
				ws.close();
			} catch {}
		}
	}
}

/**
 * The WebTransport (HTTP/3) transport — the opt-in full-duplex pipe over
 * QUIC. ONE bidirectional stream carries both roles: the attach statement
 * + upstream envelopes go up as newline-delimited JSON on the stream's
 * writable half, the SAME `\xFF`-marker downstream byte stream comes down
 * on the readable half (an OPAQUE TUNNEL — the server tunnels
 * `driveSegmentedResponse`'s bytes unchanged, so `splitSegments` parses
 * them exactly as over fetch). The only addition over fetch/WS is the
 * upstream newline delimiter: a QUIC stream is raw bytes with no message
 * boundaries, so the attach and each envelope are `\n`-terminated (safe —
 * `JSON.stringify` never emits a literal newline); the DOWNSTREAM tunnel
 * is byte-identical, unframed. Reliability lives ABOVE the transport (the
 * retransmit buffer + the downstream `applied` marker), so `send` is
 * fire-and-forget → `true`. One instance owns its current session: `open`
 * establishes it (and `send` reuses its writer) for the fire's lifetime,
 * `close` releases it.
 */
export class WebTransportTransport implements ChannelTransport {
	private wt: WebTransport | null = null;
	private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
	/** Explicit https:// URL — the browser derives it from `location`; a
	 *  test points it at a fake session. */
	private readonly url: string | undefined;
	private readonly encoder = new TextEncoder();

	constructor(url?: string) {
		this.url = url;
	}

	async open(
		statement: AttachStatement,
		signal?: AbortSignal,
	): Promise<{ body: ReadableStream<Uint8Array> }> {
		if (signal?.aborted) throw abortError();
		const url = this.url ?? channelWtUrl();
		let wt: WebTransport;
		try {
			wt = new WebTransport(url);
		} catch (err) {
			throw new NavigationError({ kind: "network", url, cause: err });
		}
		this.wt = wt;

		// Pre-establishment abort closes the session (rejecting the awaits
		// below); once the stream is open the signal is the splitter's (via
		// the caller — it cancels the body at a segment boundary, which
		// closes the session), so this listener is dropped, mirroring the
		// fetch/WS discipline of never wiring the signal to the live pipe.
		const onAbort = (): void => {
			try {
				wt.close();
			} catch {}
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		try {
			await wt.ready;
			const stream = await wt.createBidirectionalStream();
			const writer = stream.writable.getWriter();
			this.writer = writer;
			// The attach is the FIRST upstream message (mirrors the fetch
			// attach's POST body / the WS first text frame), newline-terminated.
			await writer.write(this.frame(statement));
			signal?.removeEventListener("abort", onAbort);

			// The downstream: the bidi stream's readable IS the `\xFF`-marker
			// tunnel `splitSegments` reads. A stream `cancel` (the caller's
			// cooperative abort at a segment boundary) closes the session — the
			// WebTransport twin of the fetch body's / the WS body's cancel.
			const reader = (stream.readable as ReadableStream<Uint8Array>).getReader();
			const body = new ReadableStream<Uint8Array>({
				async pull(controller) {
					let result: ReadableStreamReadResult<Uint8Array>;
					try {
						result = await reader.read();
					} catch (err) {
						controller.error(err);
						return;
					}
					if (result.done) {
						// A clean end (server wind-down on keepalive) ends the body
						// stream — `splitSegments` finishes, the caller resolves
						// `finished`.
						controller.close();
						return;
					}
					controller.enqueue(result.value);
				},
				cancel(reason) {
					try {
						reader.cancel(reason);
					} catch {}
					try {
						wt.close();
					} catch {}
				},
			});
			return { body };
		} catch (err) {
			// Any establishment failure (ready / bidi-open / attach write
			// rejected) tears the session. A concurrent abort surfaces as the
			// untouched AbortError — a normal supersede, not a degrade — while
			// a genuine connection failure maps to a typed NavigationError, the
			// same split the fetch transport draws.
			signal?.removeEventListener("abort", onAbort);
			try {
				wt.close();
			} catch {}
			if (signal?.aborted) throw abortError();
			throw new NavigationError({ kind: "network", url, cause: err });
		}
	}

	send(envelope: ChannelEnvelope): Promise<boolean> {
		const writer = this.writer;
		if (writer === null) return Promise.resolve(false);
		try {
			// Fire-and-forget: reliability is above the seam (the retransmit
			// buffer + the downstream `applied` marker), so a queued write
			// that later fails is dropped, never surfaced as a false here.
			void writer.write(this.frame(envelope)).catch(() => {});
			return Promise.resolve(true);
		} catch {
			return Promise.resolve(false);
		}
	}

	close(): void {
		const wt = this.wt;
		this.wt = null;
		this.writer = null;
		if (wt !== null) {
			try {
				wt.close();
			} catch {}
		}
	}

	/** Encode one upstream message as newline-terminated JSON bytes — the
	 *  framing the byte stream needs (a message boundary the WebSocket
	 *  provides for free). */
	private frame(value: AttachStatement | ChannelEnvelope): Uint8Array {
		return this.encoder.encode(`${JSON.stringify(value)}\n`);
	}
}

/** The ws:// URL for the channel socket, derived from the page origin
 *  (`wss:` under https). */
function channelWsUrl(): string {
	const { protocol, host } = window.location;
	const wsProtocol = protocol === "https:" ? "wss:" : "ws:";
	return `${wsProtocol}//${host}${CHANNEL_WS_ENDPOINT}`;
}

/** The https:// URL for the WebTransport session, derived from the page
 *  origin. WebTransport mandates HTTP/3 over TLS, so the scheme is always
 *  `https:` (a non-secure origin has no WebTransport global to select). */
function channelWtUrl(): string {
	return `https://${window.location.host}${CHANNEL_WT_ENDPOINT}`;
}

function abortError(): Error {
	return new DOMException("The channel open was aborted.", "AbortError");
}

/** A `?transport=` param (or `window.__partonTransport`) pinned the boot
 *  transport — the user's explicit choice. Read by the boot orchestration
 *  to STAND DOWN the auto-upgrade: a force is never second-guessed. */
let transportForced = false;

/** Whether the boot transport was explicitly forced (`?transport=…` /
 *  `window.__partonTransport`). A forced page never auto-upgrades —
 *  `fetch` pins fetch just as `ws` pins ws. */
export function isTransportForced(): boolean {
	return transportForced;
}

/**
 * Boot-time transport selection. The BOOT transport is fetch by default
 * (instant, universal, no handshake wait) — the auto-upgrade
 * (`armTransportUpgrade`, browser entry) is what promotes it to WebSocket
 * where the socket works. A `?transport=` query param or
 * `window.__partonTransport` FORCES a transport at boot and stands the
 * auto-upgrade down (the user's explicit choice):
 *
 *   - `"webtransport"` → `WebTransportTransport` (needs a `WebTransport`
 *     global AND a standalone HTTP/3 server — see [[channel-server]]'s
 *     `createWebTransportServer`).
 *   - `"ws"` → `WebSocketTransport` (needs a `WebSocket` global AND the
 *     `partonChannelServer` Vite plugin serving `/__parton/ws`).
 *   - `"fetch"` → the default, pinned: no background upgrade probe.
 *
 * Absent a `?transport=` value the default fetch transport stands AND the
 * auto-upgrade is armed. Call once before the heartbeat's first fire.
 */
export function selectChannelTransport(): void {
	if (typeof window === "undefined") return;
	const requested =
		new URLSearchParams(window.location.search).get("transport") ??
		(window as unknown as { __partonTransport?: string }).__partonTransport;
	// Any recognized `?transport=` value is a FORCE — the auto-upgrade
	// stands down, so `fetch` pins fetch just as `ws` pins ws.
	if (requested === "webtransport") {
		transportForced = true;
		if (typeof WebTransport !== "undefined")
			setChannelTransport(new WebTransportTransport());
		return;
	}
	if (requested === "ws") {
		transportForced = true;
		if (typeof WebSocket !== "undefined")
			setChannelTransport(new WebSocketTransport());
		return;
	}
	if (requested === "fetch") {
		transportForced = true;
	}
}

/** How long the WS probe waits for the `conn` handshake before giving up.
 *  A same-origin socket that WORKS confirms in ~100ms (handshake + the
 *  server's `conn` mint); this backstops the cases that DON'T fail their
 *  handshake — an endpoint the host leaves the upgrade HANGING (e.g. a
 *  Vite dev server with no `partonChannelServer`), or one that opens but
 *  is never driven. Kept tight so a plugin-less app gives up promptly. */
const PROBE_CONN_TIMEOUT_MS = 2_000;

/**
 * Probe whether the WebSocket channel endpoint is usable: open a
 * SPECULATIVE attach on a throwaway socket and resolve `true` iff the
 * server-minted `conn` handshake arrives over it. That handshake — not a
 * bare `onopen`, which only proves the TCP upgrade succeeded, never that
 * the server actually drove the socket — is the REAL establishment signal
 * (the driver mints ids only for sessions it opened, see [[channel-server]]
 * §The id handshake). Resolves `false` on any failure (absent endpoint,
 * close before `conn`, error) or if `timeoutMs` elapses, and ALWAYS closes
 * the probe socket. The statement's manifest lets the server fp-skip its
 * throwaway render; the socket closes the instant `conn` is seen, before
 * that render matters.
 *
 * The confirmation reuses the live path's own establishment detection —
 * `splitSegments`' `onEntry` surfacing the `TAG_CONNECTION_ID` marker,
 * exactly as the browser entry reads it — so there is no second-guessed
 * proxy for "it works": the signal is the one the transport already
 * trusts.
 */
export function probeWebSocketTransport(
	statement: AttachStatement,
	opts: { url?: string; timeoutMs?: number } = {},
): Promise<boolean> {
	if (typeof WebSocket === "undefined") return Promise.resolve(false);
	const probe = new WebSocketTransport(opts.url);
	const abort = new AbortController();
	return new Promise<boolean>((resolve) => {
		let settled = false;
		const finish = (ok: boolean): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				abort.abort();
			} catch {}
			probe.close();
			resolve(ok);
		};
		const timer = setTimeout(
			() => finish(false),
			opts.timeoutMs ?? PROBE_CONN_TIMEOUT_MS,
		);
		probe.open(statement, abort.signal).then(({ body }) => {
			void (async () => {
				try {
					for await (const segment of splitSegments(body, abort.signal, (tag) => {
						if (tag === TAG_CONNECTION_ID) finish(true);
					})) {
						if (settled) break;
						// Drain minimally — a probe never commits content.
						if (segment.kind === "lanes") {
							for await (const lane of segment.lanes) {
								if (settled) break;
								await new Response(lane.body).arrayBuffer().catch(() => {});
							}
						} else {
							await new Response(segment.body).arrayBuffer().catch(() => {});
						}
					}
					finish(false);
				} catch {
					finish(false);
				}
			})();
		}, () => finish(false));
	});
}
