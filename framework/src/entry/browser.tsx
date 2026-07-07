/**
 * Browser bootstrap — the client tier of a parton app's entry surface.
 * An app's `src/entry.browser.tsx` is two lines:
 *
 *     import { bootBrowser } from "@parton/framework/entry/browser.tsx"
 *     bootBrowser()
 *
 * `bootBrowser` hydrates the SSR document from the inlined Flight
 * stream, installs the Navigation API intercept, the attach transport
 * (`window.__rsc_live_attach` — the channel's opening statement and
 * the page's one held stream), the server-action callback, and the
 * live page heartbeat. Everything interactive rides the channel: the
 * attach POST opens the stream, `url` frames move it, lanes and
 * navigation segments come down it. The only GETs a page makes are
 * document loads.
 */
import {
	createFromReadableStream,
	createTemporaryReferenceSet,
	encodeReply,
	setServerCallback,
} from "@vitejs/plugin-rsc/browser";
import React from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { rscStream } from "rsc-html-stream/client";
import {
	_channelClaimWindowNav,
	_channelDeliveryCommittable,
	_channelFrameLaneCommitted,
	_channelFrameLaneSettled,
	_channelIsDegraded,
	_channelNavAvailable,
	_channelNavigate,
	_channelNavPoint,
	_channelNavPrefersTransition,
	_channelNavSegmentCommitted,
	_channelNavSegmentSettled,
	_channelNavSubsumedByAttach,
	_channelWireEntry,
	_laneDeliveryCommitted,
	_laneDeliveryDropped,
	_laneDeliveryDroppedStale,
	_lanePendingDelivery,
	_onLaneProducerAnnounce,
	_registerActionConsequences,
	_segmentDelivery,
	_segmentDeliveryCommitted,
	_segmentDeliveryDroppedStale,
	type WireDelivery,
} from "../lib/channel-client.ts";
import {
	ATTACH_ENDPOINT,
	type AttachStatement,
	type UrlFrame,
} from "../lib/channel-protocol.ts";
import type { FpUpdatesPayload } from "../lib/fp-trailer-marker.ts";
import {
	type DemuxedLane,
	splitAtFpTrailer,
	splitSegments,
} from "../lib/fp-trailer-split.ts";
import { LivePageHeartbeat } from "../lib/live-page-heartbeat.tsx";
import { markPageInteractive } from "../lib/page-interactive.ts";
import {
	_applyFpTrailerFromDocument,
	_applyFpUpdates,
	_collectFramePaths,
	_commitPartonLane,
	_commitPartonLaneProgressive,
	_dispatchFrameRefetch,
	_readFramesSnapshot,
	getCachedPartialIds,
	isFrameworkSilentInfo,
} from "../lib/partial-client.tsx";
import {
	_getLiveConnectionId,
	getAllCachedPartialTokens,
} from "../lib/partial-client-state.ts";
import { applyStandardTrailers } from "../lib/segment-trailers-client.ts";
import {
	GlobalErrorBoundary,
	NavigationErrorBoundary,
} from "../runtime/error-boundary.tsx";
import { getNavigation } from "../runtime/navigation-api.ts";
import { NavigationError } from "../runtime/navigation-error.ts";
import { createRscRenderRequest } from "../runtime/request.tsx";
import type { RscPayload } from "./rsc.tsx";

export function bootBrowser(): void {
	void main();
}

/** The page opted out of the interactive transport entirely (specs
 *  asserting document-shaped behavior set it): no heartbeat, no
 *  channel, no interception — every navigation is a document load. */
function heartbeatDisabled(): boolean {
	return (
		(window as unknown as { __partonHeartbeatDisabled?: boolean })
			.__partonHeartbeatDisabled === true
	);
}

async function main() {
	let setPayload: (v: RscPayload) => void;
	let setPayloadRaw: (v: RscPayload) => void;

	// Pending view-transition types — set synchronously by the navigate-
	// event handler when the navigation direction is known (push/forward
	// → "forward"; traverse-back → "back"), consumed by `setPayload` on
	// the very next commit. Keyed by no token because navigations on the
	// window are serialised — the next commit IS this navigation. Reset
	// even on no-types calls so a previous nav's type doesn't leak.
	let _pendingTransitionTypes: string[] = [];
	function setPendingTransitionTypes(types: string[]) {
		_pendingTransitionTypes = types;
	}

	const initialPayload = await createFromReadableStream<RscPayload>(rscStream);

	// The CURRENT attach fire's generation. A superseded fire's stream
	// keeps draining (the cooperative abort releases it only at a
	// settled boundary), but nothing it carries may act anymore: its
	// late `conn` entry must not hijack establishment away from the
	// newer fire, its lane seqs must not pollute the per-parton queues,
	// and its payloads must not commit — their content is the state the
	// page superseded.
	let liveFireGen = 0;

	// The SSR HTML response carries the fp-trailer as an HTML comment
	// appended after `</html>` (see `wrapSsrStreamWithFpTrailer` in
	// the framework). Parse it now so the warm fps the server
	// computed during this cold render are registered before the
	// heartbeat's attach presents the manifest. Without this, the
	// attach carries only cold fps and every parton whose cold fp
	// drifted from warm re-renders on the first connection.
	_applyFpTrailerFromDocument();

	function BrowserRoot() {
		const [payload, setPayload_] = React.useState(initialPayload);

		React.useEffect(() => {
			setPayload = (v) =>
				React.startTransition(() => {
					// Drain pending types into THIS transition so any
					// `<ViewTransition>` in the tree fires `document.startViewTransition`
					// with `types: [...]` matching the navigation direction.
					const types = _pendingTransitionTypes;
					_pendingTransitionTypes = [];
					for (const t of types) React.addTransitionType(t);
					setPayload_(v);
				});
			setPayloadRaw = setPayload_;
		}, [setPayload_]);

		React.useEffect(() => {
			const off = listenNavigation((url, types, signal, intent) => {
				setPendingTransitionTypes(types ?? []);
				const target = new URL(url, window.location.origin);
				// The statement: the client's URL moved. Pre-establishment it
				// latches and rides the attach it triggers; only a DEGRADED
				// page answers null — and degraded pages never intercept, so
				// the null branch is unreachable here.
				const routed = _channelNavigate({
					url: target.pathname + target.search,
					intent: intent ?? "push",
					streaming: false,
					signal,
				});
				return routed ? routed.finished : Promise.resolve();
			});
			// BrowserRoot is the tree root, so this effect runs after every
			// child's — hydration handlers are attached — and the navigate
			// listener above is now intercepting. Both "safe to interact"
			// conditions hold; publish the signal.
			markPageInteractive();
			return off;
		}, []);

		return (
			<>
				{/* Recover from torn RSC streams when a navigation supersedes an
				 *  in-flight one (the payload is rendered HERE, so a recovery
				 *  remounts the payload — not BrowserRoot, whose state + the
				 *  heartbeat below must survive). Genuine errors still bubble to
				 *  the outer <GlobalErrorBoundary>. */}
				<NavigationErrorBoundary>{payload.root}</NavigationErrorBoundary>
				{/* The live connection. The heartbeat fires the attach POST
				 *  against `/__parton/live` (via the transport installed
				 *  below); the server's segment driver pushes lanes and
				 *  navigation segments down the held stream. Mounted here so
				 *  its useEffect runs AFTER React's first commit — by that
				 *  point `_currentPageFingerprints` is populated by the
				 *  rendered `PartialErrorBoundary`s and the attach manifest
				 *  carries them. See `docs/internals/streaming.md`. */}
				<LivePageHeartbeat />
			</>
		);
	}

	/**
	 * Consume one attach stream: POST the statement to
	 * `/__parton/live` and decode the held segmented response — the
	 * `conn` handshake, payload segments (whole-tree renders,
	 * navigation segments, reconciles), and per-parton lanes. Returns
	 * synchronously with `{streaming, finished}` promises: `streaming`
	 * resolves when the first segment commits (or the lanes region
	 * opens on a catch-up boot — the current tree IS the state);
	 * `finished` when the connection fully drains (keepalive close,
	 * abort, error) — the heartbeat's settle signal.
	 *
	 * Commit arbitration for seq'd deliveries is the AS-OF guard alone:
	 * commit iff the delivery was rendered as-of the client's current
	 * navigation point or later (`_channelDeliveryCommittable`). A
	 * document navigation unloads the page — no cross-page staleness
	 * class exists.
	 */
	function consumeLiveStream(
		statement: AttachStatement,
		signal?: AbortSignal,
	): { streaming: Promise<void>; finished: Promise<void> } {
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
		// Most callers chain off `finished`. Pre-attach a no-op on
		// `streaming` so unconsumed rejections don't surface as
		// unhandledrejection — `streaming` rejecting always implies
		// `finished` will reject too, where the caller is listening.
		streaming.catch(() => {});

		const gen = ++liveFireGen;
		void (async () => {
			let streamingResolved = false;
			try {
				// Network → HTTP → decode. Each failure mode maps to a typed
				// NavigationError kind so consumers can branch on it without
				// string matching. AbortError stays untouched — it's a normal
				// lifecycle signal, not a failure.
				//
				// NOTE: `signal` is deliberately NOT passed to `fetch`.
				// Aborting the fetch errors `response.body` mid-read, which
				// tears a partially-committed Flight tree. Instead the signal
				// goes to `splitSegments` below, which aborts cooperatively at
				// a SEGMENT BOUNDARY — the in-flight segment finishes, then
				// iteration stops and the reader is cancelled.
				let response: Response;
				try {
					response = await fetch(ATTACH_ENDPOINT, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(statement),
					});
				} catch (err) {
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
				// Decode + commit one per-parton lane. The body carries the
				// lane's Flight payload plus its own fp trailer; decode fully
				// (the lane closed at its `muxend`, so all bytes are here),
				// then hand the subtree to the framework's cache-commit path —
				// which swaps it in place via a template re-render, no
				// whole-payload setPayload involved.
				const handleLane = async (lane: DemuxedLane): Promise<void> => {
					// Whether this handler has consumed its body's queue head
					// (committed or dropped) — the catch must consume exactly
					// once to keep per-parton seq attribution aligned.
					let consumed = false;
					try {
						const { mainStream, trailer } = splitAtFpTrailer(lane.body);
						const node =
							await createFromReadableStream<React.ReactNode>(mainStream);
						// Learn the body's shape before deciding the commit moment:
						// a NORMAL lane's delivery entry precedes its muxend (the
						// trailer resolves right after the root here), while a
						// PRODUCER lane announces mid-body (`muxlive`) and its
						// trailer only resolves at producer resolve — waiting on it
						// would gate the initial content on an unbounded await. Race
						// the trailer against the producer announcement.
						let delivery = _lanePendingDelivery(lane.partonId);
						if (delivery === null || delivery.live !== true) {
							await new Promise<void>((resolve) => {
								const dispose = _onLaneProducerAnnounce(lane.partonId, () =>
									resolve(),
								);
								trailer.then(
									() => {
										dispose();
										resolve();
									},
									() => {
										dispose();
										resolve();
									},
								);
							});
							delivery = _lanePendingDelivery(lane.partonId);
						}
						if (delivery !== null && delivery.live === true) {
							// PRODUCER lane: commit progressively at root-ready — the
							// body keeps streaming until the producer resolves, and
							// the committed tree's Suspense fallback holds the
							// producer's place. The as-of guard runs NOW (seq + as-of
							// arrived with the announcement).
							if (!_channelDeliveryCommittable(delivery.asOf)) {
								consumed = true;
								_laneDeliveryDroppedStale(lane.partonId);
								return;
							}
							const nav = delivery.nav;
							// The body is STILL STREAMING — a one-shot walk would stop
							// at the first pending Flight row and cache nothing. The
							// progressive commit walks what has resolved and re-walks
							// as the remaining rows land.
							_commitPartonLaneProgressive(lane.partonId, node);
							consumed = true;
							_laneDeliveryCommitted(lane.partonId);
							if (nav !== undefined) _channelFrameLaneCommitted(nav);
							// The fp trailer lands at the body's close — producer
							// resolve, or a clean cancel/region close (null then).
							const fp = (await trailer) as FpUpdatesPayload | null;
							if (fp) _applyFpUpdates(fp);
							if (nav !== undefined) _channelFrameLaneSettled(nav);
							return;
						}
						const fp = (await trailer) as FpUpdatesPayload | null;
						delivery = _lanePendingDelivery(lane.partonId);
						if (delivery === null) {
							// Unannounced body: a `cancel` statement closed it
							// mid-render (the server writes the muxend so this decode
							// settles and the id can reopen, but no delivery — the
							// content belongs to a superseded statement). Committing
							// it would swap torn content — pending-forever rows —
							// over the page. Nothing to consume: no seq was ever
							// queued.
							consumed = true;
							return;
						}
						// As-of guard: a lane rendered before the client's
						// navigation point is content of a state the client left —
						// consume it PROCESSED (the watermark advances; the
						// server's fold gate keeps it out of the acked mirror) and
						// the stream lives on.
						if (!_channelDeliveryCommittable(delivery.asOf)) {
							consumed = true;
							_laneDeliveryDroppedStale(lane.partonId);
							return;
						}
						const nav = delivery.nav;
						_commitPartonLane(node, fp, lane.partonId);
						// COMMIT is the recording moment — the cache walk above is
						// synchronous, so the subtree is the page's state now. The
						// transport advances its contiguous watermark and acks.
						consumed = true;
						_laneDeliveryCommitted(lane.partonId);
						if (nav !== undefined) {
							_channelFrameLaneCommitted(nav);
							_channelFrameLaneSettled(nav);
						}
					} catch (err) {
						// Torn decode (connection died mid-lane, a navigation tear
						// ended the region over this body, or a cancelled producer
						// body closed before its root row) — keep the per-parton
						// seq queue aligned without recording a commit that never
						// happened. A cancelled/torn PRODUCER body's delivery was
						// ANNOUNCED (its seq is on the wire), so it consumes
						// PROCESSED — the stream lives on and a permanent gap
						// would wedge the watermark; an un-announced normal body
						// stall-drops (a nav-torn lane queued no seq at all, so
						// that consume is a no-op).
						if (!consumed) {
							const head = _lanePendingDelivery(lane.partonId);
							if (head !== null && head.live === true) {
								_laneDeliveryDroppedStale(lane.partonId);
							} else {
								_laneDeliveryDropped(lane.partonId);
							}
						}
						throw err;
					}
				};
				// A live stream's payload segments carry deliveries (`seq`
				// entries — seq + as-of — ahead of their Flight rows).
				// FETCH-LOCAL pending slot: only this stream's own commits may
				// consume it.
				let pendingSegmentDelivery: WireDelivery | null = null;
				const onWireEntry = (tag: string, body: Uint8Array): void => {
					// A superseded fire's entries are dead — see `liveFireGen`.
					if (gen !== liveFireGen) return;
					// The transport's entries — `conn` handshake, lane-form
					// delivery seqs, the upstream-applied watermark.
					_channelWireEntry(tag, body);
					const delivery = _segmentDelivery(tag, body);
					if (delivery !== null) pendingSegmentDelivery = delivery;
				};
				// Consume the fetch-local slot. A function boundary — the slot
				// is written from the wire-entry closure above, which
				// straight-line flow analysis can't see.
				const takeSegmentDelivery = (): WireDelivery | null => {
					const delivery = pendingSegmentDelivery;
					pendingSegmentDelivery = null;
					return delivery;
				};
				try {
					// `onWireEntry` watches the entries for the `conn`
					// handshake — the server-minted connection id, established
					// with the channel transport the moment it is read.
					for await (const segment of splitSegments(
						response.body,
						signal,
						onWireEntry,
					)) {
						// A superseded fire only DRAINS from here — the cooperative
						// abort needs the splitter moving, but nothing may commit.
						if (gen !== liveFireGen) {
							if (segment.kind === "lanes") {
								for await (const lane of segment.lanes) {
									await new Response(lane.body).arrayBuffer().catch(() => {});
								}
							} else {
								await new Response(segment.body).arrayBuffer().catch(() => {});
							}
							continue;
						}
						if (segment.kind === "lanes") {
							// The subscription is established the moment the lanes
							// region opens. On a catch-up boot (attach anchor honored)
							// this is the FIRST segment — there is no whole-route
							// payload to commit, the client's current tree IS the
							// state — so `streaming` must resolve here, and any
							// records the attach subsumed (re-anchored at navigation
							// point 0) resolve through the same coverage: the
							// catch-up IS their covering statement.
							if (!streamingResolved) {
								streamingResolved = true;
								resolveStreaming();
								_channelNavSegmentCommitted(0);
								_channelNavSegmentSettled(0);
							}
							// Per-parton live updates. Lanes for DIFFERENT partons
							// commit concurrently (a slow lane's decode must not
							// gate a fast one — that's the point of the wire
							// format); successive lanes for the SAME parton chain
							// sequentially so commits land in server render order.
							// A torn lane rejects only its own decode — swallowed,
							// nothing was committed for it.
							const laneChains = new Map<string, Promise<void>>();
							for await (const lane of segment.lanes) {
								const prev = laneChains.get(lane.partonId) ?? Promise.resolve();
								laneChains.set(
									lane.partonId,
									prev.then(() => handleLane(lane)).catch(() => {}),
								);
							}
							continue;
						}
						let payload: RscPayload;
						try {
							payload = await createFromReadableStream<RscPayload>(
								segment.body,
							);
						} catch (err) {
							// A truncated payload on the live stream: the server's
							// mid-render navigation supersede aborted this segment
							// (a newer url frame made it moot). Its as-of predates
							// the navigation point by construction — consume the
							// delivery PROCESSED and keep reading; the covering
							// segment follows. Any other decode failure propagates.
							const torn = takeSegmentDelivery();
							if (torn !== null && !_channelDeliveryCommittable(torn.asOf)) {
								_segmentDeliveryDroppedStale(torn.seq);
								continue;
							}
							throw err;
						}
						const delivery = takeSegmentDelivery();
						// The as-of guard: a segment rendered before the client's
						// navigation point is a state the client left. Consume it
						// PROCESSED (the stream lives on); dropped commits skip
						// trailers too — they would register fingerprints for a
						// stale tree.
						if (
							delivery !== null &&
							!_channelDeliveryCommittable(delivery.asOf)
						) {
							_segmentDeliveryDroppedStale(delivery.seq);
							continue;
						}
						segment.trailers
							.then((trailers) => {
								// Server url pushes gate on the as-of (client-wins —
								// see applyStandardTrailers): the wire as-of of the
								// delivery on the live stream.
								applyStandardTrailers(trailers, {
									urlAsOf: delivery !== null ? delivery.asOf : 0,
								});
								// Trailers resolve at the segment's `settled` — the
								// covering navigation fires' `finished` milestone.
								if (delivery !== null) {
									_channelNavSegmentSettled(delivery.asOf);
								}
							})
							.catch(() => {});
						// Commit mode: the live stream commits raw by default
						// (progressive), except when a covering navigation fire
						// asked for the atomic swap.
						const preferTransition =
							delivery !== null && _channelNavPrefersTransition(delivery.asOf);
						if (preferTransition) {
							setPayload(payload);
						} else {
							setPayloadRaw(payload);
						}
						// COMMIT is the recording moment for the segment's delivery
						// seq — React has been handed the payload; the transport
						// advances its watermark and acks, and covering navigation
						// fires resolve their `streaming` milestone.
						if (delivery !== null) {
							_segmentDeliveryCommitted(delivery.seq);
							_channelNavSegmentCommitted(delivery.asOf);
						}
						// First segment landed and React has been told to render it.
						if (!streamingResolved) {
							streamingResolved = true;
							resolveStreaming();
						}
					}
				} catch (err) {
					if (err instanceof Error && err.name === "AbortError") throw err;
					throw new NavigationError({
						kind: "decode",
						url: ATTACH_ENDPOINT,
						cause: err,
					});
				}
				if (!streamingResolved) {
					streamingResolved = true;
					resolveStreaming();
				}
				resolveFinished();
			} catch (err) {
				if (!streamingResolved) rejectStreaming(err);
				rejectFinished(err);
			}
		})();

		return { streaming, finished };
	}

	/**
	 * The attach transport — the heartbeat's fire. Subsumes the
	 * channel's URL timeline (pending statements FOLD INTO the
	 * statement: the window statement becomes its `url`, frame
	 * statements its `frames` — attach-with-intent), assembles the full
	 * statement (uncapped manifest, anchor, seed, watermark), and
	 * consumes the held stream.
	 */
	function fireAttach(
		halves: {
			since: { epoch: string; ts: number } | null;
			visible: string[] | null;
			applied: number;
		},
		signal?: AbortSignal,
	): { streaming: Promise<void>; finished: Promise<void> } {
		const intent = _channelNavSubsumedByAttach();
		const statement: AttachStatement = {
			// The statement's URL: the pending window statement's (with its
			// one-shot `__force` overlay) — the client's history work is
			// done by fire time, so it equals the location plus the overlay
			// — or the current location.
			url:
				intent.url ?? window.location.pathname + window.location.search,
			// The FULL manifest — the body has no request line to protect;
			// the client pool bounds it structurally.
			cached: getAllCachedPartialTokens(),
			since: halves.since,
			visible: halves.visible,
			applied: halves.applied,
			...(intent.frames.length > 0 ? { frames: intent.frames } : {}),
		};
		return consumeLiveStream(statement, signal);
	}
	(
		window as Window & { __rsc_live_attach?: typeof fireAttach }
	).__rsc_live_attach = fireAttach;

	setServerCallback(async (id, args) => {
		const temporaryReferences = createTemporaryReferenceSet();
		// The navigation point at action fire — the as-of this response's
		// server url push is gated on (client-wins: a push the client has
		// channel-navigated past is a stale suggestion).
		const actionIssueNavPoint = _channelNavPoint();
		// Include cached partial fingerprints so the server can skip
		// unchanged partials in the action's response render — the one
		// surviving `?cached=` carrier (a discrete POST with a real
		// request line to protect, hence the capped URL form).
		const actionUrl = new URL(window.location.href);
		const cachedIds = getCachedPartialIds();
		if (cachedIds.length > 0) {
			actionUrl.searchParams.set("cached", cachedIds.join(","));
		}
		// An attached, healthy page names its live connection on the
		// action POST (`x-parton-conn`) — an explicit client statement,
		// never inferred — so the server can reserve the delivery seqs
		// the action's invalidation consequences will ride on that
		// connection. The response's `x-parton-consequences` header
		// carries them back; the optimistic overlay holds until the
		// committed watermark covers them.
		const consequenceConn = _channelNavAvailable()
			? _getLiveConnectionId()
			: null;
		const renderRequest = createRscRenderRequest(
			actionUrl.toString(),
			{
				id,
				body: await encodeReply(args, { temporaryReferences }),
			},
			consequenceConn !== null
				? { "x-parton-conn": consequenceConn }
				: undefined,
		);
		const response = await fetch(renderRequest);
		if (!response.ok || !response.body) {
			throw new NavigationError({
				kind: "http",
				url: renderRequest.url,
				status: response.status,
			});
		}
		// Register the consequence gate BEFORE the payload decode — the
		// action's returned promise must never resolve ahead of its own
		// gate's registration, or the overlay's clear point could miss it.
		const consequences = response.headers.get("x-parton-consequences");
		if (consequences) {
			const seqs = consequences
				.split(",")
				.map((s) => Number(s))
				.filter((n) => Number.isFinite(n) && n > 0);
			_registerActionConsequences(seqs);
		}
		// Same segmented-Flight decode as the live path. Actions produce a
		// single segment — but the splitter is what lets us pick the
		// trailers off the wire. Without it the url-trailer emitted by
		// `getServerNavigation().navigate(...)` inside an action body
		// never reaches the client and the URL never updates.
		let firstPayload: RscPayload | undefined;
		for await (const segment of splitSegments(response.body)) {
			// Action POSTs are one-shot — never lanes.
			if (segment.kind !== "payload") continue;
			const payload = await createFromReadableStream<RscPayload>(segment.body, {
				temporaryReferences,
			});
			if (!firstPayload) firstPayload = payload;
			segment.trailers
				.then((trailers) =>
					applyStandardTrailers(trailers, { urlAsOf: actionIssueNavPoint }),
				)
				.catch(() => {});
			// A deferred-only action returns `root: null` (no re-render): the
			// already-open streaming connection carries the update instead.
			// Committing a null root would blank the page, so skip the commit
			// — `returnValue` is still captured below and trailers (e.g. a
			// `url` push) still apply. A null root is never committable, so
			// this guard is safe for every action, not just deferred ones.
			if (payload.root != null) setPayload(payload);
		}
		if (!firstPayload) {
			throw new NavigationError({
				kind: "decode",
				url: renderRequest.url,
				cause: new Error("Action response had no segments"),
			});
		}
		const { ok, data } = firstPayload.returnValue!;
		if (!ok) throw data;
		return data;
	});

	const browserRoot = (
		<React.StrictMode>
			<GlobalErrorBoundary>
				<BrowserRoot />
			</GlobalErrorBoundary>
		</React.StrictMode>
	);

	if ("__NO_HYDRATE" in globalThis) {
		createRoot(document).render(browserRoot);
	} else {
		hydrateRoot(document, browserRoot, {
			formState: initialPayload.formState,
			onRecoverableError: silenceTornStream,
		});
	}

	if (import.meta.hot) {
		import.meta.hot.on("rsc:update", () => {
			// An edit landed: state the current URL silent — the whole-tree
			// segment (or the attach it triggers pre-establishment) carries
			// the re-render; the HMR dispose hooks already wiped the
			// registry, so fp-skip yields fresh bodies.
			const routed = _channelNavigate({
				url: window.location.pathname + window.location.search,
				intent: "silent",
				streaming: true,
			});
			routed?.finished.catch((err) => {
				if (err instanceof Error && err.name === "AbortError") return;
				console.error(err);
			});
		});
	}
}

function listenNavigation(
	onNavigation: (
		url: string,
		transitionTypes?: string[],
		signal?: AbortSignal,
		intent?: UrlFrame["intent"],
	) => Promise<void>,
) {
	const nav = getNavigation();
	if (!nav) return () => {};

	// Map a NavigateEvent to a directional transition type. `push` is
	// always treated as forward; `traverse` looks up the destination
	// entry's index in `nav.entries()` (NavigationDestination only
	// exposes `key`, not `index`) and compares to the current entry's
	// index to discriminate forward vs back; `replace` carries no
	// direction signal.
	const directionFor = (event: NavigateEvent): string[] => {
		if (event.navigationType === "push") return ["forward"];
		if (event.navigationType === "traverse") {
			const destKey = event.destination.key;
			const entries = nav.entries();
			const destIdx = entries.findIndex((e) => e.key === destKey);
			const curIdx = nav.currentEntry?.index ?? -1;
			if (destIdx >= 0 && curIdx >= 0) {
				if (destIdx > curIdx) return ["forward"];
				if (destIdx < curIdx) return ["back"];
			}
		}
		return [];
	};

	const handler = (event: NavigateEvent) => {
		if (!event.canIntercept) return;
		if (event.hashChange || event.downloadRequest !== null) return;
		// `formMethod` isn't on TS 6's NavigateEvent type but is in the
		// spec (and runtime). Reach it via a narrow cast to avoid a type
		// error without broadening `event`'s type everywhere else.
		if ((event as { formMethod?: string | null }).formMethod === "POST") return;
		// `window.location.reload()` fires a navigate event with
		// `navigationType: "reload"` that the browser *can* intercept as
		// same-document. Intercepting defeats the whole point of a reload
		// (it re-runs against the existing module state). Pass it through
		// so the browser does a real cross-document reload.
		if (event.navigationType === "reload") return;

		// Framework-internal URL syncs stamp a branded `info` payload on
		// their `navigation.navigate(...)` call. Two variants:
		//   - window-silent: caller updated the URL only (or will dispatch
		//     its own targeted refetch).
		//   - frame:         caller pushed a frame-state entry; the frame
		//     subtree refetch runs in `frameNavigateImpl` after commit.
		// In both cases we call `event.intercept()` with no handler to
		// declare the navigation as same-document and avoid a page load —
		// silent URL work is pure client state, so this branch intercepts
		// on DEGRADED pages too.
		//
		// `focusReset: "manual"` opts out of the Navigation API's default
		// post-commit focus reset to <body>. Without it, any input driving
		// a live refetch (the search input typing into `selector: ".…"`,
		// a filter that updates a frame URL, etc.) loses focus on every
		// keystroke.
		//
		// `scroll: "manual"` opts out of the default post-commit scroll. A
		// framework-silent nav is a URL-only sync (a bookmarkable `?page=` /
		// `?q=` the caller updates without a refetch); the default
		// `"after-transition"` would scroll a push/replace to the top, yanking
		// the viewport out from under whatever the user is doing.
		if (isFrameworkSilentInfo(event.info)) {
			// A window-silent URL sync on an attached page still states its
			// URL on the channel (fire-and-forget, intent "silent"): the
			// held connection's request state must follow silent moves too
			// — match gates read the page URL — and the claim keeps the
			// heartbeat from tearing the stream the statement rides. A
			// selector nav's own refetch statement (dispatched by the
			// initiator right after this event) replaces the pending frame
			// pre-flush, so exactly one url frame ships either way.
			if (event.info.mode === "window" && _channelNavAvailable()) {
				const dest = new URL(event.destination.url);
				if (!dest.searchParams.has("__frame")) {
					_channelClaimWindowNav();
					_channelNavigate({
						url: dest.pathname + dest.search,
						intent: "silent",
						record: false,
					});
				}
			}
			// A FRAME nav with explicit history (push/replace) stamps a
			// browser entry for an UNCHANGED window URL; its refetch is a
			// frame url statement on the held stream (dispatched by the
			// initiator right after this event) — keep the stream.
			if (event.info.mode === "frame" && _channelNavAvailable()) {
				_channelClaimWindowNav();
			}
			event.intercept({ focusReset: "manual", scroll: "manual" });
			return;
		}

		// A DEGRADED page (or one that opted out of the transport) does
		// not intercept: links, traverses and form posts are
		// browser-native document navigations — SSR renders, a plain
		// website.
		if (_channelIsDegraded() || heartbeatDisabled()) return;

		// Browser back/forward. Two axes need handling on a traverse:
		//   1. Page URL changed (e.g. /frames-demo?product=beta → /frames-demo)
		//      — a window url statement; the navigation segment re-renders
		//      the tree.
		//   2. Frame snapshots differ between destination and current
		//      — each differing frame needs its server session updated
		//      AND its subtree re-rendered. This fires when the user has
		//      done explicit `history: "push"` / `"replace"` frame navs
		//      (which create browser entries). The default `history:
		//      "auto"` on frames uses `updateCurrentEntry`, which doesn't
		//      create entries, so drawer-shaped frames never show up here.
		//
		// Both axes ride one envelope: the window statement latches
		// navigation-first server-side, the frame statements lane on the
		// reopened region.
		if (event.navigationType === "traverse") {
			const destPaths = _collectFramePaths(
				_readFramesSnapshot(event.destination.getState?.()),
			);
			const currentPaths = _collectFramePaths(
				_readFramesSnapshot(nav.currentEntry?.getState() ?? null),
			);
			const names = new Set([
				...Object.keys(destPaths),
				...Object.keys(currentPaths),
			]);
			// Each diff entry carries the dotted frame path and the destination URL.
			const diffs: Array<{ key: string; url: string }> = [];
			for (const name of names) {
				const dest = destPaths[name]?.url;
				const cur = currentPaths[name]?.url;
				if (dest && dest !== cur) diffs.push({ key: name, url: dest });
			}
			const urlChanged = event.destination.url !== window.location.href;
			if (urlChanged) {
				// Route through `onNavigation` so the framework's transition-
				// type detection runs (forward / back). Frame diffs dispatch
				// their own frame statements alongside — the same rAF flush
				// coalesces window + frame frames into one envelope. Intent
				// "replace": the history move already happened.
				const types = directionFor(event);
				_channelClaimWindowNav();
				event.intercept({
					handler: () =>
						swallowNavigationAbort(async () => {
							const jobs: Array<Promise<unknown>> = [
								onNavigation(
									event.destination.url,
									types,
									event.signal,
									"replace",
								),
							];
							for (const d of diffs) {
								jobs.push(_dispatchFrameRefetch(d.key.split("."), d.url).finished);
							}
							await Promise.all(jobs);
						}),
				});
				return;
			}
			if (diffs.length > 0) {
				// A pure frame traverse (window URL unchanged): the per-frame
				// statements ride the held stream — keep it.
				_channelClaimWindowNav();
				event.intercept({
					handler: () =>
						swallowNavigationAbort(() =>
							Promise.all(
								diffs.map(
									(d) =>
										_dispatchFrameRefetch(d.key.split("."), d.url).finished,
								),
							).then(() => undefined),
						),
				});
				return;
			}
		}

		// The everything-else window navigation: a `url` statement. The
		// claim (set synchronously, during this dispatch) tells the
		// heartbeat's deferred abort check to keep the held stream — the
		// navigation's segment arrives ON it. Pre-establishment the
		// statement latches and rides the attach it triggers. The intent
		// mirrors the browser's own history semantic; a traverse's history
		// move already happened, so it states "replace".
		_channelClaimWindowNav();
		event.intercept({
			handler: () =>
				swallowNavigationAbort(() =>
					onNavigation(
						event.destination.url,
						directionFor(event),
						event.signal,
						event.navigationType === "push" ? "push" : "replace",
					),
				),
		});
	};

	nav.addEventListener("navigate", handler);
	return () => nav.removeEventListener("navigate", handler);
}

// When a client-initiated navigation (or the in-flight refetch for the
// initial page) gets cancelled mid-stream — user clicks away, newer
// navigation supersedes — React sees a Suspense boundary that never
// finished and logs "The server could not finish this Suspense boundary"
// through onRecoverableError. Expected; swallow it. Any other recoverable
// error still surfaces.
function silenceTornStream(error: unknown): void {
	if (
		error instanceof Error &&
		(error.message.includes(
			"The server could not finish this Suspense boundary",
		) ||
			error.name === "AbortError")
	) {
		return;
	}
	console.error(error);
}

// Wrap a navigate-intercept handler so AbortError (newer navigation
// supersedes an in-flight one) doesn't surface as an unhandled rejection.
async function swallowNavigationAbort(fn: () => Promise<void>): Promise<void> {
	try {
		await fn();
	} catch (err) {
		if (err instanceof Error && err.name === "AbortError") return;
		throw err;
	}
}
