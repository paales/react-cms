import {
  createFromReadableStream,
  createFromFetch,
  setServerCallback,
  createTemporaryReferenceSet,
  encodeReply,
} from "@vitejs/plugin-rsc/browser";
import React from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { rscStream } from "rsc-html-stream/client";
import type { RscPayload } from "./entry.rsc";
import { GlobalErrorBoundary } from "./error-boundary";
import { createRscRenderRequest } from "./request";
import {
  _consumeSilentFlag,
  _dispatchFrameRefetch,
  _readFramesSnapshot,
  getCachedPartialIds,
} from "../lib/partial-client";

async function main() {
  let setPayload: (v: RscPayload) => void;
  let setPayloadRaw: (v: RscPayload) => void;

  const initialPayload = await createFromReadableStream<RscPayload>(rscStream);

  function BrowserRoot() {
    const [payload, setPayload_] = React.useState(initialPayload);

    React.useEffect(() => {
      setPayload = (v) => React.startTransition(() => setPayload_(v));
      setPayloadRaw = setPayload_;
    }, [setPayload_]);

    React.useEffect(() => {
      return listenNavigation((url) => fetchRscPayload(url));
    }, []);

    return payload.root;
  }

  async function fetchRscPayload(overrideUrl?: string) {
    // Tell the server which partials are already cached so it can skip them.
    // If the caller already set ?cached= (e.g. a targeted refetch built by
    // `useNavigation().reload({ids})`), respect that instead of overwriting
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
    //     price (pair with `isPending` on the trigger).
    //
    //   setPayloadRaw (opt-in via ?disableTransition=1): plain post-
    //     await setState, outside any transition. React 19 shows
    //     Suspense fallbacks for pending children and commits Flight
    //     chunks as they arrive, giving per-row progressive streaming.
    //     Good for search / filter results where per-row reveal
    //     improves perceived latency.
    const disableTransition = url.searchParams.has("disableTransition");
    const renderRequest = createRscRenderRequest(url.toString());
    const response = await fetch(renderRequest);
    const payload = await createFromReadableStream<RscPayload>(response.body!);
    if (disableTransition) {
      setPayloadRaw(payload);
    } else {
      setPayload(payload);
    }
  }

  // Navigation handles (useNavigation / frame) dispatch targeted
  // refetches by calling this handler with a fully-formed URL.
  // Exposed on `window` directly to avoid module-instance duplication
  // between the browser entry bundle and "use client" component
  // bundles.
  (window as any).__rsc_partial_refetch = (url: string) =>
    fetchRscPayload(url);

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
    const payload = await createFromFetch<RscPayload>(fetch(renderRequest), {
      temporaryReferences,
    });

    setPayload(payload);
    const { ok, data } = payload.returnValue!;
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
    });
  }

  if (import.meta.hot) {
    import.meta.hot.on("rsc:update", () => {
      fetchRscPayload();
    });
  }
}

function listenNavigation(onNavigation: (url: string) => Promise<void>) {
  const handler = (event: NavigateEvent) => {
    if (!event.canIntercept) return;
    if (event.hashChange || event.downloadRequest !== null) return;
    if (event.formMethod === "POST") return;
    // `window.location.reload()` fires a navigate event with
    // `navigationType: "reload"` that the browser *can* intercept as
    // same-document. Intercepting defeats the whole point of a reload
    // (it re-runs against the existing module state). Pass it through
    // so the browser does a real cross-document reload.
    if (event.navigationType === "reload") return;

    // Frame navigation via `frame(name).navigate()`. The imperative
    // call does `history.pushState` + `_dispatchFrameRefetch`
    // itself, so we only intercept here on TRAVERSAL (browser back/
    // forward on a frame-state entry) — that's when the listener is
    // the only place that knows to re-run the refetch.
    //
    // For the initial push of a frame nav, skip this branch (let
    // the default fall through to page-nav logic, which no-ops
    // because `frame.navigate` called `history.pushState` with the
    // same URL — canIntercept stays true, so we need to also skip
    // the page-level intercept below via a silent flag).
    // Browser back/forward. Two axes need handling on a traverse:
    //   1. Page URL changed (e.g. /frames-demo?product=beta → /frames-demo)
    //      — the main page content needs a full refetch.
    //   2. Frame snapshots differ between destination and current
    //      — each differing frame needs its server session updated
    //      AND its subtree re-rendered.
    //
    // Both axes are handled in one request: we build a refetch URL
    // with the destination's page URL AND append `__frame/__frameUrl`
    // pairs for every frame that changed, so the server applies the
    // session updates, then does a streaming render for the new URL.
    //
    // If the URL didn't change and only frames changed, skip the full
    // render and fire targeted per-frame refetches instead — keeps
    // drawer-shaped back navigation cheap (cart/menu within the same
    // page URL).
    if (event.navigationType === "traverse") {
      const destSnap = _readFramesSnapshot(event.destination.getState?.());
      const currentSnap = _readFramesSnapshot(
        typeof navigation !== "undefined"
          ? navigation.currentEntry?.getState() ?? null
          : null,
      );
      const names = new Set([
        ...Object.keys(destSnap),
        ...Object.keys(currentSnap),
      ]);
      const diffs: Array<{ name: string; url: string }> = [];
      for (const name of names) {
        const dest = destSnap[name]?.url;
        const cur = currentSnap[name]?.url;
        if (dest && dest !== cur) diffs.push({ name, url: dest });
      }
      const urlChanged = event.destination.url !== window.location.href;
      if (urlChanged) {
        event.intercept({
          handler: async () => {
            const url = new URL(event.destination.url);
            for (const d of diffs) {
              url.searchParams.append("__frame", d.name);
              url.searchParams.append("__frameUrl", d.url);
            }
            const handler = (window as Window & {
              __rsc_partial_refetch?: (url: string) => Promise<void>;
            }).__rsc_partial_refetch;
            if (handler) await handler(url.toString());
          },
        });
        return;
      }
      if (diffs.length > 0) {
        event.intercept({
          handler: async () => {
            await Promise.all(
              diffs.map((d) => _dispatchFrameRefetch(d.name, d.url)),
            );
          },
        });
        return;
      }
    }

    // Silent URL updates (`useNavigation().navigate(url, { silent: true })`
    // or `{ ids: [...] }` / `{ tags: [...] }`) flip a short-lived
    // flag in `partial-client`. When set, we skip the intercept so the
    // URL updates for bookmarkability — any refetch is either skipped
    // entirely (silent) or dispatched directly by the navigate call.
    // Same mechanism is used by frame navigation after its
    // `history.pushState`.
    if (_consumeSilentFlag()) return;

    event.intercept({
      handler: () => onNavigation(event.destination.url),
    });
  };

  navigation.addEventListener("navigate", handler);
  return () => navigation.removeEventListener("navigate", handler);
}

main();
