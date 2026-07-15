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
} from "@vitejs/plugin-rsc/rsc"
import { Fragment, type ComponentType, type ReactNode } from "react"
import type { ReactFormState } from "react-dom/client"
import {
  ATTACH_ENDPOINT,
  type AttachStatement,
  CHANNEL_ENDPOINT,
  decodeAttachStatement,
} from "../lib/channel-protocol.ts"
import {
  type ChannelDuplexStream,
  type ChannelSocket,
  driveChannelSocket,
  driveChannelWebTransport,
} from "../lib/channel-server.ts"
import {
  _adoptConnectionForAction,
  bindAttachStatement,
  handleChannelPost,
  isSameOriginPost,
} from "../lib/connection-session.ts"
import {
  wrapSsrStreamWithFpTrailer,
  wrapStreamWithCommitOnly,
  wrapStreamWithFpTrailer,
} from "../lib/fp-trailer.ts"
import { EMBED_CELLS_HEADER, embedDepthOf, embedNamespaceOf } from "../lib/page-embed.ts"
import { computeRouteKey, partialFromSnapshot } from "../lib/partial.tsx"
import {
  _readSnapshotsForRoute,
  enterRequestRegistry,
  lookupPartial,
  type PartialSnapshot,
} from "../lib/partial-registry.ts"
import { runWithPartialState } from "../lib/partial-request-state.ts"
import { _reserveActionConsequences, createSegmentedResponse } from "../lib/segmented-response.ts"
import { wrapStreamWithSnapshotTrailer } from "../lib/snapshot-trailer.ts"
import { warmCmsCache } from "../runtime/cms-runtime.ts"
import {
  _drainRequestSettled,
  _drainRequestStarted,
  drainAttachRefusal,
  installDrainOnSigterm,
} from "../runtime/drain.ts"
import {
  CAPABILITY_HEADER,
  decodeCapability,
  runWithBoundCellProjection,
  runWithCapability,
  type Capability,
} from "../runtime/capability.ts"
import {
  _actionSuppressesCommit,
  _captureCommitHandle,
  _pinCodeVersion,
  getFrameworkControl,
  getScope,
  runWithRequestAsync,
} from "../runtime/context.ts"
import { currentCodeVersion } from "../lib/code-version.ts"
import { reportServerRenderError } from "../runtime/errors.ts"
import { runInvalidationTransaction } from "../runtime/invalidation-registry.ts"
import { createRemoteHandler } from "../runtime/remote-endpoints.tsx"
import { HEADER_RSC_RENDER, parseRenderRequest } from "../runtime/request.tsx"

export type RscPayload = {
  root: ReactNode
  returnValue?: { ok: boolean; data: unknown }
  formState?: ReactFormState
}

export interface RscHandlerConfig {
  /** App shell — rendered as the payload root on every request. */
  Root: ComponentType
  /** Rendered (status 404) when a render signals `notFound()`. Without
   *  it, not-found requests get a plain-text 404 response. */
  notFound?: ComponentType
  /** App-level first crack at every request (static assets, bespoke
   *  endpoints). A returned Response short-circuits the pipeline;
   *  `null` / `undefined` falls through to the RSC/SSR render. */
  fetch?: (request: Request) => Promise<Response | null | undefined> | Response | null | undefined
  /** Serve the static remote metadata endpoints —
   *  `/__remote/manifest.json` (the embeddable-page inventory the
   *  `parton add` CLI reads) and `/__remote/types.d.ts` (capability
   *  types) — plus CORS preflight. Embedding itself needs NO config:
   *  every page is fetchable as Flight via the embed headers. `name`
   *  identifies the app in the manifest; `typesPath` (absolute) is
   *  served at `/__remote/types.d.ts`. Omit to serve no metadata. */
  remote?: { name: string; typesPath?: string }
  /** Extra per-scope app state to clear on the DEV-only
   *  `/__test/clear-caches` endpoint, alongside the framework's own
   *  cache / registry / session / cell clearing. */
  clearCaches?: (scope: string | "all") => void | Promise<void>
  /** Deploy-and-drain wiring (`runtime/drain.ts`). By default the
   *  factory wires SIGTERM → `beginDrain` → exit: new attaches get the
   *  explicit drain refusal, every held connection gets the `drain`
   *  wire frame and settles (bounded by `deadlineMs`, default
   *  `DEFAULT_DRAIN_DEADLINE_MS`), then the process exits. `false`
   *  opts out — the app's own supervisor calls `beginDrain()` itself. */
  drain?: false | { deadlineMs?: number }
}

export function createRscHandler(config: RscHandlerConfig): {
  fetch(request: Request): Promise<Response>
  handleChannelSocket(socket: ChannelSocket, request: Request): Promise<void>
} {
  const { Root, notFound: NotFound } = config

  // The serving graph's birth version (dev HMR): captured at ENTRY
  // evaluation — atomic with the module import that built this
  // handler's graph — and pinned into every request scope the handler
  // opens, so fps fold the graph that actually renders, never a
  // process counter a concurrent edit moved past it. Always 0 in prod.
  const graphCodeVersion = currentCodeVersion()

  /** Static remote-metadata dispatch — OPTIONS,
   *  /__remote/manifest.json, /__remote/types.d.ts. */
  const remoteHandler = config.remote
    ? createRemoteHandler({
        name: config.remote.name,
        typesPath: config.remote.typesPath,
      })
    : null

  async function handler(request: Request): Promise<Response> {
    if (remoteHandler) {
      const remote = await remoteHandler(request)
      if (remote) return remote
    }

    const url = new URL(request.url)

    // Channel envelopes — fire-and-forget POSTs from the client's
    // channel transport, addressed to an open live connection by its
    // explicit id. Applied to the connection session and answered
    // `204` with no body: every rendered consequence travels down the
    // live stream as lane segments, never on this response. `404`
    // (connection not open, or an attach-binding mismatch) is the
    // client's signal that the connection is gone — the transport
    // reattaches. Framework-owned, dispatched before the app's
    // `fetch` hook like the remote endpoints above — but INSIDE a
    // request scope: no render runs, yet the scope resolves through
    // the ALS and this response is the one place a channel
    // interaction can mint Set-Cookie (the held stream's headers are
    // long gone by the time a frame arrives).
    if (request.method === "POST" && url.pathname === CHANNEL_ENDPOINT) {
      const { result, cookies } = await runWithRequestAsync(request, () => {
        _pinCodeVersion(graphCodeVersion)
        return handleChannelPost(request)
      })
      for (const cookie of cookies) {
        result.headers.append("set-cookie", cookie)
      }
      return result
    }

    // The attach — the connection's opening statement, and the whole
    // interactive transport's only render POST besides actions. The
    // dedicated path IS the dispatch signal: the JSON body is the
    // full client statement, the render request is built from the
    // statement's `url` (same-origin-validated — route key, match
    // gates and tracked reads all evaluate the stated URL), and the
    // response is the held segmented stream. The statement's one-shot
    // `?__force=` overlay never enters request state — the driver
    // reads it off the statement and lanes the targets after the
    // region opens.
    if (request.method === "POST" && url.pathname === ATTACH_ENDPOINT) {
      // A draining process stops accepting NEW attaches — the explicit
      // `503` + `x-parton-drain` refusal (a drain-aware proxy retries
      // the buffered attach against a surviving backend; the client
      // transport retries promptly, never counting it toward the
      // degrade bound). Envelopes, action POSTs and document GETs keep
      // serving for the whole drain window, so in-flight work lands.
      const refusal = drainAttachRefusal()
      if (refusal !== null) return refusal
      if (!isSameOriginPost(request)) return new Response(null, { status: 403 })
      let statement: AttachStatement | null
      try {
        statement = decodeAttachStatement(await request.json())
      } catch {
        statement = null
      }
      if (statement === null) return new Response(null, { status: 400 })
      const origin = new URL(request.url).origin
      let stated: URL
      try {
        stated = new URL(statement.url, origin)
      } catch {
        return new Response(null, { status: 400 })
      }
      if (stated.origin !== origin) return new Response(null, { status: 400 })
      for (const frame of statement.frames ?? []) {
        try {
          if (new URL(frame.url, origin).origin !== origin)
            return new Response(null, { status: 400 })
        } catch {
          return new Response(null, { status: 400 })
        }
      }
      stated.searchParams.delete("__force")
      const headers = new Headers(request.headers)
      headers.set(HEADER_RSC_RENDER, "1")
      const renderRequest = new Request(stated, { headers })
      await warmCmsCache()
      const { result: response, cookies } = await runWithRequestAsync(renderRequest, () => {
        _pinCodeVersion(graphCodeVersion)
        return handleAttach(statement)
      })
      for (const cookie of cookies) {
        response.headers.append("set-cookie", cookie)
      }
      return response
    }

    if (config.fetch) {
      const appResponse = await config.fetch(request)
      if (appResponse) return appResponse
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
        ])
        const all = url.searchParams.get("all") === "1"
        const scope = all ? "all" : (request.headers.get("x-test-scope") ?? "default")
        await _clearCache(scope)
        clearRegistry(scope)
        _clearAllSessions(scope)
        getCellStorage().clear(scope)
        if (all) _clearInvalidationRegistry()
        _clearScheduledTasks(scope)
        await config.clearCaches?.(scope)
        // CMS draft is process-global file-system state shared across
        // every test scope. Only wipe it when explicitly requested via
        // `?cms=1` (or the wholesale `?all=1`) — clearing on every
        // `beforeEach` races with cms-edit tests that depend on the
        // draft state surviving across their own assertions.
        if (all || url.searchParams.get("cms") === "1") {
          await _clearCmsDraft()
        }
        return new Response("ok", { status: 200 })
      }
      // The e2e tier's reach for the same `_setKeepaliveMs` override
      // the in-process rsc harness and soak bench use — over HTTP,
      // since the dev server is a separate process. Process-global
      // (the keepalive is one module-level value), so a spec needing
      // a short idle close brackets its run: set a value, then
      // restore the default (`ms` absent) in a finally.
      if (url.pathname === "/__test/set-keepalive") {
        const { _setKeepaliveMs } = await import("../lib/segmented-response.ts")
        const raw = url.searchParams.get("ms")
        _setKeepaliveMs(raw === null ? undefined : Number(raw))
        return new Response("ok", { status: 200 })
      }
    }

    const renderRequest = parseRenderRequest(request)
    await warmCmsCache()

    const { result: response, cookies } = await runWithRequestAsync(renderRequest.request, () => {
      _pinCodeVersion(graphCodeVersion)
      return handleRequest(renderRequest)
    })

    for (const cookie of cookies) {
      response.headers.append("set-cookie", cookie)
    }

    return response
  }

  // The attach's response body — runs inside `runWithRequestAsync` on
  // the render request the endpoint built from the statement's URL.
  // Binding the statement is the first act (frame intents' session
  // writes land in this scope, so a freshly-minted session cookie
  // rides this response's headers); the drive is a live GET's exact
  // shape: the segmented driver, the fp-trailer wrap, `no-transform`.
  async function handleAttach(statement: AttachStatement): Promise<Response> {
    bindAttachStatement(statement)
    const renderOnce = (): ReadableStream<Uint8Array> =>
      wrapStreamWithFpTrailer(
        renderToReadableStream<RscPayload>({ root: <Root /> }, { onError: onRscRenderError }),
        _captureCommitHandle(),
      )
    return new Response(createSegmentedResponse(renderOnce), {
      headers: {
        "content-type": "text/x-component;charset=utf-8",
        // The segment driver's byte timing IS the protocol: the held
        // connection parks between wakes, and each framed lane must
        // reach the client the moment it drains. A compressor between
        // the driver and the browser holds frames in its buffer — a
        // block-buffering intermediary indefinitely. `no-transform`
        // keeps every transform off; documents and action responses
        // still compress.
        "cache-control": "no-transform",
      },
    })
  }

  /**
   * A page fetched as Flight — a `<RemoteFrame>` embed hop (or any
   * header-marked Flight GET of a page). Two shapes on one response
   * contract (segmented Flight + the `snapshots` trailer entry, read
   * by the consumer's `splitSegments` trailer map):
   *
   *  - Whole page (the embed's cold render / re-render): the ordinary
   *    `<Root/>` render — `PartialRoot` sees the embed-depth header
   *    and emits the slice marker instead of the page shell.
   *  - Focused (`?partials=<id>` on an embed-flagged request — the
   *    refetch protocol): reconstruct the target(s) from this app's
   *    OWN registry, exactly like a lane render, so a host's
   *    selector-targeted refetch re-renders one parton, not the page.
   *    A registry miss falls back to the whole page — over-fetch,
   *    never fail (the sliced payload still carries the target's
   *    boundary).
   *
   * The capability header decodes into `getCapability()` scope for
   * both shapes — an embedded render is an anonymous visitor plus
   * exactly what the host declared (`credentials: "omit"` on the
   * fetch keeps host cookies out even same-origin).
   */
  async function handleEmbedRender(
    renderRequest: ReturnType<typeof parseRenderRequest>,
  ): Promise<Response> {
    const request = renderRequest.request
    const capability = decodeCapability(request.headers.get(CAPABILITY_HEADER))
    // The bound-cell projection — host-resolved values of the cells
    // the placement bound (`<RemoteFrame cells>`). Rides the embed
    // POST's BODY (values may be large; headers have hard ceilings),
    // flagged by the cells header. Malformed → no projection: the
    // spec-level requirement check then fails any REQUIRED binding
    // explicitly instead of rendering against silent nulls.
    let boundCells: Record<string, unknown> | null = null
    if (request.headers.get(EMBED_CELLS_HEADER) === "1") {
      try {
        const body = (await request.json()) as { cells?: Record<string, unknown> }
        if (body && typeof body === "object" && body.cells && typeof body.cells === "object") {
          boundCells = body.cells
        }
      } catch {
        boundCells = null
      }
    }
    const inEmbedScope = <T,>(fn: () => T): T =>
      runWithCapability(capability as Capability, () =>
        boundCells === null ? fn() : runWithBoundCellProjection(boundCells, fn),
      )
    const commit = _captureCommitHandle()
    const partialsParam =
      embedDepthOf(request.headers) > 0 ? renderRequest.url.searchParams.get("partials") : null

    let stream: ReadableStream<Uint8Array> | null = null
    // The snapshots the trailer ships. Resolved at flush time, but
    // NEVER through ALS-at-flush (fragile across stream runtimes —
    // the same reason the fp-trailer captures scope + routeKey at
    // wrap time): the focused path captures its own registry ctx; the
    // whole-page path reads the committed route snapshots, which the
    // render's eager-publish + commit have fully populated by flush.
    let getSnapshots: () => Map<string, PartialSnapshot>
    if (partialsParam) {
      const ids = partialsParam
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
      // The focused render owns its registry context (no PartialRoot
      // runs). `computeRouteKey` keys on the URL base, so the
      // `?partials=` transport param can't shift the bucket — the
      // lookup reads the snapshots the earlier embed render of this
      // page committed.
      const registry = enterRequestRegistry(computeRouteKey(request.url), "cache")
      getSnapshots = () => registry.pendingWrites
      const targets = ids.map((id) => [id, lookupPartial(id)] as const)
      if (targets.length > 0 && targets.every(([, snap]) => snap !== undefined)) {
        const root = targets.map(([id, snap]) => (
          <Fragment key={id}>{partialFromSnapshot(id, snap!)}</Fragment>
        ))
        stream = runWithPartialState(
          {
            requestedIds: new Set(ids),
            isPartialRefetch: true,
            cachedFingerprints: new Map(),
            cachedMatchKeys: new Map(),
            ackedFingerprints: null,
            explicitIds: new Set(ids),
            seenIds: new Set(),
          },
          () =>
            inEmbedScope(() =>
              renderToReadableStream<RscPayload>({ root }, { onError: onRscRenderError }),
            ),
        )
      }
    }
    if (stream === null) {
      const scope = getScope()
      const routeKey = computeRouteKey(request.url)
      // The committed route set is a UNION across renders — including
      // ids other placements of this same page minted under THEIR
      // namespaces (same-origin embeds share the process store). The
      // trailer must carry only THIS placement's partons: a foreign id
      // shipped here would get re-stamped with this placement's
      // namespace on the host, and its next refetch would replay the
      // wrong namespace into the producer (a double-prefixed id the
      // host's template can never match). Every id this render minted
      // carries the inbound namespace, so the prefix IS the filter.
      const ns = embedNamespaceOf(request.headers)
      getSnapshots = () => {
        const all = _readSnapshotsForRoute(scope, routeKey)
        if (ns === null) return all
        const own = new Map<string, PartialSnapshot>()
        for (const [id, snap] of all) {
          if (id.startsWith(`${ns}:`)) own.set(id, snap)
        }
        return own
      }
      stream = inEmbedScope(() =>
        renderToReadableStream<RscPayload>({ root: <Root /> }, { onError: onRscRenderError }),
      )
    }
    // Commit first (inner flush — drains the commit-defer list, so a
    // NESTED embed's trailer registrations land before the outer
    // flush reads the snapshot set), then append the snapshots entry
    // the host registers from.
    const wrapped = wrapStreamWithSnapshotTrailer(wrapStreamWithCommitOnly(stream, commit), () =>
      getSnapshots(),
    )
    return new Response(wrapped, {
      headers: { "content-type": "text/x-component;charset=utf-8" },
    })
  }

  async function handleRequest(
    renderRequest: ReturnType<typeof parseRenderRequest>,
  ): Promise<Response> {
    const request = renderRequest.request

    if (renderRequest.isRsc && !renderRequest.isAction) {
      return handleEmbedRender(renderRequest)
    }

    let returnValue: RscPayload["returnValue"] | undefined
    let formState: ReactFormState | undefined
    let temporaryReferences: unknown | undefined
    let actionStatus: number | undefined
    // The delivery seqs this action's invalidation consequences will
    // ride on the client's live connection (`x-parton-conn` names it —
    // an explicit statement the attached client stamps on its action
    // POSTs). Reserved INSIDE the action's invalidation transaction —
    // before the commit's flush wakes any segment driver — and shipped
    // back on the response so the client's optimistic overlay holds
    // until its committed watermark covers them.
    const consequenceBox: { seqs: number[] | null } = { seqs: null }

    if (renderRequest.isAction === true) {
      if (renderRequest.actionId) {
        const contentType = request.headers.get("content-type")
        const body = contentType?.startsWith("multipart/form-data")
          ? await request.formData()
          : await request.text()
        temporaryReferences = createTemporaryReferenceSet()
        const args = await decodeReply(body, { temporaryReferences })
        const action = await loadServerAction(renderRequest.actionId)
        const consequenceConn = request.headers.get("x-parton-conn")
        // An attached action operates on the live connection's state:
        // adopt its ephemeral cell storage (so the action's writes land
        // where the held-stream driver's consequence lanes read) and its
        // cached mirror (so an action that renders its own root fp-skips
        // against what the server has delivered to this connection — the
        // client sends no `?cached=` on an attached POST).
        if (consequenceConn) _adoptConnectionForAction(consequenceConn)
        try {
          // Run inside an invalidation transaction so server-side
          // `getServerNavigation().reload({selector})` calls inside the
          // action body queue until the action resolves. On throw the
          // queued bumps are discarded — a failed mutation shouldn't
          // trigger downstream refetches. On success the bumps flush
          // BEFORE the response render runs, so the action's own
          // response sees the bumped fps and emits fresh content.
          const data = await runInvalidationTransaction(async () => {
            const result = await action.apply(null, args)
            // Still inside the transaction: the bumps are queued, not
            // flushed, so no segment driver has woken yet — reserving
            // here is strictly ordered before any driver could mint the
            // consequence lanes' seqs itself.
            if (consequenceConn) {
              consequenceBox.seqs = _reserveActionConsequences(consequenceConn)
            }
            return result
          })
          returnValue = { ok: true, data }
        } catch (e) {
          returnValue = { ok: false, data: e }
          actionStatus = 500
          consequenceBox.seqs = null
        }
      } else {
        const formData = await request.formData()
        const decodedAction = await decodeAction(formData)
        try {
          const result = await runInvalidationTransaction(() => decodedAction())
          formState = await decodeFormState(result, formData)
        } catch {
          return new Response("Internal Server Error", { status: 500 })
        }
      }
    }

    // An action omits its response re-render (`root: null`) when the
    // held stream will carry the consequences instead — the body then
    // carries only `returnValue` + `formState` + any url-trailer. Two
    // triggers, both suppressing the same way:
    //   1. Deferred-only — every write went to a `deferred` cell: the
    //      new value rides the open streaming connection, nothing to
    //      reserve (`_actionSuppressesCommit()`).
    //   2. Attached with reserved consequences — the action named a
    //      live connection (`x-parton-conn`) whose route has matching
    //      invalidations, so `_reserveActionConsequences` assigned each
    //      target a delivery seq (`consequenceBox.seqs`). Those exact
    //      partons re-render on the held stream consuming those seqs and
    //      the optimistic overlay holds on the committed watermark
    //      (`x-parton-consequences`); an in-body whole-tree root would
    //      DOUBLE-deliver the same consequences.
    // The in-body root stays for the UNATTACHED / binding-mismatch /
    // no-match path (`consequenceBox.seqs` is null — never `[]`, the
    // reserve collapses an empty match set to null): no held stream is
    // guaranteed to carry the render, so the body root is the only
    // carrier. Mixed batches and errored actions (`actionStatus` set)
    // still render so non-deferred writes and failures surface on the
    // POST. See `docs/internals/streaming.md` § "Deferred (stream-only)
    // writes" and `docs/internals/channel.md` § "Action consequence seqs".
    const suppressRoot =
      renderRequest.isAction === true &&
      actionStatus === undefined &&
      (_actionSuppressesCommit() || consequenceBox.seqs !== null)
    const buildRscPayload = (): RscPayload => ({
      root: suppressRoot ? null : <Root />,
      formState,
      returnValue,
    })
    if (renderRequest.isRsc) {
      // The one `_.rsc` request kind: an action POST — one render, one
      // segment, one return value. Every other interactive render
      // rides the channel (the attach endpoint above); documents fall
      // through to SSR below. The action render skips the fp-trailer —
      // Flight stops reading once the root row resolves on the
      // action-result path, and a splitter waiting for the trailer
      // past that point can stall under backpressure.
      const headers: Record<string, string> = {
        "content-type": "text/x-component;charset=utf-8",
      }
      // The consequence seqs the client's overlay gate holds on —
      // see `_reserveActionConsequences`. Absent without a live
      // connection (or with nothing reserved): unchanged behavior.
      if (consequenceBox.seqs !== null && consequenceBox.seqs.length > 0) {
        headers["x-parton-consequences"] = consequenceBox.seqs.join(",")
      }
      return new Response(
        wrapStreamWithCommitOnly(
          renderToReadableStream<RscPayload>(buildRscPayload(), {
            temporaryReferences,
            onError: onRscRenderError,
          }),
          _captureCommitHandle(),
        ),
        {
          status: actionStatus,
          headers,
        },
      )
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
    const commit = _captureCommitHandle()
    const ssrEntryModule = await import.meta.viteRsc.loadModule<typeof import("./ssr.tsx")>(
      "ssr",
      "index",
    )
    const ssrRscStream = renderToReadableStream<RscPayload>(buildRscPayload(), {
      temporaryReferences,
      onError: onRscRenderError,
    })
    const ssrResult = await ssrEntryModule.renderHTML(
      wrapStreamWithCommitOnly(ssrRscStream, commit),
      {
        formState,
        debugNojs: renderRequest.url.searchParams.has("__nojs"),
      },
    )

    const finalControl = getFrameworkControl()

    if (finalControl?.redirect) {
      return new Response(null, {
        status: finalControl.redirect.status,
        headers: { location: finalControl.redirect.url },
      })
    }

    if (finalControl?.notFound) {
      if (!NotFound) {
        return new Response("Not Found", { status: 404 })
      }
      const notFoundPayload: RscPayload = {
        root: <NotFound />,
        formState,
      }
      const notFoundStream = renderToReadableStream<RscPayload>(notFoundPayload, {
        temporaryReferences: createTemporaryReferenceSet(),
        onError: onRscRenderError,
      })
      const notFoundSsr = await ssrEntryModule.renderHTML(notFoundStream, {
        formState,
        debugNojs: renderRequest.url.searchParams.has("__nojs"),
      })
      return new Response(wrapSsrStreamWithFpTrailer(notFoundSsr.stream, commit), {
        status: 404,
        headers: { "Content-type": "text/html" },
      })
    }

    return new Response(wrapSsrStreamWithFpTrailer(ssrResult.stream, commit), {
      status: ssrResult.status,
      headers: { "Content-type": "text/html" },
    })
  }

  // The deploy signal: SIGTERM → drain (refuse attaches, settle lanes,
  // signal reattach) → exit. Framework-wired so every app gets it with
  // zero plumbing; `drain: false` opts out for apps whose supervisor
  // owns the shutdown and calls `beginDrain()` itself.
  if (config.drain !== false) {
    installDrainOnSigterm(config.drain)
  }

  // The drain's in-flight gauge: every request the process has SEEN is
  // counted until its response BODY fully streams out (not merely until
  // the handler resolves — a Response object exists before its bytes
  // reach the socket), so a drain begun mid-request (a write racing the
  // deploy signal) waits for the response to actually leave — the
  // "in-flight actions land" half of the drain window (bounded by the
  // deadline). A held attach stream converges too: its body ends at the
  // drain's own wind-down.
  const gaugedHandler = async (request: Request): Promise<Response> => {
    _drainRequestStarted()
    let response: Response
    try {
      response = await handler(request)
    } catch (err) {
      _drainRequestSettled()
      throw err
    }
    if (response.body === null) {
      _drainRequestSettled()
      return response
    }
    return new Response(gaugedResponseBody(response.body), response)
  }

  return {
    fetch: gaugedHandler,
    handleChannelSocket: createChannelServer({ Root }).handleSocket,
  }
}

/**
 * The socket-side twin of `createRscHandler` — a channel server bound
 * to an app's `Root`. `handleSocket(socket, request)` drives one
 * upgraded WebSocket: the SAME whole-tree render the fetch attach
 * serves, tunneled over the socket as an opaque `\xFF`-marker byte
 * stream (`docs/internals/channel.md` § The transport seam), reusing
 * `driveSegmentedResponse` + the connection session unchanged. A
 * framework Vite plugin (`@parton/framework/vite/channel-server`) owns
 * the `ws` upgrade and adapts each connection into a `ChannelSocket`
 * for this; `createRscHandler` also exposes it as `handleChannelSocket`
 * so the plugin can reach it off the app's existing default export. The
 * DEFAULT transport stays fetch — this serves the opt-in WebSocket
 * transport ([[channel-transport]]'s `WebSocketTransport`).
 */
export function createChannelServer(config: { Root: ComponentType }): {
  handleSocket(socket: ChannelSocket, request: Request): Promise<void>
} {
  // Same birth-version capture as `createRscHandler` — the drive pins
  // it into the attach scope so a held socket's fps stay at the graph
  // that renders them (dev HMR; see lib/code-version.ts).
  const graphCodeVersion = currentCodeVersion()
  const renderOnce = channelRenderOnce(config.Root)
  return {
    handleSocket: (socket, request) =>
      driveChannelSocket(socket, request, renderOnce, graphCodeVersion),
  }
}

/** The whole-tree segment closure both full-duplex servers drive — the
 *  SAME `<Root/>` render the fetch attach serves, fp-trailer-wrapped. */
function channelRenderOnce(Root: ComponentType): () => ReadableStream<Uint8Array> {
  return () =>
    wrapStreamWithFpTrailer(
      renderToReadableStream<RscPayload>({ root: <Root /> }, { onError: onRscRenderError }),
      _captureCommitHandle(),
    )
}

/** A WebTransport server session, structurally — the surface
 *  `createWebTransportServer` needs from whatever HTTP/3 server drives it
 *  (`@fails-components/webtransport`, a deployed edge). Both the
 *  standardized WebTransport interface and the common Node QUIC server
 *  expose `incomingBidirectionalStreams` as a readable of bidi streams. */
export interface WebTransportServerSession {
  /** Resolves when the session handshake completes; awaited before the
   *  first bidi stream is accepted (optional — some servers hand an
   *  already-ready session). */
  readonly ready?: Promise<unknown>
  /** The client-initiated bidi streams — the channel uses the FIRST
   *  (the one the client's `WebTransportTransport.open` created). */
  readonly incomingBidirectionalStreams: ReadableStream<ChannelDuplexStream>
}

/**
 * The WebTransport (HTTP/3) twin of `createChannelServer` — a channel
 * server bound to an app's `Root`, driven by a standalone QUIC listener
 * (Vite serves no HTTP/3, so unlike the WebSocket path there is no
 * framework Vite plugin; see `docs/internals/channel.md` § The
 * WebTransport transport). `handleSession(session, request)` accepts the
 * client's first incoming bidirectional stream and drives it through
 * `driveChannelWebTransport`: the SAME whole-tree render the fetch attach
 * serves, tunneled over the bidi stream as opaque `\xFF`-marker bytes,
 * reusing `driveSegmentedResponse` + the connection session unchanged.
 *
 * `request` is a `Request` the caller builds from the QUIC connect — its
 * `Cookie` header supplies the scope + session binding, its URL the origin
 * the attach's stated URL validates against (the WebTransport twin of the
 * WebSocket upgrade request). The DEFAULT transport stays fetch — this
 * serves the opt-in WebTransport transport ([[channel-transport]]'s
 * `WebTransportTransport`).
 */
export function createWebTransportServer(config: { Root: ComponentType }): {
  handleSession(session: WebTransportServerSession, request: Request): Promise<void>
} {
  const graphCodeVersion = currentCodeVersion()
  const renderOnce = channelRenderOnce(config.Root)
  return {
    handleSession: async (session, request) => {
      if (session.ready) await session.ready
      const reader = session.incomingBidirectionalStreams.getReader()
      let stream: ChannelDuplexStream
      try {
        const first = await reader.read()
        if (first.done) return
        stream = first.value
      } finally {
        reader.releaseLock()
      }
      await driveChannelWebTransport(stream, request, renderOnce, graphCodeVersion)
    },
  }
}

/** Pass a response body through while holding the drain's in-flight
 *  gauge until it fully streams out — settle exactly once, on end,
 *  error, or cancel (the consumer went away; nothing more will leave). */
function gaugedResponseBody(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  let settled = false
  const settleOnce = (): void => {
    if (settled) return
    settled = true
    _drainRequestSettled()
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let result: ReadableStreamReadResult<Uint8Array>
      try {
        result = await reader.read()
      } catch (err) {
        settleOnce()
        controller.error(err)
        return
      }
      if (result.done) {
        settleOnce()
        try {
          controller.close()
        } catch {}
        return
      }
      controller.enqueue(result.value)
    },
    cancel(reason) {
      settleOnce()
      return reader.cancel(reason)
    },
  })
}

// Production strips the message off a render error and ships only a
// digest to the client. `reportServerRenderError` mints that digest,
// logs it next to the real stack on the server, and returns it for
// React to serialize — so a client digest traces back to a server log.
function onRscRenderError(error: unknown): string | undefined {
  return reportServerRenderError("rsc", error)
}
