/**
 * RSC request handler factory — the server half of a parton app's
 * entry surface. An app's `src/entry.rsc.tsx` is a thin file:
 *
 *     export default createRscHandler({
 *       Root,                    // app shell, rendered on every request
 *       notFound: NotFoundPage,  // optional 404 shell
 *       fetch: serveMyAssets,    // optional first-crack hook
 *     })
 *
 * SSR module resolution: `import.meta.viteRsc.loadModule("ssr", "index")`
 * below is a compile-time transform from `@vitejs/plugin-rsc`, not a
 * runtime lookup. The plugin statically evaluates the two string
 * literals and resolves the target from the APP's vite config — the
 * `ssr` environment's `build.rollupOptions.input.index` entry
 * (canonically `./src/entry.ssr.tsx`); in production builds the call
 * becomes a relative import between the rsc and ssr output
 * directories. The call is therefore free to live here inside the
 * framework: WHICH module it loads stays app-owned via the vite
 * config, and each app keeps a thin `src/entry.ssr.tsx` re-exporting
 * `renderHTML`. The arguments must stay literal — the transform
 * `eval`s them at build time.
 */
import {
	createTemporaryReferenceSet,
	decodeAction,
	decodeFormState,
	decodeReply,
	loadServerAction,
	renderToReadableStream,
} from "@vitejs/plugin-rsc/rsc";
import type { ComponentType, ReactNode } from "react";
import type { ReactFormState } from "react-dom/client";
import { CHANNEL_ENDPOINT } from "../lib/channel-protocol.ts";
import {
	applyAttachStatement,
	handleChannelPost,
} from "../lib/connection-session.ts";
import {
	wrapSsrStreamWithFpTrailer,
	wrapStreamWithCommitOnly,
	wrapStreamWithFpTrailer,
} from "../lib/fp-trailer.ts";
import { createSegmentedResponse } from "../lib/segmented-response.ts";
import { warmCmsCache } from "../runtime/cms-runtime.ts";
import {
	_actionSuppressesCommit,
	_captureCommitHandle,
	getFrameworkControl,
	runWithRequestAsync,
} from "../runtime/context.ts";
import { reportServerRenderError } from "../runtime/errors.ts";
import { runInvalidationTransaction } from "../runtime/invalidation-registry.ts";
import { createRemoteHandler } from "../runtime/remote-endpoints.tsx";
import { parseRenderRequest } from "../runtime/request.tsx";

export type RscPayload = {
	root: ReactNode;
	returnValue?: { ok: boolean; data: unknown };
	formState?: ReactFormState;
};

export interface RscHandlerConfig {
	/** App shell — rendered as the payload root on every request. */
	Root: ComponentType;
	/** Rendered (status 404) when a render signals `notFound()`. Without
	 *  it, not-found requests get a plain-text 404 response. */
	notFound?: ComponentType;
	/** App-level first crack at every request (static assets, bespoke
	 *  endpoints). A returned Response short-circuits the pipeline;
	 *  `null` / `undefined` falls through to the RSC/SSR render. */
	fetch?: (
		request: Request,
	) => Promise<Response | null | undefined> | Response | null | undefined;
	/** Expose the app's addressable partons at `/__remote/*` for
	 *  cross-origin `<RemoteFrame>` consumers. `name` identifies the app
	 *  in the manifest; `typesPath` (absolute) is served at
	 *  `/__remote/types.d.ts`. Omit to serve no remote endpoints. */
	remote?: { name: string; typesPath?: string };
	/** Extra per-scope app state to clear on the DEV-only
	 *  `/__test/clear-caches` endpoint, alongside the framework's own
	 *  cache / registry / session / cell clearing. */
	clearCaches?: (scope: string | "all") => void | Promise<void>;
}

export function createRscHandler(config: RscHandlerConfig): {
	fetch(request: Request): Promise<Response>;
} {
	const { Root, notFound: NotFound } = config;

	/** Shared remote-endpoint dispatch — OPTIONS, /__remote/manifest.json,
	 *  /__remote/types.d.ts, /__remote/<selector>. */
	const remoteHandler = config.remote
		? createRemoteHandler({
				name: config.remote.name,
				renderToFlightStream: (element) =>
					renderToReadableStream(element, { onError: onRscRenderError }),
				typesPath: config.remote.typesPath,
			})
		: null;

	async function handler(request: Request): Promise<Response> {
		if (remoteHandler) {
			const remote = await remoteHandler(request);
			if (remote) return remote;
		}

		const url = new URL(request.url);

		// Channel envelopes — fire-and-forget POSTs from the client's
		// channel transport, addressed to an open live connection by its
		// explicit id. Applied to the connection session and answered
		// `204` with no body: every rendered consequence travels down the
		// live stream as lane segments, never on this response. `404`
		// (connection not open, or an attach-binding mismatch) is the
		// client's signal to fall back to the discrete path.
		// Framework-owned, dispatched before the app's `fetch` hook like
		// the remote endpoints above — but INSIDE a request scope: no
		// render runs, yet the scope resolves through the ALS and this
		// response is the one place a channel interaction can mint
		// Set-Cookie (the held stream's headers are long gone by the time
		// a frame arrives).
		if (request.method === "POST" && url.pathname === CHANNEL_ENDPOINT) {
			const { result, cookies } = await runWithRequestAsync(request, () =>
				handleChannelPost(request),
			);
			for (const cookie of cookies) {
				result.headers.append("set-cookie", cookie);
			}
			return result;
		}

		if (config.fetch) {
			const appResponse = await config.fetch(request);
			if (appResponse) return appResponse;
		}

		if (import.meta.env?.DEV) {
			if (url.pathname === "/__test/clear-caches") {
				const [
					{ _clearCache },
					{ clearRegistry },
					{ _clearAllSessions },
					{ _clearCmsDraft },
					{ getCellStorage },
					{ _clearInvalidationRegistry },
					{ _clearScheduledTasks },
				] = await Promise.all([
					import("../lib/cache.tsx"),
					import("../lib/partial-registry.ts"),
					import("../runtime/session.ts"),
					import("../runtime/cms-runtime.ts"),
					import("../runtime/cell-storage.ts"),
					import("../runtime/invalidation-registry.ts"),
					import("../runtime/context.ts"),
				]);
				const all = url.searchParams.get("all") === "1";
				const scope = all
					? "all"
					: (request.headers.get("x-test-scope") ?? "default");
				await _clearCache(scope);
				clearRegistry(scope);
				_clearAllSessions(scope);
				getCellStorage().clear(scope);
				if (all) _clearInvalidationRegistry();
				_clearScheduledTasks(scope);
				await config.clearCaches?.(scope);
				// CMS draft is process-global file-system state shared across
				// every test scope. Only wipe it when explicitly requested via
				// `?cms=1` (or the wholesale `?all=1`) — clearing on every
				// `beforeEach` races with cms-edit tests that depend on the
				// draft state surviving across their own assertions.
				if (all || url.searchParams.get("cms") === "1") {
					await _clearCmsDraft();
				}
				return new Response("ok", { status: 200 });
			}
		}

		const renderRequest = parseRenderRequest(request);
		await warmCmsCache();

		const { result: response, cookies } = await runWithRequestAsync(
			renderRequest.request,
			() => handleRequest(renderRequest),
		);

		for (const cookie of cookies) {
			response.headers.append("set-cookie", cookie);
		}

		return response;
	}

	async function handleRequest(
		renderRequest: ReturnType<typeof parseRenderRequest>,
	): Promise<Response> {
		const request = renderRequest.request;

		let returnValue: RscPayload["returnValue"] | undefined;
		let formState: ReactFormState | undefined;
		let temporaryReferences: unknown | undefined;
		let actionStatus: number | undefined;

		// The attach — the heartbeat's live fire as a POST whose body is
		// the client statement (manifest + catch-up anchor + viewport
		// seed). Dispatched on the explicit request marker
		// (`parseRenderRequest`), never the body's shape: an action POST
		// with a statement-shaped body stays an action, and this POST
		// never decodes as one. The statement lands on the request store
		// here so the segment driver and `PartialRoot` read it in place
		// of the `?cached=`/`?visible=` URL params a discrete GET
		// carries; the response falls through to the full segmented
		// drive + fp-trailer path exactly as a live GET's does.
		if (renderRequest.isAttach) {
			const statement = await applyAttachStatement(request);
			if (statement === null) return new Response(null, { status: 400 });
		}

		if (renderRequest.isAction === true) {
			if (renderRequest.actionId) {
				const contentType = request.headers.get("content-type");
				const body = contentType?.startsWith("multipart/form-data")
					? await request.formData()
					: await request.text();
				temporaryReferences = createTemporaryReferenceSet();
				const args = await decodeReply(body, { temporaryReferences });
				const action = await loadServerAction(renderRequest.actionId);
				try {
					// Run inside an invalidation transaction so server-side
					// `getServerNavigation().reload({selector})` calls inside the
					// action body queue until the action resolves. On throw the
					// queued bumps are discarded — a failed mutation shouldn't
					// trigger downstream refetches. On success the bumps flush
					// BEFORE the response render runs, so the action's own
					// response sees the bumped fps and emits fresh content.
					const data = await runInvalidationTransaction(() =>
						action.apply(null, args),
					);
					returnValue = { ok: true, data };
				} catch (e) {
					returnValue = { ok: false, data: e };
					actionStatus = 500;
				}
			} else {
				const formData = await request.formData();
				const decodedAction = await decodeAction(formData);
				try {
					const result = await runInvalidationTransaction(() =>
						decodedAction(),
					);
					formState = await decodeFormState(result, formData);
				} catch {
					return new Response("Internal Server Error", { status: 500 });
				}
			}
		}

		// A deferred-only action — every write went to a `deferred` cell —
		// omits its response re-render (`root: null`). The new value rides the
		// already-open streaming connection (the heartbeat's `?streaming=1`
		// segment); the client skips committing a null root. Mixed batches and
		// errored actions (`actionStatus` set) still render so non-deferred
		// writes and failures surface on the POST. See
		// `docs/internals/streaming.md` § "Deferred (stream-only) writes".
		const suppressRoot =
			renderRequest.isAction === true &&
			actionStatus === undefined &&
			_actionSuppressesCommit();
		const buildRscPayload = (): RscPayload => ({
			root: suppressRoot ? null : <Root />,
			formState,
			returnValue,
		});
		// RSC path renders inside the segment driver via `renderOnce`; it
		// may be invoked multiple times if any render signals
		// `markConnectionLive()`. SSR path renders once below (the rsc bytes
		// are inlined into `<script>FLIGHT_DATA</script>` tags so we can't
		// run multiple Flight documents through it).
		const renderOnce = (): ReadableStream<Uint8Array> => {
			const stream = renderToReadableStream<RscPayload>(buildRscPayload(), {
				temporaryReferences,
				onError: onRscRenderError,
			});
			// Action POSTs skip the trailer — Flight stops reading once the
			// root row resolves on the action-result path, and a splitter
			// waiting for the trailer past that point can stall under
			// backpressure. Non-action GETs get the length-prefixed binary
			// fp-trailer.
			const wrap = renderRequest.isAction
				? wrapStreamWithCommitOnly
				: wrapStreamWithFpTrailer;
			return wrap(stream, _captureCommitHandle());
		};

		if (renderRequest.isRsc) {
			// Single segment for action POSTs (one render + return). GETs get
			// the multi-segment driver: if any render signals
			// `markConnectionLive()` (e.g. the chat's ChunkSlot awaiting the
			// next log entry), the response stays open and re-renders on every
			// `refreshSelector` bump until a render finishes without signalling
			// live. Single-segment GETs (the common case) emit one segment and
			// close immediately — byte-identical to the pre-loop behavior.
			if (renderRequest.isAction) {
				return new Response(renderOnce(), {
					status: actionStatus,
					headers: { "content-type": "text/x-component;charset=utf-8" },
				});
			}
			return new Response(
				// The response stream's pull is the driver's demand signal:
				// lane output parks while the consumer's queue is full, so a
				// slow reader on a held connection never buffers unboundedly
				// server-side.
				createSegmentedResponse(renderOnce),
				{
					status: actionStatus,
					headers: {
						"content-type": "text/x-component;charset=utf-8",
						// The segment driver's byte timing IS the protocol: a
						// connection that holds open (an explicit `?live=1`
						// subscription, or a plain GET whose render calls
						// `markConnectionLive()` — unknowable at header time)
						// parks between wakes, and each framed lane must reach
						// the client the moment it drains. A compressor between
						// the driver and the browser holds frames in its buffer
						// — a block-buffering intermediary indefinitely, and
						// even the framework's own per-write-flush compressor
						// measurably delays mid-stream pushes (the chat's
						// progressive rows flake under it). `no-transform` on
						// every segmented response keeps all of them off;
						// documents and action responses still compress.
						"cache-control": "no-transform",
					},
				},
			);
		}

		// SSR response: rscStream gets inlined into <script>FLIGHT_DATA</script>
		// tags by `rsc-html-stream`. If we appended a binary trailer to
		// rscStream the trailer's JSON payload would be visible in the
		// rendered HTML source (FLIGHT_DATA pushes are JSON-stringified
		// chunk content). Instead: commit-only on the rscStream, and
		// append the fp-trailer as an `<!--fp-trailer:JSON-->` comment
		// AFTER the HTML output. The client's `_applyFpTrailerFromDocument`
		// reads it on hydration. The `wrapStreamWithCommitOnly` /
		// `wrapSsrStreamWithFpTrailer` helpers both call
		// `deferRequestRegistryCommit()` internally, so the registry commit
		// fires when the stream flushes (post-render) rather than at the
		// moment this handler returns.
		const commit = _captureCommitHandle();
		const ssrEntryModule = await import.meta.viteRsc.loadModule<
			typeof import("./ssr.tsx")
		>("ssr", "index");
		const ssrRscStream = renderToReadableStream<RscPayload>(buildRscPayload(), {
			temporaryReferences,
			onError: onRscRenderError,
		});
		const ssrResult = await ssrEntryModule.renderHTML(
			wrapStreamWithCommitOnly(ssrRscStream, commit),
			{
				formState,
				debugNojs: renderRequest.url.searchParams.has("__nojs"),
			},
		);

		const finalControl = getFrameworkControl();

		if (finalControl?.redirect) {
			return new Response(null, {
				status: finalControl.redirect.status,
				headers: { location: finalControl.redirect.url },
			});
		}

		if (finalControl?.notFound) {
			if (!NotFound) {
				return new Response("Not Found", { status: 404 });
			}
			const notFoundPayload: RscPayload = {
				root: <NotFound />,
				formState,
			};
			const notFoundStream = renderToReadableStream<RscPayload>(
				notFoundPayload,
				{
					temporaryReferences: createTemporaryReferenceSet(),
					onError: onRscRenderError,
				},
			);
			const notFoundSsr = await ssrEntryModule.renderHTML(notFoundStream, {
				formState,
				debugNojs: renderRequest.url.searchParams.has("__nojs"),
			});
			return new Response(
				wrapSsrStreamWithFpTrailer(notFoundSsr.stream, commit),
				{
					status: 404,
					headers: { "Content-type": "text/html" },
				},
			);
		}

		return new Response(wrapSsrStreamWithFpTrailer(ssrResult.stream, commit), {
			status: ssrResult.status,
			headers: { "Content-type": "text/html" },
		});
	}

	return { fetch: handler };
}

// Production strips the message off a render error and ships only a
// digest to the client. `reportServerRenderError` mints that digest,
// logs it next to the real stack on the server, and returns it for
// React to serialize — so a client digest traces back to a server log.
function onRscRenderError(error: unknown): string | undefined {
	return reportServerRenderError("rsc", error);
}
