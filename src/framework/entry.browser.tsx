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
  _dispatchFrameRefetch,
  _readFramesSnapshot,
  getCachedPartialIds,
  isFrameworkSilentInfo,
} from "../lib/partial-client";
import { getNavigation } from "./navigation-api.ts";

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
  const nav = getNavigation();
  if (!nav) return () => {};
  const handler = (event: NavigateEvent) => {
    if (!event.canIntercept) return;
    if (event.hashChange || event.downloadRequest !== null) return;
    // `formMethod` isn't on TS 6's NavigateEvent type but is in the
    // spec (and runtime). Reach it via a narrow cast to avoid a type
    // error without broadening `event`'s type everywhere else.
    if ((event as { formMethod?: string | null }).formMethod === "POST") return;
    // `window.location.reload()` fires a navigate event with
    // `navigationType: "reload"` that the browser *can* intercept as
    // same-document. Intercepting defeats the whole point of a reload
    // (it re-runs against the existing module state). Pass it through
    // so the browser does a real cross-document reload.
    if (event.navigationType === "reload") return;

    // Framework-internal URL syncs stamp a branded `info` payload on
    // their `navigation.navigate(...)` call. Two variants:
    //   - window-silent: caller updated the URL only (or will dispatch
    //     its own targeted refetch).
    //   - frame:         caller pushed a frame-state entry; the frame
    //     subtree refetch runs in `frameNavigateImpl` after commit.
    // In both cases we call `event.intercept()` with no handler to
    // declare the navigation as same-document and avoid a page load.
    //
    // `focusReset: "manual"` opts out of the Navigation API's default
    // post-commit focus reset to <body>. Without it, any input driving
    // a live refetch (the search input typing into `tags: [...]`, a
    // filter that updates a frame URL, etc.) loses focus on every
    // keystroke.
    if (isFrameworkSilentInfo(event.info)) {
      event.intercept({ focusReset: "manual" });
      return;
    }

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
        nav.currentEntry?.getState() ?? null,
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

    event.intercept({
      handler: () => onNavigation(event.destination.url),
    });
  };

  nav.addEventListener("navigate", handler);
  return () => nav.removeEventListener("navigate", handler);
}

main();
