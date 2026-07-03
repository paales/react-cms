/**
 * Browser bootstrap — the client tier of a parton app's entry surface.
 * An app's `src/entry.browser.tsx` is two lines:
 *
 *     import { bootBrowser } from "@parton/framework/entry/browser.tsx"
 *     bootBrowser()
 *
 * `bootBrowser` hydrates the SSR document from the inlined Flight
 * stream, installs the Navigation API intercept, the segmented-Flight
 * refetch/preload transports (`window.__rsc_partial_refetch` /
 * `__rsc_partial_preload`), the server-action callback, and the live
 * page heartbeat.
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
	_collectFramePaths,
	_commitPartonLane,
	_dispatchFrameRefetch,
	_readFramesSnapshot,
	_warmCacheFromPayload,
	getCachedPartialIds,
	isFrameworkSilentInfo,
} from "../lib/partial-client.tsx";
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

	// The SSR HTML response carries the fp-trailer as an HTML comment
	// appended after `</html>` (see `wrapSsrStreamWithFpTrailer` in
	// the framework). Parse it now so the warm fps the server
	// computed during this cold render are registered before any
	// subsequent navigation fires `?cached=`. Without this, the first
	// nav after a hard refresh / SSR mounts the page with only cold
	// fps in `_currentPageFingerprints` and the very next visit
	// pays a full fresh re-render instead of fp-skipping.
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
			const off = listenNavigation((url, types, signal) => {
				setPendingTransitionTypes(types ?? []);
				return fetchRscPayload(url, signal).finished;
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
				{/* Opt-in live updates. The heartbeat holds a `?streaming=1`
				 *  long-poll connection open against the current URL; the
				 *  server's segment driver pushes refreshSelector /
				 *  expiresAt updates as they happen. Mounted here so its
				 *  useEffect runs AFTER React's first commit — by that
				 *  point `_currentPageFingerprints` is populated by the
				 *  rendered `PartialErrorBoundary`s and the first fetch's
				 *  `?cached=` carries them. See
				 *  `docs/internals/streaming.md`. */}
				<LivePageHeartbeat />
			</>
		);
	}

	// Identity of a page URL for staleness checks — pathname + search
	// with framework-internal refetch params stripped (`partials`,
	// `cached`, `streaming`, `live`, `__frame*`). Those describe
	// HOW a refetch was dispatched, not WHICH page it represents, so a
	// targeted refetch's key equals the page it targets; only real
	// navigation (pathname / `?search` / `?q` / …) changes it. Defaults
	// to the live `window.location`.
	function pageUrlKey(href: string = window.location.href): string {
		const u = new URL(href, window.location.origin);
		// Position params the page url carries but that must NOT key the
		// stale-commit guard: `visible` (the read-tracked culling set, sent via
		// reload({params})) and `page` (the scroll anchor, silently mirrored as
		// you scroll). Both move while you stay on the same page; if they keyed
		// the guard, an in-flight culling commit would be dropped as "stale"
		// every time the anchor ticked. They are NOT FRAMEWORK_URL_PARAMS, so
		// the render still sees them (visible() and the ?page= cold seed read
		// them).
		for (const k of [
			"partials",
			"cached",
			"streaming",
			"live",
			"__conn",
			"visible",
			"page",
			"__frame",
			"__frameUrl",
			"__cullFlip",
		]) {
			u.searchParams.delete(k);
		}
		return u.pathname + u.search;
	}

	/**
	 * Returns synchronously with `{streaming, finished}` promises so
	 * navigation-handle callers can branch off the first-segment moment
	 * separately from the full-body-drained moment. The work runs in a
	 * detached async IIFE so the caller can attach handlers before the
	 * fetch even starts.
	 */
	function fetchRscPayload(
		overrideUrl?: string,
		signal?: AbortSignal,
		claimCommit?: () => boolean,
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

		// The page URL this fetch is being issued for. Every refetch
		// produces ONE whole-root Flight payload built against the URL
		// current at issue time; if the user navigates away before it
		// commits (escape-closes the search overlay, types a newer query,
		// clicks a link), that payload is stale and must NOT paint — it
		// would clobber the newer page (e.g. re-open a closed dialog).
		// Captured here, re-checked before each commit. Same-URL refetches
		// (cart badge, price, heartbeat) keep committing — only a commit
		// whose page URL is no longer current is dropped, so independent
		// sections still update concurrently. Keyed off the URL this fetch
		// is FOR (`overrideUrl` for a full-page nav, else the live page).
		const issuedForPageUrl = pageUrlKey(overrideUrl);

		void (async () => {
			let streamingResolved = false;
			try {
				// Tell the server which partials are already cached so it can skip them.
				// If the caller already set ?cached= (e.g. a targeted refetch built by
				// `useNavigation().reload({selector})`), respect that instead of overwriting
				// with the full list.
				const url = new URL(overrideUrl ?? window.location.href);
				if (!url.searchParams.has("cached")) {
					const cachedIds = getCachedPartialIds();
					if (cachedIds.length > 0) {
						url.searchParams.set("cached", cachedIds.join(","));
					}
				}
				// Suspense keys are bare partial ids — React reconciles each
				// boundary in place across refetches. The two commit paths differ
				// only in how React treats pending children on the client:
				//
				//   setPayload (default, wraps in startTransition): React holds
				//     the current UI visible until the new content is fully
				//     ready. No Suspense fallback flash, no per-chunk streaming.
				//     Good for "just swap values" UX like a cart badge or live
				//     price (pair with the `committed && !finished` predicate).
				//
				//   setPayloadRaw (opt-in via ?streaming=1): plain post-await
				//     setState, outside any transition. React 19 shows Suspense
				//     fallbacks for pending children and commits Flight chunks
				//     as they arrive, giving per-row progressive streaming.
				//     Good for search / filter results where per-row reveal
				//     improves perceived latency.
				const streamingMode = url.searchParams.has("streaming");
				const renderRequest = createRscRenderRequest(url.toString());
				// Network → HTTP → decode. Each failure mode maps to a typed
				// NavigationError kind so consumers can branch on it without
				// string matching. AbortError stays untouched — it's a normal
				// lifecycle signal, not a failure.
				//
				// NOTE: `signal` is deliberately NOT passed to `fetch`. Aborting
				// the fetch errors `response.body` mid-read, which tears a
				// partially-committed Flight tree and throws
				// `BodyStreamBuffer was aborted` into the error boundary. Instead
				// the signal goes to `splitSegments` below, which aborts
				// cooperatively at a SEGMENT BOUNDARY — the in-flight segment
				// finishes, then iteration stops and the reader is cancelled
				// (releasing a long-lived RSC GET like the chat's segment loop).
				let response: Response;
				try {
					response = await fetch(renderRequest);
				} catch (err) {
					if (err instanceof Error && err.name === "AbortError") throw err;
					throw new NavigationError({
						kind: "network",
						url: renderRequest.url,
						cause: err,
					});
				}
				if (!response.ok || !response.body) {
					throw new NavigationError({
						kind: "http",
						url: renderRequest.url,
						status: response.status,
					});
				}
				// RSC GET navs carry segmented Flight bytes: one or more Flight
				// documents on the same response, separated by `next` markers,
				// each followed by zero-or-more trailer entries (fp-updates,
				// url-update). The splitter peels each segment off and yields a
				// `{body, trailers}` pair; we hand each body to `createFromReadableStream`
				// and call setPayload per segment.
				//
				// Single-segment responses (no `next` marker) loop once — same
				// wire shape and behavior as the legacy fp-trailer flow.
				// Decode + commit one per-parton lane. The body carries the
				// lane's Flight payload plus its own fp trailer; decode fully
				// (the lane closed at its `muxend`, so all bytes are here),
				// guard against a page the user has since left, then hand the
				// subtree to the framework's cache-commit path — which swaps
				// it in place via a template re-render, no whole-payload
				// setPayload involved.
				const handleLane = async (lane: DemuxedLane): Promise<void> => {
					const { mainStream, trailer } = splitAtFpTrailer(lane.body);
					const node =
						await createFromReadableStream<React.ReactNode>(mainStream);
					if (pageUrlKey() !== issuedForPageUrl) return;
					const fp = (await trailer) as FpUpdatesPayload | null;
					_commitPartonLane(node, fp);
				};
				try {
					for await (const segment of splitSegments(response.body, signal)) {
						if (segment.kind === "lanes") {
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
						const payload = await createFromReadableStream<RscPayload>(
							segment.body,
						);
						// Drop a stale whole-root commit: if the page URL moved on
						// since this fetch was issued, painting its payload would
						// clobber the newer page (re-open a closed overlay, restore
						// a superseded query). Skip the commit AND its trailers
						// (which would otherwise register fingerprints for the
						// stale tree). Keep draining so the stream closes cleanly.
						if (pageUrlKey() !== issuedForPageUrl) continue;
						// Monotonic commit ordering: drop this segment if a newer
						// fire for the same selector has already committed (a
						// superseded refetch whose response arrived out of order —
						// the stale-`q` search bug). Keep draining so the stream
						// closes cleanly; just skip the commit and its trailers. The
						// gate is provided by the framework's refetch dispatcher
						// (`refetch-ordering.ts`); full-page navs pass none.
						if (claimCommit && !claimCommit()) continue;
						segment.trailers.then(applyStandardTrailers).catch(() => {});
						if (streamingMode) {
							setPayloadRaw(payload);
						} else {
							setPayload(payload);
						}
						// First segment landed and React has been told to render it.
						// Resolve `streaming` so per-selector abort queues can fire
						// predecessor aborts and consumers can branch off "first
						// rows visible".
						if (!streamingResolved) {
							streamingResolved = true;
							resolveStreaming();
						}
					}
				} catch (err) {
					if (err instanceof Error && err.name === "AbortError") throw err;
					throw new NavigationError({
						kind: "decode",
						url: renderRequest.url,
						cause: err,
					});
				}
				// A fully-superseded fire commits nothing (every segment dropped
				// by the monotonic gate), so `streaming` never resolved in the
				// loop. The body has drained — resolve it now (alongside
				// `finished`) so the caller's `await streaming` can't hang.
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
	 * Preload transport: warm a destination's partials into the client
	 * cache WITHOUT committing. Mirrors `fetchRscPayload`'s fetch +
	 * segmented decode, but instead of `setPayload` it walks each decoded
	 * payload into `_currentPagePartials` / `_currentPageFingerprints`
	 * via `_warmCacheFromPayload`. Nothing renders; the current page is
	 * untouched. A later navigation to this URL fp-skips the warmed
	 * partials and substitutes them from cache instantly.
	 *
	 * Sends `?cached=` (current client fps) so the warm render fp-skips
	 * shared chrome and parked off-route partials — only the
	 * destination-specific partials come back fresh and land in the cache.
	 */
	async function warmRscPayload(
		overrideUrl: string,
		signal?: AbortSignal,
	): Promise<void> {
		const url = new URL(overrideUrl, window.location.origin);
		// Hovering a link to the page you're already on warms nothing new.
		if (pageUrlKey(url.href) === pageUrlKey()) return;
		if (!url.searchParams.has("cached")) {
			const cachedIds = getCachedPartialIds();
			if (cachedIds.length > 0)
				url.searchParams.set("cached", cachedIds.join(","));
		}
		const renderRequest = createRscRenderRequest(url.toString());
		let response: Response;
		try {
			response = await fetch(renderRequest);
		} catch (err) {
			if (err instanceof Error && err.name === "AbortError") return;
			throw new NavigationError({
				kind: "network",
				url: renderRequest.url,
				cause: err,
			});
		}
		if (!response.ok || !response.body) {
			throw new NavigationError({
				kind: "http",
				url: renderRequest.url,
				status: response.status,
			});
		}
		// Same segmented-Flight decode as the nav path. Each segment's tree
		// is walked into the cache; trailers (cold→warm fp drift) are applied
		// so the warmed fps match what a later nav will compute. The signal
		// aborts cooperatively at a segment boundary (via `splitSegments`),
		// so a superseding preload tears this one down cleanly.
		for await (const segment of splitSegments(response.body, signal)) {
			// Preloads are one-shot renders — never live, so never lanes.
			if (segment.kind !== "payload") continue;
			const payload = await createFromReadableStream<RscPayload>(segment.body);
			_warmCacheFromPayload(payload.root);
			segment.trailers.then(applyStandardTrailers).catch(() => {});
		}
	}
	// Navigation handles (useNavigation / frame) dispatch targeted
	// refetches by calling this handler with a fully-formed URL.
	// Exposed on `window` directly to avoid module-instance duplication
	// between the browser entry bundle and "use client" component
	// bundles.
	(window as any).__rsc_partial_refetch = (
		url: string,
		signal?: AbortSignal,
		claimCommit?: () => boolean,
	) => fetchRscPayload(url, signal, claimCommit);
	// Preload counterpart: warm-only, no commit. See `warmRscPayload`.
	(window as any).__rsc_partial_preload = (url: string, signal?: AbortSignal) =>
		warmRscPayload(url, signal);

	setServerCallback(async (id, args) => {
		const temporaryReferences = createTemporaryReferenceSet();
		// Include cached partial fingerprints so the server can skip
		// unchanged partials after a server action (same as navigation).
		const actionUrl = new URL(window.location.href);
		const cachedIds = getCachedPartialIds();
		if (cachedIds.length > 0) {
			actionUrl.searchParams.set("cached", cachedIds.join(","));
		}
		const renderRequest = createRscRenderRequest(actionUrl.toString(), {
			id,
			body: await encodeReply(args, { temporaryReferences }),
		});
		const response = await fetch(renderRequest);
		if (!response.ok || !response.body) {
			throw new NavigationError({
				kind: "http",
				url: renderRequest.url,
				status: response.status,
			});
		}
		// Same segmented-Flight decode as the GET path. Actions today
		// produce a single segment (no `markConnectionLive` from action
		// bodies), so the `for await` loops once — but the splitter is
		// what lets us pick the trailers off the wire. Without it the
		// url-trailer emitted by `getServerNavigation().navigate(...)`
		// inside an action body never reaches the client and the URL
		// never updates.
		let firstPayload: RscPayload | undefined;
		for await (const segment of splitSegments(response.body)) {
			// Action POSTs are one-shot — never lanes.
			if (segment.kind !== "payload") continue;
			const payload = await createFromReadableStream<RscPayload>(segment.body, {
				temporaryReferences,
			});
			if (!firstPayload) firstPayload = payload;
			segment.trailers.then(applyStandardTrailers).catch(() => {});
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
			fetchRscPayload().finished.catch((err) => {
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
		// declare the navigation as same-document and avoid a page load.
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
			event.intercept({ focusReset: "manual", scroll: "manual" });
			return;
		}

		// Browser back/forward. Two axes need handling on a traverse:
		//   1. Page URL changed (e.g. /frames-demo?product=beta → /frames-demo)
		//      — the main page content needs a full refetch.
		//   2. Frame snapshots differ between destination and current
		//      — each differing frame needs its server session updated
		//      AND its subtree re-rendered. This fires when the user has
		//      done explicit `history: "push"` / `"replace"` frame navs
		//      (which create browser entries). The default `history:
		//      "auto"` on frames uses `updateCurrentEntry`, which doesn't
		//      create entries, so drawer-shaped frames never show up here.
		//
		// Both axes are handled in one request: we build a refetch URL
		// with the destination's page URL AND append `__frame/__frameUrl`
		// pairs for every frame that changed, so the server applies the
		// session updates, then does a streaming render for the new URL.
		//
		// If the URL didn't change and only frames changed, skip the full
		// render and fire targeted per-frame refetches instead.
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
				// type detection runs (forward / back). If frame snapshots
				// also differ, append `__frame=…&__frameUrl=…` so the server
				// session catches up in the same request.
				const types = directionFor(event);
				event.intercept({
					handler: () =>
						swallowNavigationAbort(async () => {
							const url = new URL(event.destination.url);
							for (const d of diffs) {
								url.searchParams.append("__frame", d.key);
								url.searchParams.append("__frameUrl", d.url);
							}
							await onNavigation(url.toString(), types, event.signal);
						}),
				});
				return;
			}
			if (diffs.length > 0) {
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

		event.intercept({
			handler: () =>
				swallowNavigationAbort(() =>
					onNavigation(
						event.destination.url,
						directionFor(event),
						event.signal,
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
