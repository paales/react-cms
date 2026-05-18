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
  _captureCommitHandle,
  getFrameworkControl,
  runWithRequestAsync,
  setRequest,
} from "@parton/framework/runtime/context.ts"
import { warmCmsCache } from "@parton/framework/runtime/cms-runtime.ts"
import {
  wrapStreamWithFpTrailer,
  wrapStreamWithCommitOnly,
  wrapSsrStreamWithFpTrailer,
} from "@parton/framework/lib/fp-trailer.ts"
import { runInvalidationTransaction } from "@parton/framework/runtime/invalidation-registry.ts"

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
    renderToReadableStream(element, { onError: silenceClientDisconnect }),
})

async function handler(request: Request): Promise<Response> {
  const remote = await remoteHandler(request)
  if (remote) return remote

  const url = new URL(request.url)

  if (import.meta.env?.DEV) {
    if (url.pathname === "/__test/clear-caches") {
      const [
        { _clearCache },
        { clearCache },
        { clearRegistry },
        { _clearAllSessions },
        { _clearCmsDraft },
      ] = await Promise.all([
        import("@parton/framework/lib/cache.tsx"),
        import("@parton/framework/lib/partial-cache.ts"),
        import("@parton/framework/lib/partial-registry.ts"),
        import("@parton/framework/runtime/session.ts"),
        import("@parton/framework/runtime/cms-runtime.ts"),
      ])
      const all = url.searchParams.get("all") === "1"
      if (all) {
        await _clearCache("all")
        clearCache("all")
        clearRegistry("all")
        _clearAllSessions("all")
      } else {
        const scope = request.headers.get("x-test-scope") ?? "default"
        await _clearCache(scope)
        clearCache(scope)
        clearRegistry(scope)
        _clearAllSessions(scope)
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

  const clientHasCache = renderRequest.url.searchParams.has("cached")
  const resultData = returnValue?.ok ? (returnValue.data as any) : null
  const directive = resultData?.revalidate ?? resultData?.invalidate

  let needsUpdate = false

  if (directive && typeof directive === "object" && !Array.isArray(directive)) {
    const { selector } = directive as { selector?: string | string[] }
    if (selector) {
      // Selectors are flat labels now — leading `#`/`.` is cosmetic and
      // stripped. All tokens merge into the unified `?partials=` wire
      // param; the server resolves each token against snapshot ids and
      // labels (fan-out across carriers).
      const raw = Array.isArray(selector) ? selector.join(" ") : selector
      const labels: string[] = []
      for (const tok of raw.split(/\s+/).map((t) => t.trim()).filter(Boolean)) {
        const name = tok.startsWith("#") || tok.startsWith(".") ? tok.slice(1) : tok
        if (name && !labels.includes(name)) labels.push(name)
      }
      if (labels.length > 0) {
        const existing = renderRequest.url.searchParams.get("partials")
        const merged = existing ? `${existing},${labels.join(",")}` : labels.join(",")
        renderRequest.url.searchParams.set("partials", merged)
        // Also bust any tagged GraphQL cache entries that carry these
        // labels — the action mutated upstream data, so cached
        // requests are stale.
        const { invalidateByTags } = await import("@parton/framework/lib/partial-cache.ts")
        invalidateByTags(labels)
        needsUpdate = true
      }
      if (!clientHasCache) {
        renderRequest.url.searchParams.set("__populateCache", "1")
        needsUpdate = true
      }
    }
  }

  if (needsUpdate) {
    setRequest(
      new Request(renderRequest.url, {
        headers: renderRequest.request.headers,
      }),
    )
  }

  const rscPayload: RscPayload = {
    root: <Root />,
    formState,
    returnValue,
  }
  const rscStream = renderToReadableStream<RscPayload>(rscPayload, {
    temporaryReferences,
    onError: silenceClientDisconnect,
  })

  if (renderRequest.isRsc) {
    // RSC response: GET navs get the binary fp-trailer (length-
    // prefixed segment after the main Flight bytes, parsed client-
    // side by `splitAtFpTrailer`). Action POSTs skip the trailer —
    // Flight stops reading once the root row resolves on the action-
    // result path, and a splitter waiting for the trailer past that
    // point can stall under backpressure.
    const wrap = renderRequest.isAction ? wrapStreamWithCommitOnly : wrapStreamWithFpTrailer
    return new Response(wrap(rscStream, _captureCommitHandle()), {
      status: actionStatus,
      headers: { "content-type": "text/x-component;charset=utf-8" },
    })
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
  const ssrResult = await ssrEntryModule.renderHTML(
    wrapStreamWithCommitOnly(rscStream, commit),
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
      onError: silenceClientDisconnect,
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

function silenceClientDisconnect(error: unknown): string | undefined {
  if (error instanceof Error) {
    if (
      error.name === "AbortError" ||
      error.name === "NotFoundError" ||
      error.name === "RedirectError" ||
      error.message === "The render was aborted by the server without a reason."
    ) {
      return undefined
    }
  }
  console.error(error)
  return undefined
}

if (import.meta.hot) {
  import.meta.hot.accept()
}
