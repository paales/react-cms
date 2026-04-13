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
  // Supports two formats:
  //   { invalidate: ["cart", "header"] }           — by partial ID
  //   { invalidate: { tags: ["cart"] } }           — by tag (resolved by Partials)
  //   { invalidate: { ids: ["header"], tags: ["cart"] } } — mixed
  if (
    returnValue?.ok &&
    returnValue.data &&
    typeof returnValue.data === "object" &&
    (returnValue.data as any).invalidate
  ) {
    const inv = (returnValue.data as any).invalidate;
    let needsUpdate = false;

    // Validate and set partial IDs on the render URL
    const setPartialIds = (ids: string[]) => {
      if (import.meta.env?.DEV) {
        for (const id of ids) {
          if (!id.includes("/")) {
            throw new Error(
              `Partial invalidation ID "${id}" has no namespace prefix. ` +
              `Use the full namespaced ID (e.g., "magento/${id}") or ` +
              `tag-based invalidation: { invalidate: { tags: ["${id}"] } }`,
            );
          }
        }
      }
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

    if (needsUpdate) {
      // Update the ALS request so getRequest() reflects the new params.
      // Only copy headers — the body was already consumed by the action handler.
      setRequest(new Request(renderRequest.url, { headers: renderRequest.request.headers }));
    }
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
