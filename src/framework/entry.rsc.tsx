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
import { parseRenderRequest } from "./request.tsx";
import { runWithRequestAsync, setRequest } from "./context.ts";

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
      _clearCache();
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

  // If the action returned invalidated partials, filter the re-render
  // so the server only renders those partials (minimal GraphQL queries).
  // The client PartialsClient merges fresh partials with its cache.
  //
  // Only apply filters when the client reports cached partials via ?cached=.
  // After a streaming render, the client's cache is empty — applying filters
  // would render only the invalidated partial and lose the rest of the page.
  // A full render populates the cache; subsequent actions use it.
  //
  // Two directives, same shape:
  //   invalidate — fresh mount: Suspense keys are version-stamped, so the
  //                fallback shows while fresh content loads.
  //   revalidate — update in place: Suspense keys are bare, so React
  //                reconciles in place and (under startTransition) holds old
  //                content visible until the new content resolves.
  //
  // Supported formats (both directives):
  //   { invalidate: ["cart", "header"] }           — by partial ID
  //   { invalidate: { tags: ["cart"] } }           — by tag (resolved by Partials)
  //   { invalidate: { ids: ["header"], tags: ["cart"] } } — mixed
  const clientHasCache = renderRequest.url.searchParams.has("cached");
  const resultData = returnValue?.ok ? (returnValue.data as any) : null;
  const directive = resultData?.revalidate ?? resultData?.invalidate;
  const isExplicitInvalidate = resultData?.invalidate != null;
  const isExplicitRevalidate = resultData?.revalidate != null;
  // Default action behavior: revalidate semantics (bare Suspense keys,
  // reconcile in place) unless the action explicitly asks for invalidate.
  // This prevents fallback flashes on action responses that have no directive
  // (e.g., action errors, or actions that just return data) — the server
  // still renders a fresh tree, but React reconciles Suspense in place under
  // the client's startTransition, so old content stays visible.
  //
  // Navigation renders (no action) keep version-stamped keys so each partial
  // shows its fallback and streams in progressively.
  const isRevalidate =
    isExplicitRevalidate || (renderRequest.isAction && !isExplicitInvalidate);

  let needsUpdate = false;

  if (directive) {
    const inv = directive;

    // Set partial IDs on the render URL. IDs are global (no namespace
    // prefix) and must match a `<Partial id="...">` declared somewhere
    // in the tree under `<PartialRoot>`.
    const setPartialIds = (ids: string[]) => {
      const existing = renderRequest.url.searchParams.get("partials");
      const merged = existing ? `${existing},${ids.join(",")}` : ids.join(",");
      renderRequest.url.searchParams.set("partials", merged);
      needsUpdate = true;
    };

    if (Array.isArray(inv)) {
      // Legacy format: string array of partial IDs
      if (inv.length > 0) {
        setPartialIds(inv);
      }
    } else if (typeof inv === "object") {
      // New format: { tags?: string[], ids?: string[] }
      const { tags, ids } = inv as { tags?: string[]; ids?: string[] };
      if (tags?.length) {
        // Purge data cache entries matching these tags
        const { invalidateByTags } = await import("../lib/partial-cache.ts");
        invalidateByTags(tags);
        renderRequest.url.searchParams.set("tags", tags.join(","));
        needsUpdate = true;
      }
      if (ids?.length) {
        setPartialIds(ids);
      }
    }

    // If the client has no cache (first action after streaming render),
    // tell Partials to use cache mode and render ALL partials to populate
    // the cache. Without this, only the invalidated partials render and
    // the rest of the page disappears (empty PartialsClient cache).
    if (!clientHasCache) {
      renderRequest.url.searchParams.set("__populateCache", "1");
      needsUpdate = true;
    }
  }

  // revalidate: tell partial.tsx to use bare Suspense keys so the client
  // reconciles in place (instead of remounting and flashing the fallback).
  // Applies on explicit revalidate directives AND any action without an
  // invalidate directive (see isRevalidate above).
  if (isRevalidate) {
    renderRequest.url.searchParams.set("revalidate", "1");
    needsUpdate = true;
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

  if (renderRequest.isRsc) {
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

  return new Response(ssrResult.stream, {
    status: ssrResult.status,
    headers: { "Content-type": "text/html" },
  });
}

if (import.meta.hot) {
  import.meta.hot.accept();
}
