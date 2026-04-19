import {
  renderToReadableStream,
  createTemporaryReferenceSet,
  decodeReply,
  loadServerAction,
  decodeAction,
  decodeFormState,
} from "@vitejs/plugin-rsc/rsc";
import type { ReactFormState } from "react-dom/client";
import { Root } from "../app/root.tsx";
import { NotFoundPage } from "../app/pages/not-found.tsx";
import { parseRenderRequest } from "./request.tsx";
import {
  getFrameworkControl,
  runWithRequestAsync,
  setRequest,
} from "./context.ts";

export type RscPayload = {
  root: React.ReactNode;
  returnValue?: { ok: boolean; data: unknown };
  formState?: ReactFormState;
};

export default { fetch: handler };

async function handler(request: Request): Promise<Response> {
  // Dev-only cache-clear endpoint used by e2e tests that depend on a
  // cold server-side `<Cache>` (e.g. tests asserting that Suspense
  // fallbacks flash during an initial stage-2/3 fetch). Also clears
  // the partial-data cache and the route-scoped partial registry so
  // each run starts from a deterministic state.
  if (import.meta.env?.DEV) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/__test/clear-caches") {
      const [{ _clearCache }, { clearCache }, { clearRegistry }] =
        await Promise.all([
          import("../lib/cache.tsx"),
          import("../lib/partial-cache.ts"),
          import("../lib/partial-registry.ts"),
        ]);
      await _clearCache();
      clearCache();
      clearRegistry();
      return new Response("ok", { status: 200 });
    }
  }

  const renderRequest = parseRenderRequest(request);

  const { result: response, cookies } = await runWithRequestAsync(
    renderRequest.request,
    () => handleRequest(renderRequest),
  );

  // Apply Set-Cookie headers from server actions/components
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
        const data = await action.apply(null, args);
        returnValue = { ok: true, data };
      } catch (e) {
        returnValue = { ok: false, data: e };
        actionStatus = 500;
      }
    } else {
      const formData = await request.formData();
      const decodedAction = await decodeAction(formData);
      try {
        const result = await decodedAction();
        formState = await decodeFormState(result, formData);
      } catch {
        return new Response("Internal Server Error", { status: 500 });
      }
    }
  }

  // If the action returned a directive to refresh partials (by id or
  // tag), filter the re-render so the server only renders those.
  // PartialsClient on the browser merges the fresh partials with its
  // cache. Both `invalidate` and `revalidate` are accepted and treated
  // identically — the distinction was only load-bearing back when the
  // server version-stamped Suspense keys; with bare keys everywhere,
  // the client's commit behavior (startTransition for actions) is what
  // controls "preserve old UI vs show fallback", not a server flag.
  //
  // Supported shapes:
  //   { invalidate: ["cart", "header"] }                   — ids
  //   { invalidate: { tags: ["cart"] } }                   — tags
  //   { invalidate: { ids: ["header"], tags: ["cart"] } }  — mixed
  //   { revalidate: ... }                                  — alias
  //
  // Apply filters only when the client reports cached partials via
  // `?cached=`. After a streaming render, the client's cache is empty;
  // filtering would render only the named partials and lose the rest
  // of the page — so in that case fall back to `__populateCache=1`
  // which renders everything fresh to refill the client cache.
  const clientHasCache = renderRequest.url.searchParams.has("cached");
  const resultData = returnValue?.ok ? (returnValue.data as any) : null;
  const directive = resultData?.revalidate ?? resultData?.invalidate;

  let needsUpdate = false;

  if (directive) {
    const setPartialIds = (ids: string[]) => {
      const existing = renderRequest.url.searchParams.get("partials");
      const merged = existing ? `${existing},${ids.join(",")}` : ids.join(",");
      renderRequest.url.searchParams.set("partials", merged);
      needsUpdate = true;
    };

    if (Array.isArray(directive)) {
      if (directive.length > 0) setPartialIds(directive);
    } else if (typeof directive === "object") {
      const { tags, ids } = directive as { tags?: string[]; ids?: string[] };
      if (tags?.length) {
        const { invalidateByTags } = await import("../lib/partial-cache.ts");
        invalidateByTags(tags);
        renderRequest.url.searchParams.set("tags", tags.join(","));
        needsUpdate = true;
      }
      if (ids?.length) setPartialIds(ids);
    }

    if (!clientHasCache) {
      renderRequest.url.searchParams.set("__populateCache", "1");
      needsUpdate = true;
    }
  }

  if (needsUpdate) {
    // Update the ALS request so getRequest() reflects the new params.
    // Only copy headers — the body was already consumed by the action handler.
    setRequest(new Request(renderRequest.url, { headers: renderRequest.request.headers }));
  }

  const rscPayload: RscPayload = {
    root: <Root />,
    formState,
    returnValue,
  };
  const rscStream = renderToReadableStream<RscPayload>(rscPayload, {
    temporaryReferences,
  });

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
    });
  }

  const ssrEntryModule = await import.meta.viteRsc.loadModule<
    typeof import("./entry.ssr.tsx")
  >("ssr", "index");
  const ssrResult = await ssrEntryModule.renderHTML(rscStream, {
    formState,
    debugNojs: renderRequest.url.searchParams.has("__nojs"),
  });

  // Post-render check — catches async sentinels thrown from deep
  // inside the tree too. By this point renderHTML has awaited the
  // whole render, so the control channel is final.
  const finalControl = getFrameworkControl();

  if (finalControl?.redirect) {
    return new Response(null, {
      status: finalControl.redirect.status,
      headers: { location: finalControl.redirect.url },
    });
  }

  // Async `notFound()` — the first render produced the partially-
  // broken page (whatever content got past the throw + error stubs
  // where partials tore). Re-render NotFoundPage cleanly so the 404
  // body matches the 404 status.
  if (finalControl?.notFound) {
    const notFoundPayload: RscPayload = {
      root: <NotFoundPage />,
      formState,
    };
    const notFoundStream = renderToReadableStream<RscPayload>(
      notFoundPayload,
      { temporaryReferences: createTemporaryReferenceSet() },
    );
    const notFoundSsr = await ssrEntryModule.renderHTML(notFoundStream, {
      formState,
      debugNojs: renderRequest.url.searchParams.has("__nojs"),
    });
    return new Response(notFoundSsr.stream, {
      status: 404,
      headers: { "Content-type": "text/html" },
    });
  }

  return new Response(ssrResult.stream, {
    status: ssrResult.status,
    headers: { "Content-type": "text/html" },
  });
}

if (import.meta.hot) {
  import.meta.hot.accept();
}
