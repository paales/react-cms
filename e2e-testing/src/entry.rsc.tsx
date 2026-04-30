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
import { parseRenderRequest } from "@react-cms/framework/framework/request.tsx"
import {
  _captureCommitHandle,
  getFrameworkControl,
  runWithRequestAsync,
  setRequest,
} from "@react-cms/framework/framework/context.ts"
import { warmCmsCache } from "@react-cms/framework/framework/cms-runtime.ts"
import { deferRequestRegistryCommit } from "@react-cms/framework/lib/partial-registry.ts"

export type RscPayload = {
  root: React.ReactNode
  returnValue?: { ok: boolean; data: unknown }
  formState?: ReactFormState
}

export default { fetch: handler }

async function handler(request: Request): Promise<Response> {
  if (import.meta.env?.DEV) {
    const url = new URL(request.url)
    if (url.pathname === "/__test/clear-caches") {
      const [
        { _clearCache },
        { clearCache },
        { clearRegistry },
        { _clearAllSessions },
        { _clearCmsDraft },
      ] = await Promise.all([
        import("@react-cms/framework/lib/cache.tsx"),
        import("@react-cms/framework/lib/partial-cache.ts"),
        import("@react-cms/framework/lib/partial-registry.ts"),
        import("@react-cms/framework/framework/session.ts"),
        import("@react-cms/framework/framework/cms-runtime.ts"),
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
        const { invalidateByTags } = await import("@react-cms/framework/lib/partial-cache.ts")
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
    return new Response(wrapStreamWithRegistryCommit(rscStream), {
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
    return new Response(wrapStreamWithRegistryCommit(notFoundSsr.stream), {
      status: 404,
      headers: { "Content-type": "text/html" },
    })
  }

  return new Response(wrapStreamWithRegistryCommit(ssrResult.stream), {
    status: ssrResult.status,
    headers: { "Content-type": "text/html" },
  })
}

function wrapStreamWithRegistryCommit(
  stream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const commit = _captureCommitHandle()
  deferRequestRegistryCommit()
  return stream.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(chunk)
      },
      flush() {
        commit()
      },
    }),
  )
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
