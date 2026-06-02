import {
  renderToReadableStream,
  createTemporaryReferenceSet,
  decodeReply,
  loadServerAction,
  decodeAction,
  decodeFormState,
} from "@vitejs/plugin-rsc/rsc"
import type { ReactFormState } from "react-dom/client"
import { Root } from "./app/root.tsx"
import { NotFoundPage } from "./app/pages/not-found.tsx"
import { createRemoteHandler } from "@parton/framework"
import { parseRenderRequest } from "@parton/framework/runtime/request.tsx"
import {
  _actionSuppressesCommit,
  _captureCommitHandle,
  getFrameworkControl,
  runWithRequestAsync,
} from "@parton/framework/runtime/context.ts"
import { warmCmsCache } from "@parton/framework/runtime/cms-runtime.ts"
import {
  wrapStreamWithFpTrailer,
  wrapStreamWithCommitOnly,
  wrapSsrStreamWithFpTrailer,
} from "@parton/framework/lib/fp-trailer.ts"
import { driveSegmentedResponse } from "@parton/framework/lib/segmented-response.ts"
import { runInvalidationTransaction } from "@parton/framework/runtime/invalidation-registry.ts"
import { reportServerRenderError } from "@parton/framework/runtime/errors.ts"

export type RscPayload = {
  root: React.ReactNode
  returnValue?: { ok: boolean; data: unknown }
  formState?: ReactFormState
}

export default { fetch: handler }

/** Shared remote-endpoint dispatch — OPTIONS, /__remote/manifest.json,
 *  /__remote/types.d.ts, /__remote/<selector>. */
const remoteHandler = createRemoteHandler({
  name: "e2e-testing",
  renderToFlightStream: (element) =>
    renderToReadableStream(element, { onError: onRscRenderError }),
})

async function handler(request: Request): Promise<Response> {
  const remote = await remoteHandler(request)
  if (remote) return remote

  const url = new URL(request.url)

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
        { _clearLogs },
      ] = await Promise.all([
        import("@parton/framework/lib/cache.tsx"),
        import("@parton/framework/lib/partial-registry.ts"),
        import("@parton/framework/runtime/session.ts"),
        import("@parton/framework/runtime/cms-runtime.ts"),
        import("@parton/framework/runtime/cell-storage.ts"),
        import("@parton/framework/runtime/invalidation-registry.ts"),
        import("@parton/framework/runtime/context.ts"),
        import("./app/chat/log.ts"),
      ])
      const all = url.searchParams.get("all") === "1"
      if (all) {
        await _clearCache("all")
        clearRegistry("all")
        _clearAllSessions("all")
        getCellStorage().clear("all")
        _clearInvalidationRegistry()
        _clearScheduledTasks("all")
        _clearLogs("all")
      } else {
        const scope = request.headers.get("x-test-scope") ?? "default"
        await _clearCache(scope)
        clearRegistry(scope)
        _clearAllSessions(scope)
        getCellStorage().clear(scope)
        _clearScheduledTasks(scope)
        _clearLogs(scope)
      }
      // CMS draft is process-global file-system state shared across
      // every test scope. Only wipe it when explicitly requested via
      // `?cms=1` (or the wholesale `?all=1`) — clearing on every
      // `beforeEach` raced with cms-edit tests that depend on the
      // draft state surviving across their own assertions.
      if (all || url.searchParams.get("cms") === "1") {
        await _clearCmsDraft()
      }
      return new Response("ok", { status: 200 })
    }
  }

  const renderRequest = parseRenderRequest(request)
  await warmCmsCache()

  const { result: response, cookies } = await runWithRequestAsync(renderRequest.request, () =>
    handleRequest(renderRequest),
  )

  for (const cookie of cookies) {
    response.headers.append("set-cookie", cookie)
  }

  return response
}

async function handleRequest(
  renderRequest: ReturnType<typeof parseRenderRequest>,
): Promise<Response> {
  const request = renderRequest.request

  let returnValue: RscPayload["returnValue"] | undefined
  let formState: ReactFormState | undefined
  let temporaryReferences: unknown | undefined
  let actionStatus: number | undefined

  if (renderRequest.isAction === true) {
    if (renderRequest.actionId) {
      const contentType = request.headers.get("content-type")
      const body = contentType?.startsWith("multipart/form-data")
        ? await request.formData()
        : await request.text()
      temporaryReferences = createTemporaryReferenceSet()
      const args = await decodeReply(body, { temporaryReferences })
      const action = await loadServerAction(renderRequest.actionId)
      try {
        // Run inside an invalidation transaction so server-side
        // `getServerNavigation().reload({selector})` calls inside the
        // action body queue until the action resolves. On throw the
        // queued bumps are discarded — a failed mutation shouldn't
        // trigger downstream refetches. On success the bumps flush
        // BEFORE the response render runs, so the action's own
        // response sees the bumped fps and emits fresh content.
        const data = await runInvalidationTransaction(() => action.apply(null, args))
        returnValue = { ok: true, data }
      } catch (e) {
        returnValue = { ok: false, data: e }
        actionStatus = 500
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
    _actionSuppressesCommit()
  const buildRscPayload = (): RscPayload => ({
    root: suppressRoot ? null : <Root />,
    formState,
    returnValue,
  })
  // RSC path renders inside the segment driver via `renderOnce`; it
  // may be invoked multiple times if any render signals
  // `markConnectionLive()`. SSR path renders once below (the rsc bytes
  // are inlined into `<script>FLIGHT_DATA</script>` tags so we can't
  // run multiple Flight documents through it).
  const renderOnce = (): ReadableStream<Uint8Array> => {
    const stream = renderToReadableStream<RscPayload>(buildRscPayload(), {
      temporaryReferences,
      onError: onRscRenderError,
    })
    // Action POSTs skip the trailer — Flight stops reading once the
    // root row resolves on the action-result path, and a splitter
    // waiting for the trailer past that point can stall under
    // backpressure. Non-action GETs get the length-prefixed binary
    // fp-trailer.
    const wrap = renderRequest.isAction ? wrapStreamWithCommitOnly : wrapStreamWithFpTrailer
    return wrap(stream, _captureCommitHandle())
  }

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
      })
    }
    return new Response(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            await driveSegmentedResponse(controller, renderOnce)
          } catch (err) {
            controller.error(err)
            return
          }
          controller.close()
        },
      }),
      {
        status: actionStatus,
        headers: { "content-type": "text/x-component;charset=utf-8" },
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
  const ssrEntryModule = await import.meta.viteRsc.loadModule<typeof import("./entry.ssr.tsx")>(
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
    const notFoundPayload: RscPayload = {
      root: <NotFoundPage />,
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

// Production strips the message off a render error and ships only a
// digest to the client. `reportServerRenderError` mints that digest,
// logs it next to the real stack on the server, and returns it for
// React to serialize — so a client digest traces back to a server log.
function onRscRenderError(error: unknown): string | undefined {
  return reportServerRenderError("rsc", error)
}

if (import.meta.hot) {
  import.meta.hot.accept()
}
