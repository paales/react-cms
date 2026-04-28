import {
  renderToReadableStream,
  createTemporaryReferenceSet,
  decodeReply,
  loadServerAction,
  decodeAction,
  decodeFormState,
} from "@vitejs/plugin-rsc/rsc"
import type { ReactFormState } from "react-dom/client"
import { Root } from "../app/root.tsx"
import { NotFoundPage } from "../app/pages/not-found.tsx"
import { parseRenderRequest } from "./request.tsx"
import { getFrameworkControl, runWithRequestAsync, setRequest } from "./context.ts"
import { warmCmsCache } from "./cms-runtime.ts"

export type RscPayload = {
  root: React.ReactNode
  returnValue?: { ok: boolean; data: unknown }
  formState?: ReactFormState
}

export default { fetch: handler }

async function handler(request: Request): Promise<Response> {
  // Dev-only cache-clear endpoint used by e2e tests that depend on a
  // cold server-side `<Cache>` (e.g. tests asserting that Suspense
  // fallbacks flash during an initial stage-2/3 fetch). Also clears
  // the partial-data cache and the route-scoped partial registry so
  // each run starts from a deterministic state.
  //
  // Scoping:
  //   - Each worker (or a single-worker test run) hits this with its
  //     own `x-test-scope` header → clears only that scope's state.
  //   - `?all=1` wipes every scope — what the debug toolbar button
  //     does from dev, and what `beforeAll` in the Playwright fixture
  //     uses to reset the server on suite start.
  if (import.meta.env?.DEV) {
    const url = new URL(request.url)
    if (url.pathname === "/__test/clear-caches") {
      const [
        { _clearCache },
        { clearCache },
        { clearRegistry },
        { _clearAllSessions },
        { _clearLogs },
        { _clearCmsDraft },
      ] = await Promise.all([
        import("../lib/cache.tsx"),
        import("../lib/partial-cache.ts"),
        import("../lib/partial-registry.ts"),
        import("./session.ts"),
        import("../app/chat/log.ts"),
        import("./cms-runtime.ts"),
      ])
      const all = url.searchParams.get("all") === "1"
      if (all) {
        await _clearCache("all")
        clearCache("all")
        clearRegistry("all")
        _clearAllSessions("all")
        _clearLogs("all")
      } else {
        const scope = request.headers.get("x-test-scope") ?? "default"
        await _clearCache(scope)
        clearCache(scope)
        clearRegistry(scope)
        _clearAllSessions(scope)
        _clearLogs(scope)
      }
      // Draft file is not scope-bucketed (it's on-disk, not in-memory);
      // always clear on both `all` and scoped calls. Tests writing to
      // the draft need a clean state per run.
      await _clearCmsDraft()
      return new Response("ok", { status: 200 })
    }
  }

  const renderRequest = parseRenderRequest(request)

  // Refresh the in-memory CMS cache against the storage backend
  // BEFORE rendering. The async backend read here means the sync
  // accessor calls inside Partial bodies hit a hot, fresh cache —
  // and the storage backend can be swapped (`setCmsStorage`) without
  // the runtime having to know whether reads are sync-fast or
  // async-only.
  await warmCmsCache()

  const { result: response, cookies } = await runWithRequestAsync(renderRequest.request, () =>
    handleRequest(renderRequest),
  )

  // Apply Set-Cookie headers from server actions/components
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
        const data = await action.apply(null, args)
        returnValue = { ok: true, data }
      } catch (e) {
        returnValue = { ok: false, data: e }
        actionStatus = 500
      }
    } else {
      const formData = await request.formData()
      const decodedAction = await decodeAction(formData)
      try {
        const result = await decodedAction()
        formState = await decodeFormState(result, formData)
      } catch {
        return new Response("Internal Server Error", { status: 500 })
      }
    }
  }

  // If the action returned a directive to refresh Partials, filter the
  // re-render so the server only renders the matched ones. PartialsClient
  // on the browser merges the fresh Partials with its cache. Both
  // `invalidate` and `revalidate` are accepted and treated identically.
  //
  // Shape:
  //   return { invalidate: { selector: "#cart .price" } };
  //   return { revalidate: { selector: "#cart" } };    // alias
  //
  // The selector follows the same grammar as `<Partial selector>` —
  // space-separated `#`-tokens (unique) and `.`-tokens (shared). The
  // server parses it into `?partials=` (`#`-token names) and `?tags=`
  // (`.`-token names) and feeds them into the existing `PartialRoot`
  // resolver.
  //
  // Apply filters only when the client reports cached partials via
  // `?cached=`. After a streaming render, the client's cache is empty;
  // filtering would render only the named partials and lose the rest
  // of the page — so in that case fall back to `__populateCache=1`
  // which renders everything fresh to refill the client cache.
  const clientHasCache = renderRequest.url.searchParams.has("cached")
  const resultData = returnValue?.ok ? (returnValue.data as any) : null
  const directive = resultData?.revalidate ?? resultData?.invalidate

  let needsUpdate = false

  if (directive && typeof directive === "object" && !Array.isArray(directive)) {
    const { selector } = directive as { selector?: string | string[] }
    if (selector) {
      const raw = Array.isArray(selector) ? selector.join(" ") : selector
      const tokens = raw
        .split(/\s+/)
        .map((t) => t.trim())
        .filter(Boolean)
      const uniqueNames: string[] = []
      const sharedNames: string[] = []
      for (const tok of tokens) {
        if (tok.startsWith("#")) {
          const n = tok.slice(1)
          if (n && !uniqueNames.includes(n)) uniqueNames.push(n)
        } else if (tok.startsWith(".")) {
          const n = tok.slice(1)
          if (n && !sharedNames.includes(n)) sharedNames.push(n)
        } else {
          throw new Error(
            `Unprefixed token "${tok}" in action invalidate selector. ` +
              `Tokens must start with "#" or ".".`,
          )
        }
      }
      if (uniqueNames.length > 0) {
        const existing = renderRequest.url.searchParams.get("partials")
        const merged = existing ? `${existing},${uniqueNames.join(",")}` : uniqueNames.join(",")
        renderRequest.url.searchParams.set("partials", merged)
        needsUpdate = true
      }
      if (sharedNames.length > 0) {
        const { invalidateByTags } = await import("../lib/partial-cache.ts")
        invalidateByTags(sharedNames)
        const existing = renderRequest.url.searchParams.get("tags")
        const merged = existing ? `${existing},${sharedNames.join(",")}` : sharedNames.join(",")
        renderRequest.url.searchParams.set("tags", merged)
        needsUpdate = true
      }

      if (!clientHasCache) {
        renderRequest.url.searchParams.set("__populateCache", "1")
        needsUpdate = true
      }
    }
  }

  if (needsUpdate) {
    // Update the ALS request so getRequest() reflects the new params.
    // Only copy headers — the body was already consumed by the action handler.
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

  // Root is a synchronous function — the plugin's renderToReadableStream
  // does an eager first render pass that executes Root's body before
  // returning. If Root caught a sentinel, `getFrameworkControl()` is
  // populated by the time we get here; if the catch happened inside
  // an async descendant instead, control stays unset and we fall back
  // to letting the stream flow.
  if (renderRequest.isRsc) {
    // For RSC refetches we can't pre-check the framework-control
    // channel (Root hasn't necessarily run yet — the plugin renders
    // lazily as the stream is pulled). Both `notFound` and `redirect`
    // are communicated via the rendered payload instead:
    //   - notFound → Root returned <NotFoundPage/>; client commits it.
    //   - redirect → Root returned <Redirect url=…/>; client commits,
    //     its useEffect calls `navigation.navigate(url)`.
    // Status stays 200. Refetches don't observe status codes — the
    // client reads the rendered output — so the miss is cosmetic.
    return new Response(rscStream, {
      status: actionStatus,
      headers: { "content-type": "text/x-component;charset=utf-8" },
    })
  }

  const ssrEntryModule = await import.meta.viteRsc.loadModule<typeof import("./entry.ssr.tsx")>(
    "ssr",
    "index",
  )
  const ssrResult = await ssrEntryModule.renderHTML(rscStream, {
    formState,
    debugNojs: renderRequest.url.searchParams.has("__nojs"),
  })

  // Post-render check — catches async sentinels thrown from deep
  // inside the tree too. By this point renderHTML has awaited the
  // whole render, so the control channel is final.
  const finalControl = getFrameworkControl()

  if (finalControl?.redirect) {
    return new Response(null, {
      status: finalControl.redirect.status,
      headers: { location: finalControl.redirect.url },
    })
  }

  // Async `notFound()` — the first render produced the partially-
  // broken page (whatever content got past the throw + error stubs
  // where partials tore). Re-render NotFoundPage cleanly so the 404
  // body matches the 404 status.
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
    return new Response(notFoundSsr.stream, {
      status: 404,
      headers: { "Content-type": "text/html" },
    })
  }

  return new Response(ssrResult.stream, {
    status: ssrResult.status,
    headers: { "Content-type": "text/html" },
  })
}

// Swallow the synthesized "The render was aborted by the server without a
// reason." error that fires when the client disconnects mid-stream. srvx
// cancels the reader with no argument; React then aborts the request with
// reason=undefined and synthesizes the no-reason error. Also swallow
// AbortError — same root cause when the request signal fires. Framework
// sentinels (`notFound()` / `redirect()`) throw to short-circuit render;
// they're already handled via the framework-control channel, so don't
// pollute the console with a stack trace. Everything else re-surfaces.
//
// See https://github.com/oven-sh/bun/issues/17142#issuecomment-2642535493
// for the equivalent pattern in Bun.
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
